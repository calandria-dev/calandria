import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { GH_BIN, PROJECTS_DIR } from "./config";
import { findInDirs, findOnPath, type BinLookupOptions } from "./binPath";
import { gitErrorDetail } from "./git";
import type { LandingMode } from "./types";

const run = promisify(execFile);

// ---------- binary resolution ----------

// Where package managers that DON'T land in a minimal system PATH put gh.
// The server process never reads a shell profile (systemd unit, container,
// `npm start` from a non-login context), so linuxbrew/Homebrew/snap installs
// that work fine in the user's terminal ENOENT here without this probe.
//
// The Windows entries are the same story with different package managers:
// winget links and the MSI's Program Files dir are on the PATH of a fresh
// interactive shell but not necessarily of a service, and scoop's shims dir is
// only ever on the user's own PATH. All three ship `gh.exe`, so the PATHEXT
// expansion in lib/binPath.ts is what actually finds them.
const GH_PROBE_DIRS =
  process.platform === "win32"
    ? [
        path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Microsoft", "WinGet", "Links"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "GitHub CLI"),
        path.join(os.homedir(), "scoop", "shims"),
      ]
    : [
        "/home/linuxbrew/.linuxbrew/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/snap/bin",
        path.join(os.homedir(), ".local", "bin"),
      ];

/**
 * The gh binary to spawn: CALANDRIA_GH_BIN if set (taken verbatim — a wrong path
 * should fail loudly, not be silently papered over by the probe), else bare
 * "gh" when the server's PATH can resolve it, else the first hit in the
 * well-known install dirs. Falls back to "gh" so the ENOENT lands in the
 * callers' existing not-installed handling. Re-resolved per call on purpose
 * (a handful of stat()s): installing gh mid-session works on the next click.
 *
 * Bare "gh" stays the answer for a PATH hit on Windows too — CreateProcess
 * repeats the PATH+PATHEXT search itself and finds the same `gh.exe`. What the
 * PATHEXT-aware lookup buys is the probe-dir half: without it every Windows
 * candidate missed (the file is `gh.exe`, never `gh`) and the fallback happened
 * to work only because gh is on PATH. gh ships as a real executable from every
 * Windows package manager, so the `.cmd`-shim problem the codex/claude paths
 * have doesn't arise here.
 */
export function resolveGhBin(
  configured: string = GH_BIN,
  pathEnv: string = process.env.PATH || "",
  probeDirs: string[] = GH_PROBE_DIRS,
  lookup: BinLookupOptions = {},
): string {
  if (configured) return configured;
  if (findOnPath("gh", { ...lookup, pathEnv })) return "gh";
  return findInDirs("gh", probeDirs, lookup) ?? "gh";
}

/**
 * What to tell a human when spawning gh ENOENT'd. "Not installed" was the old
 * message and it sent people the wrong way: the common case is gh IS installed
 * but only the user's shell profile puts it on PATH, which the server process
 * never reads.
 */
export function ghMissingMessage(configured: string = GH_BIN): string {
  if (configured)
    return `GitHub CLI not found: CALANDRIA_GH_BIN is set to "${configured}", which does not exist or is not executable. Fix the path, or unset it to auto-detect`;
  return (
    "GitHub CLI (gh) was not found on the server's PATH. If gh IS installed (Homebrew, snap, ~/.local/bin), the server process doesn't read your shell profile's PATH. Set CALANDRIA_GH_BIN to the binary's full path and restart. Otherwise install it from https://cli.github.com"
  );
}

// GitHub onboarding, built on the `gh` CLI (bundled in the container image).
// All state gh writes — the OAuth token (~/.config/gh/hosts.yml) and the git
// credential-helper config (~/.gitconfig) — lives under $HOME, which is the
// user's persistent volume in production, so a login survives container
// stop/start and sleep/wake with no extra plumbing.
//
// The login itself drives `gh auth login` (device flow) under a pseudo-tty:
// gh insists on a terminal for interactive auth, and the device flow is the
// only one that needs zero local browser. We parse the one-time code + URL
// out of its output so the UI can show them instead of burying them in
// terminal scrollback, auto-answer its yes/no prompts, and let gh do the
// polling until the user authorizes on github.com.

// ---------- status ----------

