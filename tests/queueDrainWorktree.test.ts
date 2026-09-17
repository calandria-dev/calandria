import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Same seam as tests/authFailure.test.ts: the Claude driver module is mocked so
// the real runner (including its queue drain) runs with no SDK anywhere near it.
// The mock records the cwd the driver would have run in, using the same
// `task.worktree_path || project.repo_path` fallback lib/agents/claude/driver.ts
// applies, since that fallback is what this file pins.
const { runTurnMock, cwds } = vi.hoisted(() => ({ runTurnMock: vi.fn(), cwds: [] as string[] }));

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

import { createProject, createTask, getTask, updateTask, addPendingMessage, listMessages, listPendingMessages } from "@/lib/store";
import { startResumeTurn, startTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import { ensureWorktree, removeWorktree } from "@/lib/git";
import { WORKTREES_DIR } from "@/lib/config";
import { clearAgentAuthBroken } from "@/lib/agents/connections";
import { commitFile, makeRepo, git } from "./helpers";
import { outputLines } from "./platform";
import type { TaskStreamEvent } from "@/lib/types";

const OAUTH_DEAD = "Failed to authenticate: OAuth session expired and could not be refreshed";

// Resolve once the runner publishes an event of the given type for this task.
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
  clearAgentAuthBroken("claude");
});

// A turn reaching the runner through the queue drain (run()'s finally popping
// pending_messages) never passes through the two launch paths that create a
// worktree (POST /api/tasks/[id]/messages and lib/autoStart.ts). It inherits
// whatever the task row says, so with worktree_path empty the driver's
// `task.worktree_path || project.repo_path` fallback would point the agent at
// the user's actual project checkout. startResumeTurn runs the same self-heal
// those paths do, so isolation is guaranteed by the code that runs on every
// call site.
describe("queue drain isolation", () => {
  it("cuts a worktree for a dequeued follow-up whose task lost one", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: "Drain", repo_path: repo, branch: "main" });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });
    const wt = await ensureWorktree(repo, task.id, "main");
    if (!wt) throw new Error("ensureWorktree returned null in fixture");
    updateTask(task.id, {
      started: 1,
      session_id: "sess-1",
      worktree_path: wt.path,
      work_branch: wt.branch,
      base_sha: wt.baseSha,
    });

    // Turn 1 dies on a dead login, which parks the queue instead of draining
    // it: the state in which a follow-up outlives the turn that was running.
    addPendingMessage(task.id, task.generation, "and now the follow-up");
    runTurnMock.mockImplementationOnce(async function* () {
      yield { type: "session", sessionId: "sess-1" };
      throw new Error(OAUTH_DEAD);
    });
    const ended = watch(task.id, "turn_end");
    startTurn(getTask(task.id)!, project, "do the thing", "");
    await ended;
    expect(listPendingMessages(task.id)).toHaveLength(1);

    // With no turn live, the worktree is reclaimed the way "prune merged
    // worktrees" reclaims one: the checkout goes, the branch and its commits
    // stay, and worktree_path is cleared.
    await removeWorktree(repo, wt.path, wt.branch, { keepBranch: true });
    updateTask(task.id, { worktree_path: "" });
    expect(fs.existsSync(wt.path)).toBe(false);

    // Turn 2 succeeds, so its finally drains the parked follow-up into turn 3,
    // the path that creates no worktree of its own.
    clearAgentAuthBroken("claude");
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess-1" };
      yield { type: "done", sessionId: "sess-1" };
    });
    const drained = watch(task.id, "dequeued");
    const settled = watch(task.id, "turn_end");
    startTurn(getTask(task.id)!, project, "second turn", "");
    await drained;
    await settled;

    // Three turns ran; the dequeued one is the last. (Turn 2 went straight
    // through startTurn, which is the route's job to prepare. This test drives
    // the runner directly, so only the drain's own guarantee is asserted.)
    expect(cwds).toHaveLength(3);
    const followUp = cwds[2];
    // Not the user's project checkout.
    expect(real(followUp)).not.toBe(real(repo));
    // A real worktree of this repo, at the task's own path, and on disk.
    expect(real(followUp)).toBe(real(path.join(WORKTREES_DIR, task.id)));
    expect(fs.existsSync(followUp)).toBe(true);
    const listed = await git(repo, "worktree", "list", "--porcelain");
    expect(outputLines(listed).filter((l) => l.startsWith("worktree ")).map((l) => real(l.slice(9).trim())))
      .toContain(real(followUp));
    // ensureWorktree reattached to the surviving branch, so the earlier work
    // came back instead of being restarted from base.
    expect(await git(followUp, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);

    // It's persisted, so the next turn and the diff/merge routes agree.
    const fresh = getTask(task.id)!;
    expect(real(fresh.worktree_path)).toBe(real(followUp));
    expect(fresh.work_branch).toBe(wt.branch);
    expect(listPendingMessages(task.id)).toHaveLength(0);
  });

  it("leaves a task with a live worktree exactly where it was", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: "Drain2", repo_path: repo, branch: "main" });
    const task = createTask({ project_id: project.id, title: "T2", description: "d" });
    const wt = await ensureWorktree(repo, task.id, "main");
    if (!wt) throw new Error("ensureWorktree returned null in fixture");
    updateTask(task.id, {
      started: 1,
      session_id: "sess-2",
      worktree_path: wt.path,
      work_branch: wt.branch,
      base_sha: wt.baseSha,
    });
    addPendingMessage(task.id, task.generation, "follow-up");

    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess-2" };
      yield { type: "done", sessionId: "sess-2" };
    });
    const drained = watch(task.id, "dequeued");
    const settled = watch(task.id, "turn_end");
    startTurn(getTask(task.id)!, project, "first", "");
    await drained;
    await settled;

    expect(cwds).toEqual([wt.path, wt.path]);
    expect(getTask(task.id)!.base_sha).toBe(wt.baseSha);
  });
});

