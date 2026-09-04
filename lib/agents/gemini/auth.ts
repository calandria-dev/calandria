// Antigravity (Gemini) auth: status, the guided Google OAuth login, verify,
// and the API-key fallback. The counterpart to lib/agents/codex/auth.ts.
//
// This login runs the real CLI under a pty rather than headless. The headless
// flow (`agy -p "/help"` with stdin held open) prints the authorize URL and
// hard-fails after a 61-second timeout that is not configurable by any flag or
// env var, too short for the real round trip: read the card, open Google in a
// browser, consent, copy the code back. The authorization code is bound to the
// child process's PKCE verifier, so respawning for a fresh window invalidates
// any code the user is holding. The interactive CLI has no such timeout, so the
// login spawns it under a pty, answers its one menu prompt, scrapes the URL,
// and writes the code when the user submits it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentAuthStatus, AgentLoginSession, AgentVerifyResult, AgentApiKeyAuth } from "../types";
import { AGY_CLI_PATH } from "../../config";
import { getSetting, setSetting } from "../../store";
import { GEMINI_API_KEY_HINT } from "./capabilities";

const execFileAsync = promisify(execFile);

const AGY = () => AGY_CLI_PATH || "agy";

/** Never let a self-update replace the pinned binary mid-flow. */
const AGY_ENV = { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" };

/** What a signed-out CLI says, on `agy models` and on a turn. Matched loosely
 *  because the two spellings differ and both mean the same thing. */
const SIGNED_OUT = /please sign in|not logged into antigravity|authentication required/i;

// ---------- status ----------

/**
 * Is the CLI signed in? `agy models` is the cheapest probe: it spends no
 * quota. Two things it has to work around:
 *
 *   - It takes no `--output-format` flag. Passing one makes it exit with a
 *     usage error, so the output is parsed as the TSV (`slug<TAB>label`) it
 *     actually prints.
 *   - It exits 0 either way. A signed-out CLI prints "Error: Please sign in to
 *     view available models." and still returns success, so the exit code says
 *     nothing and the text is the only signal.
 */
export async function geminiStatus(): Promise<AgentAuthStatus> {
  const out = await runAgy(["models"], 60_000);
  const text = `${out.stdout}\n${out.stderr}`;
  if (SIGNED_OUT.test(text)) {
    return { authenticated: false, method: null, email: null, plan: null, error: null };
  }
  if (out.error && !modelSlugs(out.stdout).length) {
    return { authenticated: false, method: null, email: null, plan: null, error: out.error };
  }
  if (!modelSlugs(out.stdout).length) {
    return { authenticated: false, method: null, email: null, plan: null, error: "Could not read the model list" };
  }
  return {
    authenticated: true,
    method: hasApiKey() ? "api key" : "google account",
    // The CLI exposes neither on any no-quota command, so the connect card
    // renders "signed in" without them.
    email: null,
    plan: null,
    error: null,
  };
}

/**
 * The model slugs `agy models` reports right now, using the same probe
 * `geminiStatus()` uses and spending no quota. Used by the gateway health
 * card to check the CLI's own models (side-call model included; the
 * flash-lite the CLI calls on every turn is an ordinary selectable entry
 * here, per docs/AGENTS.md) against the gateway's catalog: a model missing
 * there fails the turn deep inside `agy` with an opaque "Agent execution
 * terminated due to error". Returns null when the status couldn't be
 * determined (signed out, no binary, empty output); the health check reads
 * null as "nothing to compare" rather than "every model is missing".
 */
export async function agyModelSlugs(): Promise<string[] | null> {
  const out = await runAgy(["models"], 60_000);
  if (SIGNED_OUT.test(`${out.stdout}\n${out.stderr}`)) return null;
  const slugs = modelSlugs(out.stdout);
  return slugs.length ? slugs : null;
}

/** Model slugs from `agy models` TSV output, skipping its "Fetching…" chatter. */
export function modelSlugs(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^fetching/i.test(l) && !/^error/i.test(l))
    .map((l) => l.split("\t")[0].trim())
    .filter((s) => /^[a-z0-9][a-z0-9.\-]*$/i.test(s));
}

