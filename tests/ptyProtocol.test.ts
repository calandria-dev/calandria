/* The pty sidecar's frame handling, exercised against the real process.
 *
 * Sibling of tests/ptyOrigin.test.ts: that one pins WHO gets a shell, this one
 * pins that a client who has one cannot kill the app with a malformed frame.
 * Worth a real process because the failure mode is invisible in-process:
 * node-pty's write() throws ERR_INVALID_ARG_TYPE on a non-string, the throw
 * escapes the ws 'message' handler, and Node's default policy exits the
 * sidecar. `npm start` ties the two lifetimes together (scripts/start.mjs), so
 * that exit takes server.js with it — every in-flight agent turn across every project, plus all SSE
 * streams, for a two-byte protocol violation on the terminal socket.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import WebSocket from "ws";

const ROOT = path.resolve(__dirname, "..");
const PORT = 3948; // fixed but unusual; the suite is serial so nothing contends
const ORIGIN = `http://127.0.0.1:${PORT}`;

let sidecar: ChildProcess;
let exited: { code: number | null; signal: string | null } | null = null;

/** Open a session and resolve once the sidecar says the shell is up. */
function openSession(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?cols=80&rows=24`, {
      headers: { Origin: ORIGIN },
    });
    const timer = setTimeout(() => reject(new Error("no ready frame")), 10_000);
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg: { type?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "ready") { clearTimeout(timer); resolve(ws); }
    });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
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
  // Own the whole process group: accepted connections are real pty children,
  // and killing only the parent would orphan them onto the developer's machine.
  sidecar = spawn(process.execPath, [path.join(ROOT, "pty-server.js")], {
    cwd: ROOT,
    env: { ...process.env, PTY_PORT: String(PORT), PTY_HOST: "127.0.0.1", SHELL: "/bin/sh" },
    stdio: "ignore",
    detached: true,
  });
  sidecar.on("exit", (code, signal) => { exited = { code, signal }; });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await closeSession(await openSession());
      return;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`sidecar never came up (last: ${String(err)})`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}, 20_000);

afterAll(() => {
  // Negative pid = the group, so any pty child goes with it.
  if (sidecar?.pid) {
    try { process.kill(-sidecar.pid, "SIGKILL"); } catch { try { sidecar.kill("SIGKILL"); } catch {} }
  }
});

describe("pty sidecar frame handling", () => {
  // The regression. Every one of these reached term.write() unguarded and threw
  // ERR_INVALID_ARG_TYPE out of the message handler.
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
      await expectSurvives(JSON.stringify({ type: "input", data }));
    });
  }

  // Same defect class, one line earlier: JSON.parse("null") parses fine and
  // returns null, so the msg.type lookup itself throws a TypeError before any
  // branch is reached. Valid JSON, so the parse try/catch never sees it.
  it("survives a frame that parses to null", async () => {
    await expectSurvives("null");
  });

  // Non-object scalars parse to something with no .type, which is inert — pin
  // it so a future "just check msg.type" refactor stays honest.
  it("survives frames that parse to bare scalars", async () => {
    for (const frame of ["123", '"input"', "true"]) await expectSurvives(frame);
  });

  /** Send a raw frame, then assert the sidecar is both alive and still serving. */
  async function expectSurvives(frame: string) {
    const ws = await openSession();
    ws.send(frame);
    await new Promise((r) => setTimeout(r, 250));
    await closeSession(ws);

    expect(exited).toBeNull();
    // Alive is not enough — it must still be serving. A wedged listener with a
    // lingering process would pass the check above.
    await closeSession(await openSession());
  }

  // The guard has to reject the bad frames without swallowing the good ones,
  // so pin the happy path in the same file: the pty echoes typed characters
  // back, which proves the bytes reached the shell.
  it("still delivers a well-formed input frame to the shell", async () => {
    const ws = await openSession();
    const output = collectOutput(ws, 1_500);
    ws.send(JSON.stringify({ type: "input", data: "echo calandria-pty-alive\n" }));
    const seen = await output;
    await closeSession(ws);
    expect(seen).toContain("calandria-pty-alive");
  }, 10_000);
});
