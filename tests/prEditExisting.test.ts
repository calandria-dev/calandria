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

  function ghCalls(): string[] {
    const log = fs.readFileSync(process.env.GH_STUB_LOG!, "utf8").trim();
    return log ? log.split("\n") : [];
  }

  beforeEach(() => {
    shim = tmpDir("gh-shim-");
    process.env.GH_STUB_LOG = path.join(shim, "calls.log");
    process.env.GH_STUB_LIST = JSON.stringify([{ url: PR_URL }]);
    process.env.GH_STUB_EDIT_EXIT = "0";
    fs.writeFileSync(process.env.GH_STUB_LOG, "");
    fs.writeFileSync(
      path.join(shim, "gh"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$GH_STUB_LOG"',
        'case "$1 $2" in',
        '  "auth status") echo "Logged in to github.com account stub"; exit 0 ;;',
        '  "pr list") printf "%s" "$GH_STUB_LIST"; exit 0 ;;',
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
  });

  async function branch() {
    const { repo } = await makeRepoWithOrigin();
    const workBranch = `calandria/${uid()}`;
    await git(repo, "checkout", "-b", workBranch);
    await commitFile(repo, "work.txt", "work\n", "work");
    return { worktreePath: repo, workBranch, baseBranch: "main", title: "Task title", body: "Generated body" };
  }

  it("leaves the open PR's title and body alone when no edit is given", async () => {
    const result = await createTaskPr({ ...(await branch()), edit: {} });
    expect(result).toEqual({ ok: true, url: PR_URL, existing: true });
    expect(ghCalls().some((c) => c.startsWith("pr edit"))).toBe(false);
  });

  it("rewrites only the fields the caller gave", async () => {
    const result = await createTaskPr({ ...(await branch()), edit: { body: "Closes #12. CI green." } });
    expect(result).toMatchObject({ ok: true, url: PR_URL, existing: true, edited: ["body"] });
    const edits = ghCalls().filter((c) => c.startsWith("pr edit"));
    expect(edits).toEqual([`pr edit ${PR_URL} --body=Closes #12. CI green.`]);
  });

  it("rewrites both when both are given", async () => {
    const result = await createTaskPr({ ...(await branch()), edit: { title: "fix: y", body: "B" } });
    expect(result.edited).toEqual(["title", "body"]);
    expect(ghCalls().filter((c) => c.startsWith("pr edit"))).toEqual([`pr edit ${PR_URL} --title=fix: y --body=B`]);
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
    const result = await createTaskPr({ ...(await branch()), edit: { title: "fix: y" } });
    expect(result).toEqual({ ok: true, url: "https://github.com/o/r/pull/600" });
    const calls = ghCalls();
    expect(calls.some((c) => c.startsWith("pr edit"))).toBe(false);
    expect(calls.find((c) => c.startsWith("pr create"))).toContain("--title=Task title");
  });
});