// ---------- verify ----------

/**
 * Prove the connection end-to-end by running a real, tiny turn. `agy models`
 * can succeed on a token that the model backend then refuses, so this costs
 * one request to catch that case.
 */
export async function verifyGeminiTurn(): Promise<AgentVerifyResult> {
  const out = await runAgy(["-p", "Reply with exactly: OK", "--output-format", "json"], 180_000);
  const text = `${out.stdout}\n${out.stderr}`;
  if (SIGNED_OUT.test(text)) return { ok: false, output: trimTail(text), error: "Not signed in" };
  const parsed = parseJsonResult(out.stdout);
  if (!parsed) return { ok: false, output: trimTail(text), error: out.error || "No result from the CLI" };
  if ((parsed.status || "").toUpperCase() !== "SUCCESS") {
    return { ok: false, output: trimTail(text), error: parsed.error || `Run ${parsed.status}` };
  }
  return { ok: true, output: (parsed.response || "").trim() || "OK", error: null };
}

interface AgyJsonResult {
  status?: string;
  response?: string;
  error?: string;
  conversation_id?: string;
}

/** `--output-format json` prints one JSON object; take the last parseable line
 *  so any leading CLI chatter is ignored. */
export function parseJsonResult(stdout: string): AgyJsonResult | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      return JSON.parse(lines[i]) as AgyJsonResult;
    } catch {
      // keep walking back
    }
  }
  return null;
}

// ---------- login ----------