// The self-heal is right for a checkout that went missing on its own and
// wrong to perform quietly after something took the BRANCH too (an
// auto-reclaim, a project move). From the session's side its whole history
// vanished between two messages, and the next thing it sees is an empty diff.
describe("a resume that had to re-cut a discarded branch", () => {
  async function reclaimed(name: string) {
    const repo = await makeRepo();
    const project = createProject({ name, repo_path: repo, branch: "main" });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });
    const wt = await ensureWorktree(repo, task.id, "main");
    if (!wt) throw new Error("ensureWorktree returned null in fixture");
    await commitFile(wt.path, "work.txt", "the work\n", "feat: the work");
    const ownCommit = await git(wt.path, "rev-parse", "HEAD");
    updateTask(task.id, {
      started: 1, session_id: "sess", worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha,
    });
    return { repo, project, task, wt, ownCommit };
  }

  function noticesOf(taskId: string) {
    const seen: string[] = [];
    const unsub = subscribe(taskId, (ev) => { if (ev.type === "notice") seen.push(ev.content); });
    return { seen, unsub };
  }

  async function resume(taskId: string, project: ReturnType<typeof createProject>) {
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess" };
      yield { type: "done", sessionId: "sess" };
    });
    const settled = watch(taskId, "turn_end");
    await startResumeTurn(getTask(taskId)!, project, "carry on then");
    await settled;
  }

  it("says so on the transcript instead of handing over an empty branch", async () => {
    const { repo, project, task, wt, ownCommit } = await reclaimed("Recut");
    // Exactly what an auto-reclaim leaves: checkout and local branch both
    // gone, both columns blanked (clearTaskWorktreePath with branch: true).
    await removeWorktree(repo, wt.path, wt.branch, { keepBranch: false });
    updateTask(task.id, { worktree_path: "", work_branch: "", base_sha: "" });

    const { seen, unsub } = noticesOf(task.id);
    await resume(task.id, project);
    unsub();

    expect(seen.some((n) => n.includes("branch no longer existed"))).toBe(true);
    // Persisted as well as published: a reloaded transcript still explains it.
    expect(listMessages(task.id).some((m) => m.role === "system" && m.content.includes("branch no longer existed")))
      .toBe(true);
    // And the notice is telling the truth: the re-cut carries none of the
    // task's own commits.
    const fresh = getTask(task.id)!;
    expect(fresh.worktree_path).not.toBe("");
    expect(await git(fresh.worktree_path, "rev-parse", "HEAD")).not.toBe(ownCommit);
  });

  it("stays quiet when the branch survived and the checkout came back", async () => {
    const { repo, project, task, wt, ownCommit } = await reclaimed("Reattach");
    // The worktree sweep's rule: the checkout goes, the branch stays.
    await removeWorktree(repo, wt.path, wt.branch, { keepBranch: true });
    updateTask(task.id, { worktree_path: "" });

    const { seen, unsub } = noticesOf(task.id);
    await resume(task.id, project);
    unsub();

    expect(seen.filter((n) => n.includes("branch no longer existed"))).toEqual([]);
    expect(await git(getTask(task.id)!.worktree_path, "rev-parse", "HEAD")).toBe(ownCommit);
  });
});
