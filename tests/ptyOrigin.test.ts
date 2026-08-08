/* The pty sidecar's own gate, exercised against the real process.
 *
 * tests/sameOrigin.test.ts pins the RULE; this pins the WIRING — that
 * pty-server.js actually consults it before spawning a shell. Worth a real
 * process because the failure mode is silent and total: an unguarded sidecar
 * hands a shell to anyone who completes a handshake, and every unit test in the
 * world still passes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import WebSocket from "ws";

const ROOT = path.resolve(__dirname, "..");
const PORT = 3947; // fixed but unusual; the suite is serial so nothing contends

let sidecar: ChildProcess;

/**
 * Resolve to the handshake outcome: "open" (shell granted) or the refusal.
 * An accepted handshake spawns a REAL shell, so wait for the socket to finish
 * closing before resolving — the sidecar kills the pty on 'close', and
 * resolving early lets afterAll tear the process down first, orphaning shells.
 */
function connect(origin?: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?cols=80&rows=24`, {
      headers: origin ? { Origin: origin } : {},
    });
    const done = (outcome: string) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve(outcome);
      ws.once("close", () => resolve(outcome));
      try { ws.close(); } catch { resolve(outcome); }
    };
    ws.on("open", () => done("open"));
    ws.on("unexpected-response", (_req, res) => done(`rejected:${res.statusCode}`));
    ws.on("error", (err) => done(`error:${err.message}`));
  });
}

beforeAll(async () => {
  // Own the whole process group: the sidecar's accepted connections are real
  // pty children, and killing only the parent would orphan them onto the
  // developer's machine.
  sidecar = spawn(process.execPath, [path.join(ROOT, "pty-server.js")], {
    cwd: ROOT,
    env: { ...process.env, PTY_PORT: String(PORT), PTY_HOST: "127.0.0.1", SHELL: "/bin/sh" },
    stdio: "ignore",
    detached: true,
  });
  // Wait for the listener rather than sleeping a fixed amount.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const outcome = await connect("http://127.0.0.1:" + PORT);
    if (outcome === "open") return;
    if (Date.now() > deadline) throw new Error(`sidecar never came up (last: ${outcome})`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 20_000);

afterAll(() => {
  // Negative pid = the group, so any pty child goes with it.
  if (sidecar?.pid) {
    try { process.kill(-sidecar.pid, "SIGKILL"); } catch { try { sidecar.kill("SIGKILL"); } catch {} }
  }
});

describe("pty sidecar handshake", () => {
  it("refuses a foreign origin instead of spawning a shell", async () => {
    expect(await connect("http://evil.example")).toBe("rejected:401");
  });

  it("refuses the opaque null origin", async () => {
    expect(await connect("null")).toBe("rejected:401");
  });

  it("still serves the app's own origin", async () => {
    expect(await connect(`http://127.0.0.1:${PORT}`)).toBe("open");
  });

  // Stricter than the HTTP gate on purpose, and worth pinning because it is a
  // deliberate asymmetry someone will otherwise "fix" later: HTTP lets an
  // absent Origin through (curl, health probes, the MCP bridge all omit it),
  // but /pty is an interactive shell and every browser sends Origin on a
  // WebSocket handshake. So the only callers this turns away are non-browsers,
  // which have no business opening a terminal.
  it("refuses a handshake with no Origin at all", async () => {
    expect(await connect(undefined)).toBe("rejected:401");
  });
});
