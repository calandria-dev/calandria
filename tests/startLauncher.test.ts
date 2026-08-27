/* scripts/start.mjs — the `npm start` launcher that replaced `concurrently -k`.
 *
 * It exists so Ctrl+C reaches server.js's own SIGINT handler and its graceful
 * drain gets to finish (docs/WINDOWS.md §8: concurrently kills through
 * tree-kill, whose win32 branch is an unconditional `taskkill /T /F`, so the
 * drain lost a race it could not win). The property under test is therefore
 * "the launcher relays the signal and then WAITS", which is invisible to a
 * unit test of any single function — so this runs the real script against stub
 * entrypoints in a temp cwd. The launcher resolves `server.js` / `pty-server.js`
 * cwd-relative for exactly that reason.
 *
 * Windows' console-signal path can't be exercised from here; what this pins is
 * the POSIX behaviour plus the shared lifetime contract (first exit wins, the
 * survivor comes down with it) that both platforms rely on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
}

describe("npm start launcher", () => {
  it("relays SIGINT to both children and waits for a slow drain to finish", async () => {
    const cwd = fixture(
      // 400ms stands in for drainActiveTurns(): long enough that a launcher
      // which killed instead of waiting would leave no marker behind.
      stubStaysUp("app.signal", 400),
      stubStaysUp("pty.signal"),
    );
    const child = launch(cwd);
    await waitForFile(path.join(cwd, "app.signal.up"));
    await waitForFile(path.join(cwd, "pty.signal.up"));

    // Signal the LAUNCHER only — not the process group — so the assertion is
    // about forwarding rather than about the shell that would broadcast it.
    process.kill(child.pid!, "SIGINT");
    const { code } = await exitOf(child);

    expect(fs.readFileSync(path.join(cwd, "app.signal"), "utf8")).toBe("SIGINT");
    expect(fs.readFileSync(path.join(cwd, "pty.signal"), "utf8")).toBe("SIGINT");
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
    expect(fs.readFileSync(path.join(cwd, "pty.signal"), "utf8")).toBe("SIGTERM");
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
    expect(fs.readFileSync(path.join(cwd, "app.signal"), "utf8")).toBe("SIGTERM");
  });
});