export interface GhStatus {
  installed: boolean;
  authenticated: boolean;
  login: string | null;
}

/** Is gh present, and is anyone logged in to github.com? */
export async function ghStatus(): Promise<GhStatus> {
  try {
    const { stdout, stderr } = await run(resolveGhBin(), ["auth", "status", "--hostname", "github.com"], { timeout: 15_000 });
    // "✓ Logged in to github.com account <login> (keyring)" (or "as <login>" on older gh).
    const m = `${stdout}\n${stderr}`.match(/Logged in to \S+ (?:account|as) ([\w-]+)/);
    return { installed: true, authenticated: true, login: m ? m[1] : null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { installed: false, authenticated: false, login: null };
    return { installed: true, authenticated: false, login: null };
  }
}

export async function ghLogout(): Promise<void> {
  await run(resolveGhBin(), ["auth", "logout", "--hostname", "github.com"], { timeout: 15_000 });
}

// ---------- device-flow login session ----------

export interface LoginSession {
  status: "starting" | "awaiting" | "success" | "error";
  code: string | null; // the one-time code to enter on github.com
  url: string | null; // where to enter it (github.com/login/device)
  user: string | null; // login name once authorized
  error: string | null;
}

interface LoginState extends LoginSession {
  proc: IPty | null;
  buf: string; // cumulative ANSI-stripped output
  answered: Set<string>; // prompts already replied to (each fires once)
  timer: ReturnType<typeof setTimeout> | null;
}

// One session per app instance (= per user: each user runs their own container).
// Kept on globalThis so every route chunk that imports this module sees the
// same session regardless of how Next bundles them.
const g = globalThis as unknown as { __calandriaGhLogin?: LoginState };

// CSI sequences (colors, cursor moves), OSC sequences (titles), save/restore
// cursor (ESC 7 / ESC 8 — strip the digit too, or it leaks into the text),
// then any stray ESCs.
const stripAnsi = (s: string) =>
  s
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b[78]/g, "")
    .replace(/\u001b/g, "");