// HMR-surviving, like every other long-lived server registry in this app.
interface LoginState {
  session: AgentLoginSession;
  write: ((data: string) => void) | null;
  kill: (() => void) | null;
  buf: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const g = globalThis as unknown as { __calandriaGeminiLogin?: LoginState };

/** How long a started-but-unfinished login is kept alive before it is reaped.
 *  Set well above the CLI's own ~60s window, which is too short for a human
 *  to complete the OAuth round trip. */
const LOGIN_REAP_MS = 30 * 60 * 1000;

const AUTH_URL = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s"']+/;

/** What the CLI prints when a code was refused or its window closed. */
const AUTH_FAILED = /authentication (?:failed|timed out)/i;

/** Exported so a test can pin the wording. This message is the only signal
 *  that a still-running login child will never finish; the connect card's
 *  "Start again" recovery depends on it. */
export function isAuthFailure(cliOutput: string): boolean {
  return AUTH_FAILED.test(cliOutput);
}

/** Strip ANSI so the URL and the CLI's own words survive the TUI's redraws. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\][^]*(?:|\\)/g, "")
    .replace(/\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[()][A-B0]/g, "");
}

/**
 * Pull the authorize URL out of the CLI's terminal output. The TUI prints it
 * twice, once plain and once inside an OSC 8 hyperlink, and wraps it across
 * lines, so the longest match is the intact one.
 */
export function findAuthUrl(text: string): string | null {
  const clean = stripAnsi(text);
  const hits = clean.match(new RegExp(AUTH_URL.source, "g"));
  if (!hits?.length) return null;
  return hits.sort((a, b) => b.length - a.length)[0];
}

function blank(): AgentLoginSession {
  return { status: "starting", url: null, code: null, email: null, plan: null, error: null, log: "" };
}

export function getGeminiLogin(): AgentLoginSession | null {
  return g.__calandriaGeminiLogin?.session ?? null;
}

export function cancelGeminiLogin(): void {
  const st = g.__calandriaGeminiLogin;
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  try {
    st.kill?.();
  } catch {
    // already gone
  }
  g.__calandriaGeminiLogin = undefined;
}

/**
 * Start the guided login: spawn the interactive CLI under a pty, select
 * "Google OAuth" from its one menu, and surface the authorize URL.
 *
 * node-pty is imported lazily. It is a native module and a serverExternalPackage
 * needed only by this flow; a static import would put it in the graph of every
 * turn.
 */
export async function startGeminiLogin(): Promise<AgentLoginSession> {
  cancelGeminiLogin();
  const session = blank();
  const st: LoginState = { session, write: null, kill: null, buf: "", timer: null };
  g.__calandriaGeminiLogin = st;

  let pty: typeof import("node-pty");
  try {
    pty = await import("node-pty");
  } catch (err) {
    session.status = "error";
    session.error = `Could not load the terminal backend for the Google login: ${msg(err)}`;
    return session;
  }

  let child: import("node-pty").IPty;
  try {
    child = pty.spawn(AGY(), [], {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: os.tmpdir(),
      env: AGY_ENV as Record<string, string>,
    });
  } catch (err) {
    session.status = "error";
    session.error = `Could not start ${AGY()}: ${msg(err)}`;
    return session;
  }

  st.write = (d) => child.write(d);
  st.kill = () => child.kill();

  // One menu stands between a fresh CLI and the URL: "1. Google OAuth" /
  // "2. Use a Google Cloud project", with the first already selected. Enter
  // takes it. Sent once, on a short delay, so the TUI has drawn by then.
  const pickOAuth = setTimeout(() => {
    try {
      child.write("\r");
    } catch {
      // the child died; the exit handler below reports it
    }
  }, 1_500);

  child.onData((data) => {
    st.buf = (st.buf + data).slice(-40_000);
    const clean = stripAnsi(st.buf);
    session.log = trimTail(clean);
    if (!session.url) {
      const url = findAuthUrl(st.buf);
      if (url) {
        session.url = url;
        session.status = "awaiting";
      }
    }
    if (/successfully authenticated|welcome to antigravity/i.test(clean) && session.status !== "error") {
      session.status = "success";
    }
    // The CLI reports a refused or expired code by printing this and
    // returning to its prompt instead of exiting, so without watching for it
    // the card would sit on a dead paste box until the 30-minute reaper. The
    // authorize URL is only good for the provider's own 60-second window,
    // which is not configurable, and the code is bound to this child's PKCE
    // verifier, so the only recovery is the fresh child "Start again" spawns.
    if (session.status !== "success" && isAuthFailure(clean)) {
      session.status = "error";
      session.error = session.error || "The sign-in failed or timed out. Start again for a fresh link.";
    }
  });

  child.onExit(() => {
    clearTimeout(pickOAuth);
    if (session.status !== "success") {
      session.status = "error";
      session.error = session.error || "The Antigravity CLI exited before the login finished.";
    }
    st.write = null;
    st.kill = null;
  });

  st.timer = setTimeout(() => cancelGeminiLogin(), LOGIN_REAP_MS);

  // Give the menu keystroke and the CLI's first paint time to land, so the
  // caller usually gets a URL back on this very response instead of polling.
  await waitFor(() => !!session.url || session.status === "error", 20_000);
  return session;
}

/**
 * Hand the CLI the authorization code the user copied out of Google's callback
 * page. The code is bound to this child's PKCE verifier, so the process stays
 * alive instead of being respawned per attempt.
 */
export async function submitGeminiCode(code: string): Promise<AgentLoginSession> {
  const st = g.__calandriaGeminiLogin;
  if (!st) {
    const s = blank();
    s.status = "error";
    s.error = "No login is in progress. Start again.";
    return s;
  }
  const { session } = st;
  const trimmed = code.trim();
  if (!trimmed) {
    session.error = "Enter the authorization code from the Google page.";
    return session;
  }
  if (!st.write) {
    session.status = "error";
    session.error = "The login session has closed. Start again.";
    return session;
  }

  session.status = "submitting";
  session.error = null;
  st.write(`${trimmed}\r`);

  // Signing in, then the CLI's first-run onboarding, take a few seconds. Poll
  // the status the data handler maintains instead of using a fixed delay.
  await waitFor(() => session.status === "success" || session.status === "error", 60_000);

  if (session.status === "submitting") {
    // The CLI accepted the paste but hasn't confirmed yet. Check the
    // authoritative status instead of reporting a failure that didn't happen:
    // the token is written to disk before the TUI finishes its onboarding
    // screens, so `agy models` can already succeed here.
    const status = await geminiStatus();
    if (status.authenticated) session.status = "success";
  }
  if (session.status === "success") {
    // The interactive CLI stays open on its onboarding screens; nothing further
    // is needed from it, and leaving it running would hold a pty forever.
    cancelGeminiLogin();
    return { ...session, status: "success" };
  }
  return session;
}

// ---------- API key ----------

/**
 * The container path. `agy` keeps OAuth tokens in the D-Bus Secret Service and
 * the published image ships no D-Bus, so a subscription login cannot complete
 * there; an API key can. Setting one also writes
 * `{"modelProvider":"gemini"}` into the CLI's settings, which makes it read
 * GEMINI_API_KEY instead of looking for a token.
 */
const API_KEY_SETTING = "gemini_api_key";
const SETTINGS_REL = path.join(".gemini", "antigravity-cli", "settings.json");

/**
 * Merge `modelProvider` into the CLI's settings without discarding what's
 * already there. Always writes the real home, never a per-task one: a
 * gateway turn (./home.ts) writes here too, and its per-task HOME only
 * symlinks this directory back to the real one once it already exists (for
 * the login). Writing through a dangling symlink to a directory that was
 * never created fails outright, while writing the real path directly
 * creates it. Both callers land on the one shared file `agy` actually reads;
 * there is no per-task divergence to preserve.
 */
export function writeModelProviderSetting(useKey: boolean): void {
  const file = path.join(os.homedir(), SETTINGS_REL);
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // Missing or unparseable: start from empty instead of refusing to write.
  }
  if (useKey) current.modelProvider = "gemini";
  else delete current.modelProvider;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
  } catch {
    // Non-fatal: the env var below is the part that actually authenticates.
  }
}

