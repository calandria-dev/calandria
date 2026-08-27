import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import {
  WORKTREES_DIR,
  GIT_FETCH_ENABLED,
  GIT_FETCH_TIMEOUT_MS,
  GIT_FETCH_COOLDOWN_MS,
} from "./config";
import { repoLockKey, withRepoLock } from "./repoLock";

const run = promisify(execFile);

// Worktrees live OUTSIDE the Calandria project (CALANDRIA_WORKTREES_DIR, default
// ~/.calandria/worktrees), keyed by task id. Each is a real git
// worktree of the *project's* repo, so a task gets an isolated checkout +
// branch and parallel tasks never collide. Keeping them out of the project
// root is essential: nested checkouts under the Next app would be swept up by
// tsc/eslint and would thrash the dev watcher every time an agent writes a file.

async function git(repoPath: string, args: string[]): Promise<string> {
  // execFile's default maxBuffer is 1MB — a whole-tree `git diff` (taskDiff)
  // or a busy log can exceed that. It's a cap, not an allocation, so raise it.
  const { stdout } = await run("git", ["-C", repoPath, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

// Run `fn` over `items` with at most `limit` in flight. Spawning a git
// subprocess costs 10–40ms before it does any work, so anything per-file must
// overlap those spawns — but unbounded Promise.all over a huge diff would fork
// hundreds of processes at once.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** True if `dir` is inside a git work tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/** True if the repo has at least one commit (worktrees can't branch from an empty HEAD). */
async function hasCommit(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export const branchForTask = (taskId: string) => `calandria/${taskId}`;
/**
 * The spelling tasks were minted under before the rename. Never minted again,
 * only ADOPTED: a branch is written into the repo once and lives there
 * forever, and a v0.2.0 task's commits are on `orch/<id>`, not on a
 * `calandria/<id>` that doesn't exist yet. See existingTaskBranch().
 */
export const legacyBranchForTask = (taskId: string) => `orch/${taskId}`;

/**
 * The branch a task already has in this repo, under either spelling, or null
 * when it has none. This is what makes a reattach a reattach: ensureWorktree
 * is the one place that DERIVES a branch name rather than reading it off the
 * row, and it runs on every self-heal (a pruned merged worktree, a lost
 * checkout, a task moved between projects) — deriving only the new spelling
 * there cut a fresh empty `calandria/<id>` beside the task's real work on
 * `orch/<id>`, and every caller then committed that to the row: an empty
 * diff, a merge of nothing, and a branch nothing pointed at any more.
 */
async function existingTaskBranch(repoPath: string, taskId: string): Promise<string | null> {
  const current = branchForTask(taskId);
  if (await branchExists(repoPath, current)) return current;
  const legacy = legacyBranchForTask(taskId);
  if (await branchExists(repoPath, legacy)) return legacy;
  return null;
}

// Fallback committer identity, used only when the user has none configured.
const FALLBACK_IDENTITY = ["-c", "user.name=Calandria", "-c", "user.email=calandria@local"];

/**
 * The message for a commit the app makes on the user's behalf. Every one carries
 * the task id so a merge on `main` traces back to the session that produced it.
 * Lives here so the five routes that commit can't drift apart.
 */
export const taskCommitMessage = (task: { id: string; title: string }) =>
  `${task.title} (calandria task ${task.id})`;

/**
 * The message for the commit that syncs a task's base branch into it. Takes the
 * branch rather than the project because a task can be based on a branch of its
 * own (lib/baseBranch.ts) — naming the project's default here would label the
 * commit with a branch the merge never touched.
 */
export const syncCommitMessage = (baseBranch: string, task: { id: string; title: string }) =>
  `Sync ${baseBranch} into ${taskCommitMessage(task)}`;

// Commit whatever is currently in the repo as the project baseline. Writes a
// sensible default .gitignore first (so a base commit doesn't swallow
// node_modules), and uses a fallback identity if the user has none configured.
async function baseCommit(repoPath: string): Promise<void> {
  const gi = path.join(repoPath, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "node_modules/\n.next/\ndist/\nbuild/\n.DS_Store\n*.log\n");
  await git(repoPath, ["add", "-A"]);
  const args = ["commit", "--allow-empty", "-m", "Initial project state (calandria)", "--no-verify"];
  try {
    await git(repoPath, args);
  } catch {
    await git(repoPath, [...FALLBACK_IDENTITY, ...args]);
  }
}

// Initialize a fresh git repo (on `main`) and make the baseline commit.
async function initRepo(repoPath: string): Promise<void> {
  try {
    await git(repoPath, ["init", "-b", "main"]);
  } catch {
    await git(repoPath, ["init"]); // older git without -b
  }
  await baseCommit(repoPath);
}

/** Best-effort recent commit log (one `hash date subject` per line). "" if not a git repo. */
export async function recentCommits(repoPath: string, n = 10): Promise<string> {
  if (!repoPath || !(await isGitRepo(repoPath))) return "";
  try {
    return await git(repoPath, ["log", `-${n}`, "--pretty=format:%h %ad %s", "--date=short"]);
  } catch {
    return "";
  }
}

// ---------- remote awareness ----------
//
// Everything above this line is purely local, and for a long time so was the
// whole app. That only holds while every merge happens through the merge
// button: the moment work lands on the remote instead — a PR merged on GitHub,
// a teammate's push, a pull in another checkout — the local base branch goes
// stale and every task cut afterwards silently branches off a dead tip. Worse,
// the staleness is invisible, because the sync panel measures "behind" against
// that same stale branch.
//
// The fix is a best-effort `git fetch` of the base branch and a base branch
// that knows about its remote. Best-effort is load-bearing: no network, no
// remote, an expired credential or a slow link must never stop a task from
// launching, exactly like the greenfield/non-git fallback below.

/** Where the base branch's remote counterpart lives. */
export interface BaseRemote {
  remote: string; // remote name — usually "origin", but a fork may fetch from "upstream"
  remoteBranch: string; // the branch's name ON the remote (can differ from the local one)
  trackingRef: string; // refs/remotes/<remote>/<remoteBranch>
  label: string; // "origin/main" — what the UI says
}

// Refuse anything that can't be a branch name before it goes into a refspec.
// The base branch is user input — the project's, or a task's own
// (lib/baseBranch.ts) — and while execFile never involves a shell, a name
// starting with "-" would still be read by git as a flag. Exported because
// retargeting a task has to refuse an unusable name BY NAME, before any git
// runs, rather than letting the first subprocess fail with git's wording.
export function refNameSafe(name: string): boolean {
  return (
    !!name &&
    /^[A-Za-z0-9._\-/]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.includes("..")
  );
}

/**
 * Resolve which remote (and which branch on it) the project's base branch
 * corresponds to. Prefers the branch's configured upstream, so a fork whose
 * `main` tracks `upstream/main` is followed correctly; falls back to `origin`
 * with the same branch name, which is what a plain clone looks like. Returns
 * null for a repo with no remote at all — including every project the app
 * created itself — and that null is the "stay entirely local" signal.
 */
export async function baseRemote(repoPath: string, baseBranch: string): Promise<BaseRemote | null> {
  if (!refNameSafe(baseBranch)) return null;

  const cfg = (key: string) => git(repoPath, ["config", "--get", key]).catch(() => "");
  let remote = (await cfg(`branch.${baseBranch}.remote`)).trim();
  // "." is a valid upstream meaning "this same repo" — local-only, nothing to fetch.
  if (remote === ".") return null;

  let remoteBranch = baseBranch;
  if (remote) {
    const merge = (await cfg(`branch.${baseBranch}.merge`)).trim();
    if (merge.startsWith("refs/heads/")) remoteBranch = merge.slice("refs/heads/".length);
  } else {
    const url = await git(repoPath, ["remote", "get-url", "origin"]).catch(() => "");
    if (!url.trim()) return null;
    remote = "origin";
  }
  if (!refNameSafe(remote) || !refNameSafe(remoteBranch)) return null;

  return {
    remote,
    remoteBranch,
    trackingRef: `refs/remotes/${remote}/${remoteBranch}`,
    label: `${remote}/${remoteBranch}`,
  };
}

// A git subprocess that may touch the network. Two guards the local `git()`
// helper doesn't need: a hard deadline (the point of "best-effort" is that a
// hung connection can't outlive it) and no interactive prompting, so a repo
// with an expired credential fails fast instead of blocking on a password
// prompt nobody is there to answer.
async function gitNet(repoPath: string, args: string[], timeoutMs = GIT_FETCH_TIMEOUT_MS): Promise<string> {
  const { stdout } = await run("git", ["-C", repoPath, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      // Only when the user hasn't set their own — theirs may carry keys/config we'd break.
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -oBatchMode=yes",
    },
  });
  return stdout.trim();
}

function subprocessStderr(e: unknown): string {
  return e && typeof e === "object" && "stderr" in e ? String((e as { stderr: unknown }).stderr ?? "") : "";
}

// A line naming a rejected ref — client-side (`! [rejected] …`) or server-side,
// via a pre-receive hook on the remote (`! [remote rejected] …`). Preferred over
// the generic "failed to push some refs" summary line as the headline, since
// THIS is the line that says which branch and why.
const REJECTED_LINE = /!\s*\[(remote )?rejected\]/i;
const GENERIC_PUSH_FAILURE = /^error:\s*failed to push some refs/i;

// The one line of git's stderr wall that says what actually failed — a rejected
// push otherwise reaches the user as forty lines of hint text. Exported for
// tests/gitErrorDetail.test.ts, which pins the headline this reorders.
export function gitErrorLine(e: unknown, fallback: string): string {
  const stderr = subprocessStderr(e);
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const fatalLine = lines.find((l) => /^(fatal|error)[:\s]/i.test(l));
  const rejectedLine = lines.find((l) => REJECTED_LINE.test(l));

  // The generic line ("failed to push some refs to '<url>'") is the same for
  // every push rejection, so it's the WORST headline available whenever
  // something more specific exists: a named [rejected]/[remote rejected] ref,
  // or — when a pre-push hook rejected the push without git printing one of
  // those (hooks aren't required to) — the fact that a hook spoke at all.
  if (fatalLine && GENERIC_PUSH_FAILURE.test(fatalLine)) {
    if (rejectedLine) return rejectedLine;
    if (gitErrorDetail(e)) return "push rejected by a pre-push hook";
  }

  return (
    fatalLine?.replace(/^(fatal|error):\s*/i, "") ||
    rejectedLine ||
    lines.find((l) => /rejected|denied|could not|not found|protected|non-fast-forward/i.test(l)) ||
    lines[lines.length - 1] ||
    (e instanceof Error ? e.message : fallback)
  );
}

const DETAIL_MAX_LINES = 40;
const DETAIL_MAX_CHARS = 4000;

/**
 * The rest of git's stderr, once `gitErrorLine`'s headline is stripped of its
 * own noise — chiefly a pre-push (or pre-receive) hook's own output, which
 * otherwise never reaches the user at all. A DENYLIST of git's own boilerplate,
 * not an allowlist: a hook's output doesn't match any known shape, so keeping
 * only "recognized" lines would drop the one thing this exists to surface.
 */
export function gitErrorDetail(e: unknown): string {
  const stderr = subprocessStderr(e);
  const rawLines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const lines: string[] = [];
  for (const line of rawLines) {
    if (/^hint:/i.test(line)) continue; // git's own "what this usually means" filler
    if (GENERIC_PUSH_FAILURE.test(line)) continue; // the headline already says this
    if (/^To\s+\S+/.test(line)) continue; // "To <url>" — restates what we're pushing to
    if (/^remote:/i.test(line)) {
      // Server-side (pre-receive) hook output arrives prefixed on every line;
      // strip the prefix but drop the boilerplate blank "remote:" separator lines.
      const rest = line.replace(/^remote:\s?/i, "").trim();
      if (!rest) continue;
      lines.push(rest);
      continue;
    }
    lines.push(line);
  }

  let truncated = false;
  let kept = lines;
  if (kept.length > DETAIL_MAX_LINES) {
    kept = kept.slice(0, DETAIL_MAX_LINES);
    truncated = true;
  }
  let text = kept.join("\n").trim();
  if (text.length > DETAIL_MAX_CHARS) {
    text = text.slice(0, DETAIL_MAX_CHARS).trim();
    truncated = true;
  }
  return truncated ? `${text}…` : text;
}

/** What a best-effort fetch managed to do. Never an exception. */
export interface FetchOutcome {
  attempted: boolean; // false = nothing to fetch (no remote, or fetching disabled)
  ok: boolean; // the remote-tracking ref reflects a successful recent fetch
  fetchedAt: number; // epoch ms of the fetch we're relying on (0 = never in this process)
  error?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaFetch: { last: Map<string, number>; inflight: Map<string, Promise<FetchOutcome>> } | undefined;
}

// Same globalThis pattern as lib/events.ts / lib/abort.ts, so dev HMR doesn't
// reset the cooldown and turn every reload into a fetch storm.
function fetchState() {
  if (!global.__calandriaFetch) global.__calandriaFetch = { last: new Map(), inflight: new Map() };
  return global.__calandriaFetch;
}

/**
 * Update the base branch's remote-tracking ref, best-effort. Coalesced two ways:
 * a fetch already in flight for this repo is awaited rather than duplicated, and
 * one that finished within the cooldown is reused outright — so opening a project
 * and immediately launching five tasks costs one fetch, not six.
 *
 * Deliberately fetches into an EXPLICIT destination refspec rather than trusting
 * `git fetch <remote> <branch>` to update `<remote>/<branch>`: bare-branch fetch
 * mainly writes FETCH_HEAD, and whether the tracking ref moves depends on the
 * repo's configured `remote.<name>.fetch` — which a single-branch clone narrows.
 */
export async function fetchBase(repoPath: string, baseBranch: string): Promise<FetchOutcome> {
  const st = fetchState();
  // Keyed on the repo's IDENTITY (its common git dir, the same resolution
  // lib/repoLock.ts uses) rather than the configured path, so a symlinked
  // spelling, a trailing slash, or two projects pointed at one checkout share a
  // cooldown instead of each fetching on their own clock — and on the branch,
  // because a fetch of `main` says nothing about `release` (issue #41).
  const key = `${await repoLockKey(repoPath)}\0${baseBranch}`;
  const last = st.last.get(key) ?? 0;
  // Turned off is not the same as failed: the user may still fetch by hand, so
  // the remote-tracking ref can be perfectly current. Report nothing to report.
  if (!GIT_FETCH_ENABLED) return { attempted: false, ok: false, fetchedAt: last };
  if (last && Date.now() - last < GIT_FETCH_COOLDOWN_MS) return { attempted: true, ok: true, fetchedAt: last };

  const inflight = st.inflight.get(key);
  if (inflight) return inflight;

  const p = runFetch(key, repoPath, baseBranch).finally(() => st.inflight.delete(key));
  st.inflight.set(key, p);
  return p;
}

async function runFetch(key: string, repoPath: string, baseBranch: string): Promise<FetchOutcome> {
  const st = fetchState();
  const prior = () => st.last.get(key) ?? 0;
  let up: BaseRemote | null = null;
  try {
    up = await baseRemote(repoPath, baseBranch);
  } catch {
    return { attempted: false, ok: false, fetchedAt: prior() };
  }
  if (!up) return { attempted: false, ok: false, fetchedAt: prior() };

  try {
    // Forced (+) because a remote-tracking ref must mirror the remote even when
    // the remote branch was rewritten — it's a mirror, not history we own.
    await gitNet(repoPath, [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--quiet",
      up.remote,
      `+refs/heads/${up.remoteBranch}:${up.trackingRef}`,
    ]);
    const at = Date.now();
    st.last.set(key, at);
    return { attempted: true, ok: true, fetchedAt: at };
  } catch (e) {
    return { attempted: true, ok: false, fetchedAt: prior(), error: gitErrorLine(e, "git fetch failed") };
  }
}

/** How the LOCAL base branch stands against the last successfully fetched remote tip. */
export interface RemoteBaseStatus {
  hasRemote: boolean;
  label: string; // "origin/main" ("" when there's no remote)
  tracked: boolean; // a remote-tracking ref exists to compare against
  behind: number; // commits on the remote tip that the local branch doesn't have
  ahead: number; // local commits the remote doesn't have
  diverged: boolean; // both directions non-zero — no automatically correct move
  unknown: boolean; // ancestry couldn't be computed (shallow clone, missing objects)
  canFastForward: boolean; // behind, not ahead, and knowable → a one-click catch-up
  localTip: string;
  remoteTip: string;
}

const noRemoteStatus = (label = ""): RemoteBaseStatus => ({
  hasRemote: false, label, tracked: false, behind: 0, ahead: 0, diverged: false,
  unknown: false, canFastForward: false, localTip: "", remoteTip: "",
});

/**
 * Read-only comparison of the local base branch against its remote-tracking
 * ref. Never touches the network — call `fetchBase` first if freshness matters.
 *
 * "Unknown" is a distinct outcome on purpose. In a shallow clone the commits
 * needed to establish ancestry simply aren't there, and the count fails; calling
 * that zero would report a stale branch as up to date, which is the exact lie
 * this whole feature exists to stop telling.
 */
export async function remoteBaseStatus(repoPath: string, baseBranch: string): Promise<RemoteBaseStatus> {
  const up = await baseRemote(repoPath, baseBranch).catch(() => null);
  if (!up) return noRemoteStatus();
  const base = { ...noRemoteStatus(up.label), hasRemote: true };

  const [localTip, remoteTip] = await Promise.all([
    git(repoPath, ["rev-parse", "--verify", `refs/heads/${baseBranch}`]).catch(() => ""),
    git(repoPath, ["rev-parse", "--verify", `${up.trackingRef}^{commit}`]).catch(() => ""),
  ]);
  if (!localTip || !remoteTip) return { ...base, localTip, remoteTip, tracked: !!remoteTip };

  if (localTip === remoteTip) return { ...base, tracked: true, localTip, remoteTip };

  // `--left-right --count A...B` answers both directions in one subprocess:
  // "<commits only on A>\t<commits only on B>".
  let ahead = 0;
  let behind = 0;
  try {
    const [l, r] = (await git(repoPath, ["rev-list", "--left-right", "--count", `${localTip}...${remoteTip}`])).split(/\s+/);
    ahead = parseInt(l, 10) || 0;
    behind = parseInt(r, 10) || 0;
  } catch {
    return { ...base, tracked: true, localTip, remoteTip, unknown: true };
  }

  return {
    ...base,
    tracked: true,
    localTip,
    remoteTip,
    ahead,
    behind,
    diverged: ahead > 0 && behind > 0,
    canFastForward: behind > 0 && ahead === 0,
  };
}

// Which worktree, if any, has `branch` checked out. `git worktree list
// --porcelain` prints one blank-line-separated block per worktree, the main one
// first. Moving a branch that some worktree has checked out would leave that
// worktree's index and files describing a commit the branch no longer points at.
export async function worktreeForBranch(repoPath: string, branch: string): Promise<{ path: string; isMain: boolean } | null> {
  const out = await git(repoPath, ["worktree", "list", "--porcelain"]).catch(() => "");
  let current = "";
  let seen = -1;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = line.slice("worktree ".length);
      seen++;
    } else if (line === `branch refs/heads/${branch}`) {
      return { path: current, isMain: seen === 0 };
    }
  }
  return null;
}

export interface AdvanceResult {
  ok: boolean;
  from?: string;
  to?: string;
  error?: string;
}

/**
 * Move the local base branch forward to `toSha` — the one-click catch-up behind
 * the project banner, and the tidy-up step before a merge that would otherwise
 * drag the remote's commits in behind the task's own.
 *
 * Strictly forward-only: a branch holding commits `toSha` doesn't have needs a
 * merge or rebase the user drives, and is refused here. How the branch moves
 * depends on who's holding it — a raw ref update when nobody has it checked out
 * (compare-and-swap on the tip we read, so a concurrent merge wins rather than
 * being silently discarded), git's own fast-forward when it's the main checkout
 * so files and index move with it, and a refusal when a linked worktree has it.
 */
export async function advanceBaseBranch(repoPath: string, baseBranch: string, toSha: string): Promise<AdvanceResult> {
  return withRepoLock(repoPath, () => advanceBaseBranchLocked(repoPath, baseBranch, toSha));
}

// The body of `advanceBaseBranch`, minus the lock, so `mergeTask` can use it
// from inside its own critical section — `withRepoLock` is a promise chain, and
// re-entering it from within would wait on a lock that can't be released yet.
async function advanceBaseBranchLocked(repoPath: string, baseBranch: string, toSha: string): Promise<AdvanceResult> {
  if (!refNameSafe(baseBranch)) return { ok: false, error: `${baseBranch || "(empty)"} isn't a usable branch name` };

  const from = await git(repoPath, ["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`]).catch(() => "");
  if (!from) return { ok: false, error: `base branch ${baseBranch} not found` };
  const to = await git(repoPath, ["rev-parse", "--verify", `${toSha}^{commit}`]).catch(() => "");
  if (!to) return { ok: false, from, error: "that commit isn't in this repo — fetch again and retry" };
  if (from === to) return { ok: true, from, to };

  const forward = await git(repoPath, ["merge-base", "--is-ancestor", from, to])
    .then(() => true)
    .catch(() => false);
  if (!forward)
    return { ok: false, from, error: `${baseBranch} has commits of its own — merge or rebase it yourself, this only fast-forwards` };

  const holder = await worktreeForBranch(repoPath, baseBranch);
  if (holder && !holder.isMain)
    return { ok: false, from, error: `${baseBranch} is checked out in ${holder.path} — that worktree has to let go of it first` };

  try {
    if (holder) await git(holder.path, ["merge", "--ff-only", to]);
    else await git(repoPath, ["update-ref", `refs/heads/${baseBranch}`, to, from]);
  } catch (e) {
    return { ok: false, from, error: gitErrorLine(e, `could not move ${baseBranch}`) };
  }
  return { ok: true, from, to };
}

export interface PushResult {
  ok: boolean;
  label?: string; // "origin/main"
  error?: string;
  detail?: string; // hook/rejection output beyond the one-line headline, if any
}

// A push moves more data than a fetch of one branch, so it gets the same
// generous ceiling the PR flow uses rather than the fetch deadline.
const PUSH_TIMEOUT_MS = 120_000;

/**
 * Publish the local base branch to its remote. Plain, non-force, no `-u`: if the
 * remote has moved on or branch protection says no, that's a rejection to report,
 * never something to override. Offered after a merge lands, so the app-side loop
 * and the GitHub-side loop stop drifting apart — but only ever on a click.
 */
export async function pushBaseBranch(repoPath: string, baseBranch: string): Promise<PushResult> {
  if (!GIT_FETCH_ENABLED) return { ok: false, error: "remote access is turned off for this instance" };
  const up = await baseRemote(repoPath, baseBranch).catch(() => null);
  if (!up) return { ok: false, error: "this repo has no remote to push to" };

  try {
    await gitNet(repoPath, ["push", up.remote, `refs/heads/${baseBranch}:refs/heads/${up.remoteBranch}`], PUSH_TIMEOUT_MS);
    return { ok: true, label: up.label };
  } catch (e) {
    const detail = gitErrorDetail(e);
    return { ok: false, label: up.label, error: gitErrorLine(e, "git push failed"), ...(detail ? { detail } : {}) };
  }
}

// ---------- base-branch retargeting primitives (lib/baseBranch.ts) ----------
//
// The git half of pointing an existing task at a different base branch. The
// POLICY — which refusals, in what order, and what the user is told — lives in
// lib/baseBranch.ts so the route and the agent tool share one copy of it; these
// are the operations it composes.

/** What `ensureLocalBaseBranch` found (or made) for a branch a task wants to be based on. */
export interface LocalBaseBranch {
  found: "local" | "created" | "missing";
  /** For "created": the remote-tracking ref it was cut from and now tracks ("origin/feature/auth"). */
  label?: string;
  /** For "missing": where we looked on the remote, or "" when the repo has no remote at all. */
  remoteLabel?: string;
}

/**
 * Make sure `branch` exists locally, creating it at the remote's tip when it
 * exists only there.
 *
 * Refusing a branch the user can plainly see on GitHub is the failure mode this
 * exists to avoid: a feature branch a colleague pushed is exactly the branch a
 * task most wants to be based on, and it has no local ref until someone asks
 * for one. Created with `--track`, so the new local branch behaves like one the
 * user had checked out by hand — which is also what makes `baseRemote()` resolve
 * it correctly for every later fetch, sync and PR.
 */
export async function ensureLocalBaseBranch(repoPath: string, branch: string): Promise<LocalBaseBranch> {
  if (!refNameSafe(branch)) return { found: "missing", remoteLabel: "" };
  if (await branchExists(repoPath, branch)) return { found: "local" };

  const up = await baseRemote(repoPath, branch).catch(() => null);
  if (!up) return { found: "missing", remoteLabel: "" };
  // Best-effort, exactly like every other fetch here: no network is a reason to
  // fall back to whatever tracking ref is already on disk, not to fail.
  await fetchBase(repoPath, branch).catch(() => {});
  const tip = await git(repoPath, ["rev-parse", "--verify", `${up.trackingRef}^{commit}`]).catch(() => "");
  if (!tip) return { found: "missing", remoteLabel: up.label };
  try {
    await git(repoPath, ["branch", "--track", branch, up.trackingRef]);
  } catch (e) {
    return { found: "missing", remoteLabel: gitErrorLine(e, up.label) };
  }
  return { found: "created", label: up.label };
}

/**
 * The commit a task retargeted onto `baseBranch` should be re-cut at — the very
 * choice `ensureWorktree` makes for a fresh task, so a re-cut task lands exactly
 * where one created now would. "" when the branch doesn't exist.
 */
export async function baseStartPoint(repoPath: string, baseBranch: string): Promise<string> {
  if (!(await branchExists(repoPath, baseBranch))) return "";
  return selectStartPoint(repoPath, baseBranch).catch(() => "");
}

/** Move the worktree's branch to `sha`, discarding index and tree. Returns false if git refuses. */
export async function resetWorktreeTo(worktreePath: string, sha: string): Promise<boolean> {
  try {
    await git(worktreePath, ["reset", "--hard", sha]);
    return true;
  } catch {
    return false;
  }
}

/** Uncommitted changes present in the worktree (tracked or not). */
export async function worktreeIsDirty(worktreePath: string): Promise<boolean> {
  if (!worktreePath) return false;
  return (await git(worktreePath, ["status", "--porcelain"]).catch(() => "")).trim().length > 0;
}

/**
 * How many commits the worktree's HEAD carries beyond the commit it was cut
 * from — "what this task has made of its own". `null` when that can't be
 * determined (no recorded base_sha, or one git no longer has), which callers
 * must read as "assume there IS work": the answer gates a `reset --hard`.
 */
export async function commitsSinceCut(worktreePath: string, baseSha: string): Promise<number | null> {
  if (!worktreePath || !baseSha) return null;
  try {
    await git(worktreePath, ["cat-file", "-e", `${baseSha}^{commit}`]);
  } catch {
    return null;
  }
  const out = await git(worktreePath, ["rev-list", "--count", `${baseSha}..HEAD`]).catch(() => "");
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

/** merge-base of two refs, or "" when they share no history (or either is missing). */
export async function mergeBaseSha(repoPath: string, a: string, b: string): Promise<string> {
  return git(repoPath, ["merge-base", a, b]).catch(() => "");
}

// The commit a NEW task should branch from. The remote tip when the local base
// branch is merely behind it; the local tip in every other case — diverged (no
// automatically correct answer), ahead (local has unpublished work the remote
// would drop), or unknown. Resolved to a SHA, never handed on as a ref name: the
// ref could move before `worktree add` runs, and starting a branch from a
// remote-tracking NAME makes git set its upstream, after which a bare `git push`
// inside the task's worktree would target the base branch.
async function selectStartPoint(repoPath: string, localBase: string): Promise<string> {
  const localTip = await git(repoPath, ["rev-parse", localBase || "HEAD"]);
  if (!localBase) return localTip;
  const st = await remoteBaseStatus(repoPath, localBase).catch(() => noRemoteStatus());
  return st.canFastForward && st.remoteTip ? st.remoteTip : localTip;
}

// The commit an EXISTING task branch grew from. Used whenever the branch is
// already here (a retried launch, or a reopened task whose merged worktree was
// pruned): callers persist whatever we return as `base_sha`, so handing back
// today's tip would move the goalposts and erase the task's own work from its
// own diff. The fork point is the honest answer.
async function forkPointSha(repoPath: string, branch: string, localBase: string): Promise<string> {
  if (localBase) {
    const fork = await git(repoPath, ["merge-base", branch, localBase]).catch(() => "");
    if (fork) return fork;
  }
  return git(repoPath, ["rev-parse", localBase || "HEAD"]).catch(() => "");
}

/**
 * Create an isolated git worktree + branch for a task, branched from the
 * project's configured base branch (`baseBranch`) when it exists, else from the
 * repo's current HEAD. Basing off the configured branch matters: `mergeTask`
 * lands the task INTO that branch, so branching from whatever the main checkout
 * happens to have checked out would make tasks base off one branch and merge
 * into another. Returns the worktree path and branch, or `null` when isolation
 * isn't possible (not a git repo, or no commits yet) — the caller then falls
 * back to running directly in the project's repo path.
 *
 * When the base branch has a remote and is simply behind it, the task is cut
 * from the fetched remote tip instead — see `selectStartPoint`. The user's local
 * base branch is never moved as a side effect of launching a task.
 *
 * `baseBranch` in the result is the branch the cut ACTUALLY used — the requested
 * one, or "" when it didn't exist and the fallback to HEAD applied. That's what
 * the launch paths pin into `tasks.base_branch`: after the cut the task owns the
 * answer, because `baseSha` came from that branch and nothing else can be true
 * (see lib/baseBranch.ts).
 */
export async function ensureWorktree(
  repoPath: string,
  taskId: string,
  baseBranch?: string
): Promise<{ path: string; branch: string; baseSha: string; baseBranch: string } | null> {
  // Refresh the remote-tracking ref BEFORE taking the lock. A fetch only writes
  // refs/remotes/*, so it's safe alongside anything else in the repo, and holding
  // the per-repo lock across a network round trip would park every other task
  // launch behind one slow connection. Cannot throw; the guard is belt and braces.
  if (baseBranch) await fetchBase(repoPath, baseBranch).catch(() => {});
  // Serialize with merges and other worktree creations on the same repo: both
  // touch the shared worktree registry / read HEAD for the base sha, and a merge
  // racing this could hand back a base_sha read off a transient HEAD.
  return withRepoLock(repoPath, () => ensureWorktreeLocked(repoPath, taskId, baseBranch));
}

/**
 * Whether `wtPath` is a worktree `repoPath` currently has linked. Compared by
 * real path, since either side can reach the same directory through a symlink
 * (on macOS /var is one, and TMPDIR lives under it).
 *
 * Conservative on failure: if the registry can't be read, the answer is "yes,
 * it's ours" — the caller reacts to a `false` by deleting the directory, and a
 * git hiccup must never be grounds for that.
 */
async function isLinkedWorktree(repoPath: string, wtPath: string): Promise<boolean> {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  let listed: string;
  try {
    listed = await git(repoPath, ["worktree", "list", "--porcelain"]);
  } catch {
    return true;
  }
  const target = real(wtPath);
  return listed
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .some((line) => real(line.slice("worktree ".length).trim()) === target);
}

async function ensureWorktreeLocked(
  repoPath: string,
  taskId: string,
  baseBranch?: string
): Promise<{ path: string; branch: string; baseSha: string; baseBranch: string } | null> {
  // Greenfield (non-git) or commitless repo: initialize it so the task can be
  // isolated. Without this, every Calandria-created project — which starts
  // as a bare folder — would silently skip isolation and have nothing to diff.
  if (!(await isGitRepo(repoPath))) await initRepo(repoPath);
  else if (!(await hasCommit(repoPath))) await baseCommit(repoPath);
  // If init didn't take (e.g. permissions), fall back to running in repo_path.
  if (!(await isGitRepo(repoPath)) || !(await hasCommit(repoPath))) return null;

  const wtPath = path.join(WORKTREES_DIR, taskId);
  // A branch already under this task's name — either spelling — means the task
  // ran before, so this is a reattach, not a fresh start: its base is where it
  // forked, not the tip as of now, and the branch it gets is the one its
  // commits are on.
  const existing = await existingTaskBranch(repoPath, taskId);
  const branch = existing ?? branchForTask(taskId);
  // The configured base branch if it exists, else current HEAD. The fallback
  // must stay — a freshly-initialized repo may have an unborn or differently-named
  // default branch, and a misconfigured project shouldn't block task isolation.
  const localBase = baseBranch && (await branchExists(repoPath, baseBranch)) ? baseBranch : "";

  const reattaching = existing !== null;
  const baseSha = reattaching
    ? await forkPointSha(repoPath, branch, localBase)
    : await selectStartPoint(repoPath, localBase);
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });

  // Already linked (e.g. retry after a failed first launch) — reuse it, but
  // only once it's THIS repo's. Worktree paths are keyed by task id and nothing
  // else, so a task that changed projects (POST /move with the worktree torn
  // down) can find the old project's checkout still sitting at the path it
  // wants — if teardown half-failed, or the process died between removing it
  // and committing the move. Reusing that would run the agent against the repo
  // the task just left, and diff and merge against it too. A leftover that
  // isn't registered here is an orphan by definition: clear it and cut fresh.
  if (fs.existsSync(wtPath)) {
    if (await isLinkedWorktree(repoPath, wtPath)) return { path: wtPath, branch, baseSha, baseBranch: localBase };
    try {
      fs.rmSync(wtPath, { recursive: true, force: true });
    } catch {
      // Can't clear it and can't trust it; running in repo_path unisolated is
      // the lesser evil versus committing into someone else's repo.
      return null;
    }
  }

  try {
    await git(repoPath, ["worktree", "add", "-b", branch, wtPath, baseSha]);
  } catch {
    // Branch may already exist from a prior generation; attach to it instead.
    await git(repoPath, ["worktree", "add", wtPath, branch]);
  }
  return { path: wtPath, branch, baseSha, baseBranch: localBase };
}

/**
 * Best-effort teardown of a task's worktree. Never throws.
 *
 * By default this also deletes the task's branch (full teardown, as on task or
 * project delete). Pass `{ keepBranch: true }` to reclaim the worktree's disk
 * while preserving the branch — that's what the "prune merged worktrees"
 * cleanup does, since the branch is the diff base for reopening an old task and
 * deleting it would lose the ability to view that task's changes.
 *
 * The two halves are independent: a task pruned that way has a branch and no
 * worktree, and full teardown of THAT still has to delete the branch.
 */
export async function removeWorktree(
  repoPath: string,
  wtPath: string,
  branch: string,
  opts: { keepBranch?: boolean } = {}
): Promise<void> {
  if (!wtPath && !branch) return;
  if (wtPath) {
    try {
      await git(repoPath, ["worktree", "remove", "--force", wtPath]);
    } catch {
      // Fall back to removing the directory and pruning the stale registration.
      try {
        fs.rmSync(wtPath, { recursive: true, force: true });
        await git(repoPath, ["worktree", "prune"]);
      } catch {}
    }
  }
  if (branch && !opts.keepBranch) {
    try {
      await git(repoPath, ["branch", "-D", branch]);
    } catch {}
  }
}

/**
 * Disk footprint of a worktree directory in bytes (actual blocks used, via
 * `du`), or 0 if it's gone or can't be measured. Used to show how much a stale
 * merged worktree is costing before the user decides to prune it.
 */
export async function worktreeDiskUsage(wtPath: string): Promise<number> {
  if (!wtPath || !fs.existsSync(wtPath)) return 0;
  try {
    // -s: summary for the dir; -k: 1024-byte blocks (portable across macOS/Linux).
    const { stdout } = await run("du", ["-sk", wtPath]);
    const kb = parseInt(stdout.trim().split(/\s+/)[0], 10);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

// ---------- prune safety ----------

export interface PruneSafety {
  safe: boolean; // removing the worktree would lose no work
  isDirty: boolean; // uncommitted changes present (discarded by `remove --force`)
  ahead: number; // commits on the work branch not yet in the base branch
  reason?: string; // why it's unsafe — surfaced to the user
}

/**
 * Whether a merged task's worktree can be removed WITHOUT losing work — the
 * safety gate for the "prune merged worktrees" cleanup.
 *
 * `merged_at` only records that a task was merged AT LEAST ONCE, and it's never
 * cleared, but the product supports merging several rounds while continuing to
 * iterate. So a task flagged "merged" may since have grown work that is NOT in
 * the base branch. Removing its worktree would then be silent data loss:
 * `git worktree remove --force` discards uncommitted edits, and (with
 * delete-branch) `git branch -D` orphans commits made after the merge.
 *
 * Unsafe when the worktree is dirty (uncommitted edits) OR the work branch is
 * ahead of the base branch (commits not yet merged). Read-only; never mutates.
 *
 * The two halves are independent: with no worktree there are no uncommitted
 * edits to lose, but the BRANCH can still be carrying unmerged commits — the
 * exact shape a task left in by "prune merged worktrees" (worktree reclaimed,
 * branch kept), whose commits a later full teardown would orphan.
 */
export async function worktreePruneSafety(input: {
  repoPath: string;
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
}): Promise<PruneSafety> {
  const { repoPath, worktreePath, workBranch, baseBranch } = input;

  const isDirty = worktreePath
    ? (await git(worktreePath, ["status", "--porcelain"]).catch(() => "")).trim().length > 0
    : false;

  // Commits on the work branch that the base branch hasn't yet absorbed. Compared
  // against the base BRANCH (not the recorded base_sha) so it reflects git reality
  // regardless of merged_at bookkeeping.
  let ahead = 0;
  if (workBranch && (await branchExists(repoPath, workBranch)) && (await branchExists(repoPath, baseBranch))) {
    ahead = parseInt(await git(repoPath, ["rev-list", "--count", `${baseBranch}..${workBranch}`]).catch(() => "0"), 10) || 0;
  }

  const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
  const reason =
    isDirty && ahead > 0
      ? `uncommitted changes + ${commits(ahead)} not yet in ${baseBranch || "the base branch"}`
      : isDirty
        ? "uncommitted changes not saved to any branch"
        : ahead > 0
          ? `${commits(ahead)} not yet in ${baseBranch || "the base branch"}`
          : undefined;

  return { safe: !isDirty && ahead === 0, isDirty, ahead, reason };
}

// ---------- diff ----------

export interface DiffFile {
  path: string;
  status: string; // A | M | D | R | ? (untracked)
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string; // this file's own unified diff
  truncated?: boolean; // this file's patch was clipped
}

export interface TaskDiff {
  base: string; // resolved base commit/ref
  baseLabel: string; // human label (branch name or short sha)
  files: DiffFile[];
  isDirty: boolean; // uncommitted changes present in the worktree
  ahead: number; // commits on the branch beyond base
  alreadyMerged: boolean; // every branch commit is reachable from the base branch
}

const MAX_FILE_PATCH = 60_000;

const stdoutOf = (e: unknown): string =>
  e && typeof e === "object" && "stdout" in e ? String((e as { stdout: unknown }).stdout ?? "") : "";
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// How much of an untracked file to read when synthesizing its patch. The
// per-file patch is clipped to MAX_FILE_PATCH anyway; this just keeps a giant
// stray artifact from being pulled into memory whole.
const UNTRACKED_READ_CAP = 1 << 20;

// Untracked files aren't in `git diff <base>` — synthesize each one's
// "new file" patch straight from disk instead of spawning
// `git diff --no-index /dev/null <path>` per file.
async function untrackedFileDiff(worktreePath: string, p: string): Promise<DiffFile> {
  const f: DiffFile = { path: p, status: "?", additions: 0, deletions: 0, binary: false, patch: "", truncated: false };
  let buf: Buffer;
  let mode = "100644";
  try {
    const abs = path.join(worktreePath, p);
    const st = await fs.promises.lstat(abs);
    if (st.isSymbolicLink()) {
      buf = Buffer.from(await fs.promises.readlink(abs));
      mode = "120000";
    } else if (st.size <= UNTRACKED_READ_CAP) {
      if (st.mode & 0o111) mode = "100755";
      buf = await fs.promises.readFile(abs);
    } else {
      if (st.mode & 0o111) mode = "100755";
      const fh = await fs.promises.open(abs, "r");
      try {
        buf = Buffer.alloc(UNTRACKED_READ_CAP);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        buf = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      f.truncated = true;
    }
  } catch {
    return f; // vanished or unreadable between ls-files and here
  }
  f.binary = buf.subarray(0, 8000).includes(0); // git's own heuristic: a NUL byte in the first 8k
  const header = `diff --git a/${p} b/${p}\nnew file mode ${mode}`;
  if (f.binary) {
    f.patch = `${header}\nBinary files /dev/null and b/${p} differ`;
  } else if (buf.length === 0) {
    f.patch = header; // empty new file: header only, no hunk — matches git
  } else {
    const text = buf.toString("utf8");
    const endsNl = text.endsWith("\n");
    const lines = (endsNl ? text.slice(0, -1) : text).split("\n");
    f.additions = lines.length;
    f.patch =
      `${header}\n--- /dev/null\n+++ b/${p}\n` +
      `@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@\n` +
      lines.map((l) => `+${l}`).join("\n") +
      (endsNl ? "" : "\n\\ No newline at end of file");
  }
  if (f.patch.length > MAX_FILE_PATCH) {
    f.patch = f.patch.slice(0, MAX_FILE_PATCH);
    f.truncated = true;
  }
  return f;
}

// Resolve a usable diff base inside the worktree: prefer the stored base sha,
// fall back to the merge-base with the project's base branch, then the root commit.
async function resolveBase(worktreePath: string, baseSha: string, baseBranch: string): Promise<string> {
  if (baseSha) {
    try {
      await git(worktreePath, ["cat-file", "-e", `${baseSha}^{commit}`]);
      // The stored snapshot goes stale when the worktree is caught up to the
      // base branch outside the app (e.g. `git merge origin/main` in the
      // terminal): diffing from it re-reports every already-merged commit as
      // task changes. If the live merge-base has moved strictly forward from
      // the snapshot, diff from it instead. When the snapshot is NOT an
      // ancestor of the live merge-base (base branch rebased/rewritten), keep
      // the snapshot — a rewritten base must not silently move the goalposts.
      if (baseBranch) {
        try {
          const liveBase = await git(worktreePath, ["merge-base", baseBranch, "HEAD"]);
          if (liveBase && liveBase !== baseSha) {
            await git(worktreePath, ["merge-base", "--is-ancestor", baseSha, liveBase]);
            return liveBase;
          }
        } catch {}
      }
      return baseSha;
    } catch {}
  }
  if (baseBranch) {
    try {
      return await git(worktreePath, ["merge-base", baseBranch, "HEAD"]);
    } catch {}
  }
  try {
    const roots = await git(worktreePath, ["rev-list", "--max-parents=0", "HEAD"]);
    return roots.split("\n").filter(Boolean).pop() || "HEAD";
  } catch {
    return "HEAD";
  }
}

/**
 * Just the totals — for the board card footer, polled every few seconds
 * alongside the task list. One subprocess (plus resolveBase's own cat-file
 * check), versus taskDiff's whole-tree patch + untracked reads + ahead-count.
 * No baseBranch: the polling caller doesn't have it handy, and the
 * live-rebase-drift correction resolveBase does with one is a refinement this
 * cheap path doesn't need.
 */
export async function taskDiffStat(
  repoPath: string,
  worktreePath: string,
  baseSha: string
): Promise<{ additions: number; deletions: number; files: number }> {
  // resolveBase's unresolvable-baseSha fallback walks all the way back to the
  // repo's first commit (rev-list --max-parents=0) — exactly wrong for this
  // cheap polling path, which would then diff the entire history and cache a
  // huge bogus stat. Verify baseSha resolves in the worktree first; if it
  // doesn't (pruned after a squash-merge or gc), fail closed — the caller
  // already catches and just omits diff_add/diff_del for that task.
  await git(worktreePath, ["cat-file", "-e", `${baseSha}^{commit}`]);
  const base = await resolveBase(worktreePath, baseSha, "");
  const numstat = await git(worktreePath, ["diff", "--numstat", base, "--"]).catch(() => "");
  let additions = 0, deletions = 0, files = 0;
  for (const line of numstat.split("\n")) {
    if (!line) continue;
    const [add, del] = line.split("\t");
    files++;
    if (add === "-" || del === "-") continue; // binary — numstat has no counts
    additions += parseInt(add, 10) || 0;
    deletions += parseInt(del, 10) || 0;
  }
  return { additions, deletions, files };
}

/**
 * Everything a task changed versus its base: committed + uncommitted tracked
 * changes (`git diff <base>`) plus untracked files (shown as additions).
 */
export async function taskDiff(
  repoPath: string,
  worktreePath: string,
  baseSha: string,
  baseBranch: string
): Promise<TaskDiff> {
  const base = await resolveBase(worktreePath, baseSha, baseBranch);
  const baseLabel = baseBranch || base.slice(0, 7);

  const files: DiffFile[] = [];
  const byPath = new Map<string, DiffFile>();

  // All of these are read-only — one concurrent round instead of sequential
  // subprocess spawns (each spawn alone costs 10–40ms before git does
  // anything). File lists use -z so unusual paths arrive raw (no c-quoting,
  // no tab-splitting ambiguity); the patch is ONE whole-tree diff, split per
  // file below, instead of one `git diff` per changed path.
  const [nameStatus, numstat, treePatch, untrackedOut, statusOut, aheadOut, mergedAncestor] = await Promise.all([
    git(worktreePath, ["diff", "--name-status", "-z", base, "--"]).catch(() => ""),
    git(worktreePath, ["diff", "--numstat", "-z", base, "--"]).catch(() => ""),
    git(worktreePath, ["diff", base, "--"]).catch(() => null),
    git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]).catch(() => ""),
    git(worktreePath, ["status", "--porcelain"]).catch(() => ""),
    git(worktreePath, ["rev-list", "--count", `${base}..HEAD`]).catch(() => ""),
    // Already merged if every commit on this branch is reachable from the base
    // branch. Catches merges done outside the app's merge button (CLI, etc).
    // `--is-ancestor` exits 0 when HEAD is an ancestor of baseBranch, 1 otherwise.
    baseBranch
      ? git(worktreePath, ["merge-base", "--is-ancestor", "HEAD", baseBranch]).then(() => true).catch(() => false)
      : Promise.resolve(false),
  ]);

  // `--name-status -z`: STATUS NUL PATH NUL, with renames/copies carrying
  // src NUL dst NUL. The dst path is the file's identity, as before.
  const ns = nameStatus.split("\0");
  for (let i = 0; i + 1 < ns.length; ) {
    const status = ns[i][0];
    const twoPaths = status === "R" || status === "C";
    const p = twoPaths ? ns[i + 2] : ns[i + 1];
    i += twoPaths ? 3 : 2;
    if (!p) continue;
    const f: DiffFile = { path: p, status, additions: 0, deletions: 0, binary: false, patch: "" };
    byPath.set(p, f);
    files.push(f);
  }
  // `--numstat -z`: ADD TAB DEL TAB PATH NUL — except renames/copies, where
  // the inline path is empty and src NUL dst NUL follow.
  const num = numstat.split("\0");
  for (let i = 0; i < num.length; ) {
    const entry = num[i++];
    if (!entry) continue;
    const [add, del, inlinePath] = entry.split("\t");
    let p = inlinePath;
    if (!p) {
      p = num[i + 1];
      i += 2;
    }
    const f = byPath.get(p);
    if (!f) continue;
    if (add === "-" || del === "-") f.binary = true;
    else {
      f.additions = parseInt(add, 10) || 0;
      f.deletions = parseInt(del, 10) || 0;
    }
  }

  // Split the whole-tree patch on its per-file headers. Headers c-quote
  // unusual paths, so never parse paths out of them — patch sections come out
  // in the same path-sorted order as --name-status, so zip by position. Any
  // surprise (unmerged entries emit no patch section, an overflowed exec
  // buffer nulls treePatch) falls back to one `git diff` per file.
  const chunks = treePatch === null ? null : treePatch === "" ? [] : treePatch.split(/\n(?=diff --git )/);
  if (chunks && chunks.length === files.length && chunks.every((c) => c.startsWith("diff --git "))) {
    files.forEach((f, i) => {
      let p = chunks[i];
      if (p.length > MAX_FILE_PATCH) {
        p = p.slice(0, MAX_FILE_PATCH);
        f.truncated = true;
      }
      f.patch = p;
    });
  } else if (files.length) {
    await mapLimit(files, 8, async (f) => {
      let p = await git(worktreePath, ["diff", base, "--", f.path]).catch(() => "");
      if (p.length > MAX_FILE_PATCH) {
        p = p.slice(0, MAX_FILE_PATCH);
        f.truncated = true;
      }
      f.patch = p;
    });
  }

  // Untracked files: synthesized from disk (bounded fan-out keeps fd use sane).
  const untracked = untrackedOut.split("\0").filter(Boolean);
  files.push(...(await mapLimit(untracked, 8, (p) => untrackedFileDiff(worktreePath, p))));

  const isDirty = statusOut.trim().length > 0;
  const ahead = parseInt(aheadOut, 10) || 0;

  return { base, baseLabel, files, isDirty, ahead, alreadyMerged: mergedAncestor };
}

// ---------- merge ----------

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  if (!branch) return false;
  try {
    await git(repoPath, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function currentBranch(repoPath: string): Promise<string> {
  try {
    return await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return "";
  }
}

/** Stage + commit everything in the worktree. Returns false if nothing to commit. */
export async function commitWorktree(worktreePath: string, message: string): Promise<boolean> {
  const dirty = (await git(worktreePath, ["status", "--porcelain"]).catch(() => "")).trim().length > 0;
  if (!dirty) return false;
  await git(worktreePath, ["add", "-A"]);
  try {
    await git(worktreePath, ["commit", "-m", message, "--no-verify"]);
  } catch {
    // No committer identity configured — commit with a local fallback.
    await git(worktreePath, [...FALLBACK_IDENTITY, "commit", "-m", message, "--no-verify"]);
  }
  return true;
}

export interface MergeResult {
  ok: boolean;
  targetBranch: string;
  committed: boolean;
  alreadyMerged?: boolean;
  conflicts?: string[];
  error?: string;
  mergedSha?: string; // the work-branch tip that was merged — the new diff base
  additions?: number; // line stats of what this merge landed on the target
  deletions?: number; // (absent when alreadyMerged / stats couldn't be read)
  dirty?: DirtyEntry[]; // in-place merge refused: what's uncommitted in the MAIN checkout
  dirtyTruncated?: boolean; // `dirty` was clipped at DIRTY_CAP
  stashed?: StashRestore; // set when the merge ran after stashing that dirt aside
}

/** One `git status --porcelain` entry of a repo's main working tree. */
export interface DirtyEntry {
  code: string; // raw two-char XY status ("??" untracked, " M" modified, "A " added, …)
  path: string;
  untracked: boolean;
}

/** What became of the stash an acknowledged `stashDirty` merge set aside. */
export interface StashRestore {
  restored: boolean; // put back on top of the merged tree
  sha: string; // the stash commit — how to get the work back if it wasn't
  label: string;
  error?: string;
}

// Enough to identify a tool dropping or a forgotten edit; a checkout with more
// dirt than this is not one the merge card can usefully enumerate.
const DIRTY_CAP = 100;

/**
 * What is uncommitted in the repo's main working tree, parsed rather than merely
 * counted. An in-place merge refuses on ANY dirt, and a bare refusal leaves the
 * user debugging blind — in practice the blocker is often a tool dropping (a
 * hook-written .gitattributes, an editor scratch file) rather than their own
 * work, which they can only find out by going to a terminal. `-z` so paths with
 * spaces or quotes arrive literal instead of git-quoted.
 */
export async function repoDirtyEntries(repoPath: string): Promise<DirtyEntry[]> {
  // Raw, not `git()`: the status code's first column is a SPACE for a file that
  // is modified but unstaged, and trimming stdout would eat it — turning " M
  // file.txt" into a path of "ile.txt", i.e. an offer to stash a file that
  // doesn't exist.
  const out = await run("git", ["-C", repoPath, "status", "--porcelain", "-z"], { maxBuffer: 64 * 1024 * 1024 })
    .then((r) => r.stdout)
    .catch(() => "");
  const fields = out.split("\0").filter(Boolean);
  const entries: DirtyEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i].slice(0, 2);
    const p = fields[i].slice(3); // read before skipping — the skipped field is a path too
    // A rename/copy spends a second NUL-separated field on the source path.
    if (code[0] === "R" || code[0] === "C") i++;
    entries.push({ code, path: p, untracked: code === "??" });
  }
  return entries;
}

// A stash entry this app created, held by SHA: stash refs renumber under every
// other push, and this stack is shared with the user's own shells.
interface StashHandle {
  sha: string;
  label: string;
}

async function stashMainTree(repoPath: string, label: string): Promise<StashHandle> {
  await git(repoPath, ["stash", "push", "--include-untracked", "-m", label]);
  return { sha: await git(repoPath, ["rev-parse", "refs/stash"]), label };
}

/**
 * Put stashed work back on top of the merged tree. `apply` then `drop`, never
 * `pop`: the stash stack is shared with every linked worktree of the repo and
 * with any shell the user has open, so the entry is re-found BY SHA before it's
 * dropped rather than trusting `stash@{0}` to still be ours. A failed apply
 * keeps the entry and says so — the work is recoverable from the sha, and
 * silently dropping it would be the one unrecoverable outcome here.
 */
async function restoreStash(repoPath: string, stash: StashHandle): Promise<StashRestore> {
  const { sha, label } = stash;
  try {
    // --index also restores what was staged; it fails on its own when the index
    // can't be reconstructed, so fall back to a plain apply — but only while the
    // tree is still untouched, so a partial apply can't be applied twice.
    try {
      await git(repoPath, ["stash", "apply", "--index", sha]);
    } catch (e) {
      if ((await repoDirtyEntries(repoPath)).length) throw e;
      await git(repoPath, ["stash", "apply", sha]);
    }
  } catch (e) {
    return { restored: false, sha, label, error: gitErrorLine(e, "could not restore your stashed changes") };
  }
  // Re-find the entry immediately before dropping it (see above). Best-effort:
  // a leftover entry is duplicated work, never lost work.
  const list = await git(repoPath, ["stash", "list", "--format=%H %gd"]).catch(() => "");
  const ref = list.split("\n").find((l) => l.startsWith(`${sha} `))?.split(" ")[1];
  if (ref) await git(repoPath, ["stash", "drop", ref]).catch(() => {});
  return { restored: true, sha, label };
}

// The refusal an in-place merge gives a dirty main checkout, carrying the dirt
// itself so the UI can show WHAT is in the way (and offer to set it aside).
function dirtyRefusal(target: string, committed: boolean, dirty: DirtyEntry[]): MergeResult {
  return {
    ok: false,
    targetBranch: target,
    committed,
    dirty: dirty.slice(0, DIRTY_CAP),
    ...(dirty.length > DIRTY_CAP ? { dirtyTruncated: true } : {}),
    error: `the repo's working tree has uncommitted changes in ${dirty.length} file(s) — commit or stash them before merging`,
  };
}

// Paths that are dirty NOW but weren't in the list the user acknowledged. The
// acknowledgement is by path, like the bulk-move discards: a user who agreed to
// set three files aside must not have a fourth swept up because the tree moved
// while the card sat on screen. Dirt that has since gone away needs no consent.
function unacknowledgedDirt(ack: string[], dirty: DirtyEntry[]): string[] {
  const acked = new Set(ack);
  return dirty.map((d) => d.path).filter((p) => !acked.has(p));
}

// Line stats of the merge that just completed in `dir`: ORIG_HEAD (the target's
// pre-merge tip, set by `git merge`) → HEAD. Read immediately after a successful
// merge, before the throwaway worktree is torn down — worktrees don't survive
// their task, so merge time is the only chance to persist these. Best-effort:
// a failure just omits the stats. Binary files count 0 ("-" in numstat).
async function mergeLineStats(dir: string, from = "ORIG_HEAD", to = "HEAD"): Promise<{ additions: number; deletions: number } | null> {
  try {
    const out = await git(dir, ["diff", "--numstat", from, to]);
    let additions = 0, deletions = 0;
    for (const line of out.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!m) continue;
      if (m[1] !== "-") additions += parseInt(m[1], 10);
      if (m[2] !== "-") deletions += parseInt(m[2], 10);
    }
    return { additions, deletions };
  } catch {
    return null;
  }
}

// Best-effort teardown of the throwaway merge worktree. Never throws.
async function removeMergeWorktree(repoPath: string, tmp: string): Promise<void> {
  try {
    await git(repoPath, ["worktree", "remove", "--force", tmp]);
  } catch {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      await git(repoPath, ["worktree", "prune"]);
    } catch {}
  }
}

// Object-level merge of `workBranch` into `target` — see the fast-path note in
// `mergeIntoTargetWorktree`. Returns null when this git can't do it (merge-tree
// --write-tree needs git ≥ 2.38) or anything unexpected happens, in which case
// the caller falls back to the throwaway-worktree merge; conflicts are a real
// result (the worktree path would hit the same ones), not a fallback case.
async function mergeViaTree(input: {
  repoPath: string;
  target: string;
  workBranch: string;
  message: string;
  committed: boolean;
  mergedSha?: string;
}): Promise<MergeResult | null> {
  const { repoPath, target, workBranch, message, committed, mergedSha } = input;

  let tree: string;
  try {
    tree = (await git(repoPath, ["merge-tree", "--write-tree", target, workBranch])).split("\n")[0].trim();
  } catch (e) {
    const out = stdoutOf(e);
    if (!out.trim()) return null; // merge-tree unsupported or errored — use the worktree path
    const conflicts = parseMergeTreeConflicts(out);
    if (!conflicts.length) return null; // unrecognized output — let the real merge decide
    return {
      ok: false,
      targetBranch: target,
      committed,
      conflicts,
      error: `merge conflicts in ${conflicts.length} file(s)`,
    };
  }
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return null;

  try {
    const [oldTip, workTip] = await Promise.all([
      git(repoPath, ["rev-parse", `refs/heads/${target}`]),
      git(repoPath, ["rev-parse", workBranch]),
    ]);
    const args = ["commit-tree", tree, "-p", oldTip, "-p", workTip, "-m", message];
    let commit: string;
    try {
      commit = await git(repoPath, args);
    } catch {
      // No committer identity configured — same fallback as commitWorktree.
      commit = await git(repoPath, [...FALLBACK_IDENTITY, ...args]);
    }
    // Passing the old tip makes the update atomic: if anything moved the branch
    // since we read it, git refuses instead of silently discarding that move.
    await git(repoPath, ["update-ref", `refs/heads/${target}`, commit, oldTip]);
    const stats = await mergeLineStats(repoPath, oldTip, commit);
    return { ok: true, targetBranch: target, committed, mergedSha, ...(stats ?? {}) };
  } catch {
    return null; // any hiccup (at worst a dangling commit object) → real merge is the source of truth
  }
}

/**
 * Land `workBranch` into `target` WITHOUT touching the user's main working tree,
 * by doing the merge inside a throwaway linked worktree checked out on `target`.
 * Only valid when `target` is NOT the branch checked out in the main repo (git
 * refuses to check out the same branch in two worktrees) — the caller guarantees
 * that. Because the main tree is never touched, the merge needs no clean-tree
 * check and no branch restore, so it can never strand the user's checkout.
 */
async function mergeIntoTargetWorktree(input: {
  repoPath: string;
  target: string;
  workBranch: string;
  message: string;
  committed: boolean;
  mergedSha?: string;
}): Promise<MergeResult> {
  const { repoPath, target, workBranch, message, committed, mergedSha } = input;

  // Fast path (git ≥ 2.38): merge at the object level — `merge-tree
  // --write-tree` computes the merged tree, `commit-tree` wraps it in a merge
  // commit, `update-ref` advances the target branch. No working tree is ever
  // materialized. The fallback below checks out the ENTIRE repo into a
  // throwaway worktree just to run one merge and delete it — on any non-trivial
  // repo that checkout is the dominant cost of clicking Merge.
  const fast = await mergeViaTree(input);
  if (fast) return fast;

  const tmp = path.join(WORKTREES_DIR, `.merge-${target.replace(/[^A-Za-z0-9._-]/g, "_")}`);
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  // Clear any stale merge worktree left behind by a prior crash before reusing the path.
  await removeMergeWorktree(repoPath, tmp);

  try {
    await git(repoPath, ["worktree", "add", tmp, target]);
  } catch (e) {
    return { ok: false, targetBranch: target, committed, error: `cannot prepare merge worktree for ${target}: ${msgOf(e)}` };
  }

  try {
    await git(tmp, ["merge", "--no-ff", "-m", message, workBranch]);
  } catch (e) {
    const conflicts = (await git(tmp, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
      .split("\n")
      .filter(Boolean);
    await git(tmp, ["merge", "--abort"]).catch(() => {});
    await removeMergeWorktree(repoPath, tmp);
    return {
      ok: false,
      targetBranch: target,
      committed,
      conflicts: conflicts.length ? conflicts : undefined,
      error: conflicts.length ? `merge conflicts in ${conflicts.length} file(s)` : `merge failed: ${msgOf(e)}`,
    };
  }

  const stats = await mergeLineStats(tmp);
  await removeMergeWorktree(repoPath, tmp);
  return { ok: true, targetBranch: target, committed, mergedSha, ...(stats ?? {}) };
}

/**
 * Land a task's branch into the base branch. Commits any uncommitted work first,
 * then merges — serialized per repo (see `withRepoLock`) so concurrent merges
 * can't race the main tree's HEAD/index.
 *
 * When the base branch is NOT the one checked out in the main repo, the merge is
 * done in a throwaway worktree so the user's checkout is never touched. When the
 * base branch IS checked out, the merge happens in place in the main tree (which
 * must be clean); a prior crash that stranded that tree mid-merge (MERGE_HEAD
 * set) is recovered with `merge --abort` instead of blocking forever. Conflicts
 * abort cleanly either way.
 *
 * `baseSha` — the commit the task was cut from — is optional but worth passing.
 * A task branched from the remote tip (see `ensureWorktree`) carries the remote's
 * commits as well as its own, and merging it wholesale would fold both into one
 * commit whose line counts credit the task with everything that arrived from the
 * remote. Given the base sha, the base branch is fast-forwarded to it first, so
 * what lands afterwards is only the task's own work.
 *
 * `stashDirty` is the user's answer to the dirty-main-tree refusal above: the
 * exact paths they were shown and agreed to have set aside, which are stashed
 * before the merge and restored after it. Absent (the default), a dirty tree is
 * still just a refusal — now one that names the files.
 */
export async function mergeTask(input: {
  repoPath: string;
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
  message: string;
  baseSha?: string;
  stashDirty?: string[];
}): Promise<MergeResult> {
  const { repoPath, worktreePath, workBranch, baseBranch, message, baseSha, stashDirty } = input;

  let committed = false;
  try {
    committed = await commitWorktree(worktreePath, message);
  } catch (e) {
    return { ok: false, targetBranch: baseBranch, committed, error: `commit failed: ${msgOf(e)}` };
  }

  // The branch tip now holds all of the task's work; this becomes the next diff
  // base so a subsequent round shows only changes made after this merge.
  const mergedSha = (await git(repoPath, ["rev-parse", workBranch]).catch(() => "")) || undefined;

  return withRepoLock(repoPath, async () => {
    // Recover a repo stranded mid-merge by a prior crash: an unfinished merge in
    // the MAIN tree leaves MERGE_HEAD set and the tree "dirty", which would
    // otherwise block EVERY future merge on the dirty check below. Aborting
    // returns it to the pre-merge branch tip — a clean, known state — so merges
    // are never permanently wedged.
    if ((await worktreeMergeStatus(repoPath)).mergeInProgress) {
      await git(repoPath, ["merge", "--abort"]).catch(() => {});
    }

    // Target: the configured base branch if it exists, else the repo's current branch.
    const current = await currentBranch(repoPath);
    const target = (await branchExists(repoPath, baseBranch)) ? baseBranch : current || baseBranch;

    // Nothing to land? Answered before anything mutates — a re-click on an
    // already-merged task is "up to date" even when the checkout is dirty, and
    // with nothing to merge the base advance below is provably a no-op (baseSha
    // is an ancestor of the work branch, which the target already contains).
    try {
      const ahead = parseInt(await git(repoPath, ["rev-list", "--count", `${target}..${workBranch}`]), 10) || 0;
      if (ahead === 0) return { ok: true, targetBranch: target, committed, alreadyMerged: true, mergedSha };
    } catch {}

    // Merging in place needs a clean main tree — both for the merge itself and
    // for the fast-forward below, which git refuses when it would overwrite an
    // uncommitted file. Dirt is where this used to end, with the user told to
    // "commit or stash" and no idea what the dirt was; now the refusal carries
    // the file list, and a user who has SEEN that list can ask for it to be
    // stashed aside for the merge (`stashDirty`) and put back afterwards.
    let stash: StashHandle | null = null;
    if (target === current) {
      const dirty = await repoDirtyEntries(repoPath);
      if (dirty.length) {
        if (!stashDirty) return dirtyRefusal(target, committed, dirty);
        const unacked = unacknowledgedDirt(stashDirty, dirty);
        if (unacked.length)
          return {
            ...dirtyRefusal(target, committed, dirty),
            error: `the working tree changed since you reviewed it — ${unacked.length} file(s) you didn't agree to stash are now uncommitted (${unacked
              .slice(0, 3)
              .join(", ")}); review them and try again`,
          };
        try {
          stash = await stashMainTree(repoPath, `calandria: set aside to merge ${workBranch}`);
        } catch (e) {
          return {
            ...dirtyRefusal(target, committed, dirty),
            error: gitErrorLine(e, "could not stash the checkout's uncommitted changes"),
          };
        }
      }
    }

    const merge = async (): Promise<MergeResult> => {
      // Catch the target up to the commit the task was cut from, when that commit
      // is already on the work branch and strictly ahead of the target — the shape
      // a task cut from the remote tip leaves behind. Purely a tidy-up: it makes
      // the merge below contain only the task's own work. Best-effort, because
      // every reason it can fail (diverged branch, dirty checkout, a linked
      // worktree holding the branch) is one the plain merge handles anyway.
      if (baseSha) {
        const onWorkBranch = await git(repoPath, ["merge-base", "--is-ancestor", baseSha, workBranch])
          .then(() => true)
          .catch(() => false);
        if (onWorkBranch) await advanceBaseBranchLocked(repoPath, target, baseSha);
      }

      // Base branch isn't the main checkout → merge in a throwaway worktree so the
      // user's working tree (and its uncommitted edits) are never touched.
      if (target !== current) {
        return mergeIntoTargetWorktree({ repoPath, target, workBranch, message, committed, mergedSha });
      }

      // Base branch IS the main checkout → merge in place, in a tree the gate
      // above guaranteed clean. A failed merge is aborted so we never leave the
      // user mid-merge (and so a stash can be restored onto a sane tree).
      try {
        await git(repoPath, ["merge", "--no-ff", "-m", message, workBranch]);
      } catch (e) {
        const conflicts = (await git(repoPath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
          .split("\n")
          .filter(Boolean);
        await git(repoPath, ["merge", "--abort"]).catch(() => {});
        return {
          ok: false,
          targetBranch: target,
          committed,
          conflicts: conflicts.length ? conflicts : undefined,
          error: conflicts.length ? `merge conflicts in ${conflicts.length} file(s)` : `merge failed: ${msgOf(e)}`,
        };
      }

      const stats = await mergeLineStats(repoPath);
      return { ok: true, targetBranch: target, committed, mergedSha, ...(stats ?? {}) };
    };

    // Whatever the merge did, the borrowed work goes back — a failed merge
    // must leave the checkout exactly as dirty as it found it.
    const res = await merge().catch((e): MergeResult => ({
      ok: false,
      targetBranch: target,
      committed,
      error: `merge failed: ${msgOf(e)}`,
    }));
    return stash ? { ...res, stashed: await restoreStash(repoPath, stash) } : res;
  });
}

// ---------- LLM-assisted conflict resolution ----------
//
// When `mergeTask` reports conflicts it aborts in the shared main tree, leaving
// no state to fix. To resolve them, we instead replay the merge the *other*
// direction — base INTO the work branch — but inside the task's ISOLATED
// worktree, leaving the conflict markers in place. Claude (or the user) then
// resolves them there, never touching the shared main tree. Once resolved, the
// work branch contains the base, so `completeWorktreeMerge` lands it cleanly via
// the normal `mergeTask` path.

// A per-worktree ref marking the pre-merge tip of a resolution merge the app
// itself started (via `prepareWorktreeMerge`). `abortWorktreeMerge` uses it to
// undo ONLY that merge — never a merge commit the app didn't create (e.g. a prior
// `sync` of the base branch). Refs under `refs/worktree/` are per-worktree, so
// parallel tasks each get their own marker and never collide on the shared ref
// store. See `abortWorktreeMerge` for the full lifecycle (set here → cleared on
// abort or a successful `completeWorktreeMerge`).
const MERGE_ABORT_REF = "refs/worktree/calandria-merge-abort";
// A merge prepared before the rename recorded its marker under the old name. A
// paused merge lives in the worktree, not the DB, so it can outlive a deploy —
// aborting has to still find it. Read (and cleared) as well as the new name;
// only ever written under the new one.
const LEGACY_MERGE_ABORT_REF = "refs/worktree/orch-merge-abort";

async function setMergeAbortMarker(worktreePath: string): Promise<void> {
  await git(worktreePath, ["update-ref", MERGE_ABORT_REF, "HEAD"]).catch(() => {});
}

/** The recorded pre-merge tip, from either ref name; "" when there's no marker. */
async function readMergeAbortMarker(worktreePath: string): Promise<string> {
  for (const ref of [MERGE_ABORT_REF, LEGACY_MERGE_ABORT_REF]) {
    const sha = (await git(worktreePath, ["rev-parse", "-q", "--verify", ref]).catch(() => "")).trim();
    if (sha) return sha;
  }
  return "";
}

async function clearMergeAbortMarker(worktreePath: string): Promise<void> {
  for (const ref of [MERGE_ABORT_REF, LEGACY_MERGE_ABORT_REF]) {
    await git(worktreePath, ["update-ref", "-d", ref]).catch(() => {});
  }
}

/** Conflict-resolution state of a task's worktree (survives reloads). */
export interface WorktreeMergeStatus {
  mergeInProgress: boolean; // a merge is paused mid-flight (MERGE_HEAD present)
  unresolved: string[]; // files still flagged unmerged in the index
}

export async function worktreeMergeStatus(worktreePath: string): Promise<WorktreeMergeStatus> {
  if (!worktreePath) return { mergeInProgress: false, unresolved: [] };
  const mergeInProgress = await git(worktreePath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])
    .then(() => true)
    .catch(() => false);
  const indexUnresolved = (await git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
    .split("\n")
    .filter(Boolean);
  if (!indexUnresolved.length) return { mergeInProgress, unresolved: [] };
  // The index flags a file unmerged until it's staged, but resolution turns (AI
  // or an editor) rewrite the markers out WITHOUT `git add` — going by the index
  // alone tells the user "still unresolved" about content that is fine. Trust
  // content over index: a text file with no markers left is resolved (accept
  // stages everything anyway). Binaries can never carry markers, so they stay
  // unresolved until staged explicitly.
  const [withMarkers, binaries] = await Promise.all([
    conflictMarkerFiles(worktreePath, indexUnresolved),
    binaryConflictFiles(worktreePath, indexUnresolved),
  ]);
  const binarySet = new Set(binaries);
  return { mergeInProgress, unresolved: indexUnresolved.filter((f) => withMarkers.has(f) || binarySet.has(f)) };
}

// Of the given unmerged files, those whose WORKING-TREE content still contains
// conflict markers. `git diff --check` prints "<path>:<line>: leftover conflict
// marker" per marker (exiting non-zero) and goes silent for a file once it has
// been edited marker-free — staged or not.
async function conflictMarkerFiles(worktreePath: string, candidates: string[]): Promise<Set<string>> {
  const out = await git(worktreePath, ["diff", "--check", "--", ...candidates]).catch((e) => stdoutOf(e));
  const files = new Set<string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^(.+?):\d+: leftover conflict marker/);
    if (m) files.add(m[1]);
  }
  return files;
}

// Of the given unmerged files, those git treats as binary — these can't be
// resolved by editing markers and must be handled manually. During a conflict
// `git diff` emits a *combined* ("--cc") diff, whose --numstat reports 0/0 (not
// '-'/'-') even for binaries, so we instead detect the textual "Binary files
// differ" marker git prints under each file's `diff --cc <path>` header.
async function binaryConflictFiles(worktreePath: string, candidates: string[]): Promise<string[]> {
  if (!candidates.length) return [];
  const out = await git(worktreePath, ["diff", "--diff-filter=U"]).catch(() => "");
  const binary = new Set<string>();
  let current = "";
  for (const line of out.split("\n")) {
    const m = line.match(/^diff --(?:cc|combined) (.+)$/);
    if (m) {
      current = m[1];
    } else if (current && /^Binary files /.test(line)) {
      binary.add(current);
    }
  }
  return candidates.filter((f) => binary.has(f));
}

export interface PrepareMergeResult {
  ok: boolean;
  clean: boolean; // merged with no conflicts (nothing left to resolve)
  conflicts: string[]; // text files with conflicts — resolvable by AI/editor
  binaryConflicts: string[]; // binary/unmergeable files — need manual handling
  error?: string;
}

/**
 * Trial-merge the base branch INTO the task's work branch inside its isolated
 * worktree, leaving conflict markers in place (no abort) so they can be resolved
 * there. Commits any pending worktree edits first. A clean result means the
 * later `completeWorktreeMerge` will land trivially.
 */
export async function prepareWorktreeMerge(input: {
  repoPath: string;
  worktreePath: string;
  baseBranch: string;
  message: string;
}): Promise<PrepareMergeResult> {
  const { repoPath, worktreePath, baseBranch, message } = input;
  const fail = (error: string): PrepareMergeResult => ({ ok: false, clean: false, conflicts: [], binaryConflicts: [], error });
  if (!worktreePath) return fail("this task has no isolated worktree");
  if (!(await branchExists(repoPath, baseBranch))) return fail(`base branch ${baseBranch} not found`);

  // Already mid-merge (e.g. a prior prepare, or a reload) — report its conflicts
  // rather than starting a second merge on top.
  const pre = await worktreeMergeStatus(worktreePath);
  if (pre.mergeInProgress) {
    const binaryConflicts = await binaryConflictFiles(worktreePath, pre.unresolved);
    return { ok: true, clean: false, conflicts: pre.unresolved.filter((f) => !binaryConflicts.includes(f)), binaryConflicts };
  }

  // Work branch already contains the base tip — nothing to merge, so skip the
  // commit + merge machinery entirely. Re-running prepare after a half-completed
  // accept (or a raced second sync) would otherwise stack a pointless
  // sync-titled commit onto an already-synced branch.
  const alreadySynced = await git(worktreePath, ["merge-base", "--is-ancestor", baseBranch, "HEAD"])
    .then(() => true)
    .catch(() => false);
  if (alreadySynced) return { ok: true, clean: true, conflicts: [], binaryConflicts: [] };

  // Commit pending edits so the merge runs against a clean tree.
  try {
    await commitWorktree(worktreePath, message);
  } catch (e) {
    return fail(`commit failed: ${msgOf(e)}`);
  }

  // Record the pre-merge tip so a later `abortWorktreeMerge` can undo strictly the
  // merge we're about to create — and nothing else (see MERGE_ABORT_REF).
  await setMergeAbortMarker(worktreePath);

  try {
    await git(worktreePath, ["merge", "--no-ff", "-m", message, baseBranch]);
    return { ok: true, clean: true, conflicts: [], binaryConflicts: [] };
  } catch {
    const unresolved = (await git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""))
      .split("\n")
      .filter(Boolean);
    if (!unresolved.length) {
      // Failed for a non-conflict reason — abort to keep the worktree clean.
      await git(worktreePath, ["merge", "--abort"]).catch(() => {});
      await clearMergeAbortMarker(worktreePath);
      return fail("merge failed");
    }
    const binaryConflicts = await binaryConflictFiles(worktreePath, unresolved);
    return { ok: true, clean: false, conflicts: unresolved.filter((f) => !binaryConflicts.includes(f)), binaryConflicts };
  }
}

/**
 * Undo a conflict-resolution merge the app itself started, returning to the
 * pre-merge tip. Deliberately narrow: it will only ever discard a merge recorded
 * by `prepareWorktreeMerge` (the MERGE_ABORT_REF marker) — never a merge commit
 * that happens to sit at HEAD for some other reason (e.g. a `sync` of the base
 * branch), and never over uncommitted edits the app didn't create. When there's
 * nothing the app started to abort, it's a true no-op.
 */
export async function abortWorktreeMerge(worktreePath: string): Promise<void> {
  if (!worktreePath) return;
  const { mergeInProgress } = await worktreeMergeStatus(worktreePath);
  if (mergeInProgress) {
    // A paused merge (MERGE_HEAD present) — `merge --abort` restores the pre-merge
    // tip and working tree atomically. Safe regardless of who started the merge.
    await git(worktreePath, ["merge", "--abort"]).catch(() => {});
    await clearMergeAbortMarker(worktreePath);
    return;
  }

  // No merge is paused. Claude may have committed the resolution merge itself. We
  // undo it ONLY if it's the one the app started — identified by the marker ref at
  // its pre-merge tip. Guessing from HEAD's parent count (the old behaviour) also
  // matched an ordinary sync merge and would `reset --hard` away that commit AND
  // any uncommitted work — real data loss.
  const marker = await readMergeAbortMarker(worktreePath);
  if (!marker) return; // nothing the app started to abort → no-op

  try {
    // The recorded merge must still be exactly at HEAD: a merge commit whose first
    // parent is the marker. If the worktree has moved on (more commits landed on
    // top), resetting would destroy that later work — so we leave it alone.
    const parents = (await git(worktreePath, ["rev-list", "--parents", "-n", "1", "HEAD"]).catch(() => ""))
      .split(" ")
      .filter(Boolean);
    const isOurMerge = parents.length >= 3 && parents[1] === marker;

    // Never reset over a dirty tree — uncommitted edits made after the merge aren't
    // part of what the app created and must not be silently discarded.
    const dirty = (await git(worktreePath, ["status", "--porcelain"]).catch(() => "")).trim().length > 0;

    if (isOurMerge && !dirty) await git(worktreePath, ["reset", "--hard", marker]).catch(() => {});
  } finally {
    await clearMergeAbortMarker(worktreePath);
  }
}

// ---------- sync the worktree to the latest base branch ----------
//
// An old task's worktree is branched from a stale base_sha; while it sat idle the
// base branch (main) moved on. These helpers drive a divergence-based sync — NOT
// wall-clock age — so a reopened task can be brought up to date before follow-up
// work piles more changes on top of stale code.

export interface SyncStatus {
  behind: number; // commits on the base branch not yet in the work branch
  ahead: number; // divergent commits on the work branch not in the base branch
  isDirty: boolean; // uncommitted changes in the worktree
  canFastForward: boolean; // no divergent work + clean tree → a zero-risk fast-forward
  clean: boolean; // a trial merge of base→work has no conflicts
  conflicts: string[]; // files that would conflict on merge (when not clean)
  baseTip: string; // the base branch tip — the new diff base after a successful sync
  mergeInProgress: boolean; // a base→work merge is paused in the worktree (MERGE_HEAD present), awaiting accept/discard
  unresolved: string[]; // while paused: files still carrying markers (or unstaged binaries) — `conflicts` mirrors this
}

/**
 * Divergence of a task's work branch versus the base branch, plus a NON-DESTRUCTIVE
 * conflict prediction (via `git merge-tree`) so a banner can show clean-vs-conflicts
 * before the user clicks anything. Read-only: never mutates the worktree.
 */
export async function worktreeSyncStatus(input: {
  repoPath: string;
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
}): Promise<SyncStatus> {
  const { repoPath, worktreePath, workBranch, baseBranch } = input;
  const none: SyncStatus = { behind: 0, ahead: 0, isDirty: false, canFastForward: false, clean: true, conflicts: [], baseTip: "", mergeInProgress: false, unresolved: [] };
  if (!worktreePath || !workBranch) return none;
  const [baseOk, workOk] = await Promise.all([branchExists(repoPath, baseBranch), branchExists(repoPath, workBranch)]);
  if (!baseOk || !workOk) return none;

  const countOf = async (range: string) => parseInt(await git(repoPath, ["rev-list", "--count", range]).catch(() => "0"), 10) || 0;
  const [baseTip, behind, ahead, isDirty] = await Promise.all([
    git(repoPath, ["rev-parse", baseBranch]).catch(() => ""),
    countOf(`${workBranch}..${baseBranch}`),
    countOf(`${baseBranch}..${workBranch}`),
    git(worktreePath, ["status", "--porcelain"]).catch(() => "").then((s) => s.trim().length > 0),
  ]);
  const idle = { mergeInProgress: false, unresolved: [] as string[] };

  // Already up to date — nothing to sync; skip the (relatively costly) conflict probe.
  if (behind === 0) return { behind, ahead, isDirty, canFastForward: false, clean: true, conflicts: [], baseTip, ...idle };

  // A base→work merge paused in the worktree (prepareWorktreeMerge left the
  // conflicts for a resolution turn or an editor). The branch tips haven't
  // moved — `behind` is unchanged and merge-tree would re-predict the very
  // conflicts that have since been edited out — so the truth is the worktree's
  // live state: what still carries markers is what's still conflicted, and
  // nothing left means the merge is resolved and only awaits accept/discard.
  // Without this the sync banner re-offered "Fix with AI" over a finished
  // resolution, and a second click launched a turn with nothing to fix.
  const paused = await worktreeMergeStatus(worktreePath);
  if (paused.mergeInProgress) {
    return {
      behind, ahead, isDirty, canFastForward: false, baseTip,
      clean: paused.unresolved.length === 0, conflicts: paused.unresolved,
      mergeInProgress: true, unresolved: paused.unresolved,
    };
  }

  // No divergent commits + clean tree → merging base in is a plain fast-forward
  // (just moves the branch pointer), so there's zero conflict risk.
  if (ahead === 0 && !isDirty) return { behind, ahead, isDirty, canFastForward: true, clean: true, conflicts: [], baseTip, ...idle };

  const conflicts = await predictMergeConflicts(repoPath, baseBranch, workBranch);
  return { behind, ahead, isDirty, canFastForward: false, clean: conflicts.length === 0, conflicts, baseTip, ...idle };
}

// Predict the conflicts of merging `baseBranch` into `workBranch` WITHOUT touching
// any worktree, using `git merge-tree --write-tree` (git ≥ 2.38). A clean merge
// exits 0 with just the result tree's OID; a conflicted merge exits non-zero and
// prints the OID, then a "Conflicted file info" block (`<mode> <object> <stage>\t
// <path>` per line) terminated by a blank line. We collect the unique paths there.
// On an unsupported/failed merge-tree we fall back to "clean" — the real merge
// (prepareWorktreeMerge) will still surface any conflicts when the user syncs.
async function predictMergeConflicts(repoPath: string, baseBranch: string, workBranch: string): Promise<string[]> {
  try {
    await git(repoPath, ["merge-tree", "--write-tree", baseBranch, workBranch]);
    return []; // exit 0 → clean merge
  } catch (e) {
    const out = stdoutOf(e);
    if (!out) return []; // merge-tree unsupported or errored — treat as clean
    return parseMergeTreeConflicts(out);
  }
}

// Parse the conflicted paths out of `git merge-tree --write-tree` output: the
// result-tree OID line, then `<mode> <object> <stage>\t<path>` per conflicted
// entry, terminated by a blank line.
function parseMergeTreeConflicts(out: string): string[] {
  const lines = out.split("\n");
  const conflicts = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "") break; // end of the conflicted-file-info section
    const tab = lines[i].indexOf("\t");
    if (tab >= 0) conflicts.add(lines[i].slice(tab + 1));
  }
  return [...conflicts];
}