// gh's prompt library probes the terminal before rendering anything — OSC 11
// (background color, for its light/dark scheme) and CSI 6n (cursor position,
// also used as a bottom-right probe to measure the screen) — and BLOCKS until
// each query is answered. We are the terminal here, so answer every query in
// the order it appears: a color for OSC 11, and a cursor report for CSI 6n
// (the full claimed size when it follows a move-to-999;999 size probe).
const TERM_QUERY = /\u001b(\]11;\?|\[6n|\[999;999f)/g;
function answerTermQueries(proc: IPty, chunk: string, size: { rows: number; cols: number }) {
  let sizeProbe = false;
  for (const m of chunk.matchAll(TERM_QUERY)) {
    if (m[1] === "]11;?") proc.write("\u001b]11;rgb:1e1e/1e1e/1e1e\u001b\\");
    else if (m[1] === "[999;999f") sizeProbe = true;
    else {
      proc.write(sizeProbe ? `\u001b[${size.rows};${size.cols}R` : "\u001b[1;1R");
      sizeProbe = false;
    }
  }
}

const publicView = (st: LoginState): LoginSession => ({
  status: st.status,
  code: st.code,
  url: st.url,
  user: st.user,
  error: st.error,
});

export function getLogin(): LoginSession | null {
  return g.__calandriaGhLogin ? publicView(g.__calandriaGhLogin) : null;
}

export function cancelLogin(): void {
  const st = g.__calandriaGhLogin;
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  try {
    st.proc?.kill();
  } catch {}
  delete g.__calandriaGhLogin;
}

/**
 * Start (or return the already-running) device-flow login. Resolves once the
 * one-time code has been parsed from gh's output — or earlier on error — so
 * the UI can render the code immediately; the session keeps running in the
 * background until the user authorizes on github.com (poll with getLogin).
 */
export async function startLogin(): Promise<LoginSession> {
  const cur = g.__calandriaGhLogin;
  if (cur && (cur.status === "starting" || cur.status === "awaiting")) return awaitCode();
  cancelLogin(); // clear any finished (success/error) session

  const st: LoginState = {
    status: "starting",
    code: null,
    url: null,
    user: null,
    error: null,
    proc: null,
    buf: "",
    answered: new Set(),
    timer: null,
  };
  g.__calandriaGhLogin = st;

  try {
    // BROWSER=true: gh "opens" the verification URL with /bin/true instead of
    // erroring on a headless box — the user opens the link we show in the UI.
    st.proc = ptySpawn(resolveGhBin(), ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"], {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: os.homedir(),
      env: { ...process.env, BROWSER: "true", GH_NO_UPDATE_NOTIFIER: "1" } as Record<string, string>,
    });
  } catch (e) {
    st.status = "error";
    st.error = `could not start gh: ${e instanceof Error ? e.message : String(e)}`;
    return publicView(st);
  }

  // The device-flow code expires after ~15 min; reap a forgotten session.
  st.timer = setTimeout(() => {
    if (st.status === "starting" || st.status === "awaiting") {
      st.status = "error";
      st.error = "login expired. The one-time code is only valid for 15 minutes";
      try {
        st.proc?.kill();
      } catch {}
    }
  }, 16 * 60_000);

  // Reply to a prompt the first time it shows up in the output.
  const answer = (key: string, when: RegExp, reply: string) => {
    if (!st.answered.has(key) && when.test(st.buf)) {
      st.answered.add(key);
      st.proc?.write(reply);
    }
  };

  st.proc.onData((chunk) => {
    if (st.proc) answerTermQueries(st.proc, chunk, { rows: 50, cols: 200 });
    if (st.status === "success" || st.status === "error") return;
    st.buf += stripAnsi(chunk);

    answer("reauth", /already logged in[\s\S]*re-authenticate\?/i, "y\r"); // stale UI: re-auth anyway
    answer("gitcred", /Authenticate Git with your GitHub credentials\?/i, "\r"); // default Yes → credential helper
    answer("open", /Press Enter to open/i, "\r");

    if (!st.code) {
      const m = st.buf.match(/one-time code: ([A-Z0-9]{4,}-[A-Z0-9]{4,})/i);
      if (m) {
        st.code = m[1];
        st.url = st.buf.match(/(https:\/\/github\.com\/login\/device\S*)/)?.[1] ?? "https://github.com/login/device";
        st.status = "awaiting";
      }
    }

    const ok = st.buf.match(/Logged in as ([\w-]+)/);
    if (ok) {
      st.status = "success";
      st.user = ok[1];
      if (st.timer) clearTimeout(st.timer);
      // gh already configured the credential helper (we answered Yes above);
      // run setup-git anyway so a quirky version still leaves git working.
      run(resolveGhBin(), ["auth", "setup-git", "--hostname", "github.com"], { timeout: 15_000 }).catch(() => {});
    }
  });

  st.proc.onExit(({ exitCode }) => {
    if (st.timer) clearTimeout(st.timer);
    if (st.status === "success") return;
    st.status = "error";
    const tail = st.buf
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/one-time code|Press Enter|login\/device/i.test(l))
      .slice(-3)
      .join(" · ");
    st.error = tail || `gh auth login exited with code ${exitCode}`;
  });

  return awaitCode();
}

// Resolve once the session leaves "starting" (code parsed, success, or error);
// give up after 15s and return whatever state we have.
async function awaitCode(): Promise<LoginSession> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const st = g.__calandriaGhLogin;
    if (!st) return { status: "error", code: null, url: null, user: null, error: "login session vanished" };
    if (st.status !== "starting" || Date.now() > deadline) return publicView(st);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------- repos + clone ----------

export interface GhRepo {
  nameWithOwner: string;
  description: string;
  isPrivate: boolean;
  updatedAt: string;
}

