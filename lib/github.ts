import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { GH_BIN, PROJECTS_DIR } from "./config";
import { findInDirs, findOnPath, type BinLookupOptions } from "./binPath";
import { gitErrorDetail } from "./git";

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
    return `GitHub CLI not found: CALANDRIA_GH_BIN is set to "${configured}", which does not exist or is not executable — fix the path, or unset it to auto-detect`;
  return (
    "GitHub CLI (gh) was not found on the server's PATH. If gh IS installed (Homebrew, snap, ~/.local/bin), the server process doesn't read your shell profile's PATH — set CALANDRIA_GH_BIN to the binary's full path and restart. Otherwise install it from https://cli.github.com"
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
      st.error = "login expired — the one-time code is only valid for 15 minutes";
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
    return { ok: false, error: "gh is not logged in to GitHub — connect GitHub in Settings (or run `gh auth login`), then try again" };

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
    return { ok: false, error: "this repo has no origin remote — push it to GitHub first (e.g. `gh repo create`), then try again" };

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
    if (!url) return { ok: false, error: "gh did not report a PR URL — check the repo on GitHub" };
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: `could not create the PR: ${cliErrorMessage(e, "gh pr create errored")}` };
  }
}
