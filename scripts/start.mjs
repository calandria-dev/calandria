// Production launcher for `npm start`: boots the app (server.js) and the
// node-pty sidecar (pty-server.js) as two children of this process and ties
// their lifetimes together, the same contract docker/entrypoint.sh implements
// with `wait -n`.
//
// It exists for one reason `concurrently` can't satisfy: Ctrl+C must reach
// server.js's own SIGINT handler, because that handler runs the graceful
// drain (POST /api/instance/drain -> drainActiveTurns() in lib/runner.ts),
// which persists every in-flight turn's interrupted state instead of
// leaving it to the next boot's recoverFromCrash().
//
// `concurrently` kills its children through `tree-kill`, whose win32 branch
// is `taskkill /pid <pid> /T /F` unconditionally: the requested signal is
// ignored. So on Windows, Ctrl+C reaches server.js directly (children share
// the console and concurrently spawns them with `detached: false`), but
// concurrently's own SIGINT handler force-terminates the whole tree in the
// same tick, and the drain loses the race against `taskkill /F`. See
// docs/WINDOWS.md §8.
//
// The two platform rules this file exists for:
//
//   * POSIX: forward the signal we received to each live child, then wait.
//   * win32: on a console signal (Ctrl+C / Ctrl+Break), send nothing at all.
//     The console has already delivered the event to every attached process,
//     and Node's child.kill() on Windows is a TerminateProcess for every
//     signal name, so forwarding it would reintroduce the bypass this file
//     removes.
//
// Plain Node, no dependencies, no imports from lib/: it runs before anything
// else does. Script paths are cwd-relative, matching what these npm scripts
// always used (`node server.js`), which also makes the launcher testable
// against stub entrypoints in a temp dir (tests/startLauncher.test.ts).
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

// Mirrors lib/config.ts's SHUTDOWN_GRACE_MS, per this repo's plain-Node
// convention of reading the same env name directly. server.js's own hard
// timeout is graceMs + 3s; ours is later so the app's self-exit wins and
// this only force-kills something genuinely wedged.
const graceMs = (() => {
  const raw = process.env.CALANDRIA_SHUTDOWN_GRACE_MS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 5000;
})();
const forceKillAfterMs = graceMs + 6000;

// pty first, matching docker/entrypoint.sh: the app proxies /pty upgrades to
// it, so the sidecar being up first avoids a refused upgrade on a fast reload.
const ENTRIES = [
  { name: "pty", script: "pty-server.js" },
  { name: "app", script: "server.js" },
];

const children = ENTRIES.map((entry) => {
  const child = spawn(process.execPath, [entry.script], {
    stdio: "inherit",
    windowsHide: true,
  });
  const rec = { ...entry, child, alive: true };
  child.on("error", (err) => {
    console.error(`[start] failed to spawn ${entry.script}: ${err?.message || err}`);
    rec.alive = false;
    settle(rec, 1, null);
  });
  child.on("exit", (code, signal) => {
    rec.alive = false;
    settle(rec, code, signal);
  });
  return rec;
});

let stopping = false;
let signalled = false;
let exitCode = null;
let forceTimer = null;

// First exit wins: its status is what `npm start` reports, and the other
// child comes down with it. A child that dies on its own is a failure even
// when the shutdown it triggers is orderly.
function settle(rec, code, signal) {
  if (exitCode === null) {
    exitCode = code === null ? (signal ? 1 : 0) : code;
    if (!stopping) {
      console.log(
        `[start] ${rec.name} exited (${signal ? `signal ${signal}` : `code ${code}`}); stopping the other process`,
      );
    }
  }
  if (children.every((c) => !c.alive)) {
    if (forceTimer) clearTimeout(forceTimer);
    // A shutdown we were asked for is a success, whatever the children's own
    // exit statuses say: the pty sidecar installs no SIGINT handler, so it
    // dies by the signal and would otherwise turn every Ctrl+C into a
    // failing `npm start`.
    process.exit(signalled ? 0 : (exitCode ?? 0));
  }
  stop(null);
}

// `signal` is the console/POSIX signal we are relaying, or null when the
// shutdown was triggered by a child exiting rather than by the user.
function stop(signal) {
  if (stopping) return; // a second Ctrl+C must not preempt a drain in progress
  stopping = true;
  signalled = signal !== null;

  // On Windows a console signal was already broadcast to every process
  // attached to this console, so there is nothing to forward, and nothing
  // that could be forwarded: child.kill() there is TerminateProcess
  // regardless of the signal name and would skip server.js's drain. Just
  // wait for them.
  const consoleSignal = isWindows && (signal === "SIGINT" || signal === "SIGBREAK");
  if (!consoleSignal) {
    for (const rec of children) {
      if (!rec.alive) continue;
      // No signal means a child died and we're taking the survivor down. On
      // POSIX that's a graceful SIGTERM (server.js drains on it); on
      // Windows it is unavoidably a TerminateProcess, since the app has no
      // console event to react to there, so a sidecar crash still skips the
      // drain on that platform.
      try {
        rec.child.kill(signal || "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  forceTimer = setTimeout(() => {
    for (const rec of children) {
      if (!rec.alive) continue;
      console.warn(`[start] ${rec.name} did not exit within ${forceKillAfterMs}ms; forcing`);
      try {
        rec.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, forceKillAfterMs);
  forceTimer.unref?.();
}

const SIGNALS = isWindows ? ["SIGINT", "SIGBREAK", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
for (const sig of SIGNALS) {
  // Registering a listener also stops Node from killing this process on the
  // default handler, letting it outlive the children and wait for them.
  process.on(sig, () => stop(sig));
}
