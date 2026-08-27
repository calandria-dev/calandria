/* Which shell the pty sidecar spawns, exercised against the real process.
 *
 * Third sibling of tests/ptyOrigin.test.ts (WHO gets a shell) and
 * tests/ptyProtocol.test.ts (a client who has one can't kill the app): this
 * one pins WHICH shell they get. The old resolution was `$SHELL || "/bin/zsh"`,
 * and $SHELL is only a POSIX convention — unset on native Windows and under
 * systemd/trimmed environments — while /bin/zsh exists on neither Windows nor
 * most Linux boxes, so the drawer just failed to spawn with nothing but an
 * ENOENT in the sidecar's log. Worth a real process for the same reason as its
 * siblings: the resolution decides an argument to pty.spawn, and only a real
 * spawn proves the choice was one the OS could actually execute.
 *
 * The win32 half of the default can't run here; it's pinned by structure —
 * a shell resolved by probing PATH/COMSPEC, and TERM set only on POSIX.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import WebSocket from "ws";

const ROOT = path.resolve(__dirname, "..");
const PORT = 3949; // fixed but unusual; the suite is serial so nothing contends
const ORIGIN = `http://127.0.0.1:${PORT}`;

let sidecar: ChildProcess | null = null;

/** Boot the sidecar with exactly `env` layered on, and wait for it to serve. */
async function startSidecar(env: Record<string, string | undefined>): Promise<void> {
  // Own the whole process group: accepted connections are real pty children,
  // and killing only the parent would orphan them onto the developer's machine.
  const child = spawn(process.execPath, [path.join(ROOT, "pty-server.js")], {
    cwd: ROOT,
    env: { ...process.env, PTY_PORT: String(PORT), PTY_HOST: "127.0.0.1", SHELL: undefined, CALANDRIA_PTY_SHELL: undefined, ...env },
    stdio: "ignore",
    detached: true,
  });
  sidecar = child;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const ws = await openSession();
      ws.close();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`sidecar never came up (last: ${String(err)})`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

function openSession(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?cols=80&rows=24`, { headers: { Origin: ORIGIN } });
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

/**
 * Run one command in a fresh session and return everything the pty emitted.
 * A shell that never spawned emits nothing, which is the failure this file is
 * about — so an empty string is a real (and legible) assertion failure.
 */
async function runInShell(command: string): Promise<string> {
  const ws = await openSession();
  let out = "";
  const onMessage = (raw: Buffer, isBinary: boolean) => { if (isBinary) out += raw.toString("utf8"); };
  ws.on("message", onMessage as never);
  ws.send(JSON.stringify({ type: "input", data: `${command}\n` }));
  await new Promise((r) => setTimeout(r, 1_500));
  await new Promise<void>((resolve) => { ws.once("close", () => resolve()); ws.close(); });
  return out;
}

afterEach(() => {
  // Negative pid = the group, so any pty child goes with it.
  if (sidecar?.pid) {
    try { process.kill(-sidecar.pid, "SIGKILL"); } catch { try { sidecar.kill("SIGKILL"); } catch {} }
  }
  sidecar = null;
});

describe("pty sidecar shell resolution", () => {
  it("uses CALANDRIA_PTY_SHELL ahead of $SHELL", async () => {
    // $SHELL points at nothing, so if precedence were the other way round the
    // spawn ENOENTs and no output comes back at all.
    await startSidecar({ CALANDRIA_PTY_SHELL: "/bin/sh", SHELL: "/nonexistent/calandria-shell" });
    expect(await runInShell("echo shell-is-$0")).toContain("shell-is-/bin/sh");
  }, 30_000);

  it("falls back to $SHELL when the knob is unset", async () => {
    await startSidecar({ SHELL: "/bin/sh" });
    expect(await runInShell("echo shell-is-$0")).toContain("shell-is-/bin/sh");
  }, 30_000);

  it("still spawns a shell when neither is set", async () => {
    // The regression: a trimmed environment used to get /bin/zsh, which most
    // Linux boxes don't have. The default is now probed, so whatever comes
    // back has to be a shell that exists and runs.
    await startSidecar({});
    expect(await runInShell("echo shell-is-$0")).toMatch(/shell-is-\/bin\/(zsh|bash|sh)/);
  }, 30_000);

  it("sets TERM on POSIX", async () => {
    // The other half of the platform split: ConPTY doesn't want TERM, so it is
    // set only here — and it must still BE set here, or every curses program in
    // the drawer degrades to a dumb terminal.
    await startSidecar({ CALANDRIA_PTY_SHELL: "/bin/sh" });
    expect(await runInShell("echo term-is-$TERM")).toContain("term-is-xterm-256color");
  }, 30_000);
});