/**
 * Fast-forward the work branch to the base branch inside the worktree. Only safe
 * when there are no divergent commits and the tree is clean (see `canFastForward`);
 * returns false if git refuses the fast-forward.
 */
export async function fastForwardWorktree(worktreePath: string, baseBranch: string): Promise<boolean> {
  try {
    await git(worktreePath, ["merge", "--ff-only", baseBranch]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finish a conflict resolution: stage the resolved files, refuse if any conflict
 * markers remain, commit the merge on the work branch, then land it into the base
 * via the normal `mergeTask` path (now conflict-free).
 */
export async function completeWorktreeMerge(input: {
  repoPath: string;
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
  message: string;
  stashDirty?: string[]; // acknowledged main-checkout dirt — see `mergeTask`
}): Promise<MergeResult> {
  const { repoPath, worktreePath, workBranch, baseBranch, message, stashDirty } = input;
  const { mergeInProgress } = await worktreeMergeStatus(worktreePath);

  // Editing a conflicted file leaves it "unmerged" until staged; stage first so a
  // resolved tree commits cleanly, then scan the staged content for stray markers.
  await git(worktreePath, ["add", "-A"]).catch(() => {});
  const check = await git(worktreePath, ["diff", "--cached", "--check"]).catch((e) => stdoutOf(e));
  if (/conflict marker/i.test(check))
    return {
      ok: false,
      targetBranch: baseBranch,
      committed: false,
      error: "conflict markers (<<<<<<< / =======) still remain — resolve them before merging",
    };

  if (mergeInProgress) {
    try {
      await git(worktreePath, ["commit", "--no-edit", "--no-verify"]);
    } catch {
      await git(worktreePath, [...FALLBACK_IDENTITY, "commit", "--no-edit", "--no-verify"]);
    }
  }

  const result = await mergeTask({ repoPath, worktreePath, workBranch, baseBranch, message, stashDirty });
  // The resolution merge has landed — its pre-merge marker is spent. Drop it so a
  // subsequent "discard merge" doesn't try to unwind an already-merged commit.
  if (result.ok) await clearMergeAbortMarker(worktreePath);
  return result;
}
