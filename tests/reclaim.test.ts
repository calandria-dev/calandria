// Landed → reclaimed (lib/reclaim.ts).
//
// The cases here are the ones that decide whether this feature is usable at
// all. The safety gate reads worktreePruneSafety() DIFFERENTLY per landing, and
// getting that wrong fails in one of two total ways: gate on `ahead` for a PR
// and every squash-merged branch is refused forever (the feature never fires),
// or drop it for a local merge and post-merge commits are deleted silently.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET, POST } from "../app/api/tasks/[id]/reclaim/route";
import { ensureWorktree } from "../lib/git";
import { getDb } from "../lib/db";
import { landedVia, maybeAutoReclaim, reclaimPreview, reclaimTask } from "../lib/reclaim";
import { createProject, createTask, getTask, updateProject, updateTask } from "../lib/store";
import type { Task } from "../lib/types";
import { commitFile, git, makeRepo, makeRepoWithOrigin, pushFromColleague, writeFile } from "./helpers";

/**
 * A project clone with a real `origin`, one task on its own worktree carrying
 * one commit, and that branch pushed — the shape a task is in the moment its PR
 * is opened. `land` then plays GitHub's part: a SEPARATE commit on origin/main,
 * which is what a squash merge leaves behind and why the task branch stays
 * permanently "ahead" of its base afterwards.
 */
async function taskAwaitingItsPr(opts: { autoReclaim?: boolean } = {}) {
  const { repo, colleague } = await makeRepoWithOrigin();
  const project = createProject({ name: `reclaim-${Math.random()}`, repo_path: repo, branch: "main" });
  if (opts.autoReclaim) updateProject(project.id, { auto_reclaim: 1 });
  const task = createTask({ project_id: project.id, title: "a landed task" });
  const wt = await ensureWorktree(repo, task.id, "main");
  if (!wt) throw new Error("worktree fixture failed");
  await commitFile(wt.path, "feature.txt", "the work\n", "feat: the work");
  await git(wt.path, "push", "-u", "origin", wt.branch);
  updateTask(task.id, {
    status: "in_progress",
    started: 1,
    worktree_path: wt.path,
    work_branch: wt.branch,
    base_sha: wt.baseSha,
  });
  const land = () => pushFromColleague(colleague, "feature.txt", "the work\n", "main");
  return { repo, colleague, project, task, wt, land };
}

/** Mark the PR merged the way lib/prState.ts's refresh does. */
const prMerged = (id: string) =>
  updateTask(id, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7, pr_state: "merged", pr_merged_at: Date.now() });

