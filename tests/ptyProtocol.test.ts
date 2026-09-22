/* The pty sidecar's frame handling, exercised against the real process.
 *
 * Sibling of tests/ptyOrigin.test.ts: that one pins who gets a shell, this one
 * pins that a client who has one cannot kill the app with a malformed frame.
 * This runs against a real process because the failure is invisible
 * in-process: node-pty's write() throws ERR_INVALID_ARG_TYPE on a
 * non-string, the throw escapes the ws 'message' handler, and Node's default
 * policy exits the sidecar. `npm start` ties the two lifetimes together
 * (scripts/start.mjs), so that exit takes server.js with it: every in-flight
 * agent turn across every project, plus all SSE streams.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import path from "node:path";
import WebSocket from "ws";
import { DETACHED, TEST_SHELL, killChildTree } from "./platform";

const ROOT = path.resolve(__dirname, "..");
const PORT = 3948; // fixed but unusual; the suite is serial so nothing contends
const ORIGIN = `http://127.0.0.1:${PORT}`;

let sidecar: ChildProcess;
let exited: { code: number | null; signal: string | null } | null = null;
const SIDECAR_STDERR_LIMIT = 64 * 1024;
let sidecarStderr = "";
const sessionDiagnostics = new WeakMap<WebSocket, SessionDiagnostics>();

type SessionDiagnostics = {
  phase: string;
  rawInbound: Buffer[];
  rawInboundBytes: number;
  upgradeHeaders: Record<string, string | string[] | undefined> | null;
  negotiatedExtensions: string;
};

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > SIDECAR_STDERR_LIMIT ? next.slice(-SIDECAR_STDERR_LIMIT) : next;
}

function diagnosticError(error: unknown, diagnostics: SessionDiagnostics): Error {
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  const rawWireHex = Buffer.concat(diagnostics.rawInbound).subarray(-16 * 1024).toString("hex");
  return new Error([
    `pty session phase: ${diagnostics.phase}`,
    `pty receiver error:\n${detail}`,
    `pty raw inbound wire hex (tail): ${rawWireHex || "(none)"}`,
    `pty upgrade headers: ${JSON.stringify(diagnostics.upgradeHeaders)}`,
    `pty negotiated extensions: ${JSON.stringify(diagnostics.negotiatedExtensions)}`,
    `pty sidecar writer trace (tail):\n${sidecarStderr || "(none)"}`,
  ].join("\n"));
}

/** Open a session and resolve once the sidecar says the shell is up. */
function openSession(phase = "session"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const diagnostics: SessionDiagnostics = {
      phase,
      rawInbound: [],
      rawInboundBytes: 0,
      upgradeHeaders: null,
      negotiatedExtensions: "",
    };
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?cols=80&rows=24`, {
      headers: { Origin: ORIGIN },
      perMessageDeflate: false,
    });
    sessionDiagnostics.set(ws, diagnostics);
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Let the sidecar's stderr pipe receive a trace line before formatting it.
      setTimeout(() => reject(diagnosticError(error, diagnostics)), 25);
    };
    const timer = setTimeout(() => fail(new Error("no ready frame")), 10_000);
    ws.on("upgrade", (response) => {
      diagnostics.upgradeHeaders = response.headers;
    });
    ws.on("open", () => {
      diagnostics.negotiatedExtensions = ws.extensions;
      const socket = (ws as WebSocket & { _socket?: Socket })._socket;
      socket?.prependListener("data", (chunk: Buffer) => {
        const boundedChunk = chunk.subarray(-16 * 1024);
        diagnostics.rawInbound.push(boundedChunk);
        diagnostics.rawInboundBytes += boundedChunk.length;
        while (diagnostics.rawInboundBytes > 16 * 1024 && diagnostics.rawInbound.length > 1) {
          diagnostics.rawInboundBytes -= diagnostics.rawInbound.shift()?.length || 0;
        }
      });
    });
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg: { type?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "ready") { settled = true; clearTimeout(timer); resolve(ws); }
    });
    ws.on("error", (err) => fail(err));
  });
}

/** Close a session and wait for it, so the sidecar reaps the pty child. */
function closeSession(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
    try { ws.close(); } catch { resolve(); }
  });
}

/** Collect terminal output (binary frames) for `ms`. */
function collectOutput(ws: WebSocket, ms: number): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const onMessage = (raw: Buffer, isBinary: boolean) => { if (isBinary) out += raw.toString("utf8"); };
    ws.on("message", onMessage as never);
    setTimeout(() => { ws.off("message", onMessage as never); resolve(out); }, ms);
  });
}

beforeAll(async () => {
  // Own the whole tree: accepted connections are real pty children, and killing
  // only the parent would orphan them onto the developer's machine.
  // killChildTree() uses a process group on POSIX and `taskkill /T` on win32.
  sidecar = spawn(process.execPath, [path.join(ROOT, "pty-server.js")], {
    cwd: ROOT,
    // Uses the CALANDRIA_PTY_SHELL knob: this file needs a working shell, and
    // $SHELL may be unset.
    env: { ...process.env, PTY_PORT: String(PORT), PTY_HOST: "127.0.0.1", CALANDRIA_PTY_SHELL: TEST_SHELL, CALANDRIA_TEST_PTY_FRAME_TRACE: "1" },
    stdio: ["ignore", "ignore", "pipe"],
    detached: DETACHED,
  });
  sidecar.stderr?.on("data", (chunk: Buffer) => { sidecarStderr = appendBounded(sidecarStderr, chunk); });
  sidecar.on("exit", (code, signal) => { exited = { code, signal }; });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await closeSession(await openSession("setup"));
      return;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`sidecar never came up (last: ${String(err)})`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}, 20_000);

afterAll(() => {
  killChildTree(sidecar);
});

describe("pty sidecar frame handling", () => {
  // Each of these bypasses JSON shape checks and would reach term.write()
  // unguarded, throwing ERR_INVALID_ARG_TYPE, without the frame guard.
  const malformed: Array<[string, unknown]> = [
    ["a number", 12345],
    ["null", null],
    ["missing data", undefined],
    ["an object", { nested: true }],
    ["an array", ["a", "b"]],
    ["a boolean", true],
  ];

  for (const [label, data] of malformed) {
    it(`survives an input frame whose data is ${label}`, async () => {
      await expectSurvives(label, JSON.stringify({ type: "input", data }));
    });
  }

  // Same defect class, one line earlier: JSON.parse("null") parses fine and
  // returns null, so the msg.type lookup itself throws a TypeError before any
  // branch is reached. Valid JSON, so the parse try/catch never sees it.
  it("survives a frame that parses to null", async () => {
    await expectSurvives("bare null", "null");
  });

  // Non-object scalars parse to something with no .type, which is inert.
  // Pinned so a future "just check msg.type" refactor stays honest.
  it("survives frames that parse to bare scalars", async () => {
    for (const frame of ["123", '"input"', "true"]) await expectSurvives("bare scalar", frame);
  });

  /** Send a raw frame, then assert the sidecar is both alive and still serving. */
  async function expectSurvives(label: string, frame: string) {
    const ws = await openSession(`test-open: ${label}`);
    ws.send(frame);
    await new Promise((r) => setTimeout(r, 250));
    await closeSession(ws);

    expect(exited).toBeNull();
    // Alive is not enough: it must still be serving. A wedged listener with a
    // lingering process would pass the check above.
    await closeSession(await openSession(`verification-open: ${label}`));
  }

  // The guard has to reject the bad frames without swallowing the good ones,
  // so pin the happy path in the same file: the pty echoes typed characters
  // back, which proves the bytes reached the shell.
  it("still delivers a well-formed input frame to the shell", async () => {
    const ws = await openSession("happy-path");
    const output = collectOutput(ws, 1_500);
    ws.send(JSON.stringify({ type: "input", data: "echo calandria-pty-alive\n" }));
    const seen = await output;
    await closeSession(ws);
    expect(seen).toContain("calandria-pty-alive");
  }, 10_000);

  it("serializes terminal output before the exit control frame", async () => {
    const ws = await openSession("output-and-exit");
    const outcome = new Promise<{ output: string; exitCode: number | undefined }>((resolve, reject) => {
      let output = "";
      const fail = (error: unknown) => {
        clearTimeout(timer);
        reject(diagnosticError(error, sessionDiagnostics.get(ws)!));
      };
      const timer = setTimeout(() => fail(new Error("no exit frame")), 10_000);
      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          output += raw.toString("utf8");
          return;
        }
        let msg: { type?: string; exitCode?: number };
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type !== "exit") return;
        clearTimeout(timer);
        ws.off("error", fail);
        resolve({ output, exitCode: msg.exitCode });
      });
      ws.once("error", fail);
    });

    const first = "calandria-frame-000";
    const last = "calandria-frame-127";
    const commands = Array.from(
      { length: 128 },
      (_, i) => `echo calandria-frame-${String(i).padStart(3, "0")}`,
    );
    ws.send(JSON.stringify({ type: "input", data: `${commands.join("\n")}\nexit\n` }));

    const { output, exitCode } = await outcome;
    await closeSession(ws);
    expect(output).toContain(first);
    expect(output).toContain(last);
    expect(exitCode).toBe(0);
  }, 15_000);
});
