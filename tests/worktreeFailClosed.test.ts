// Regression for the security finding: ensureWorktree THROWING (a stale
// index.lock from a crashed process, a disk-full git op, a detached HEAD) used
// to be caught by an empty `catch {}` at every launch site and silently
// treated the same as ensureWorktree returning null — the legitimate
// non-git/empty-repo case. That merged "can't isolate, fine to skip" with
// "can't isolate, something is actually wrong" into one fallback: an
// unattended launch (a schedule firing, an auto-start) would run straight in
// the user's real project checkout instead of an isolated worktree, with no
// event, no transcript line, no banner.
//
// The fix removes the swallow at each site and lets the throw reach whatever
// failure-recording mechanism that site already has: dispatchPromptTask's own
// DispatchResult (which fireSchedule turns into a "failed" run, and the
// runbook route turns into a visible 400), and autoStart's existing
// publishTurnError path (already proven by the "throws unwinds the row"
// TypeError test below it). This file covers dispatchPromptTask and
// lib/autoStart.ts; tests/runnerWorktreeFailClosed.test.ts covers the queue
// drain in lib/runner.ts's startResumeTurn.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureWorktreeMock, startTurnMock, publishTurnErrorMock } = vi.hoisted(() => ({
  ensureWorktreeMock: vi.fn(),
  startTurnMock: vi.fn(),
  publishTurnErrorMock: vi.fn(),
}));

// Real ensureWorktree by default (so fixtures and the "returns null" cases
// still exercise actual git); a test arms a throw with mockImplementationOnce.
vi.mock("@/lib/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git")>();
  ensureWorktreeMock.mockImplementation(actual.ensureWorktree);
  return { ...actual, ensureWorktree: ensureWorktreeMock };
});

// Same seam tests/dispatch.test.ts and tests/autoStart.test.ts already use:
// pin the launch at the runner boundary so no real SDK/driver is anywhere
// near these tests.
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
  note: "▶ Scheduled — Sweep.",
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
    // The row was minted (the launch, not the creation, fell over) so it's a
    // real, retryable task rather than a leak — same contract as every other
    // post-mint dispatch failure.
    expect(res.task).toBeDefined();
    const task = getTask(res.task!.id)!;
    expect(task.running).toBe(0);
    expect(task.worktree_path).toBe("");
    // The turn never launched into any cwd, isolated or not.
    expect(startTurnMock).not.toHaveBeenCalled();
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

    // Unlike a launch that throws AFTER marking the row running (the existing
    // TypeError regression test), a throw during THIS self-heal happens before
    // running ever flips to 1 — so waiting on running===0 would resolve
    // trivially against its untouched default. Wait on the actual signal that
    // the async unwind finished instead.
    await vi.waitFor(() => expect(publishTurnErrorMock).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const fresh = getTask(b.id)!;
    // Cleanly retryable — same guarantee the existing broken-runner-import
    // regression test makes.
    expect(fresh.started).toBe(0);
    expect(fresh.status).toBe("not_started");
    expect(hasTurn(b.id)).toBe(false);
    // The failure is recorded where the user will see it, not only swallowed.
    expect(publishTurnErrorMock).toHaveBeenCalledTimes(1);
    const [id, gen, text] = publishTurnErrorMock.mock.calls[0];
    expect(id).toBe(b.id);
    expect(gen).toBe(fresh.generation);
    expect(text).toContain(LOCK_ERROR);
    // The turn was never handed a cwd at all — isolated or not.
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
