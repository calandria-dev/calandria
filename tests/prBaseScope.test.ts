import { describe, expect, it } from "vitest";
import { ensureWorktree, taskPrScopeError } from "@/lib/git";
import { commitFile, git, makeRepoWithOrigin, pushFromColleague, uid } from "./helpers";

async function scope(worktreePath: string, baseSha: string, prBaseBranch?: string) {
  return taskPrScopeError({ worktreePath, baseSha, baseBranch: "main", prBaseBranch });
}

describe("PR base scope", () => {
  it("refuses unpublished inherited commits without moving local or sibling branches", async () => {
    const { repo, origin, colleague } = await makeRepoWithOrigin();
    await pushFromColleague(colleague, "remote.txt", "remote\n");
    await commitFile(repo, "local.txt", "local\n");
    const wt = (await ensureWorktree(repo, uid(), "main"))!;
    await commitFile(wt.path, "task.txt", "task\n");
    await git(repo, "branch", "sibling", "main");
    const before = await git(repo, "show-ref", "--heads");
    const remoteBefore = await git(origin, "show-ref", "--heads");
    expect(await scope(wt.path, wt.baseSha)).toMatch(/origin\/main.*1 inherited base commit/);
    expect(await git(repo, "show-ref", "--heads")).toBe(before);
    expect(await git(origin, "show-ref", "--heads")).toBe(remoteBefore);
  });

  it("accepts an unchanged base and a task cut from a newer remote", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    const first = (await ensureWorktree(repo, uid(), "main"))!;
    expect(await scope(first.path, first.baseSha)).toBeNull();
    await pushFromColleague(colleague, "remote.txt", "remote\n");
    const second = (await ensureWorktree(repo, uid(), "main"))!;
    expect(await scope(second.path, second.baseSha)).toBeNull();
  });

  it("fetches fresh origin even when its tracking ref is stale or rewound", async () => {
    const { repo, origin } = await makeRepoWithOrigin();
    const original = await git(repo, "rev-parse", "main");
    const inherited = await commitFile(repo, "local.txt", "local\n");
    const wt = (await ensureWorktree(repo, uid(), "main"))!;
    await git(repo, "push", "origin", "main");
    await git(repo, "update-ref", "refs/remotes/origin/main", original);
    expect(await scope(wt.path, wt.baseSha)).toBeNull();
    await git(origin, "update-ref", "refs/heads/main", original);
    expect(await scope(wt.path, wt.baseSha)).toMatch(/1 inherited base commit/);
    expect(await git(repo, "rev-parse", "refs/heads/main")).toBe(inherited);
  });

  it("accepts a task rebuilt onto origin even with its old cut recorded", async () => {
    const { repo } = await makeRepoWithOrigin();
    await commitFile(repo, "local.txt", "local\n");
    const wt = (await ensureWorktree(repo, uid(), "main"))!;
    await commitFile(wt.path, "task.txt", "task\n");
    await git(wt.path, "rebase", "--onto", "origin/main", wt.baseSha);
    expect(await scope(wt.path, wt.baseSha)).toBeNull();
  });

  it("checks origin and the actual PR base even when upstream differs", async () => {
    const { repo } = await makeRepoWithOrigin();
    await git(repo, "branch", "release", "main");
    await git(repo, "push", "origin", "release");
    await commitFile(repo, "local.txt", "local\n");
    await git(repo, "remote", "add", "upstream", repo);
    await git(repo, "config", "branch.main.remote", "upstream");
    const wt = (await ensureWorktree(repo, uid(), "main"))!;
    expect(await scope(wt.path, wt.baseSha, "release")).toMatch(/origin\/release.*1 inherited base commit/);
  });

  it("fails closed when the PR target cannot be fetched", async () => {
    const { repo } = await makeRepoWithOrigin();
    const wt = (await ensureWorktree(repo, uid(), "main"))!;
    expect(await scope(wt.path, wt.baseSha, "missing")).toMatch(/Could not verify PR scope/);
  });

  it("refuses a local base merged into the task after its cut", async () => {
    const { repo } = await makeRepoWithOrigin();
    const wt = (await ensureWorktree(repo, uid(), "main"))!;
    await commitFile(repo, "local.txt", "local\n");
    await git(wt.path, "merge", "--no-edit", "main");
    expect(await scope(wt.path, wt.baseSha)).toMatch(/1 inherited base commit/);
  });

  it("refuses another branch or detached HEAD without moving branches", async () => {
    const { repo } = await makeRepoWithOrigin();
    const wt = (await ensureWorktree(repo, uid(), "main"))!;
    await git(wt.path, "checkout", "-b", "other");
    const before = await git(repo, "show-ref", "--heads");
    const input = { worktreePath: wt.path, baseSha: wt.baseSha, baseBranch: "main", workBranch: wt.branch };
    expect(await taskPrScopeError(input)).toMatch(/checkout is not on task branch/);
    await git(wt.path, "checkout", "--detach");
    expect(await taskPrScopeError(input)).toMatch(/checkout is not on task branch/);
    expect(await git(repo, "show-ref", "--heads")).toBe(before);
  });
});
