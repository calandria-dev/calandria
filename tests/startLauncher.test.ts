/* scripts/start.mjs is the `npm start` launcher.
 *
 * It exists so Ctrl+C reaches server.js's own SIGINT handler and its graceful
 * drain finishes: killing through a process-tree kill can force-terminate
 * children before the drain completes. The property under test is "the
 * launcher relays the signal and then waits", which a unit test of any single
 * function cannot show, so this runs the real script against stub
 * entrypoints in a temp cwd. The launcher resolves `server.js` and
 * `pty-server.js` cwd-relative for that reason.
 *
 * Windows' console-signal path cannot be exercised from here: there is no way
 * to deliver a CTRL_C_EVENT to another process from Node, and `child.kill()`
 * there is a TerminateProcess for every signal name, so nothing downstream
 * can observe which signal it got. A Windows run keeps the half that is
 * still meaningful (the lifetime contract: first exit wins, the survivor
 * comes down with it, the launcher reports the first child's code) and skips
 * the relay assertions; `expectSignalled` and `onPosix` mark each place.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IS_WIN, onPosix } from "./platform";

const LAUNCHER = path.resolve(__dirname, "..", "scripts", "start.mjs");

let dir: string | null = null;
let launcher: ChildProcess | null = null;

afterEach(() => {
  if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
    try { launcher.kill("SIGKILL"); } catch { /* already gone */ }
  }
  launcher = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A temp cwd holding the two stub entrypoints the launcher will spawn. */
function fixture(app: string, pty: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-start-"));
  dir = cwd;
  fs.writeFileSync(path.join(cwd, "server.js"), app);
  fs.writeFileSync(path.join(cwd, "pty-server.js"), pty);
  return cwd;
}

/** Stays up until signalled, then records that it was reached and exits. */
function stubStaysUp(marker: string, drainMs = 0): string {
  return `
const fs = require("node:fs");
const alive = setInterval(() => {}, 1000);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(marker)}, sig);
      clearInterval(alive);
      process.exit(0);
    }, ${drainMs});
  });
}
fs.writeFileSync(${JSON.stringify(marker)} + ".up", "1");
`;
}

function launch(cwd: string): ChildProcess {
  launcher = spawn(process.execPath, [LAUNCHER], { cwd, stdio: "ignore" });
  return launcher;
}

/** Resolve once both stubs have written their readiness marker. */
async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

/**
 * Assert a stub recorded the signal it was asked to shut down on. A no-op on
 * Windows, where every `child.kill()` is a TerminateProcess and no handler
 * runs: the marker file is never written, so asserting on it would test
 * nothing about the launcher.
 */
function expectSignalled(file: string, signal: string): void {
  if (IS_WIN) return;
  expect(fs.readFileSync(file, "utf8")).toBe(signal);
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
}

describe("npm start launcher", () => {
  // POSIX-only: `process.kill(pid, "SIGINT")` at another process is not a
  // deliverable signal on Windows. It terminates the target outright, so
  // there is no relay to observe. The console path Windows uses instead can
  // only be checked on a real Windows console.
  onPosix("relays SIGINT to both children and waits for a slow drain to finish", async () => {
    const cwd = fixture(
      // 400ms stands in for drainActiveTurns(): long enough that a launcher
      // which killed instead of waiting would leave no marker behind.
      stubStaysUp("app.signal", 400),
      stubStaysUp("pty.signal"),
    );
    const child = launch(cwd);
    await waitForFile(path.join(cwd, "app.signal.up"));
    await waitForFile(path.join(cwd, "pty.signal.up"));

    // Signal the launcher only, not the process group: this tests forwarding,
    // not what a shell would broadcast to the whole group.
    process.kill(child.pid!, "SIGINT");
    const { code } = await exitOf(child);

    expectSignalled(path.join(cwd, "app.signal"), "SIGINT");
    expectSignalled(path.join(cwd, "pty.signal"), "SIGINT");
    // A shutdown we were asked for is a success, whatever the children reported.
    expect(code).toBe(0);
  });

  it("takes the sidecar down when the app exits, and reports the app's code", async () => {
    const cwd = fixture(
      `require("node:fs").writeFileSync("app.up", "1"); setTimeout(() => process.exit(3), 150);`,
      stubStaysUp("pty.signal"),
    );
    const child = launch(cwd);
    await waitForFile(path.join(cwd, "pty.signal.up"));

    const { code } = await exitOf(child);
    expect(code).toBe(3);
    expectSignalled(path.join(cwd, "pty.signal"), "SIGTERM");
  });

  it("takes the app down when the sidecar dies, so a crashed pty can't be missed", async () => {
    const cwd = fixture(
      stubStaysUp("app.signal"),
      `require("node:fs").writeFileSync("pty.up", "1"); setTimeout(() => process.exit(1), 150);`,
    );
    const child = launch(cwd);
    await waitForFile(path.join(cwd, "app.signal.up"));

    const { code } = await exitOf(child);
    expect(code).toBe(1);
    expectSignalled(path.join(cwd, "app.signal"), "SIGTERM");
  });
});