function hasApiKey(): boolean {
  return !!(getSetting(API_KEY_SETTING) || process.env.GEMINI_API_KEY);
}

export const geminiApiKey: AgentApiKeyAuth = {
  hint: GEMINI_API_KEY_HINT,
  looksValid: (key: string) => key.trim().length >= 20 && !/\s/.test(key.trim()),
  has: hasApiKey,
  set(key: string) {
    const k = key.trim();
    setSetting(API_KEY_SETTING, k);
    process.env.GEMINI_API_KEY = k;
    writeModelProviderSetting(true);
  },
  clear() {
    setSetting(API_KEY_SETTING, "");
    delete process.env.GEMINI_API_KEY;
    writeModelProviderSetting(false);
  },
};

/** Apply a persisted key to the environment a turn will inherit. Never
 *  overwrites a key already there: a gateway turn's `GEMINI_API_KEY`
 *  (lib/agentEnv.ts) is composed before this runs and must win over the
 *  user's own stored personal key. */
export function applyStoredApiKey(env: Record<string, string>): Record<string, string> {
  const stored = getSetting(API_KEY_SETTING);
  if (stored && !env.GEMINI_API_KEY) env.GEMINI_API_KEY = stored;
  return env;
}

// ---------- helpers ----------

interface AgyRun {
  stdout: string;
  stderr: string;
  error: string | null;
}

/** Run `agy` and capture both streams. Never throws: a non-zero exit (or a
 *  missing binary) is data the callers above classify, not an exception. */
async function runAgy(args: string[], timeoutMs: number): Promise<AgyRun> {
  try {
    const { stdout, stderr } = await execFileAsync(AGY(), args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: AGY_ENV,
    });
    return { stdout, stderr, error: null };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", error: e.message ?? "failed to run agy" };
  }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const trimTail = (s: string, n = 4000): string => (s.length <= n ? s : s.slice(-n));

/** Poll a predicate until it holds or the budget runs out. */
async function waitFor(done: () => boolean, budgetMs: number): Promise<void> {
  const step = 250;
  for (let waited = 0; waited < budgetMs; waited += step) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, step));
  }
}
