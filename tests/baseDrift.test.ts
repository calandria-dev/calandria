// The base-drift note: branchDriftStatus (lib/git.ts) is the read-only local
// comparison, lib/baseDrift.ts turns it into a note recorded at worktree-cut
// time and consumed once by buildProjectContext (lib/agents/shared.ts).
import { describe, expect, it } from "vitest";
import { createProject, createTask, getProject, getTask, updateTask } from "@/lib/store";
import { buildProjectContext } from "@/lib/agents/shared";
import { branchDriftStatus } from "@/lib/git";
import { recordBaseCut, takeBaseCutNote, missingBaseLine, staleBaseLine } from "@/lib/baseDrift";
import { git, commitFile, makeRepo, tmpDir } from "./helpers";

/** Branch `name` at the current tip (usually main), leaving it there. */
async function forkBranch(repo: string, name: string): Promise<void> {
  await git(repo, "branch", name);
}

describe("branchDriftStatus", () => {
  it("a branch forked from main and left there, while main gains N commits, reports behind: N", async () => {
    const repo = await makeRepo();
    await forkBranch(repo, "feature");
    await commitFile(repo, "a.txt", "a", "main commit 1");
    await commitFile(repo, "b.txt", "b", "main commit 2");
    await commitFile(repo, "c.txt", "c", "main commit 3");

    const drift = await branchDriftStatus(repo, "feature", "main");
    expect(drift).toEqual({ exists: true, ahead: 0, behind: 3, diverged: false, unknown: false });
  });

  it("a branch with its own commits while main also moves ahead reports both counts and diverged: true", async () => {
    const repo = await makeRepo();
    await git(repo, "checkout", "-b", "feature");
    await commitFile(repo, "own.txt", "own work", "feature's own commit");
    await git(repo, "checkout", "main");
    await commitFile(repo, "m1.txt", "m1", "main commit 1");
    await commitFile(repo, "m2.txt", "m2", "main commit 2");

    const drift = await branchDriftStatus(repo, "feature", "main");
    expect(drift.exists).toBe(true);
    expect(drift.ahead).toBe(1);
    expect(drift.behind).toBe(2);
    expect(drift.diverged).toBe(true);
    expect(drift.unknown).toBe(false);
  });

  it("a branch name that does not exist reports exists: false, not unknown: true", async () => {
    const repo = await makeRepo();
    const drift = await branchDriftStatus(repo, "no-such-branch", "main");
    expect(drift.exists).toBe(false);
    expect(drift.unknown).toBe(false);
    expect(drift.ahead).toBe(0);
    expect(drift.behind).toBe(0);
  });

  it("a branch whose tip equals `against` reports exists: true with zero counts", async () => {
    const repo = await makeRepo();
    await forkBranch(repo, "same");
    const drift = await branchDriftStatus(repo, "same", "main");
    expect(drift).toEqual({ exists: true, ahead: 0, behind: 0, diverged: false, unknown: false });
  });

  it("an `against` that does not exist reports unknown: true even though the branch itself resolves", async () => {
    const repo = await makeRepo();
    const drift = await branchDriftStatus(repo, "main", "no-such-target");
    expect(drift.exists).toBe(true);
    expect(drift.unknown).toBe(true);
  });
});