const req = (id: string, body?: object) =>
  new Request(`http://test/api/tasks/${id}/reclaim`, {
    method: body ? "POST" : "GET",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const branchExists = async (repo: string, branch: string) =>
  git(repo, "rev-parse", "--verify", `refs/heads/${branch}`).then(() => true).catch(() => false);

describe("landedVia", () => {
  it("prefers GitHub's verdict when both are true", () => {
    const t = { pr_state: "merged", merged_at: 123 } as Task;
    expect(landedVia(t)).toBe("pr");
    expect(landedVia({ pr_state: "", merged_at: 123 } as Task)).toBe("merge");
    expect(landedVia({ pr_state: "open", merged_at: 0 } as Task)).toBeNull();
  });
});

describe("reclaiming a task whose PR has merged", () => {
  it("fast-forwards the base, removes the worktree, deletes the local branch and marks it done", async () => {
    const { repo, task, wt, land } = await taskAwaitingItsPr();
    const landedSha = await land();
    prMerged(task.id);

    const res = await reclaimTask(task.id);

    expect(res).toMatchObject({ ok: true, landing: "pr", baseAdvanced: true, worktreeRemoved: true, branchDeleted: true });
    // 1. the local base branch actually contains what landed
    expect(await git(repo, "rev-parse", "main")).toBe(landedSha);
    // 2. the checkout is gone from disk
    expect(fs.existsSync(wt.path)).toBe(false);
    // 3. the LOCAL branch is gone; the remote one is GitHub's to delete
    expect(await branchExists(repo, wt.branch)).toBe(false);
    // 4. the task is done, and points at nothing
    expect(getTask(task.id)).toMatchObject({ status: "done", worktree_path: "", work_branch: "", base_sha: "" });
  });

  it("is not refused for the `ahead` a squash merge always leaves behind", async () => {
    const { repo, task, wt, land } = await taskAwaitingItsPr();
    await land();
    prMerged(task.id);

    // The premise: git still says the branch holds a commit the base doesn't,
    // because a squash landed a DIFFERENT commit with the same content. Gating
    // on that count would refuse every merged PR there is.
    expect(parseInt(await git(repo, "rev-list", "--count", `main..${wt.branch}`), 10)).toBeGreaterThan(0);

    const preview = await reclaimPreview(task.id);
    expect(preview).toMatchObject({ landing: "pr", unsafe: false });
    expect((await reclaimTask(task.id)).ok).toBe(true);
  });

  it("refuses when the branch holds commits the remote never saw", async () => {
    const { task, wt, land } = await taskAwaitingItsPr();
    await land();
    // Made after the PR was opened and never pushed: whatever GitHub merged, it
    // was not this.
    await commitFile(wt.path, "afterthought.txt", "later\n", "chore: after the PR");
    prMerged(task.id);

    const res = await reclaimTask(task.id);
    expect(res.ok).toBe(false);
    expect(res.unsafe).toBe(true);
    expect(res.reason).toMatch(/never pushed/);
    expect(fs.existsSync(wt.path)).toBe(true);

    // ...and the acknowledgement gets past it, which is the whole point of the
    // refusal being an offer rather than a wall.
    expect((await reclaimTask(task.id, { discardUnsafe: true })).ok).toBe(true);
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it("refuses over uncommitted edits, in the words a refused move uses", async () => {
    const { task, wt, land } = await taskAwaitingItsPr();
    await land();
    prMerged(task.id);
    writeFile(wt.path, "scratch.txt", "half a thought\n");

    const res = await reclaimTask(task.id);
    expect(res.ok).toBe(false);
    expect(res.unsafe).toBe(true);
    expect(res.reason).toMatch(/the worktree has unsaved work/);
    expect(fs.existsSync(path.join(wt.path, "scratch.txt"))).toBe(true);
  });
});

describe("reclaiming a task merged locally", () => {
  it("refuses over commits made after the merge", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: `local-${Math.random()}`, repo_path: repo, branch: "main" });
    const task = createTask({ project_id: project.id, title: "merged locally" });
    const wt = await ensureWorktree(repo, task.id, "main");
    if (!wt) throw new Error("worktree fixture failed");
    await commitFile(wt.path, "after.txt", "kept going\n", "feat: after the merge");
    updateTask(task.id, {
      status: "in_progress", started: 1, worktree_path: wt.path, work_branch: wt.branch,
      base_sha: wt.baseSha, merged_at: Date.now(),
    });

    // No PR, so `ahead` means exactly what it says: work the base branch has
    // not absorbed. The PR reading must not leak into this landing.
    const res = await reclaimTask(task.id);
    expect(res).toMatchObject({ ok: false, unsafe: true, landing: "merge" });
    expect(res.reason).toMatch(/not yet in main/);
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it("reclaims once the merge really has absorbed everything", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: `local-ok-${Math.random()}`, repo_path: repo, branch: "main" });
    const task = createTask({ project_id: project.id, title: "merged locally" });
    const wt = await ensureWorktree(repo, task.id, "main");
    if (!wt) throw new Error("worktree fixture failed");
    await commitFile(wt.path, "landed.txt", "in main\n", "feat: landed");
    await git(repo, "merge", "--no-ff", "-m", "merge the task", wt.branch);
    updateTask(task.id, {
      status: "in_progress", started: 1, worktree_path: wt.path, work_branch: wt.branch,
      base_sha: wt.baseSha, merged_at: Date.now(),
    });

    // No remote at all: catching the base up is best-effort and its absence
    // must never stop a checkout being reclaimed.
    const res = await reclaimTask(task.id);
    expect(res).toMatchObject({ ok: true, landing: "merge", baseAdvanced: false });
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(await branchExists(repo, wt.branch)).toBe(false);
  });
});