/** The user's repos, most recently pushed first (gh's default ordering). */
export async function listRepos(): Promise<GhRepo[]> {
  const { stdout } = await run(
    resolveGhBin(),
    ["repo", "list", "--limit", "200", "--json", "nameWithOwner,description,isPrivate,updatedAt"],
    { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
  );
  return JSON.parse(stdout || "[]") as GhRepo[];
}

// Accepted clone specs. Tight on purpose: these become argv entries, and a
// spec that can't start with "-" can never be mistaken for a flag.
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const HTTPS_URL = /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/?$/;
const SSH_URL = /^git@[\w.-]+:[\w.-]+\/[\w.-]+$/;

export const validRepoSpec = (spec: string): boolean =>
  !spec.startsWith("-") && (OWNER_REPO.test(spec) || HTTPS_URL.test(spec.replace(/\.git$/, "")) || SSH_URL.test(spec.replace(/\.git$/, "")));

/**
 * Clone `spec` (owner/repo or a full URL) into PROJECTS_DIR and report where
 * it landed plus its default branch. Uses gh (authenticated → private repos
 * work) when available, plain git otherwise; never prompts — a private repo
 * without credentials fails fast instead of hanging.
 */
export async function cloneRepo(spec: string): Promise<{ path: string; branch: string }> {
  spec = spec.trim().replace(/\/+$/, "");
  if (!validRepoSpec(spec)) throw new Error("repository must look like owner/repo or a GitHub URL");

  const base = (spec.split("/").pop() || "repo").replace(/\.git$/, "");
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  let dest = path.join(PROJECTS_DIR, base);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(PROJECTS_DIR, `${base}-${i}`);

  const opts = {
    timeout: 10 * 60_000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  };
  // gh only understands GitHub; pasted URLs for other hosts go to plain git.
  const githubSpec = OWNER_REPO.test(spec) || /^(https:\/\/|git@)github\.com[/:]/.test(spec);
  const { installed, authenticated } = await ghStatus();
  try {
    if (installed && authenticated && githubSpec) {
      await run(resolveGhBin(), ["repo", "clone", spec, dest], opts);
    } else {
      const url = OWNER_REPO.test(spec) ? `https://github.com/${spec}.git` : spec;
      await run("git", ["clone", url, dest], opts);
    }
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true }); // no half-clones
    throw new Error(cliErrorMessage(e, "clone failed"));
  }

  let branch = "main";
  try {
    branch = (await run("git", ["-C", dest, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "main";
  } catch {}
  return { path: dest, branch };
}

// Distill git/gh's stderr wall into the line that says what actually failed.
function cliErrorMessage(e: unknown, fallback: string): string {
  const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr: unknown }).stderr ?? "") : "";
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const fatal = lines.find((l) => /^(fatal|error)[:\s]/i.test(l)) || lines.find((l) => /could not|denied|not found|terminal prompts disabled|already exists|no commits between/i.test(l));
  if (fatal) return fatal.replace(/^(fatal|error):\s*/i, "");
  if (lines.length) return lines[lines.length - 1];
  return e instanceof Error ? e.message : fallback;
}

// ---------- landing-mode detection ----------

export interface LandingProbe {
  /** What the repo says. null = we could not tell (no gh, no auth, no remote, API error). */
  mode: LandingMode | null;
  /** One line for a human: why this is the answer. Always set. */
  reason: string;
  /** Which probe answered — "rules" (a ruleset), "protection" (classic branch protection), "none" (neither). */
  source?: "rules" | "protection" | "none";
}

