import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

/** Run a git command in `cwd`, returning trimmed stdout. Throws on non-zero exit. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

/** Fresh directory under the per-run tmp root (cleaned up by tests/setup.ts). */
export function tmpDir(prefix = "dir-"): string {
  return fs.mkdtempSync(path.join(process.env.CALANDRIA_TEST_TMP!, prefix));
}

export const uid = () => crypto.randomBytes(6).toString("hex");

export function writeFile(repo: string, file: string, content: string | Buffer): void {
  const p = path.join(repo, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export async function commitFile(
  repo: string,
  file: string,
  content: string | Buffer,
  message = `update ${file}`
): Promise<string> {
  writeFile(repo, file, content);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", message, "--no-verify");
  return git(repo, "rev-parse", "HEAD");
}

/** New repo on `main` with one initial commit (file.txt). */
export async function makeRepo(): Promise<string> {
  const repo = tmpDir("repo-");
  await git(repo, "init", "-b", "main");
  await commitFile(repo, "file.txt", "line one\nline two\n", "initial commit");
  return repo;
}

/**
 * A bare `origin` on `main`, a "colleague" clone that pushes to it, and the
 * project clone under test: the minimum shape for exercising anything that
 * reads or writes a remote. Advance the remote with `pushFromColleague`, then
 * the project clone is stale exactly the way a PR merged on GitHub leaves it.
 */
export async function makeRepoWithOrigin(): Promise<{ origin: string; repo: string; colleague: string }> {
  const origin = tmpDir("origin-");
  await git(origin, "init", "--bare", "-b", "main");

  const colleague = await makeRepo();
  await git(colleague, "remote", "add", "origin", origin);
  await git(colleague, "push", "-u", "origin", "main");

  const repo = tmpDir("clone-");
  await exec("git", ["clone", origin, repo]);
  return { origin, repo, colleague };
}

/** Land a commit on the remote's `branch` from outside the project clone. */
export async function pushFromColleague(
  colleague: string,
  file: string,
  content: string,
  branch = "main"
): Promise<string> {
  const sha = await commitFile(colleague, file, content, `remote: ${file}`);
  await git(colleague, "push", "origin", `HEAD:refs/heads/${branch}`);
  return sha;
}

/** Repo + task worktree via ensureWorktree, with the boilerplate unpacked. */
export async function makeRepoWithWorktree(
  ensureWorktree: (repoPath: string, taskId: string) => Promise<{ path: string; branch: string; baseSha: string; reattached: boolean } | null>
) {
  const repo = await makeRepo();
  const taskId = uid();
  const wt = await ensureWorktree(repo, taskId);
  if (!wt) throw new Error("ensureWorktree returned null in fixture");
  return { repo, taskId, wt };
}

/**
 * Park a live ask on a task the way the runner does: a registered waiter in
 * lib/asks.ts plus its persisted question card. Returns the ask id and the
 * card's message id. The waiter's promise is swallowed so a later settle or
 * teardown does not surface as an unhandled rejection.
 */
export async function parkAsk(taskId: string, askId = `ask-${uid()}`, question = "Which way?"): Promise<{ askId: string; messageId: string }> {
  const { waitForAnswer } = await import("@/lib/asks");
  const { addMessage, getTask } = await import("@/lib/store");
  const task = getTask(taskId)!;
  const questions = [{ question, header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }], multiSelect: false }];
  waitForAnswer(taskId, askId, questions as never).catch(() => {});
  const m = addMessage(taskId, task.generation, "tool", JSON.stringify({ title: "Question", ask: { id: askId, questions } }));
  return { askId, messageId: m.id };
}

/** Park a live permission card the same way (ordinary Bash gate, no scope offer unless given). */
export async function parkPermission(
  taskId: string,
  opts: { requestId?: string; kind?: "settings" | "environment"; scope?: unknown } = {}
): Promise<{ requestId: string; messageId: string }> {
  const { waitForAnswer } = await import("@/lib/asks");
  const { addMessage, getTask } = await import("@/lib/store");
  const task = getTask(taskId)!;
  const requestId = opts.requestId ?? `perm:${uid()}`;
  if (opts.kind === "environment") {
    const { mandatoryDecisionWaiter } = await import("@/lib/advanced-env/capabilities");
    mandatoryDecisionWaiter.park(taskId, requestId).catch(() => {});
  } else {
    waitForAnswer(taskId, requestId, []).catch(() => {});
  }
  const request = { id: requestId, tool: "Bash", title: "Run a command", detail: "ls", expiresAt: 0, ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.scope ? { scope: opts.scope } : {}) };
  const m = addMessage(taskId, task.generation, "tool", JSON.stringify({ title: "Permission needed", permission: { request } }));
  return { requestId, messageId: m.id };
}
