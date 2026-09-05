// A tag's base branch can drift from the project default, and Sync closes it
// (docs/FEATURES.md). `syncBranchFrom` is the git half, the route wires it to
// a tag row, and `driftLine` is the pure judgement the strip renders.
// `branchDriftStatus` itself is covered by tests/baseDrift.test.ts; what is
// pinned here is that these callers measure the default at `baseStartPoint`,
// not at a possibly-stale local ref.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET, POST } from "../app/api/tags/[id]/sync/route";
import { driftLine } from "../app/shell/TagStrip";
import { branchDriftStatus, createBranchAt, syncBranchFrom } from "../lib/git";
import { createProject, createTag } from "../lib/store";
import { commitFile, git, makeRepo, makeRepoWithOrigin, pushFromColleague, uid, writeFile } from "./helpers";

describe("syncBranchFrom", () => {
  it("fast-forwards a branch with nothing of its own, nobody holding it", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "integration");
    await commitFile(repo, "a.txt", "1\n", "a");
    await commitFile(repo, "b.txt", "2\n", "b");
    const res = await syncBranchFrom({ repoPath: repo, branch: "integration", from: "main" });
    expect(res).toMatchObject({ ok: true, fastForwarded: true, behind: 2 });
    expect(await git(repo, "rev-parse", "integration")).toBe(await git(repo, "rev-parse", "main"));
    expect((await branchDriftStatus(repo, "integration", "main")).behind).toBe(0);
  });

  it("merges non-conflicting divergence in without moving main, nobody holding the branch", async () => {
    const repo = await makeRepo();
    await git(repo, "checkout", "-b", "integration");
    await commitFile(repo, "int.txt", "int\n", "integration work");
    await git(repo, "checkout", "main");
    await commitFile(repo, "main.txt", "main\n", "main work");
    const mainBefore = await git(repo, "rev-parse", "main");

    const res = await syncBranchFrom({ repoPath: repo, branch: "integration", from: "main" });
    expect(res.ok).toBe(true);
    expect(res.fastForwarded).toBeFalsy();
    const files = await git(repo, "ls-tree", "-r", "--name-only", "integration");
    expect(files).toContain("int.txt");
    expect(files).toContain("main.txt");
    expect(await git(repo, "rev-parse", "main")).toBe(mainBefore);
  });

  it("refuses on a real conflict, naming the file, and leaves the branch tip unchanged", async () => {
    const repo = await makeRepo();
    await git(repo, "checkout", "-b", "integration");
    await commitFile(repo, "file.txt", "integration version\n", "integration edit");
    await git(repo, "checkout", "main");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    const tipBefore = await git(repo, "rev-parse", "integration");

    const res = await syncBranchFrom({ repoPath: repo, branch: "integration", from: "main" });
    expect(res.ok).toBe(false);
    expect(res.conflicts).toContain("file.txt");
    expect(await git(repo, "rev-parse", "integration")).toBe(tipBefore);
  });

  // The stale-clone case: origin/main has moved but the clone's local main has
  // not, and a task cut now would start at the remote tip. Syncing to the local
  // ref would report the tag fixed while new worktrees kept starting stale.
  it("syncs to the remote tip when the local default is merely behind it", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await git(repo, "branch", "integration");
    // The colleague's sha, not `origin/main` in the clone: that tracking ref
    // stays at the old tip until sync's own fetch moves it.
    const remoteTip = await pushFromColleague(colleague, "f.txt", "x");

    const res = await syncBranchFrom({ repoPath: repo, branch: "integration", from: "main" });
    expect(res).toMatchObject({ ok: true, behind: 1 });
    expect(await git(repo, "rev-parse", "integration")).toBe(remoteTip);
    expect((await branchDriftStatus(repo, "integration", remoteTip)).behind).toBe(0);
  });

  it("reports alreadyCurrent when there is nothing to bring over", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "integration");
    const res = await syncBranchFrom({ repoPath: repo, branch: "integration", from: "main" });
    expect(res).toMatchObject({ ok: true, alreadyCurrent: true, behind: 0 });
  });

  it("refuses when the branch does not exist, naming it", async () => {
    const repo = await makeRepo();
    const res = await syncBranchFrom({ repoPath: repo, branch: "nope", from: "main" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nope");
  });

  // `git worktree add` refuses an existing target directory, so the test
  // builds the path directly under the tmp root, skipping tmpDir(), which
  // pre-creates it.
  it("refuses when the branch's worktree has uncommitted changes, naming the path", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "integration");
    await commitFile(repo, "main.txt", "x\n", "main work"); // gives sync something to bring over
    const wtPath = path.join(process.env.CALANDRIA_TEST_TMP!, "wt-" + uid());
    await git(repo, "worktree", "add", wtPath, "integration");
    writeFile(wtPath, "scratch.txt", "unsaved\n");
    const tipBefore = await git(repo, "rev-parse", "integration");

    const res = await syncBranchFrom({ repoPath: repo, branch: "integration", from: "main" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("uncommitted changes");
    expect(res.error).toContain(wtPath);
    expect(await git(repo, "rev-parse", "integration")).toBe(tipBefore);
  });

  it("succeeds when the branch's worktree is clean, and the worktree moves with it", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "integration");
    await commitFile(repo, "main.txt", "x\n", "main work");
    const wtPath = path.join(process.env.CALANDRIA_TEST_TMP!, "wt-" + uid());
    await git(repo, "worktree", "add", wtPath, "integration");

    const res = await syncBranchFrom({ repoPath: repo, branch: "integration", from: "main" });
    expect(res.ok).toBe(true);
    const newTip = await git(repo, "rev-parse", "integration");
    expect(await git(wtPath, "rev-parse", "HEAD")).toBe(newTip);
  });
});

