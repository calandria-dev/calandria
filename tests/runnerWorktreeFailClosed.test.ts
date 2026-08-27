// Regression for the security finding, at the fourth site: lib/runner.ts's
// startResumeTurn. Its riskiest caller is the queue drain in run()'s finally —
// a dequeued follow-up whose task lost its worktree_path reaches
// startResumeTurn with nobody watching the exact instant it's prepared. An
// empty `catch {}` around ensureWorktree there used to fall back to
// task.worktree_path || project.repo_path on ANY git error, not just the
// legitimate non-git/empty-repo null case — so a stale index.lock would run
// the drained turn straight in the user's real project checkout.
//
// Same seam as tests/queueDrainWorktree.test.ts: the Claude driver is mocked
// so the real runner (including its queue drain and startResumeTurn) runs
// with no SDK anywhere near it, and the mock records the cwd it would have
// run in.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { runTurnMock, cwds, ensureWorktreeMock } = vi.hoisted(() => ({
  runTurnMock: vi.fn(),
  cwds: [] as string[],
  ensureWorktreeMock: vi.fn(),
}));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Claude Code",
    runTurn: (task: { worktree_path: string }, project: { repo_path: string }, userText: string, ac?: unknown) => {
      cwds.push(task.worktree_path || project.repo_path);
      return runTurnMock(task, project, userText, ac);
    },
  },
}));

// Real ensureWorktree by default (the fixture setup and the "returns null"
// test both need actual git); a test arms a throw with mockImplementationOnce.
vi.mock("@/lib/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git")>();
  ensureWorktreeMock.mockImplementation(actual.ensureWorktree);
  return { ...actual, ensureWorktree: ensureWorktreeMock };
});

import { createProject, createTask, getTask, updateTask, addPendingMessage, listPendingMessages, listMessages } from "@/lib/store";
import { startTurn } from "@/lib/runner";
import { hasTurn } from "@/lib/abort";
import { subscribe } from "@/lib/events";
import { removeWorktree } from "@/lib/git";
import { WORKTREE_REPAIR_NOTICE, WorktreePrepError } from "@/lib/worktreeFailure";
import { clearAgentAuthBroken } from "@/lib/agents/connections";
import { makeRepo, git } from "./helpers";
import type { TaskStreamEvent } from "@/lib/types";

const OAUTH_DEAD = "Failed to authenticate: OAuth session expired and could not be refreshed";
const LOCK_ERROR = "fatal: Unable to create '.git/worktrees/x/index.lock': File exists.";

function watch(taskId: string, until: TaskStreamEvent["type"]): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      if (ev.type === until) { unsub(); resolve(); }
    });
  });
}

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

beforeEach(() => {
  runTurnMock.mockReset();
  cwds.length = 0;
  ensureWorktreeMock.mockClear();
  clearAgentAuthBroken("claude");
});

// A task with a live worktree, a turn that dies on a dead login (parking the
// queued follow-up instead of draining it), and the worktree then reclaimed
// exactly like "prune merged worktrees" does — the state in which a drained
// follow-up must self-heal a worktree of its own. Leaves `cwds` holding
// exactly turn 1's cwd (the live worktree).
async function primeDrainedTask() {
  const repo = await makeRepo();
  const project = createProject({ name: `drain-fc-${Math.random().toString(36).slice(2)}`, repo_path: repo, branch: "main" });
  const task = createTask({ project_id: project.id, title: "T", description: "d" });
  const wt = await ensureWorktreeMock(repo, task.id, "main");
  if (!wt) throw new Error("ensureWorktree returned null in fixture");
  updateTask(task.id, {
    started: 1,
    session_id: "sess-1",
    worktree_path: wt.path,
    work_branch: wt.branch,
    base_sha: wt.baseSha,
  });
  addPendingMessage(task.id, task.generation, "and now the follow-up");
  runTurnMock.mockImplementationOnce(async function* () {
    yield { type: "session", sessionId: "sess-1" };
    throw new Error(OAUTH_DEAD);
  });
  const ended = watch(task.id, "turn_end");
  startTurn(getTask(task.id)!, project, "do the thing", "");
  await ended;
  expect(listPendingMessages(task.id)).toHaveLength(1);
  expect(cwds).toEqual([wt.path]);

  await removeWorktree(repo, wt.path, wt.branch, { keepBranch: true });
  updateTask(task.id, { worktree_path: "" });
  clearAgentAuthBroken("claude");
  return { repo, project, task, wt };
}

describe("queue drain fails closed on a throwing ensureWorktree", () => {
  it("refuses the drained turn and records the failure instead of running it in the real repo checkout", async () => {
    const { repo, project, task } = await primeDrainedTask();

    // Turn 2 runs fine (worktree_path is empty, so it falls back to repo_path —
    // that part is unaffected); it's turn 3, the drained follow-up, whose
    // self-heal throws.
    // The shape ensureWorktree really throws now: classified, so the failure
    // line the drain writes can carry a recovery (issue #44).
    ensureWorktreeMock.mockImplementationOnce(async () => {
      throw new WorktreePrepError(new Error(LOCK_ERROR));
    });
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess-1" };
      yield { type: "done", sessionId: "sess-1" };
    });
    const settled = watch(task.id, "turn_end");
    startTurn(getTask(task.id)!, project, "second turn", "");
    await settled;

    // Turn 1 (from setup) ran in the live worktree; turn 2 ran unisolated in
    // repo_path (worktree_path was cleared — that fallback for an empty path
    // is pre-existing, legitimate behavior, untouched by this fix). The
    // drained turn 3 never reached the driver at all.
    expect(cwds).toHaveLength(2);
    expect(real(cwds[1])).toBe(real(repo));

    await vi.waitFor(() => {
      const msgs = listMessages(task.id);
      expect(msgs.some((m) => m.role === "system" && m.content.includes(LOCK_ERROR))).toBe(true);
    });
    // Nobody was watching this launch, so the transcript line IS the recovery:
    // it explains the stale lock and carries the "Repair worktree" affordance.
    expect(listMessages(task.id).find((m) => m.content.includes(LOCK_ERROR))!.content).toContain(WORKTREE_REPAIR_NOTICE);
    expect(listPendingMessages(task.id)).toHaveLength(0);
    await vi.waitFor(() => expect(hasTurn(task.id)).toBe(false));
    await vi.waitFor(() => expect(getTask(task.id)!.running).toBe(0));
    // Never fell back to the user's actual project checkout for the DRAINED
    // turn: worktree_path stayed empty rather than being silently populated
    // with something running unisolated.
    expect(getTask(task.id)!.worktree_path).toBe("");
  });

  it("still self-heals a new worktree and drains normally when ensureWorktree succeeds", async () => {
    const { project, task, wt } = await primeDrainedTask();

    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess-1" };
      yield { type: "done", sessionId: "sess-1" };
    });
    const drained = watch(task.id, "dequeued");
    const settled = watch(task.id, "turn_end");
    startTurn(getTask(task.id)!, project, "second turn", "");
    await drained;
    await settled;

    // Turn 1 (from the fixture setup) + turn 2 + the drained turn 3.
    expect(cwds).toHaveLength(3);
    const followUp = cwds[2];
    expect(fs.existsSync(followUp)).toBe(true);
    expect(real(followUp)).not.toBe(real(project.repo_path));
    expect(await git(followUp, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
    expect(listPendingMessages(task.id)).toHaveLength(0);
    expect(real(getTask(task.id)!.worktree_path)).toBe(real(followUp));
  });
});
