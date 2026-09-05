// A long-lived `codex app-server` JSON-RPC connection over stdio, the
// transport a Codex turn runs on (lib/agents/codex/driver.ts).
//
// ./appServer.ts spawns a throwaway process per question and is right for the
// one thing it asks (the account's rate limits). A turn is the opposite shape:
// one process that outlives every message, three kinds of traffic on the same
// two pipes, and no way to tell them apart except by the envelope —
//
//   * our REQUESTS, answered by a message carrying our numeric `id`;
//   * the server's NOTIFICATIONS (`method`, no `id`), the item stream a turn
//     renders from;
//   * the server's REQUESTS (`method` AND `id`), which the turn cannot finish
//     without us answering: every approval prompt is one of these, and an
//     unanswered one parks the model forever, because the protocol has no
//     approval timeout of its own (verified against the 0.153.0 schema).
//
// This module owns the framing and correlation and nothing else. What each
// notification means, and how a server request gets its answer, is the
// driver's business — handed in as callbacks so this stays a pure transport
// that a fake binary can be pointed at (tests/codexAppServer.test.ts).
//
// Wire facts, carried over from ./appServer.ts (verified live on 0.146.0 and
// again on 0.153.0): responses carry no `jsonrpc` field, so correlation is by
// `id` alone; unsolicited notifications interleave with responses from the
// first byte; a log line on stdout is possible and is skipped rather than
// treated as a protocol error.

import { spawn, type ChildProcess } from "node:child_process";
import { resolveCodexBin } from "./bin";
import { spawnSpec } from "../../binPath";
import { hasProcessGroups, killTree } from "../../processTree";

// Only echoed back inside the server's `userAgent` string.
const CLIENT_INFO = { name: "calandria", title: "Calandria", version: "1" };

export interface AppServerHandlers {
  /** A server → client notification: `method` and its `params`. */
  onNotification: (method: string, params: unknown) => void;
  /**
   * A server → client request. Resolve with the result to send back, or
   * throw to answer with a JSON-RPC error (the server treats that as a
   * refusal — for an approval, the same as declining).
   */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  /** The process ended (any reason). `stderrTail` is the last of its stderr. */
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void;
}

export interface AppServerSpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Already-flattened `key=value` config overrides, one `-c` flag each. */
  configOverrides?: string[];
  /**
   * Override the binary (tests point this at a fake). Default: CODEX_CLI_PATH,
   * else `codex` on PATH. Either way it goes through spawnSpec: on win32 an
   * npm-installed codex — and the test fake — is a `.cmd` shim, which Node
   * refuses to spawn without a shell (`spawn EINVAL`), so lib/binPath wraps
   * it in cmd.exe with the argv quoted piece by piece.
   */
  bin?: string;
}

export class AppServerRpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "AppServerRpcError";
    this.code = code;
    this.data = data;
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };

// The last few stderr lines, which is where a dying process says why.
function stderrTail(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-3).join(" ").slice(0, 400);
}

