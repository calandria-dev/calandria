// A single `codex app-server` JSON-RPC request, spawned and torn down again.
//
// The app-server is the codex CLI's long-lived IDE protocol (stdio JSON-RPC:
// `initialize` → `initialized` → requests). We do not hold a connection open —
// the one thing we ask it for is the account's rate-limit snapshot, behind the
// plan-usage fetch floor, so a process per answer is cheaper than a supervised
// child that outlives every turn. Separated from ./planUsage.ts so the cache
// and merge policy there can be tested without spawning anything.
//
// Handshake VERIFIED live against codex-cli 0.146.0 on this machine. The exact
// exchange, transcribed:
//
//   → {"jsonrpc":"2.0","id":1,"method":"initialize",
//      "params":{"clientInfo":{"name":"calandria","title":"Calandria","version":"1"}}}
//   ← {"id":1,"result":{"userAgent":"…","codexHome":"/home/u/.codex",
//      "platformFamily":"unix","platformOs":"linux"}}
//   → {"jsonrpc":"2.0","method":"initialized","params":{}}
//   → {"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}
//   ← {"id":2,"result":{"rateLimits":{…}}}          (logged in)
//   ← {"id":2,"error":{"code":-32600,
//      "message":"codex account authentication required to read rate limits"}}
//
// Three things that exchange settles, each of which would otherwise be a bug:
//
//   * Responses carry NO `jsonrpc` field, so correlation is by `id` alone.
//   * The server pushes UNSOLICITED notifications on the same stream before and
//     between the responses (`configWarning`, `remoteControl/status/changed`),
//     so anything without our id is skipped rather than treated as an answer.
//   * Not being logged in is an ordinary JSON-RPC error on the read, not a
//     failure to start — which is what makes it a usable "no subscription"
//     signal instead of a crash to classify.

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

export interface AppServerResult {
  /** The JSON-RPC `result`, when the call succeeded. */
  data?: unknown;
  /** Why there is no result — an RPC error message, or a process failure. */
  error?: string;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The app-server logs to stderr even on a healthy run (this host's bubblewrap
// sandbox warning, for one), so stderr is only used to explain a process that
// died without answering — and only its tail, which is where the cause is.
function stderrTail(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-2).join(" ").slice(0, 300);
}

/**
 * Run one `<method>` request against a throwaway `codex app-server`.
 * Never rejects: every failure comes back as `{ error }` so the caller's
 * backoff policy has one shape to handle.
 */
export function callAppServer(method: string, params: unknown = {}): Promise<AppServerResult> {
  return new Promise<AppServerResult>((resolve) => {
    const spec = codexSpawn(["app-server"]);
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        // Home rather than a task worktree: this asks about the ACCOUNT, and a
        // repo-local config.toml has no business steering it.
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
    let stdout = "";
    let stderr = "";

    const finish = (r: AppServerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Nothing to drain and no shutdown RPC worth waiting on — we have the one
      // answer we came for, and a lingering app-server would outlive the poll.
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(r);
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
      finish({ error: e.code === "ENOENT" ? "the codex CLI isn't installed in this workspace" : e.message });
    });
    child.on("exit", () => {
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
        let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // a log line on the wrong stream — not our business
        }
        if (msg.id === INIT_ID) {
          if (msg.error) {
            finish({ error: String(msg.error.message ?? "codex app-server refused the handshake") });
            return;
          }
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: CALL_ID, method, params });
        } else if (msg.id === CALL_ID) {
          if (msg.error) finish({ error: String(msg.error.message ?? `${method} failed`) });
          else finish({ data: msg.result });
          return;
        }
        // Anything else is an unsolicited notification — ignored.
      }
    });

    send({ jsonrpc: "2.0", id: INIT_ID, method: "initialize", params: { clientInfo: CLIENT_INFO } });
  });
}

/** The account's current rate-limit snapshot (`GetAccountRateLimitsResponse`). */
export function readAccountRateLimits(): Promise<AppServerResult> {
  return callAppServer("account/rateLimits/read", {});
}
