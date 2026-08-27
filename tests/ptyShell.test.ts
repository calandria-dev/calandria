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
 * Split by platform: the cases that assert on `$SHELL`, `$0` and `$TERM` are
 * POSIX semantics and are skipped on win32; what a Windows run pins instead is
 * that the probed default resolves to a shell node-pty can launch at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import WebSocket from "ws";
import { DETACHED, IS_WIN, killChildTree } from "./platform";

const ROOT = path.resolve(__dirname, "..");
const PORT = 3949; // fixed but unusual; the suite is serial so nothing contends
const ORIGIN = `http://127.0.0.1:${PORT}`;

let sidecar: ChildProcess | null = null;

/** Boot the sidecar with exactly `env` layered on, and wait for it to serve. */
async function startSidecar(env: Record<string, string | undefined>): Promise<void> {
  // Own the whole tree: accepted connections are real pty children, and killing
  // only the parent would orphan them onto the developer's machine.
  const child = spawn(process.execPath, [path.join(ROOT, "pty-server.js")], {
    cwd: ROOT,
    env: { ...process.env, PTY_PORT: String(PORT), PTY_HOST: "127.0.0.1", SHELL: undefined, CALANDRIA_PTY_SHELL: undefined, ...env },
    stdio: "ignore",
    detached: DETACHED,
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
  killChildTree(sidecar);
  sidecar = null;
});

// Skipped on Windows rather than ported: every case below is ABOUT a POSIX
// convention — `$SHELL`, `$0` naming the shell that ran the line, `$TERM` — and
// a cmd.exe translation would assert a different thing under the same name. The
// win32 half is covered where it can be: the default is exercised end-to-end by
// the case below, and by tests/ptyOrigin.test.ts + tests/ptyProtocol.test.ts,
// which spawn real Windows shells through the knob (docs/WINDOWS.md §7).
describe.skipIf(IS_WIN)("pty sidecar shell resolution", () => {
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

describe.runIf(IS_WIN)("pty sidecar shell resolution on Windows", () => {
  it("spawns a shell with neither the knob nor $SHELL set", async () => {
    // The whole win32 default in one assertion: pwsh/powershell/COMSPEC has to
    // resolve to something node-pty can actually launch. startSidecar only
    // returns once a session reached the `ready` frame, which the sidecar sends
    // after pty.spawn — so a default that ENOENTs fails here rather than
    // silently serving a dead terminal.
    await startSidecar({});
  }, 30_000);
});