describe("recordBaseCut / takeBaseCutNote", () => {
  it("a cut from a branch behind the project default leaves a note naming the branch, the behind count and the default, and mentioning Sync", async () => {
    const repo = await makeRepo();
    await forkBranch(repo, "core-fixes");
    await commitFile(repo, "a.txt", "a", "main commit 1");
    await commitFile(repo, "b.txt", "b", "main commit 2");

    const project = createProject({ name: "bd-stale", branch: "main" });
    const task = createTask({ project_id: project.id, title: "Do a thing" });

    await recordBaseCut({
      taskId: task.id,
      repoPath: repo,
      requestedBase: "core-fixes",
      cutBase: "core-fixes",
      projectDefault: "main",
    });

    const note = takeBaseCutNote(task.id);
    expect(note).toContain("core-fixes");
    expect(note).toContain("2 commits");
    expect(note).toContain("main");
    expect(note).toContain("Sync");
    expect(note).toBe(staleBaseLine("core-fixes", "main", 2, 0));
  });

  it("a cut from the project default itself leaves no note", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: "bd-default", branch: "main" });
    const task = createTask({ project_id: project.id, title: "Do a thing" });

    await recordBaseCut({
      taskId: task.id,
      repoPath: repo,
      requestedBase: "main",
      cutBase: "main",
      projectDefault: "main",
    });

    expect(takeBaseCutNote(task.id)).toBe("");
  });

  it("a requested base that did not exist leaves the missing-base note naming the requested branch, not a staleness claim", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: "bd-missing", branch: "main" });
    const task = createTask({ project_id: project.id, title: "Do a thing" });

    await recordBaseCut({
      taskId: task.id,
      repoPath: repo,
      requestedBase: "long-gone",
      cutBase: "", // ensureWorktree's signal that it fell back to HEAD
      projectDefault: "main",
    });

    const note = takeBaseCutNote(task.id);
    expect(note).toContain("long-gone");
    expect(note).toMatch(/no such branch.*exists/i);
    expect(note).not.toContain("Stale base branch");
    expect(note).toBe(missingBaseLine("long-gone", "main"));
  });

  it("a base branch that is up to date with the default leaves no note", async () => {
    const repo = await makeRepo();
    await forkBranch(repo, "caught-up"); // same tip as main, no drift either way
    const project = createProject({ name: "bd-uptodate", branch: "main" });
    const task = createTask({ project_id: project.id, title: "Do a thing" });

    await recordBaseCut({
      taskId: task.id,
      repoPath: repo,
      requestedBase: "caught-up",
      cutBase: "caught-up",
      projectDefault: "main",
    });

    expect(takeBaseCutNote(task.id)).toBe("");
  });

  it("a base branch that is only ahead of the default (never behind) leaves no note", async () => {
    const repo = await makeRepo();
    await git(repo, "checkout", "-b", "ahead-only");
    await commitFile(repo, "own.txt", "own work", "ahead-only's own commit");
    await git(repo, "checkout", "main"); // main never moves again, so behind stays 0

    const project = createProject({ name: "bd-aheadonly", branch: "main" });
    const task = createTask({ project_id: project.id, title: "Do a thing" });

    await recordBaseCut({
      taskId: task.id,
      repoPath: repo,
      requestedBase: "ahead-only",
      cutBase: "ahead-only",
      projectDefault: "main",
    });

    expect(takeBaseCutNote(task.id)).toBe("");
  });

  it("the note is consumed: a second take for the same task returns empty", async () => {
    const repo = await makeRepo();
    await forkBranch(repo, "core-fixes");
    await commitFile(repo, "a.txt", "a", "main commit 1");

    const project = createProject({ name: "bd-consume", branch: "main" });
    const task = createTask({ project_id: project.id, title: "Do a thing" });

    await recordBaseCut({
      taskId: task.id,
      repoPath: repo,
      requestedBase: "core-fixes",
      cutBase: "core-fixes",
      projectDefault: "main",
    });

    expect(takeBaseCutNote(task.id)).not.toBe("");
    expect(takeBaseCutNote(task.id)).toBe("");
  });

  it("against a repo path that is not a git repo, leaves no note and does not throw", async () => {
    const notARepo = tmpDir("not-a-repo-");
    const project = createProject({ name: "bd-broken", branch: "main" });
    const task = createTask({ project_id: project.id, title: "Do a thing" });

    await expect(
      recordBaseCut({
        taskId: task.id,
        repoPath: notARepo,
        requestedBase: "core-fixes",
        cutBase: "core-fixes",
        projectDefault: "main",
      })
    ).resolves.toBeUndefined();

    expect(takeBaseCutNote(task.id)).toBe("");
  });
});

describe("buildProjectContext + base-drift note", () => {
  it("after recordBaseCut records a stale-base note, buildProjectContext includes it right after the Base branch line", async () => {
    const repo = await makeRepo();
    await forkBranch(repo, "core-fixes");
    await commitFile(repo, "a.txt", "a", "main commit 1");
    await commitFile(repo, "b.txt", "b", "main commit 2");

    const project = createProject({ name: "bpc-stale", branch: "main" });
    const task = createTask({ project_id: project.id, title: "Do a thing" });
    updateTask(task.id, { base_branch: "core-fixes" });

    await recordBaseCut({
      taskId: task.id,
      repoPath: repo,
      requestedBase: "core-fixes",
      cutBase: "core-fixes",
      projectDefault: "main",
    });

    const ctx = buildProjectContext(getProject(project.id)!, getTask(task.id)!);
    expect(ctx).toContain("Stale base branch");
    const baseLineIdx = ctx.indexOf("Base branch: core-fixes");
    const noteIdx = ctx.indexOf("Stale base branch");
    expect(baseLineIdx).toBeGreaterThanOrEqual(0);
    expect(noteIdx).toBeGreaterThan(baseLineIdx);
  });

  it("calling buildProjectContext a second time for the same task does not repeat the note", async () => {
    const repo = await makeRepo();
    await forkBranch(repo, "core-fixes");
    await commitFile(repo, "a.txt", "a", "main commit 1");

    const project = createProject({ name: "bpc-onceonly", branch: "main" });
    const task = createTask({ project_id: project.id, title: "Do a thing" });
    updateTask(task.id, { base_branch: "core-fixes" });

    await recordBaseCut({
      taskId: task.id,
      repoPath: repo,
      requestedBase: "core-fixes",
      cutBase: "core-fixes",
      projectDefault: "main",
    });

    const first = buildProjectContext(getProject(project.id)!, getTask(task.id)!);
    expect(first).toContain("Stale base branch");

    const second = buildProjectContext(getProject(project.id)!, getTask(task.id)!);
    expect(second).not.toContain("Stale base branch");
  });

  it("an ordinary task with no recorded note gets no such line at all", () => {
    const project = createProject({ name: "bpc-ordinary", branch: "main" });
    const task = createTask({ project_id: project.id, title: "Do a thing" });

    const ctx = buildProjectContext(getProject(project.id)!, getTask(task.id)!);
    expect(ctx).not.toContain("⚠");
    expect(ctx).not.toContain("Stale base branch");
  });
});