describe("reclaim refusals that aren't about safety", () => {
  it("refuses a task that hasn't landed", async () => {
    const { task, wt } = await taskAwaitingItsPr();
    const res = await reclaimTask(task.id);
    expect(res.ok).toBe(false);
    expect(res.unsafe).toBeUndefined();
    expect(res.reason).toMatch(/hasn't landed/);
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it("refuses a task with a turn running", async () => {
    const { task, land } = await taskAwaitingItsPr();
    await land();
    prMerged(task.id);
    updateTask(task.id, { running: 1 });
    expect((await reclaimTask(task.id)).reason).toMatch(/a turn is running/);
  });
});

describe("an automatic reclaim doesn't float an old task to the top of Done", () => {
  it("clears the worktree columns without stamping updated_at", async () => {
    const { task, land } = await taskAwaitingItsPr({ autoReclaim: true });
    await land();
    prMerged(task.id);
    // Already terminal, and cold: the case the sweep's clearTaskWorktreePath
    // exists for. A reclaim nobody asked for must leave the board's sort key
    // (and retention's clock) exactly where it was.
    updateTask(task.id, { status: "done" });
    getDb().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(1000, task.id);

    const res = await reclaimTask(task.id);
    expect(res.ok).toBe(true);
    expect(res.markedDone).toBeUndefined();
    expect(getTask(task.id)).toMatchObject({ worktree_path: "", work_branch: "", updated_at: 1000 });
  });

  it("does stamp when the reclaim is what moved the task to done", async () => {
    const { task, land } = await taskAwaitingItsPr();
    await land();
    prMerged(task.id);
    getDb().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(1000, task.id);

    expect((await reclaimTask(task.id)).markedDone).toBe(true);
    // A live task becoming done IS something that happened, and Done's top is
    // where it belongs.
    expect(getTask(task.id)!.updated_at).toBeGreaterThan(1000);
  });
});

describe("maybeAutoReclaim", () => {
  it("does nothing unless the project opted in", async () => {
    const { task, wt, land } = await taskAwaitingItsPr();
    await land();
    prMerged(task.id);

    maybeAutoReclaim(task.id);
    await new Promise((r) => setTimeout(r, 150));
    expect(fs.existsSync(wt.path)).toBe(true);
    expect(getTask(task.id)!.worktree_path).not.toBe("");
  });

  it("runs the whole tail when it did", async () => {
    const { task, wt, land } = await taskAwaitingItsPr({ autoReclaim: true });
    await land();
    prMerged(task.id);

    maybeAutoReclaim(task.id);
    // Fire-and-forget by contract (a merge route must not hold a request open
    // across a fetch of origin), so this waits on the effect rather than a
    // promise the caller never sees. Waiting on the STATUS specifically: the
    // directory disappears mid-teardown, before the row is written, so watching
    // the disk races the two DB writes that follow it.
    for (let i = 0; i < 100 && getTask(task.id)!.status !== "done"; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(getTask(task.id)).toMatchObject({ status: "done", worktree_path: "", work_branch: "" });
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it("never forces past the safety gate, because nobody is there to acknowledge", async () => {
    const { task, wt, land } = await taskAwaitingItsPr({ autoReclaim: true });
    await land();
    prMerged(task.id);
    writeFile(wt.path, "scratch.txt", "half a thought\n");

    maybeAutoReclaim(task.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(wt.path)).toBe(true);
  });
});

describe("POST/GET /api/tasks/:id/reclaim", () => {
  it("prices the reclaim, then performs it", async () => {
    const { task, wt, land } = await taskAwaitingItsPr();
    await land();
    prMerged(task.id);

    const preview = await (await GET(req(task.id), params(task.id))).json();
    expect(preview).toMatchObject({ landing: "pr", hasWorktree: true, unsafe: false, running: false });
    expect(preview.bytes).toBeGreaterThan(0);

    const res = await POST(req(task.id, {}), params(task.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it("answers a safety refusal as a 409 the client can read", async () => {
    const { task, wt, land } = await taskAwaitingItsPr();
    await land();
    prMerged(task.id);
    writeFile(wt.path, "scratch.txt", "half a thought\n");

    const res = await POST(req(task.id, {}), params(task.id));
    expect(res.status).toBe(409);
    const body = await res.json();
    // `error` is the key every client fetch helper unwraps; `unsafe` is what
    // tells the button to offer the acknowledgement rather than give up.
    expect(body.unsafe).toBe(true);
    expect(body.error).toBe(body.reason);
    expect(body.error).toMatch(/unsaved work/);

    const forced = await POST(req(task.id, { discardUnsafe: true }), params(task.id));
    expect(forced.status).toBe(200);
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it("404s an unknown task", async () => {
    expect((await POST(req("nope", {}), params("nope"))).status).toBe(404);
    expect((await GET(req("nope"), params("nope"))).status).toBe(404);
  });
});

// A base branch that has no ref in this repository — a task pinned to a branch
// since deleted locally, or a project pointed at one that only ever existed on
// the remote. worktreePruneSafety used to answer that with `ahead: 0`, which
// reads as "nothing unlanded, safe to prune" while it authorises deleting the
// checkout AND its branch; catchUpBase saw the matching all-zero remote status
// and reported nothing to do.
describe("reclaiming against a base branch with no local ref", () => {
  it("refuses a local-merge landing rather than reading the unknown count as zero", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: `base-gone-${Math.random()}`, repo_path: repo, branch: "main" });
    const task = createTask({ project_id: project.id, title: "based on a branch that's gone" });
    const wt = await ensureWorktree(repo, task.id, "main");
    if (!wt) throw new Error("worktree fixture failed");
    await commitFile(wt.path, "landed.txt", "in main\n", "feat: landed");
    await git(repo, "merge", "--no-ff", "-m", "merge the task", wt.branch);
    updateTask(task.id, {
      status: "in_progress", started: 1, worktree_path: wt.path, work_branch: wt.branch,
      base_sha: wt.baseSha, merged_at: Date.now(), base_branch: "gone",
    });

    const res = await reclaimTask(task.id);

    expect(res).toMatchObject({ ok: false, unsafe: true, landing: "merge" });
    expect(res.reason).toContain("gone");
    // Nothing was destroyed on the way to the refusal.
    expect(fs.existsSync(wt.path)).toBe(true);
    expect(await branchExists(repo, wt.branch)).toBe(true);

    // And the acknowledgement still gets through, the way it does for any other
    // unsafe reclaim.
    expect(await reclaimTask(task.id, { discardUnsafe: true })).toMatchObject({ ok: true });
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it("says why the base couldn't be caught up instead of silently advancing nothing", async () => {
    const { repo, task, wt, land } = await taskAwaitingItsPr();
    await land();
    prMerged(task.id);
    updateTask(task.id, { base_branch: "gone" });

    const res = await reclaimTask(task.id);

    // A PR landing never trusted the ahead count (a squash leaves every landed
    // branch permanently ahead) and asks unpushedCommits instead — a question
    // about the REMOTE, which the missing local base doesn't touch. So the
    // reclaim still runs, and the base failure is reported rather than hidden.
    expect(res).toMatchObject({ ok: true, landing: "pr", baseAdvanced: false, worktreeRemoved: true });
    expect(res.baseError).toContain("gone");
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(await branchExists(repo, wt.branch)).toBe(false);
  });
});