export class AppServerClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuf = "";
  private stderrBuf = "";
  private closed = false;
  private exitError: Error | null = null;

  constructor(private readonly handlers: AppServerHandlers) {}

  /**
   * Spawn the process and complete the `initialize` → `initialized`
   * handshake. Rejects if the binary can't start or refuses the handshake.
   */
  async start(opts: AppServerSpawnOptions): Promise<unknown> {
    const args = ["app-server"];
    for (const o of opts.configOverrides ?? []) args.push("-c", o);
    const spec = spawnSpec(opts.bin ?? resolveCodexBin(), args);
    const child = spawn(spec.command, spec.args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    this.child = child;

    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (e: NodeJS.ErrnoException) => {
        reject(new Error(e.code === "ENOENT" ? "the codex CLI isn't installed in this workspace" : e.message));
      });
    });

    child.stderr?.on("data", (d) => {
      this.stderrBuf += d;
      // Bound the buffer: the app-server logs freely and a long turn would
      // otherwise grow it without limit. The tail is all we ever read.
      if (this.stderrBuf.length > 16_000) this.stderrBuf = this.stderrBuf.slice(-8_000);
    });
    child.stdout?.on("data", (d) => this.onStdout(String(d)));
    child.on("exit", (code, signal) => {
      const tail = stderrTail(this.stderrBuf);
      this.exitError = new Error(tail ? `codex app-server exited: ${tail}` : `codex app-server exited (${signal ?? code})`);
      // Every in-flight request is now unanswerable.
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.reject(this.exitError);
      }
      this.handlers.onExit({ code, signal, stderrTail: tail });
    });

    await spawned;
    const init = await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized", {});
    return init;
  }

  /** Whether the process is still up. */
  get alive(): boolean {
    return !!this.child && !this.closed && this.exitError === null;
  }

  /** Send a request and await its result. Rejects on a JSON-RPC error or a dead process. */
  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return p as Promise<T>;
  }

  /** Send a notification (no answer expected). */
  notify(method: string, params: unknown = {}): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /**
   * Stop the process. POSIX: SIGTERM first so the CLI can flush its rollout,
   * then SIGKILL if it lingers. win32: the whole tree at once, forced —
   * the direct child is cmd.exe wrapping a `.cmd` shim, and killing it alone
   * leaves the CLI behind it running (measured on the Windows CI runner: the
   * fake's node process kept the worktree as its cwd until the suite gave up
   * removing it). `taskkill /T` walks the parent chain, so it has to run
   * while the parent is still alive, which is why it isn't an escalation.
   * Idempotent.
   */
  close(graceMs = 1500): void {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin?.end();
    } catch {
      /* already gone */
    }
    if (!hasProcessGroups()) {
      if (!killTree(child.pid ?? 0, "SIGKILL")) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, graceMs);
    t.unref?.();
    child.once("exit", () => clearTimeout(t));
  }

  private send(msg: unknown): void {
    const stdin = this.child?.stdin;
    if (!stdin || this.closed) return;
    try {
      stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      /* the exit handler reports it */
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    for (let nl = this.stdoutBuf.indexOf("\n"); nl !== -1; nl = this.stdoutBuf.indexOf("\n")) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: number; message?: unknown; data?: unknown } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a log line on the wrong stream
      }
      if (typeof msg !== "object" || msg === null) continue;
      const hasId = msg.id !== undefined && msg.id !== null;
      if (typeof msg.method === "string") {
        if (hasId) this.handleServerRequest(msg.id as string | number, msg.method, msg.params);
        else this.safeNotify(msg.method, msg.params);
        continue;
      }
      if (hasId && typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new AppServerRpcError(String(msg.error.message ?? `${p.method} failed`), msg.error.code, msg.error.data));
        } else {
          p.resolve(msg.result);
        }
      }
    }
  }

  private safeNotify(method: string, params: unknown): void {
    try {
      this.handlers.onNotification(method, params);
    } catch (e) {
      console.warn(`[codex] notification handler threw on ${method}:`, e instanceof Error ? e.message : e);
    }
  }

  private handleServerRequest(id: string | number, method: string, params: unknown): void {
    void this.handlers
      .onRequest(method, params)
      .then((result) => this.send({ jsonrpc: "2.0", id, result: result ?? {} }))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        this.send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
      });
  }
}

// ---------- config-override flattening ----------
//
// The same rendering @openai/codex-sdk does for its `config` option (verified
// against its dist/index.js at 0.146.0): a nested object becomes dotted keys,
// each leaf a TOML literal, and every entry lands as one `-c key=value` on the
// app-server command line — so the mcp_servers / model_providers overrides the
// exec transport already relies on mean exactly the same thing here.

export type ConfigObject = { [key: string]: ConfigValue };
export type ConfigValue = string | number | boolean | ConfigValue[] | ConfigObject | undefined;

function isPlainObject(v: unknown): v is ConfigObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

export function toTomlValue(value: ConfigValue, path: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Codex config override at ${path} must be a finite number`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item, i) => toTomlValue(item, `${path}[${i}]`)).join(", ")}]`;
  if (isPlainObject(value)) {
    const parts: string[] = [];
    for (const [k, child] of Object.entries(value)) {
      if (child === undefined) continue;
      parts.push(`${tomlKey(k)} = ${toTomlValue(child, `${path}.${k}`)}`);
    }
    return `{${parts.join(", ")}}`;
  }
  throw new Error(`Unsupported Codex config override value at ${path}`);
}

/** Flatten a nested config object into `key=value` overrides. */
export function flattenConfigOverrides(value: ConfigObject | undefined, prefix = "", out: string[] = []): string[] {
  if (!value) return out;
  const entries = Object.entries(value);
  if (prefix && entries.length === 0) {
    out.push(`${prefix}={}`);
    return out;
  }
  for (const [key, child] of entries) {
    if (!key) throw new Error("Codex config override keys must be non-empty strings");
    if (child === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) flattenConfigOverrides(child, path, out);
    else out.push(`${path}=${toTomlValue(child, path)}`);
  }
  return out;
}