/** Run `gh api <path>` in the repo and parse the JSON, or null on any failure. */
async function ghApi(repoPath: string, apiPath: string): Promise<unknown | null> {
  try {
    const { stdout } = await run(resolveGhBin(), ["api", "-H", "Accept: application/vnd.github+json", apiPath], {
      cwd: repoPath,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    return JSON.parse(stdout || "null");
  } catch {
    // Includes the ordinary 404 from an unprotected branch, which the caller
    // distinguishes by having got an answer from the other probe.
    return null;
  }
}

/**
 * Does this repo's base branch require a pull request? The answer preselects a
 * project's `landing_mode`; it never writes one (see the route and the settings
 * form — detection proposes, a human saves).
 *
 * Two probes, because GitHub has two independent mechanisms and neither one
 * reports the other:
 *
 *  1. `repos/{owner}/{repo}/rules/branches/{base}` — the EFFECTIVE rules for one
 *     branch. This is the right call rather than listing `rulesets` and matching
 *     their ref patterns client-side: GitHub already does that matching, across
 *     org-level parent rulesets too, and a hand-rolled `~ALL`/`refs/heads/*`
 *     glob matcher would be a second, worse implementation of it. A rule of type
 *     `pull_request` is the requirement we are looking for.
 *  2. `repos/{owner}/{repo}/branches/{base}/protection` — classic branch
 *     protection, which predates rulesets and does NOT appear in (1). Its
 *     `required_pull_request_reviews` says the same thing. 404 here is the
 *     ordinary "not protected" answer, which is why a failed call is not an
 *     error on its own.
 *
 * `{owner}/{repo}` are gh's own placeholders, resolved from the repo in `cwd`,
 * so this needs no remote parsing. Never throws: everything that can go wrong
 * (gh missing, logged out, private repo, no network, a branch name the API
 * rejects) comes back as `mode: null` with a reason, and null means "leave the
 * project's current setting alone".
 */
export async function detectLandingMode(repoPath: string, baseBranch: string): Promise<LandingProbe> {
  const repo = repoPath.trim();
  if (!repo) return { mode: null, reason: "There is no working directory, so there is no repository to check." };

  // An unnamed branch means "whatever this checkout is on" — the New project
  // dialog has a folder but no branch field yet, and the branch the person is
  // standing on is the one they are about to work against.
  const base =
    baseBranch.trim() ||
    (await run("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 15_000 })
      .then((r) => r.stdout.trim())
      .catch(() => ""));
  if (!base || base === "HEAD")
    return { mode: null, reason: "No base branch to check: name one, or check out the branch this project builds on." };

  const st = await ghStatus();
  if (!st.installed) return { mode: null, reason: ghMissingMessage() };
  if (!st.authenticated)
    return { mode: null, reason: "gh is not logged in to GitHub, so branch rules can't be read. Connect GitHub in Settings, then detect again." };

  const remote = await run("git", ["-C", repo, "remote", "get-url", "origin"], {
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
    .then((r) => r.stdout.trim())
    .catch(() => "");
  if (!remote) return { mode: null, reason: "This repo has no origin remote, so it has no branch rules to read. Merge is the only way it can land." };

  // The branch name is a path segment. Encode everything but "/", which the API
  // takes literally in a branch path (feature/x is .../branches/feature/x).
  const ref = base.split("/").map(encodeURIComponent).join("/");

  const rules = await ghApi(repo, `repos/{owner}/{repo}/rules/branches/${ref}`);
  if (Array.isArray(rules)) {
    const pr = rules.find((r) => (r as { type?: string })?.type === "pull_request");
    if (pr) return { mode: "pr", reason: `A branch ruleset on ${base} requires a pull request.`, source: "rules" };
  }

  const protection = await ghApi(repo, `repos/{owner}/{repo}/branches/${ref}/protection`);
  if (protection && typeof protection === "object" && "required_pull_request_reviews" in protection)
    return { mode: "pr", reason: `Branch protection on ${base} requires a pull request.`, source: "protection" };

  // Only claim "merge" when a probe actually answered. Both failing means we
  // learned nothing — a private repo the token can't read looks exactly like an
  // unprotected one from here, and reporting "merge" would be a guess dressed
  // as a finding.
  if (Array.isArray(rules))
    return { mode: "merge", reason: `Nothing on ${base} requires a pull request, so work can land by merge.`, source: "none" };
  return { mode: null, reason: `GitHub did not answer for ${base}. It may be private to this login, or the branch may not exist on the remote.` };
}

// ---------- pull requests ----------

export interface CreatePrResult {
  ok: boolean;
  url?: string;
  existing?: boolean; // an open PR for this branch already existed — the push updated it
  error?: string;
  detail?: string; // hook/rejection output beyond the one-line push error, if any
}

/**
 * Compose the PR body from what the task knows about itself: the description,
 * the latest session summary (the condensed "what happened" from /clear, when
 * one exists), and an attribution footer. Pure — exported for tests.
 */
export function buildPrBody(input: { description?: string; summary?: string; taskId: string }): string {
  const parts: string[] = [];
  if (input.description?.trim()) parts.push(input.description.trim());
  if (input.summary?.trim()) parts.push(`## Session summary\n\n${input.summary.trim()}`);
  parts.push(`---\n_Opened by Calandria (task ${input.taskId})._`);
  return parts.join("\n\n");
}

/**
 * Push a task's work branch to origin and open a GitHub PR against the base
 * branch via `gh pr create`. Idempotent: if an open PR for the branch already
 * exists, the push just updated it and its URL is returned (`existing: true`).
 * Never throws — every failure mode (no gh, not logged in, no remote, push
 * rejected, gh error) comes back as `{ ok: false, error }` with a message that
 * says what to do about it.
 */
export async function createTaskPr(input: {
  worktreePath: string;
  workBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<CreatePrResult> {
  const { worktreePath, workBranch, baseBranch, title, body } = input;

  const st = await ghStatus();
  if (!st.installed) return { ok: false, error: ghMissingMessage() };
  if (!st.authenticated)
    return { ok: false, error: "gh is not logged in to GitHub. Connect GitHub in Settings (or run `gh auth login`), then try again" };

  const opts = {
    cwd: worktreePath,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    // Never hang on a credential or confirmation prompt — fail with gh/git's message instead.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
  };

  const remote = await run("git", ["-C", worktreePath, "remote", "get-url", "origin"], opts)
    .then((r) => r.stdout.trim())
    .catch(() => "");
  if (!remote)
    return { ok: false, error: "this repo has no origin remote. Push it to GitHub first (e.g. `gh repo create`), then try again" };

  try {
    await run("git", ["-C", worktreePath, "push", "-u", "origin", workBranch], opts);
  } catch (e) {
    const detail = gitErrorDetail(e);
    return { ok: false, error: `push failed: ${cliErrorMessage(e, "git push errored")}`, ...(detail ? { detail } : {}) };
  }

  // Already an open PR for this branch? The push above just updated it.
  try {
    const { stdout } = await run(resolveGhBin(), ["pr", "list", "--head", workBranch, "--state", "open", "--json", "url", "--limit", "1"], opts);
    const found = JSON.parse(stdout || "[]") as { url?: string }[];
    if (found[0]?.url) return { ok: true, url: found[0].url, existing: true };
  } catch {
    // listing failed — fall through and let `pr create` speak for itself
  }

  try {
    // `--flag=value` form so a title/body that begins with "-" can't be read as a flag.
    const { stdout } = await run(
      resolveGhBin(),
      ["pr", "create", `--head=${workBranch}`, `--base=${baseBranch}`, `--title=${title}`, `--body=${body}`],
      opts
    );
    const url = stdout.match(/https:\/\/\S+\/pull\/\d+/)?.[0];
    if (!url) return { ok: false, error: "gh did not report a PR URL. Check the repo on GitHub" };
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: `could not create the PR: ${cliErrorMessage(e, "gh pr create errored")}` };
  }
}

// ---------- pull-request state ----------

/**
 * The PR number in a GitHub PR URL (…/pull/42), or 0 when there isn't one.
 * Parsed ONCE, at create time, into tasks.pr_number — the UI used to re-derive
 * it from the URL on every render.
 */
export function parsePrNumber(url: string): number {
  const m = /\/pull\/(\d+)/.exec(url || "");
  return m ? Number(m[1]) : 0;
}

/** Where a PR sits. Mirrors gh's `state`, lowercased. */
export type PrState = "open" | "merged" | "closed";
/**
 * The check rollup, collapsed to the three answers a human acts on. "none" is
 * NOT "passing": a repo with no CI at all must not render a green tick.
 */
export type PrChecks = "pending" | "passing" | "failing" | "none";

/**
 * One red check, named and linkable. "checks failing" is a verdict nobody can
 * act on: the whole point of surfacing a red PR is to say WHICH job broke and
 * where its log is, so the answer is one click away rather than a trip to the
 * Actions tab to find out.
 */
export interface PrFailingCheck {
  /** The job/context name, as GitHub shows it ("test (20.x)", "typecheck"). */
  name: string;
  /** The run/job URL, or "" when the entry carried none. */
  url: string;
  /** The workflow the job belongs to ("Tests"), "" for a legacy status context. */
  workflow: string;
  /** gh's verdict for this one: FAILURE / TIMED_OUT / CANCELLED / … */
  verdict: string;
}

export interface PrSnapshot {
  number: number;
  state: PrState;
  checks: PrChecks;
  /** gh's reviewDecision: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED, "" when review isn't required. */
  review: string;
  /** ms epoch the PR merged, 0 when it hasn't. */
  mergedAt: number;
  /** gh's mergeStateStatus (CLEAN/BLOCKED/DIRTY/BEHIND/…), "" when unknown. */
  mergeState: string;
  /** The red entries behind `checks: "failing"` — empty for every other rollup. */
  failing: PrFailingCheck[];
}

// One entry of gh's statusCheckRollup: a GitHub Actions CheckRun (status +
// conclusion, named by `name` under `workflowName`) or a legacy commit
// StatusContext (state, named by `context`, linked by `targetUrl`). Both shapes
// come back in the same array, which is why each field is optional here.
interface RollupEntry {
  __typename?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  name?: string;
  context?: string;
  detailsUrl?: string;
  targetUrl?: string;
  workflowName?: string;
}

// The one verdict an entry carries, whichever shape it is.
//   CheckRun: `conclusion`, and only once `status` is COMPLETED — an
//     in-flight run's conclusion is null, not a pass.
//   StatusContext: `state` is the verdict outright.
// "" means "nothing decided yet".
function verdictOf(e: RollupEntry): string {
  const raw = (e.status !== undefined ? (e.status === "COMPLETED" ? e.conclusion : "") : e.state) || "";
  return raw.toUpperCase();
}

// A check run only has a verdict once it has COMPLETED; anything else (QUEUED,
// IN_PROGRESS, WAITING, PENDING, REQUESTED) is still in flight. SKIPPED and
// NEUTRAL are deliberately "passing" — GitHub itself counts them as green, and
// a path-filtered workflow that skipped must not read as a stalled PR.
const CHECK_PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const CHECK_FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE", "ERROR"]);

/**
 * Collapse gh's per-check array into one answer. Pure — exported for tests.
 *
 * Precedence is failing > pending > passing, which is the order a human cares
 * about: one red check makes the PR red however many green ones surround it,
 * and a still-running check can't be called green yet.
 */
export function rollupChecks(entries: RollupEntry[] | null | undefined): PrChecks {
  if (!entries || entries.length === 0) return "none";
  let pending = false;
  let failing = false;
  for (const e of entries) {
    const v = verdictOf(e);
    if (!v || v === "PENDING" || v === "EXPECTED") pending = true;
    else if (CHECK_FAIL.has(v)) failing = true;
    else if (!CHECK_PASS.has(v)) pending = true; // an unknown verdict is not a pass
  }
  if (failing) return "failing";
  if (pending) return "pending";
  return "passing";
}

// How many red checks are worth keeping. A workflow that fans out over a
// fifteen-entry matrix goes red fifteen times for one bug, and the row this
// lands in is read on every task list — the cap is what stops a JSON column and
// a chip from growing with the matrix.
const MAX_FAILING = 8;

/**
 * The red entries behind a "failing" rollup, in gh's order. Pure — exported for
 * tests, and shares verdictOf() with rollupChecks() so the two can never
 * disagree about which entries are the red ones.
 */
export function failingChecks(entries: RollupEntry[] | null | undefined): PrFailingCheck[] {
  if (!entries) return [];
  const out: PrFailingCheck[] = [];
  for (const e of entries) {
    if (out.length >= MAX_FAILING) break;
    const v = verdictOf(e);
    if (!CHECK_FAIL.has(v)) continue;
    out.push({
      name: String(e.name || e.context || "check"),
      url: String(e.detailsUrl || e.targetUrl || ""),
      workflow: String(e.workflowName || ""),
      verdict: v,
    });
  }
  return out;
}

/** What a refresh came back with: a snapshot, or why it couldn't get one. */
export type PrStateResult = { ok: true; snapshot: PrSnapshot } | { ok: false; error: string; gone?: boolean };

/**
 * Read a PR's current state from GitHub via `gh pr view`. One subprocess, no
 * writes, never throws — the caller is a background job and a dead network, a
 * logged-out gh or a deleted PR must all come back as a reported failure rather
 * than an unhandled rejection in a detached task.
 *
 * `cwd` should be the PROJECT's repo, not the task's worktree: gh resolves the
 * repo from the origin remote, and a task's checkout is reclaimable while its
 * PR is still worth tracking.
 */
export async function fetchPrState(cwd: string, number: number): Promise<PrStateResult> {
  if (!number) return { ok: false, error: "no PR number" };
  const st = await ghStatus();
  if (!st.installed) return { ok: false, error: ghMissingMessage() };
  if (!st.authenticated) return { ok: false, error: "gh is not logged in to GitHub" };

  let stdout: string;
  try {
    ({ stdout } = await run(
      resolveGhBin(),
      ["pr", "view", String(number), "--json", "state,mergedAt,statusCheckRollup,mergeStateStatus,reviewDecision"],
      {
        cwd,
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      }
    ));
  } catch (e) {
    const msg = cliErrorMessage(e, "gh pr view errored");
    // A PR that no longer resolves (deleted repo, wrong remote) is reported
    // separately so the caller can stop asking rather than retry forever.
    const gone = /could not resolve|no pull requests found|not found/i.test(msg);
    return { ok: false, error: msg, ...(gone ? { gone: true } : {}) };
  }

  let raw: {
    state?: string;
    mergedAt?: string | null;
    statusCheckRollup?: RollupEntry[] | null;
    mergeStateStatus?: string | null;
    reviewDecision?: string | null;
  };
  try {
    raw = JSON.parse(stdout || "{}");
  } catch {
    return { ok: false, error: "gh returned output that isn't JSON" };
  }

  const state = String(raw.state || "").toLowerCase();
  const mergedAt = raw.mergedAt ? Date.parse(raw.mergedAt) : 0;
  return {
    ok: true,
    snapshot: {
      number,
      // A merged PR reports state MERGED; anything unrecognized is treated as
      // still open, since "closed" is the claim that would wrongly stop polling.
      state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
      checks: rollupChecks(raw.statusCheckRollup),
      review: String(raw.reviewDecision || ""),
      mergedAt: Number.isFinite(mergedAt) ? mergedAt : 0,
      mergeState: String(raw.mergeStateStatus || ""),
      failing: failingChecks(raw.statusCheckRollup),
    },
  };
}

// A CheckRun's detailsUrl: …/actions/runs/<runId>/job/<jobId>. Both halves are
// wanted, but never together: `gh run view` refuses a run-id AND --job in one
// call, so the job id (when there is one) narrows the log to the job that
// actually went red and the run id is the fallback for a URL without one.
function actionsIds(url: string): { runId: string; jobId: string } | null {
  const m = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url || "");
  if (!m) return null;
  return { runId: m[1], jobId: m[2] || "" };
}

/** The tail of a failed job's log, or why it couldn't be read. */
export type CheckLogResult = { ok: true; log: string } | { ok: false; error: string };

/**
 * The tail of the FAILED steps of one check run's log (`gh run view
 * --log-failed`), which is the part that says what actually broke — a full job
 * log is megabytes of setup and green steps.
 *
 * Best-effort by contract, like every other network call in this file: a legacy
 * status context with no Actions URL, a log GitHub has already expired, a
 * logged-out gh and a dead network all come back as a reported failure. The
 * caller (the "Fix CI" prompt) is still useful with the job NAME alone, so a
 * missing log must degrade rather than fail the click.
 */
export async function fetchCheckLog(cwd: string, url: string, tailLines: number): Promise<CheckLogResult> {
  const ids = actionsIds(url);
  if (!ids) return { ok: false, error: "not a GitHub Actions run" };
  const st = await ghStatus();
  if (!st.installed) return { ok: false, error: ghMissingMessage() };
  if (!st.authenticated) return { ok: false, error: "gh is not logged in to GitHub" };

  // The job form first (one job's failed steps), the whole run as the fallback:
  // a job id can be stale or belong to a re-run, and a fatter log still names
  // the failure.
  const attempts = ids.jobId
    ? [["run", "view", "--job", ids.jobId, "--log-failed"], ["run", "view", ids.runId, "--log-failed"]]
    : [["run", "view", ids.runId, "--log-failed"]];

  let lastError = "";
  for (const args of attempts) {
    try {
      const { stdout } = await run(resolveGhBin(), args, {
        cwd,
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      });
      const lines = String(stdout || "").split("\n").filter((l) => l.trim() !== "");
      if (lines.length === 0) {
        lastError = "GitHub returned no failed-step log";
        continue;
      }
      return { ok: true, log: lines.slice(-tailLines).join("\n") };
    } catch (e) {
      lastError = cliErrorMessage(e, "gh run view errored");
    }
  }
  return { ok: false, error: lastError };
}
