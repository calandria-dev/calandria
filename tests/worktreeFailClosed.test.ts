// Pins that ensureWorktree throwing (a stale index.lock from a crashed
// process, a disk-full git op, a detached HEAD) must not be treated the same
// as ensureWorktree returning null, the legitimate non-git/empty-repo case.
// Conflating them would let an unattended launch (a schedule firing, an
// auto-start) run in the user's real project checkout instead of an isolated
// worktree, with no event, no transcript line, no banner.
//
// Each launch site must let the throw reach its own failure-recording
// mechanism: dispatchPromptTask's DispatchResult (which fireSchedule turns
// into a "failed" run, and the runbook route turns into a 400), and
// autoStart's publishTurnError path. This file covers dispatchPromptTask and
// lib/autoStart.ts; tests/runnerWorktreeFailClosed.test.ts covers the queue
// drain in lib/runner.ts's startResumeTurn.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureWorktreeMock, startTurnMock, publishTurnErrorMock } = vi.hoisted(() => ({
  ensureWorktreeMock: vi.fn(),
  startTurnMock: vi.fn(),
  publishTurnErrorMock: vi.fn(),
}));

// Uses the real ensureWorktree by default, so fixtures and the "returns
// null" cases still exercise actual git; a test arms a throw with
// mockImplementationOnce.
vi.mock("@/lib/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git")>();
  ensureWorktreeMock.mockImplementation(actual.ensureWorktree);
  return { ...actual, ensureWorktree: ensureWorktreeMock };
});

// Same seam tests/dispatch.test.ts and tests/autoStart.test.ts use: pins the
// launch at the runner boundary so no real SDK or driver is involved.
vi.mock("@/lib/runner", () => ({
  startTurn: startTurnMock,
  publishTurnError: publishTurnErrorMock,
}));

let promptCheck: { ok: boolean; error?: string; suggestions?: string[] } = { ok: true };
vi.mock("@/lib/schedule/commands", () => ({
  validatePrompt: async () => promptCheck,
}));

import { createProject, createTask, getTask, setTaskDeps, updateTask } from "@/lib/store";
import { dispatchPromptTask } from "@/lib/dispatch";
import { maybeAutoStartDependents } from "@/lib/autoStart";
import { hasTurn } from "@/lib/abort";
import { setAgentConnection } from "@/lib/agents/connections";
import { makeRepo } from "./helpers";

const LOCK_ERROR = "fatal: Unable to create '.git/worktrees/x/index.lock': File exists.";

async function projectWithRepo() {
  const repo = await makeRepo();
  return createProject({ name: `wtfc-${Math.random().toString(36).slice(2)}`, repo_path: repo });
}

const base = {
  title: "Sweep",
  description: "Do the sweep.",
  prompt: "/sweep",
  agent: "claude",
  permission_mode: "bypassPermissions" as string | null,
  send_context: true,
  priority: "hi" as const,
  note: "▶ Scheduled: Sweep.",
};

beforeEach(() => {
  ensureWorktreeMock.mockClear();
  startTurnMock.mockReset();
  publishTurnErrorMock.mockReset();
  promptCheck = { ok: true };
  setAgentConnection("claude", { method: "subscription", email: null, plan: null });
});

describe("dispatchPromptTask fails closed on a throwing ensureWorktree", () => {
  it("refuses the launch and reports the error instead of running in repo_path", async () => {
    const p = await projectWithRepo();
    ensureWorktreeMock.mockImplementationOnce(async () => {
      throw new Error(LOCK_ERROR);
    });

    const res = await dispatchPromptTask({ ...base, project_id: p.id });

    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain(LOCK_ERROR);
    // The row was minted before the launch failed, so it is a real,
    // retryable task instead of a leak, the same contract every other
    // post-mint dispatch failure follows.
    expect(res.task).toBeDefined();
    const task = getTask(res.task!.id)!;
    expect(task.running).toBe(0);
    expect(task.worktree_path).toBe("");
    // The turn never launched into any cwd, isolated or not.
    expect(startTurnMock).not.toHaveBeenCalled();
    // The minted task also carries the classified failure on its own
    // transcript (issue #44); otherwise a schedule's failure lives only in
    // the run ledger and the task itself shows nothing.
    expect(publishTurnErrorMock).toHaveBeenCalledWith(task.id, task.generation, expect.stringContaining(LOCK_ERROR));
  });

  it("still falls back to repo_path when ensureWorktree legitimately returns null", async () => {
    const p = await projectWithRepo();
    ensureWorktreeMock.mockImplementationOnce(async () => null);

    const res = await dispatchPromptTask({ ...base, project_id: p.id });

    expect(res.ok).toBe(true);
    expect(startTurnMock).toHaveBeenCalledTimes(1);
    const [task] = startTurnMock.mock.calls[0];
    expect(task.worktree_path).toBeFalsy();
    expect(getTask(res.task!.id)!.running).toBe(1);
  });
});

describe("lib/autoStart.ts fails closed on a throwing ensureWorktree", () => {
  it("a throw during the worktree self-heal unwinds the row instead of running unattended in repo_path", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: `auto-throw-${Math.random().toString(36).slice(2)}`, repo_path: repo });
    const a = createTask({ project_id: project.id, title: "A" });
    const b = createTask({ project_id: project.id, title: "B" });
    setTaskDeps(b.id, [a.id]);
    updateTask(b.id, { auto_start: 1 });

    ensureWorktreeMock.mockImplementationOnce(async () => {
      throw new Error(LOCK_ERROR);
    });
    updateTask(a.id, { status: "done" });
    maybeAutoStartDependents(a.id);

    // A throw during this self-heal happens before running ever flips to 1,
    // unlike a launch that throws after marking the row running (the
    // TypeError regression test), so waiting on running===0 would resolve
    // trivially against its untouched default. Wait on the signal that the
    // async unwind finished instead.
    await vi.waitFor(() => expect(publishTurnErrorMock).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const fresh = getTask(b.id)!;
    // Cleanly retryable, the same guarantee the broken-runner-import
    // regression test makes.
    expect(fresh.started).toBe(0);
    expect(fresh.status).toBe("not_started");
    expect(hasTurn(b.id)).toBe(false);
    // The failure is recorded where the user will see it instead of being
    // swallowed.
    expect(publishTurnErrorMock).toHaveBeenCalledTimes(1);
    const [id, gen, text] = publishTurnErrorMock.mock.calls[0];
    expect(id).toBe(b.id);
    expect(gen).toBe(fresh.generation);
    expect(text).toContain(LOCK_ERROR);
    // The turn was never handed a cwd at all, isolated or not.
    expect(startTurnMock).not.toHaveBeenCalled();
  });

  it("still launches in an isolated worktree when ensureWorktree succeeds", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: `auto-ok-${Math.random().toString(36).slice(2)}`, repo_path: repo });
    const a = createTask({ project_id: project.id, title: "A" });
    const b = createTask({ project_id: project.id, title: "B" });
    setTaskDeps(b.id, [a.id]);
    updateTask(b.id, { auto_start: 1 });

    updateTask(a.id, { status: "done" });
    maybeAutoStartDependents(a.id);

    await vi.waitFor(() => expect(startTurnMock).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const [task] = startTurnMock.mock.calls[0];
    expect(task.worktree_path).toBeTruthy();
    expect(publishTurnErrorMock).not.toHaveBeenCalled();
  });
});
