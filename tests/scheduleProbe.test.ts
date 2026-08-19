import { describe, expect, it, beforeEach, vi } from "vitest";

// The fire-time slash-command probe, executed FOR REAL.
//
// tests/scheduler.test.ts and tests/scheduleApi.test.ts both mock
// @/lib/schedule/commands wholesale, so until this file existed the probe —
// which spawns the agent CLI from inside the ticker's single-flight sweep — had
// never actually run in a test. What it hides when it misbehaves is the worst
// failure this feature has: tickSchedules() is single-flight, so one probe that
// never returns leaves `ticking` true forever and EVERY schedule on the instance
// stops firing, with nothing thrown, nothing logged, and nothing in the run
// ledger to say why.
//
// So the SDK is mocked at its module boundary (the real commands.ts, the real
// scheduler) and scripted to do the two things that matter: answer normally, and
// never answer at all.

// Read at import time by lib/config, so it has to be set before the static
// imports below are evaluated — vi.hoisted is the only thing that runs earlier.
vi.hoisted(() => {
  process.env.ORCH_SCHEDULE_PROBE_MS = "150";
});

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => cfg,
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

// The turn itself is not under test here; the launch decision is.
const started: string[] = [];
vi.mock("@/lib/runner", () => ({
  startTurn: (task: { id: string }) => { started.push(task.id); },
}));

import { createProject, listTasks } from "@/lib/store";
import { listSlashCommands, validatePrompt } from "@/lib/schedule/commands";
import { createSchedule, lastRun } from "@/lib/schedule/store";
import { tickSchedules } from "@/lib/scheduler";
import { getDb } from "@/lib/db";
import { setAgentConnection } from "@/lib/agents/connections";
import { makeRepo } from "./helpers";
import type { Project } from "@/lib/types";

/** A session whose init message carries a command registry, then ends. */
const scriptRegistry = (commands: string[]) =>
  queryMock.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "system", subtype: "init", slash_commands: commands };
    },
    interrupt: async () => {},
  }));

/** A session that opens and then never says anything — the wedge case. */
const scriptStall = () =>
  queryMock.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {}); // never resolves, never yields
    },
  }));

const project = { id: "p-probe", name: "Probe", repo_path: "/tmp" } as Project;

async function projectWithRepo() {
  const repo = await makeRepo();
  return createProject({ name: `probe-${Math.random().toString(36).slice(2)}`, repo_path: repo });
}

const dueNow = (id: string) =>
  getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, id);

beforeEach(() => {
  started.length = 0;
  queryMock.mockReset();
  setAgentConnection("claude", { method: "subscription", email: null, plan: null });
});

describe("the fire-time command probe", () => {
  it("reads the session's registry and validates against it", async () => {
    scriptRegistry(["jira-tasks", "superpowers:brainstorming"]);
    expect(await listSlashCommands(project, "claude")).toEqual(["jira-tasks", "superpowers:brainstorming"]);

    scriptRegistry(["jira-tasks"]);
    expect(await validatePrompt("/jira-tasks", project, "claude")).toEqual({ ok: true });

    scriptRegistry(["jira-tasks"]);
    const bad = await validatePrompt("/jira-taks", project, "claude");
    expect(bad.ok).toBe(false);
    expect(bad.suggestions).toContain("jira-tasks");
  });

  it("does not probe an agent that has no such surface", async () => {
    scriptRegistry(["jira-tasks"]);
    expect(await listSlashCommands(project, "codex")).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("gives up on a stalled CLI instead of hanging forever", async () => {
    scriptStall();
    const t0 = Date.now();
    // `null` is "couldn't check", which validatePrompt degrades to `unchecked` —
    // best-effort by design: a probe we can't complete must not block the
    // morning's work either way.
    expect(await listSlashCommands(project, "claude", 100)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(await validatePrompt("/anything", project, "claude", 100)).toEqual({ ok: true, unchecked: true });
  });

  it("aborts the stalled session rather than leaking the child", async () => {
    scriptStall();
    await listSlashCommands(project, "claude", 100);
    const opts = (queryMock.mock.calls[0][0] as { options: { abortController?: AbortController } }).options;
    expect(opts.abortController?.signal.aborted).toBe(true);
  });

  it("a stalled probe cannot wedge the sweep — the next tick still fires", async () => {
    // The actual harm, end to end. Before the timeout, the `for await` below
    // never returned, so tickSchedules() never cleared `ticking` and every
    // schedule on the instance was silently dead until the process restarted.
    const p = await projectWithRepo();
    const stalls = createSchedule({
      project_id: p.id, name: "stalls", prompt: "/needs-a-registry",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    dueNow(stalls.id);
    scriptStall();

    const began = Date.now();
    await tickSchedules(Date.now());
    expect(Date.now() - began).toBeLessThan(10_000);
    // Unchecked, not failed: we could not reach the registry, so the run went
    // ahead rather than being refused on a probe that never answered.
    expect(lastRun(stalls.id)!.status).toBe("running");
    expect(listTasks(p.id).filter((t) => t.schedule_id === stalls.id)).toHaveLength(1);

    // And the sweep is genuinely free: a second schedule fires on the very next
    // tick, which is impossible if `ticking` is still true.
    const after = createSchedule({
      project_id: p.id, name: "after", prompt: "plain prompt",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    dueNow(after.id);
    await tickSchedules(Date.now());
    expect(lastRun(after.id)!.status).toBe("running");
    expect(started).toHaveLength(2);
  });
});