describe("GET/POST /api/tags/[id]/sync", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const get = (id: string) => GET(new Request("http://t/"), params(id));
  const post = (id: string) => POST(new Request("http://t/", { method: "POST" }), params(id));
  const create = (id: string) =>
    POST(new Request("http://t/", { method: "POST", body: JSON.stringify({ action: "create" }) }), params(id));

  it("GET answers inherited, no git touched, for a tag with no base of its own", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: `sync-${uid()}`, repo_path: repo, branch: "main" });
    const tag = createTag({ project_id: project.id, name: "T" });
    const res = await get(tag.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inherited: true });
  });

  it("GET answers sameAsProject when the tag's base is the project default", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: `sync-${uid()}`, repo_path: repo, branch: "main" });
    const tag = createTag({ project_id: project.id, name: "T", base_branch: "main" });
    const res = await get(tag.id);
    expect(await res.json()).toMatchObject({ sameAsProject: true });
  });

  it("GET reports drift for a tag pinned to a branch behind the project default", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "integration");
    await commitFile(repo, "a.txt", "1\n", "a");
    const project = createProject({ name: `sync-${uid()}`, repo_path: repo, branch: "main" });
    const tag = createTag({ project_id: project.id, name: "T", base_branch: "integration" });
    const body = await (await get(tag.id)).json();
    expect(body.behind).toBeGreaterThan(0);
  });

  it("POST refuses an inherited tag with 400", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: `sync-${uid()}`, repo_path: repo, branch: "main" });
    const tag = createTag({ project_id: project.id, name: "T" });
    expect((await post(tag.id)).status).toBe(400);
  });

  it("POST syncs a drifted tag's branch and reports ok", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "integration");
    await commitFile(repo, "a.txt", "1\n", "a");
    const project = createProject({ name: `sync-${uid()}`, repo_path: repo, branch: "main" });
    const tag = createTag({ project_id: project.id, name: "T", base_branch: "integration" });

    const res = await post(tag.id);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(await git(repo, "rev-parse", "integration")).toBe(await git(repo, "rev-parse", "main"));
  });

  it("GET 404s on an unknown tag id", async () => {
    expect((await get("no-such-tag")).status).toBe(404);
  });

  // A base branch nothing has created reports exists: false, distinct from
  // deleted, so creating it stays on offer.
  it("GET reports exists: false for a base branch nothing has created", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: `sync-${uid()}`, repo_path: repo, branch: "main" });
    const tag = createTag({ project_id: project.id, name: "T", base_branch: "litellm-support" });
    const body = await (await get(tag.id)).json();
    expect(body).toMatchObject({ exists: false, againstExists: true, branch: "litellm-support" });
  });

  it("POST create cuts the missing branch at the project default's tip, and GET then reads up to date", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: `sync-${uid()}`, repo_path: repo, branch: "main" });
    const tag = createTag({ project_id: project.id, name: "T", base_branch: "litellm-support" });

    const res = await create(tag.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: true, branch: "litellm-support", from: "main" });
    expect(await git(repo, "rev-parse", "litellm-support")).toBe(await git(repo, "rev-parse", "main"));
    // No upstream: a bare push from a task cut off it must not target main.
    await expect(git(repo, "rev-parse", "--abbrev-ref", "litellm-support@{upstream}")).rejects.toThrow();
    expect(await (await get(tag.id)).json()).toMatchObject({ exists: true, behind: 0 });
  });

  it("POST create starts the branch at the fetched remote tip when the local default is behind", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    const remoteTip = await pushFromColleague(colleague, "f.txt", "x");
    const project = createProject({ name: `sync-${uid()}`, repo_path: repo, branch: "main" });
    const tag = createTag({ project_id: project.id, name: "T", base_branch: "integration" });

    expect((await create(tag.id)).status).toBe(200);
    expect(await git(repo, "rev-parse", "integration")).toBe(remoteTip);
  });

  it("POST create refuses with 409 when the branch already exists", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "integration");
    const project = createProject({ name: `sync-${uid()}`, repo_path: repo, branch: "main" });
    const tag = createTag({ project_id: project.id, name: "T", base_branch: "integration" });
    const res = await create(tag.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already exists");
  });

  // A colleague's pushed integration branch has no local ref until something
  // asks for one; the reading must match the cut `ensureWorktree` would make.
  it("GET counts a branch that exists only on the remote as existing", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await git(colleague, "checkout", "-b", "integration");
    await git(colleague, "push", "-u", "origin", "integration");
    await git(colleague, "checkout", "main");
    const project = createProject({ name: `sync-${uid()}`, repo_path: repo, branch: "main" });
    const tag = createTag({ project_id: project.id, name: "T", base_branch: "integration" });
    const body = await (await get(tag.id)).json();
    expect(body).toMatchObject({ exists: true, behind: 0 });
    expect(await git(repo, "rev-parse", "--verify", "refs/heads/integration")).toBeTruthy();
  });
});

