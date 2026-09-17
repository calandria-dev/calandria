import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { createProject, createTask, getTask, updateTask } from "@/lib/store";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { adoptExistingPr } from "@/lib/prTools";
import type { LandingMode } from "@/lib/types";
import { git, commitFile, makeRepoWithOrigin, tmpDir, uid } from "./helpers";
import { IS_WIN } from "./platform";

// Linking a PR the SESSION opened by hand (lib/prTools.ts's adoptExistingPr).
//
// When `create_pr` is cut off before it reaches Calandria, the session falls
// back to `git push` + `gh pr create`. The PR is real; the task row is empty.
// This pins that the row catches up on its own, without ever adopting
// somebody else's branch or forking gh for a task that could not possibly
// have a PR.
//
// gh is a REAL subprocess here, stubbed as a script on PATH instead of mocked
// at the module boundary, because two of the things worth pinning live in the
// argv and the JSON: that the query is filtered to `--head <branch> --state
// open`, and that a headRefName which does not match is refused. Everything
// else (the git repo, the remote-tracking ref, the store writes, the bus) is
// real. Windows is skipped: resolveGhBin answers bare "gh" for a PATH hit, and
// execFile can't run a .cmd shim without a shell (see tests/ghBin.test.ts for
// the same split).
describe.skipIf(IS_WIN)("adopting a PR opened outside Calandria", () => {
  let shim = "";
  let originalPath = "";

  /** What the next `gh pr list` prints, and what it exits with. */
  function ghAnswers(rows: unknown[], exitCode = 0): void {
    fs.writeFileSync(process.env.GH_STUB_OUT!, JSON.stringify(rows));
    process.env.GH_STUB_EXIT = String(exitCode);
  }

  /** Every argv the stub has been called with, one per line. */
  function ghCalls(): string[] {
    const log = fs.readFileSync(process.env.GH_STUB_LOG!, "utf8").trim();
    return log ? log.split("\n") : [];
  }

  beforeEach(() => {
    shim = tmpDir("gh-shim-");
    process.env.GH_STUB_OUT = path.join(shim, "out.json");
    process.env.GH_STUB_LOG = path.join(shim, "calls.log");
    process.env.GH_STUB_EXIT = "0";
    fs.writeFileSync(process.env.GH_STUB_OUT, "[]");
    fs.writeFileSync(process.env.GH_STUB_LOG, "");
    fs.writeFileSync(
      path.join(shim, "gh"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_STUB_LOG"\ncat "$GH_STUB_OUT"\nexit "${GH_STUB_EXIT:-0}"\n',
      { mode: 0o755 }
    );
    originalPath = process.env.PATH || "";
    process.env.PATH = `${shim}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.GH_STUB_OUT;
    delete process.env.GH_STUB_LOG;
    delete process.env.GH_STUB_EXIT;
  });

  /**
   * A project that lands by PR, a task with a work branch, and (unless
   * `pushed` is false) that branch pushed to origin, which is what leaves the
   * refs/remotes ref the cheap gate looks for.
   */
  async function fixture(opts: { landing?: LandingMode; pushed?: boolean } = {}) {
    const { repo } = await makeRepoWithOrigin();
    const project = createProject({
      name: `p-${uid()}`,
      repo_path: repo,
      branch: "main",
      landing_mode: opts.landing ?? "pr",
    });
    const branch = `calandria/${uid()}`;
    await git(repo, "checkout", "-b", branch);
    await commitFile(repo, "work.txt", "done");
    if (opts.pushed !== false) await git(repo, "push", "-u", "origin", branch);
    const task = createTask({ project_id: project.id, title: "some work" });
    updateTask(task.id, { work_branch: branch, worktree_path: repo });
    return { repo, project, branch, taskId: task.id };
  }

  it("links the open PR whose head is exactly the task branch", async () => {
    const { branch, taskId } = await fixture();
    const url = "https://github.com/acme/widgets/pull/198";
    ghAnswers([{ number: 198, url, headRefName: branch }]);

    const events: BusEvent[] = [];
    const off = subscribeGlobal((_id, e) => events.push(e));
    const opened: string[] = [];
    const found = await adoptExistingPr(taskId, (id) => opened.push(id));
    off();

    expect(found).toEqual({ url, number: 198 });
    const row = getTask(taskId)!;
    expect(row.pr_url).toBe(url);
    expect(row.pr_number).toBe(198);
    // The client is told to re-read the row, and the PR-state read is kicked;
    // the same two things create_pr's own success does.
    expect(events.some((e) => e.type === "task_edited")).toBe(true);
    expect(opened).toEqual([taskId]);
    // Filtered at gh, not in JS: one branch's PRs, open ones only.
    expect(ghCalls()).toHaveLength(1);
    expect(ghCalls()[0]).toContain(`pr list --head ${branch} --state open`);
  });

  it("refuses a PR whose head branch is not the task branch", async () => {
    const { taskId } = await fixture();
    // gh's --head is a filter, not a promise: a fork's PR reports owner:branch.
    ghAnswers([{ number: 7, url: "https://github.com/acme/widgets/pull/7", headRefName: "someone-else/patch" }]);

    expect(await adoptExistingPr(taskId)).toBeNull();
    expect(getTask(taskId)!.pr_url).toBe("");
  });

  it("never asks GitHub about a branch nobody pushed", async () => {
    const { taskId } = await fixture({ pushed: false });
    ghAnswers([{ number: 198, url: "https://github.com/acme/widgets/pull/198", headRefName: "irrelevant" }]);

    expect(await adoptExistingPr(taskId)).toBeNull();
    expect(getTask(taskId)!.pr_url).toBe("");
    // The local-ref gate exists for this: no subprocess, no network call.
    expect(ghCalls()).toEqual([]);
  });

  it("leaves a project that lands by merging alone", async () => {
    const { branch, taskId } = await fixture({ landing: "merge" });
    ghAnswers([{ number: 198, url: "https://github.com/acme/widgets/pull/198", headRefName: branch }]);

    expect(await adoptExistingPr(taskId)).toBeNull();
    expect(getTask(taskId)!.pr_url).toBe("");
    expect(ghCalls()).toEqual([]);
  });

  it("leaves a task that already has a PR alone", async () => {
    const { branch, taskId } = await fixture();
    updateTask(taskId, { pr_url: "https://github.com/acme/widgets/pull/12", pr_number: 12 });
    ghAnswers([{ number: 198, url: "https://github.com/acme/widgets/pull/198", headRefName: branch }]);

    expect(await adoptExistingPr(taskId)).toBeNull();
    expect(getTask(taskId)!.pr_number).toBe(12);
    expect(ghCalls()).toEqual([]);
  });

  it("stays quiet when gh fails", async () => {
    const { taskId } = await fixture();
    ghAnswers([], 1); // logged out, no network, not a GitHub remote: all the same here

    expect(await adoptExistingPr(taskId)).toBeNull();
    expect(getTask(taskId)!.pr_url).toBe("");
    expect(ghCalls()).toHaveLength(1);
  });
});
