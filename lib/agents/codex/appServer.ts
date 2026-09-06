// A single `codex app-server` JSON-RPC request, spawned and torn down again.
//
// The app-server is the codex CLI's long-lived IDE protocol (stdio JSON-RPC:
// `initialize` -> `initialized` -> requests). The only thing we ask it for is
// the account's rate-limit snapshot, so a process per answer is cheaper than
// a supervised child that outlives every turn. Kept separate from
// ./planUsage.ts so the cache and merge policy there can be tested without
// spawning anything.
//
// Responses carry no `jsonrpc` field, so correlation is by `id` alone. The
// server also pushes unsolicited notifications on the same stream before and
// between responses, so anything without our id is skipped. Not being logged
// in is an ordinary JSON-RPC error on the read rather than a failure to
// start, which makes it a usable "no subscription" signal instead of a crash
// to classify.

import { spawn } from "node:child_process";
import os from "node:os";
import { codexSpawn } from "./bin";

// Only echoed back inside the server's `userAgent` string, so a fixed value
// keeps this off package.json (which the bundler would inline wholesale).
const CLIENT_INFO = { name: "calandria", title: "Calandria", version: "1" };

const INIT_ID = 1;
const CALL_ID = 2;

/** Total budget for spawn + handshake + answer. */
const TIMEOUT_MS = 10_000;

/** How long to keep reading notifications after the answer, when asked to. */
const SETTLE_MS = 750;

export interface AppServerResult {
  /** The JSON-RPC `result`, when the call succeeded. */
  data?: unknown;
  /** Why there is no result: an RPC error message, or a process failure. */
  error?: string;
  /**
   * Whether `initialize` was answered. An `error` with this set means the
   * server started and refused the CALL (not logged in, say); an `error`
   * without it means nothing ran at all. Only a caller that cares about the
   * server's startup output rather than the answer needs the distinction.
   */
  handshook?: boolean;
}

export interface AppServerCallOptions {
  /** Every unsolicited notification the server pushes on the same stream. */
  onNotification?: (method: string, params: unknown) => void;
  /**
   * Keep reading for this long after the answer instead of killing the child
   * immediately. Notifications are pushed around the responses rather than
   * before them, so a caller collecting notifications would otherwise race the
   * server's own startup chatter.
   */
  settleMs?: number;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The app-server can log to stderr on a healthy run (a sandbox warning, for
// one), so stderr is only used to explain a process that died without
// answering, and only its tail, which is where the cause is.
function stderrTail(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-2).join(" ").slice(0, 300);
}

/**
 * Run one `<method>` request against a throwaway `codex app-server`.
 * Never rejects: every failure comes back as `{ error }` so the caller's
 * backoff policy has one shape to handle.
 */
export function callAppServer(
  method: string,
  params: unknown = {},
  opts: AppServerCallOptions = {},
): Promise<AppServerResult> {
  return new Promise<AppServerResult>((resolve) => {
    const spec = codexSpawn(["app-server"]);
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        // Home rather than a task worktree: this asks about the account, and a
        // repo-local config.toml must not steer it.
        cwd: os.homedir(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
    } catch (e) {
      resolve({ error: messageOf(e) });
      return;
    }

    let settled = false;
    let handshook = false;
    let stdout = "";
    let stderr = "";
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (r: AppServerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      // Nothing to drain and no shutdown RPC worth waiting on: the one answer
      // we came for is already in hand, and a lingering app-server would
      // outlive the poll.
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({ ...r, handshook });
    };

    // The answer is already decided, but a caller that asked for
    // notifications also needs the server's startup chatter, which arrives
    // around the responses rather than strictly before them. Hold the child
    // open a beat longer so the stdout handler keeps feeding onNotification
    // until the window closes.
    //
    // Once armed, `pending` holds that decided result: the child exiting or
    // the overall timeout during this window resolves the same result
    // instead of an error about a process that has already finished.
    let pending: AppServerResult | undefined;
    const finishAfterSettle = (r: AppServerResult) => {
      if (settled || pending) return;
      if (!opts.settleMs) {
        finish(r);
        return;
      }
      pending = r;
      clearTimeout(timer);
      settleTimer = setTimeout(() => finish(r), opts.settleMs);
    };

    const timer = setTimeout(() => finish({ error: `codex app-server did not answer ${method} in time` }), TIMEOUT_MS);

    const send = (msg: unknown) => {
      try {
        child.stdin?.write(`${JSON.stringify(msg)}\n`);
      } catch {
        /* the exit handler reports it */
      }
    };

    child.on("error", (e: NodeJS.ErrnoException) => {
      if (pending) return finish(pending);
      finish({ error: e.code === "ENOENT" ? "the codex CLI isn't installed in this workspace" : e.message });
    });
    child.on("exit", () => {
      if (pending) return finish(pending);
      finish({ error: stderrTail(stderr) || "codex app-server exited without answering" });
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.stdout?.on("data", (d) => {
      stdout += d;
      for (let nl = stdout.indexOf("\n"); nl !== -1; nl = stdout.indexOf("\n")) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // a log line on the wrong stream, unrelated to this protocol
        }
        if (msg.id === INIT_ID) {
          if (msg.error) {
            finish({ error: String(msg.error.message ?? "codex app-server refused the handshake") });
            return;
          }
          handshook = true;
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: CALL_ID, method, params });
        } else if (msg.id === CALL_ID) {
          if (msg.error) finishAfterSettle({ error: String(msg.error.message ?? `${method} failed`) });
          else finishAfterSettle({ data: msg.result });
        } else if (typeof msg.method === "string" && msg.id === undefined) {
          // An unsolicited notification. Only a caller that asked for them sees
          // them; everyone else gets the old behavior of ignoring them.
          opts.onNotification?.(msg.method, msg.params);
        }
      }
    });

    send({ jsonrpc: "2.0", id: INIT_ID, method: "initialize", params: { clientInfo: CLIENT_INFO } });
  });
}

/** The account's current rate-limit snapshot (`GetAccountRateLimitsResponse`). */
export function readAccountRateLimits(): Promise<AppServerResult> {
  return callAppServer("account/rateLimits/read", {});
}

export interface ConfigWarningProbe {
  /** Every `configWarning` summary the server pushed while starting up. */
  warnings: string[];
  /** Set when the server never handshook, so the warnings mean nothing. */
  error: string | null;
}

/**
 * Every `configWarning` a fresh `codex app-server` emits at startup.
 *
 * These are the CLI's own verdict on its configuration, including whether its
 * Linux sandbox can be created, and they arrive whether or not an account is
 * logged in. That makes this a usable, self-contained health check. The RPC
 * underneath is only a vehicle for the handshake: its answer is discarded,
 * and an error on it (not logged in, for one) still means the server started
 * and reported its warnings.
 */
export async function readConfigWarnings(): Promise<ConfigWarningProbe> {
  const warnings: string[] = [];
  const r = await callAppServer(
    "account/rateLimits/read",
    {},
    {
      settleMs: SETTLE_MS,
      onNotification: (method, params) => {
        if (method !== "configWarning") return;
        const summary = (params as { summary?: unknown } | undefined)?.summary;
        if (typeof summary === "string" && summary.trim()) warnings.push(summary.trim());
      },
    },
  );
  return { warnings, error: r.handshook ? null : (r.error ?? "codex app-server did not start") };
}