describe("createBranchAt", () => {
  it("creates the branch at the sha with no upstream", async () => {
    const repo = await makeRepo();
    const sha = await git(repo, "rev-parse", "main");
    expect(await createBranchAt(repo, "integration", sha)).toEqual({ ok: true, sha });
    expect(await git(repo, "rev-parse", "integration")).toBe(sha);
  });

  it("refuses an existing branch, an unsafe name and an empty start point, each named", async () => {
    const repo = await makeRepo();
    const sha = await git(repo, "rev-parse", "main");
    expect(await createBranchAt(repo, "main", sha)).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
    expect(await createBranchAt(repo, "-bad", sha)).toMatchObject({ ok: false, error: expect.stringContaining("-bad") });
    expect(await createBranchAt(repo, "integration", "")).toMatchObject({ ok: false, error: expect.stringContaining("integration") });
  });
});

describe("driftLine", () => {
  it("says nothing for a tag with no second branch to fall behind", () => {
    expect(driftLine({ inherited: true })).toBeNull();
    expect(driftLine({ sameAsProject: true })).toBeNull();
  });

  it("flags a missing base branch as bad, unsyncable and creatable, naming HEAD and saying yet", () => {
    const line = driftLine({ exists: false, branch: "x", against: "main", againstExists: true });
    expect(line).toMatchObject({ tone: "bad", syncable: false, creatable: true });
    expect(line!.text).toContain("HEAD");
    expect(line!.text).toContain("yet");
    expect(line!.text).not.toContain("no longer");
  });

  it("withholds Create when there is no project default to cut from", () => {
    const line = driftLine({ exists: false, branch: "x", against: "main", againstExists: false });
    expect(line).toMatchObject({ tone: "bad", creatable: false });
  });

  it("reports up to date as ok and not offering Sync", () => {
    const line = driftLine({ exists: true, againstExists: true, behind: 0 });
    expect(line).toMatchObject({ tone: "ok", syncable: false });
  });

  it("reports a behind count as warn and syncable", () => {
    const line = driftLine({ exists: true, againstExists: true, behind: 3, against: "main" });
    expect(line).toMatchObject({ text: "3 behind main", tone: "warn", syncable: true });
  });

  it("reports unknown ancestry as warn and not syncable", () => {
    const line = driftLine({ exists: true, againstExists: true, unknown: true });
    expect(line).toMatchObject({ tone: "warn", syncable: false });
  });
});
