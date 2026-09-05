import { describe, expect, it, beforeEach, vi } from "vitest";

// The fire-time slash-command probe, executed for real: the SDK is mocked at
// its module boundary (the real commands.ts, the real composer probe
// underneath it, the real scheduler), scripted to answer normally, fail, and
// never answer at all.
//
// tickSchedules() is single-flight, so a probe that never returns leaves
// `ticking` true forever and every schedule on the instance stops firing, with
// nothing thrown, nothing logged, and nothing in the run ledger to say why.

// Read at import time by lib/config, so it has to be set before the static
// imports below are evaluated. vi.hoisted is the only thing that runs earlier.
vi.hoisted(() => {
  process.env.CALANDRIA_SCHEDULE_PROBE_MS = "150";
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
import { makeRepo, uid } from "./helpers";
import type { Project } from "@/lib/types";

type Cmd = { name: string; description?: string; aliases?: string[] };

/** A session that answers the control-channel question, then is torn down. */
const scriptRegistry = (...rounds: Cmd[][]) => {
  queryMock.mockReset();
  for (const commands of rounds) {
    queryMock.mockImplementationOnce(() => ({
      supportedCommands: async () => commands.map((c) => ({ description: "", argumentHint: "", ...c })),
      close: () => {},
    }));
  }
};

/** A session that can't be enumerated at all: no CLI, dead login, bad spawn. */
const scriptFailure = () =>
  queryMock.mockImplementation(() => ({
    supportedCommands: async () => { throw new Error("no CLI on PATH"); },
    close: () => {},
  }));

/**
 * A session that opens and then never answers: the wedge case. Modeled as the
 * SDK honoring its abort signal, which is what the real one does. The caller
 * must not wait for that to happen.
 */
const scriptStall = () =>
  queryMock.mockImplementation((args: { options: { abortController: AbortController } }) => ({
    supportedCommands: () =>
      new Promise((_resolve, reject) => {
        args.options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    close: () => {},
  }));

// The probe caches per cwd, so tests that script different answers must not
// share one. (The cache itself is asserted on further down.)
const project = (): Project => ({ id: `p-${uid()}`, name: "Probe", repo_path: `/tmp/probe-${uid()}` }) as Project;

const optionsOf = (n: number) =>
  (queryMock.mock.calls[n][0] as { options: { abortController: AbortController } }).options;

async function projectWithRepo() {
  const repo = await makeRepo();
  return createProject({ name: `probe-${uid()}`, repo_path: repo });
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
    scriptRegistry([{ name: "jira-tasks" }, { name: "superpowers:brainstorming" }]);
    expect(await listSlashCommands(project(), "claude")).toEqual(["jira-tasks", "superpowers:brainstorming"]);

    scriptRegistry([{ name: "jira-tasks" }]);
    expect(await validatePrompt("/jira-tasks", project(), "claude")).toEqual({ ok: true });

    // A refusal is re-read fresh before it's said, so both rounds are scripted.
    scriptRegistry([{ name: "jira-tasks" }], [{ name: "jira-tasks" }]);
    const bad = await validatePrompt("/jira-taks", project(), "claude");
    expect(bad.ok).toBe(false);
    expect(bad.suggestions).toContain("jira-tasks");
  });

  it("counts an alias as a registration", async () => {
    // The CLI resolves /writing-plans to superpowers:writing-plans, so refusing
    // it would fail a working job every morning. Aliases are visible here only
    // because the shared probe carries them; the init message never did.
    scriptRegistry([{ name: "superpowers:writing-plans", aliases: ["writing-plans"] }]);
    expect(await validatePrompt("/writing-plans", project(), "claude")).toEqual({ ok: true });
  });

  it("does not probe an agent that has no such surface", async () => {
    scriptRegistry([{ name: "jira-tasks" }]);
    expect(await listSlashCommands(project(), "codex")).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("reads a failed probe as 'couldn't check', never as 'no such command'", async () => {
    // The contract that makes sharing the composer's probe safe. Its menu
    // degrades to an empty list on a dead login, and an empty list here would
    // mean every scheduled command is unknown, settling the run `failed` and
    // minting nothing every morning for a command that exists.
    scriptFailure();
    expect(await listSlashCommands(project(), "claude")).toBeNull();
    expect(await validatePrompt("/jira-tasks", project(), "claude")).toEqual({ ok: true, unchecked: true });
  });

  it("treats an MCP prompt the probe cannot see as unchecked, not unknown", async () => {
    // /mcp__<server>__<prompt> names appear only on a session's init message,
    // never in supportedCommands(); it is not a timing artifact (re-asked at
    // 3s/8s/15s) and not strictMcpConfig (identical with and without). A
    // scheduled turn inherits the user's MCP servers and would expand them, so
    // absence here proves nothing and must not refuse.
    scriptRegistry([{ name: "jira-tasks" }]);
    const check = await validatePrompt("/mcp__aura__daily-review", project(), "claude");
    expect(check).toMatchObject({ ok: true, unchecked: true });
    expect(check.note).toContain("MCP prompt");
    // It also avoids a second spawn to confirm what it can't see anyway.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("confirms an absence against a fresh read before refusing on it", async () => {
    // The registry is cached for a minute. A command installed inside that
    // minute would otherwise be refused for existing too recently; at fire
    // time that's a `failed` run and no task.
    const p = project();
    scriptRegistry([{ name: "jira-tasks" }], [{ name: "jira-tasks" }, { name: "just-installed" }]);
    expect(await listSlashCommands(p, "claude")).toEqual(["jira-tasks"]); // warms the cache
    expect(await validatePrompt("/just-installed", p, "claude")).toEqual({ ok: true });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("spawns one probe for a whole sweep, not one per schedule", async () => {
    // Same project, same cwd: the second and third checks are answered from the
    // cache the composer's menu already uses.
    const p = project();
    scriptRegistry([{ name: "jira-tasks" }]);
    for (let i = 0; i < 3; i++) expect(await validatePrompt("/jira-tasks", p, "claude")).toEqual({ ok: true });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("gives up on a stalled CLI instead of hanging forever", async () => {
    // Bound this on the fake clock, same as the "bounds the sweep" test below,
    // instead of asserting a real wall-clock elapsed time stayed under a loose
    // safety margin.
    vi.useFakeTimers();
    try {
      scriptStall();
      const listPending = listSlashCommands(project(), "claude", 100);
      await vi.advanceTimersByTimeAsync(100);
      // `null` is "couldn't check", which validatePrompt degrades to
      // `unchecked`: a probe that can't complete must not block the morning's
      // work either way.
      expect(await listPending).toBeNull();

      const validatePending = validatePrompt("/anything", project(), "claude", 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(await validatePending).toEqual({ ok: true, unchecked: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the sweep on its own clock and leaves the child to the probe's", async () => {
    // The two deadlines compose. This caller's deadline frees the sweep; the
    // probe's own deadline kills the process, and the two are separate because
    // several schedules share one in-flight probe, so one impatient caller must
    // not tear it down for the rest.
    vi.useFakeTimers();
    try {
      scriptStall();
      const pending = listSlashCommands(project(), "claude", 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBeNull();
      expect(optionsOf(0).abortController.signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(optionsOf(0).abortController.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stalled probe cannot wedge the sweep — the next tick still fires", async () => {
    // End to end: if the read below never returns, tickSchedules() never
    // clears `ticking` and every schedule on the instance stops firing until
    // the process restarts.
    const p = await projectWithRepo();
    const stalls = createSchedule({
      project_id: p.id, name: "stalls", prompt: "/needs-a-registry",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    dueNow(stalls.id);
    scriptStall();

    // The probe's own giveUp fires at SCHEDULE_PROBE_MS (150ms, set via env at
    // the top of this file). Advance the fake clock past it instead of trusting
    // a real wall-clock bound to prove the sweep didn't hang.
    vi.useFakeTimers();
    try {
      const pending = tickSchedules(Date.now());
      await vi.advanceTimersByTimeAsync(200);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    // Unchecked, not failed: the registry could not be reached, so the run
    // went ahead instead of being refused for a probe that never answered.
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
