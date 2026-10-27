import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { createTaskPr } from "@/lib/github";
import { git, commitFile, makeRepoWithOrigin, tmpDir, uid } from "./helpers";
import { IS_WIN } from "./platform";

// createTaskPr against a PR that is already open (lib/github.ts). The push
// updates its commits; `edit` decides whether `gh pr edit` also rewrites its
// title and body. gh is a stub script on PATH, so the argv it receives is
// what the assertions read. The git repo and the push are real. Windows is
// skipped for the same reason tests/prAdopt.test.ts is.
describe.skipIf(IS_WIN)("createTaskPr on an already-open PR", () => {
  const PR_URL = "https://github.com/o/r/pull/524";
  let shim = "";
  let originalPath = "";
  let originalGhRepo: string | undefined;

  function ghCalls(): string[] {
    const log = fs.readFileSync(process.env.GH_STUB_LOG!, "utf8").trim();
    return log ? log.split("\n") : [];
  }

  beforeEach(() => {
    shim = tmpDir("gh-shim-");
    process.env.GH_STUB_LOG = path.join(shim, "calls.log");
    process.env.GH_STUB_LIST = JSON.stringify([{ url: PR_URL, baseRefName: "main" }]);
    process.env.GH_STUB_EDIT_EXIT = "0";
    process.env.GH_STUB_LIST_EXIT = "0";
    originalGhRepo = process.env.GH_REPO;
    process.env.GH_REPO = "misleading/other";
    fs.writeFileSync(process.env.GH_STUB_LOG, "");
    fs.writeFileSync(
      path.join(shim, "gh"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$GH_STUB_LOG"',
        'case "$1 $2" in',
        '  "auth status") echo "Logged in to github.com account stub"; exit 0 ;;',
        '  "pr list") [ "$GH_STUB_LIST_EXIT" = 0 ] || { echo "list failed" >&2; exit 1; }; printf "%s" "$GH_STUB_LIST"; exit 0 ;;',
        '  "pr edit") [ "$GH_STUB_EDIT_EXIT" = 0 ] || echo "HTTP 403: no access" >&2; exit "$GH_STUB_EDIT_EXIT" ;;',
        '  "pr create") echo "https://github.com/o/r/pull/600"; exit 0 ;;',
        "esac",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
    originalPath = process.env.PATH || "";
    process.env.PATH = `${shim}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.GH_STUB_LOG;
    delete process.env.GH_STUB_LIST;
    delete process.env.GH_STUB_EDIT_EXIT;
    delete process.env.GH_STUB_LIST_EXIT;
    if (originalGhRepo === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = originalGhRepo;
  });

  async function branch() {
    const { repo } = await makeRepoWithOrigin();
    const workBranch = `calandria/${uid()}`;
    const baseSha = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "-b", workBranch);
    await commitFile(repo, "work.txt", "work\n", "work");
    return { worktreePath: repo, workBranch, baseBranch: "main", baseSha, title: "Task title", body: "Generated body" };
  }

  it("leaves the open PR's title and body alone when no edit is given", async () => {
    const result = await createTaskPr({ ...(await branch()), edit: {} });
    expect(result).toEqual({ ok: true, url: PR_URL, existing: true });
    expect(ghCalls().some((c) => c.startsWith("pr edit"))).toBe(false);
  });

  it("rewrites only the fields the caller gave", async () => {
    const input = await branch();
    const result = await createTaskPr({ ...input, edit: { body: "Closes #12. CI green." } });
    expect(result).toMatchObject({ ok: true, url: PR_URL, existing: true, edited: ["body"] });
    const edits = ghCalls().filter((c) => c.startsWith("pr edit"));
    expect(edits).toEqual([`pr edit ${PR_URL} --repo=${await git(input.worktreePath, "remote", "get-url", "origin")} --body=Closes #12. CI green.`]);
  });

  it("rewrites both when both are given", async () => {
    const input = await branch();
    const result = await createTaskPr({ ...input, edit: { title: "fix: y", body: "B" } });
    expect(result.edited).toEqual(["title", "body"]);
    expect(ghCalls().filter((c) => c.startsWith("pr edit"))).toEqual([`pr edit ${PR_URL} --repo=${await git(input.worktreePath, "remote", "get-url", "origin")} --title=fix: y --body=B`]);
  });

  it("keeps the PR and reports the edit failure separately", async () => {
    process.env.GH_STUB_EDIT_EXIT = "1";
    const result = await createTaskPr({ ...(await branch()), edit: { title: "fix: y" } });
    expect(result.ok).toBe(true);
    expect(result.url).toBe(PR_URL);
    expect(result.edited).toBeUndefined();
    expect(result.editError).toContain("403");
  });

  it("a new PR takes title and body and never runs pr edit", async () => {
    process.env.GH_STUB_LIST = "[]";
    const input = await branch();
    const result = await createTaskPr({ ...input, edit: { title: "fix: y" } });
    expect(result).toEqual({ ok: true, url: "https://github.com/o/r/pull/600" });
    const calls = ghCalls();
    expect(calls.some((c) => c.startsWith("pr edit"))).toBe(false);
    const repoArg = `--repo=${await git(input.worktreePath, "remote", "get-url", "origin")}`;
    expect(calls.find((c) => c.startsWith("pr list"))).toContain(repoArg);
    expect(calls.find((c) => c.startsWith("pr create"))).toContain(repoArg);
    expect(calls.find((c) => c.startsWith("pr create"))).toContain("--title=Task title");
  });
  it("refuses a new PR containing commits inherited from a local baseline", async () => {
    process.env.GH_STUB_LIST = "[]";
    const { repo, origin } = await makeRepoWithOrigin();
    const baseSha = await commitFile(repo, "inherited.txt", "inherited\n", "local baseline");
    const workBranch = `calandria/${uid()}`;
    await git(repo, "checkout", "-b", workBranch);
    await commitFile(repo, "task.txt", "task\n", "task work");
    const result = await createTaskPr({ worktreePath: repo, workBranch, baseBranch: "main", baseSha, title: "Task", body: "Body" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Nothing was pushed");
    await expect(git(origin, "rev-parse", `refs/heads/${workBranch}`)).rejects.toThrow();
    expect(ghCalls().some((c) => c.startsWith("pr create"))).toBe(false);
  });

  it("checks an existing PR against its retargeted base before pushing or editing", async () => {
    const { repo, origin } = await makeRepoWithOrigin();
    await git(repo, "push", "origin", "HEAD:refs/heads/older");
    const baseSha = await commitFile(repo, "inherited.txt", "inherited\n", "baseline on main");
    await git(repo, "push", "origin", "main");
    const workBranch = `calandria/${uid()}`;
    await git(repo, "checkout", "-b", workBranch);
    await git(repo, "push", "origin", `HEAD:refs/heads/${workBranch}`);
    const before = await git(origin, "rev-parse", `refs/heads/${workBranch}`);
    await commitFile(repo, "task.txt", "task\n", "task work");
    process.env.GH_STUB_LIST = JSON.stringify([{ url: PR_URL, baseRefName: "older" }]);
    const result = await createTaskPr({ worktreePath: repo, workBranch, baseBranch: "main", baseSha, title: "Task", body: "Body", edit: { title: "Changed" } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Nothing was pushed");
    expect(await git(origin, "rev-parse", `refs/heads/${workBranch}`)).toBe(before);
    expect(ghCalls().some((c) => c.startsWith("pr edit"))).toBe(false);
  });

  it("refuses to push when the existing PR lookup fails", async () => {
    process.env.GH_STUB_LIST_EXIT = "1";
    const input = await branch();
    const result = await createTaskPr(input);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Nothing was pushed");
    await expect(git(input.worktreePath, "rev-parse", `refs/remotes/origin/${input.workBranch}`)).rejects.toThrow();
    expect(ghCalls().some((c) => c.startsWith("pr create"))).toBe(false);
  });

  it.each([{ url: 1, baseRefName: "main" }, { url: PR_URL, baseRefName: {} }, { url: " ", baseRefName: "main" }])("refuses malformed listing %j", async (row) => {
    process.env.GH_STUB_LIST = JSON.stringify([row]);
    const input = await branch();
    const result = await createTaskPr(input);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Nothing was pushed");
    await expect(git(input.worktreePath, "rev-parse", `refs/remotes/origin/${input.workBranch}`)).rejects.toThrow();
  });

  it("refuses when the checkout is on another branch", async () => {
    const input = await branch();
    await git(input.worktreePath, "checkout", "-b", "other");
    const result = await createTaskPr(input);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Nothing was pushed");
    await expect(git(input.worktreePath, "rev-parse", `refs/remotes/origin/${input.workBranch}`)).rejects.toThrow();
  });
});
