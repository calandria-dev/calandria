/* Calandria desktop shell — sidecar supervisor.
 *
 * SPIKE CODE. See ./README.md and docs/DESKTOP_APP.md.
 *
 * This file deliberately contains NO `require("electron")`. Everything that is
 * hard about wrapping Calandria — finding a Node that can load better-sqlite3,
 * picking ports that don't fight a `npm run dev` the user already has, waiting
 * for readiness, and draining in-flight turns on quit — is process management,
 * not window management. Keeping it Electron-free means (a) it can be tested
 * with plain `node` (test-supervisor.js does exactly that, no GUI, no display)
 * and (b) if the shell is later swapped for Tauri/Wails, this survives intact.
 *
 * The one non-obvious rule, measured rather than assumed: the sidecars must run
 * under a REAL node binary, never under Electron's (`ELECTRON_RUN_AS_NODE`).
 * Two reasons, both in docs/DESKTOP_APP.md:
 *   - better-sqlite3 is a V8-ABI addon; the npm prebuild for Node 22 (ABI 127)
 *     will not load into Electron 44 (ABI 149) without @electron/rebuild.
 *   - lib/agents/codex/driver.ts spawns the MCP bridge as `process.execPath
 *     scripts/calandria-mcp.mjs` with a CLOSED four-key env map. Under an
 *     Electron-hosted server that execPath is the Electron binary and the child
 *     inherits no ELECTRON_RUN_AS_NODE, so every Codex turn would launch a
 *     silent GUI process instead of the tool bridge.
 */
"use strict";

const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const MIN_NODE_MAJOR = 20; // package.json engines: >=20.9

/** Is `port` free to bind on loopback right now? */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * `PORT`/`PTY_PORT` off an environment, as the Supervisor's `port`/`ptyPort`
 * options. A *preference*, not a demand — `pickPorts` still steps past a busy
 * one, which is what makes a second Calandria on a dev box survivable.
 *
 * Lives here rather than in `main.js` so it can be tested without a display,
 * and so the shell's one line of wiring stays a spread with nothing to get
 * subtly wrong. Junk (non-numeric, 0, out of range) is dropped rather than
 * passed on: `pickPorts` would probe from it and `sidecarEnv` treats 0 as
 * "unset", so a typo'd PORT would silently land the app back on 3000.
 */
function preferredPorts(env = process.env) {
  const out = {};
  const num = (raw) => {
    const n = Number(String(raw ?? "").trim());
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  };
  const port = num(env.PORT);
  const ptyPort = num(env.PTY_PORT);
  if (port) out.port = port;
  if (ptyPort) out.ptyPort = ptyPort;
  return out;
}

/**
 * Prefer the documented defaults (3000/3001) so a user's bookmarks, their
 * `PUBLIC_BASE_URL`, and any project's managed services keep working — but
 * never fail to launch because something else holds them. A developer running
 * `npm run dev` from a terminal is the expected collision, not an error.
 */
async function pickPorts({ port = 3000, ptyPort = 3001, probes = 20 } = {}) {
  // `claimed` is why this isn't two independent searches: with 3000 and 3001
  // both busy, both searches converge on 3002 and the second sidecar to bind
  // loses with EADDRINUSE — while the app's readiness probe cheerfully talks to
  // whichever one won. (Measured, on a box already running an instance.)
  const claimed = new Set();
  const pick = async (preferred) => {
    for (let i = 0; i < probes; i++) {
      const candidate = preferred + i;
      if (claimed.has(candidate)) continue;
      if (await portFree(candidate)) {
        claimed.add(candidate);
        return candidate;
      }
    }
    return 0; // let the OS choose — caller can't predict it, so this is a last resort
  };
  return { port: await pick(port), ptyPort: await pick(ptyPort) };
}

/**
 * Find a Node the sidecars can run under, in order of how much we trust it:
 *   1. CALANDRIA_NODE — explicit override, always wins.
 *   2. A node bundled into the packaged app's resources (extraResources).
 *   3. The current process's execPath, but ONLY when we are already plain Node
 *      (under Electron this is the Electron binary — see the file header).
 *   4. `node` on PATH.
 * Returns { path, version, source } or throws with an actionable message.
 *
 * `execPath`/`isElectron` are injectable for the same reason the env is: the
 * interesting case (running under Electron, where execPath must be rejected) is
 * otherwise only reachable by running the test suite inside Electron.
 */
function resolveNode({
  env = process.env,
  resourcesPath = null,
  execPath = process.execPath,
  // Set even under ELECTRON_RUN_AS_NODE, which is precisely the case to reject.
  isElectron = !!process.versions.electron,
} = {}) {
  const candidates = [];
  if (env.CALANDRIA_NODE) candidates.push({ path: env.CALANDRIA_NODE, source: "CALANDRIA_NODE" });
  if (resourcesPath) {
    const exe = process.platform === "win32" ? "node.exe" : "node";
    candidates.push({ path: path.join(resourcesPath, "node", "bin", exe), source: "bundled" });
    candidates.push({ path: path.join(resourcesPath, "node", exe), source: "bundled" });
  }
  if (!isElectron) candidates.push({ path: execPath, source: "execPath" });
  candidates.push({ path: process.platform === "win32" ? "node.exe" : "node", source: "PATH" });

  const tried = [];
  for (const c of candidates) {
    // `electron --version` prints a plausible "v44.0.0", so a CALANDRIA_NODE
    // pointed at Electron would pass the version probe and then fail much later
    // with an ABI error from better-sqlite3. Refuse it by name up front.
    if (/^electron/i.test(path.basename(c.path))) {
      tried.push(`${c.source}: ${c.path} — is Electron, not Node`);
      continue;
    }
    // Probe with the SAME env the sidecars will get — otherwise a bare `node`
    // resolves against the supervisor's own PATH and we'd report a runtime the
    // child can't actually find.
    const version = nodeVersion(c.path, env);
    tried.push(`${c.source}: ${c.path}${version ? ` (${version})` : " — not runnable"}`);
    if (!version) continue;
    const major = Number(version.replace(/^v/, "").split(".")[0]);
    if (Number.isFinite(major) && major < MIN_NODE_MAJOR) continue;
    return { path: c.path, version, source: c.source };
  }
  const err = new Error(
    `No usable Node ${MIN_NODE_MAJOR}+ found for the Calandria server.\n` +
      `Install Node ${MIN_NODE_MAJOR}+ or set CALANDRIA_NODE to its path.\nTried:\n  ${tried.join("\n  ")}`
  );
  err.code = "ENONODE";
  throw err;
}

function nodeVersion(bin, env = process.env) {
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, env, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().startsWith("v") ? out.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The env the sidecars run with. Two classes of edit, both load-bearing:
 *
 * STRIP — every ELECTRON_* var. The server spawns agent CLIs, MCP bridges and
 * (through pty-server) the user's login shell; all of them inherit this env.
 * A leaked ELECTRON_RUN_AS_NODE turns any `electron` a task's build happens to
 * invoke into a headless node, and ELECTRON_IS_DEV / _RUN_AS_NODE showing up in
 * a user's terminal is confusing at best.
 *
 * SET — ports and NODE_ENV, and nothing else. There used to be a win32 SHELL
 * fallback here, from when pty-server.js's unset-$SHELL default was "/bin/zsh";
 * the Windows-support work replaced that with a real probe (CALANDRIA_PTY_SHELL
 * -> $SHELL -> pwsh.exe -> powershell.exe -> COMSPEC, docs/WINDOWS.md), which
 * turned the mitigation into a DOWNGRADE: $SHELL is checked before the probe, so
 * injecting COMSPEC handed every desktop terminal tab cmd.exe on a box where the
 * server on its own would have picked PowerShell. Measured on Windows 11 with
 * pwsh 7 installed. An inherited SHELL is still passed through untouched, which
 * is the case the removal does not change.
 */
function sidecarEnv({ env = process.env, port, ptyPort, dbDir = null, extra = {} } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("ELECTRON_")) continue;
    if (v !== undefined) out[k] = v;
  }
  out.NODE_ENV = "production";
  if (port) out.PORT = String(port);
  if (ptyPort) out.PTY_PORT = String(ptyPort);
  out.PTY_HOST = env.PTY_HOST || "127.0.0.1";
  if (dbDir) out.CALANDRIA_DB_DIR = dbDir;
  return { ...out, ...extra };
}

// The PATH launchd hands a macOS .app opened from Finder/Spotlight. A GUI app
// inherits THIS, not the user's shell PATH — so `codex`, `gh`, a Homebrew git,
// and an nvm-managed node are all invisible to a double-clicked Calandria while
// working perfectly in the same user's terminal.
const LAUNCHD_PATH_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin"]);

/**
 * Does this PATH look like the stub launchd gives GUI apps? Only then is it
 * worth paying for a login shell: the repair costs a shell startup (rc files,
 * version managers — hundreds of ms) and would be a surprising thing to do on
 * every launch when the PATH is already the user's real one.
 */
function needsPathRepair(env = process.env) {
  if (process.platform === "win32") return false;
  const parts = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  if (parts.length === 0) return true;
  return parts.every((p) => LAUNCHD_PATH_DIRS.has(p));
}

/**
 * Ask the user's login shell what PATH it has. The sentinel is not decoration:
 * an interactive login shell prints motd, version-manager banners and whatever
 * else lives in the rc files, so the value has to be fenced to be found.
 * Returns null on any failure — a wrapper that refuses to launch because a
 * shell probe timed out is worse than one that runs with a short PATH.
 */
function loginShellPath({ env = process.env, timeoutMs = 5000 } = {}) {
  if (process.platform === "win32") return null;
  const shell = env.SHELL || "/bin/bash";
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(shell, ["-ilc", 'printf "__CAL_PATH_%s_END__" "$PATH"'], {
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...env, TERM: "dumb" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /__CAL_PATH_(.*?)_END__/s.exec(out);
    const value = m?.[1]?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

/** Poll GET /api/version until it answers 200, or give up. */
async function waitForReady(port, { timeoutMs = 60_000, intervalMs = 250, signal = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("readiness wait aborted");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/version`, {
        headers: process.env.SERVICE_TOKEN ? { "x-service-token": process.env.SERVICE_TOKEN } : {},
        // Also on the fetch, not just the loop head: an abort arriving while a
        // probe is in flight should end the wait now rather than after this
        // request and the next sleep.
        signal,
      });
      if (res.ok) {
        // Insist on the shape, not just a 200: pty-server.js answers every path
        // with its own banner, so a port mix-up would otherwise read as "ready"
        // and the window would load the sidecar instead of the app.
        const body = await res.json().catch(() => null);
        if (body && typeof body.version === "string") return body;
        lastErr = new Error(`port ${port} answered, but not as the app`);
      } else {
        lastErr = new Error(`status ${res.status}`);
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`server did not become ready on port ${port} within ${timeoutMs}ms (${lastErr?.message || "no response"})`);
}

/**
 * The rejection `start()` owes its caller when a sidecar dies before the app
 * answers.
 *
 * `waitForReady` polls a port and knows nothing about the process it is waiting
 * for, so on its own a sidecar that exited one second in still costs the whole
 * CALANDRIA_READY_TIMEOUT_MS (90s) and then reports the timeout — "server did
 * not become ready … (fetch failed)" — which names the symptom and hides the
 * cause. The child already said why it left; this puts THAT on the error.
 *
 * The reason is lifted out of the tail rather than re-derived, because the log
 * is where a sidecar's own words are: `[app] [server] another Calandria process
 * already holds this database (pid 4242 on devBox)`. Only lines from the child
 * that died are eligible — the other sidecar's boot chatter is the last thing
 * printed about half the time and would read as the explanation.
 */
function bootExitError({ name, code, signal, dbLockHeld }, tail = "") {
  const prefix = `[${name}] `;
  const said = String(tail)
    .split("\n")
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length).trim())
    .filter(Boolean)
    .pop();
  const how = signal ? `on ${signal}` : `with code ${code}`;
  const err = new Error(`the ${name} sidecar exited ${how} before the server became ready${said ? `: ${said}` : ""}`);
  err.code = "ESIDECAREXIT";
  err.child = { name, exitCode: code ?? null, signal: signal ?? null, dbLockHeld: !!dbLockHeld };
  return err;
}

/**
 * Supervises the two sidecars for one desktop session.
 *
 * Not an EventEmitter on purpose: the shell wants exactly three callbacks
 * (log line, unexpected exit, ready) and a promise-shaped start/stop, and a
 * spike is a bad place to invent an event vocabulary the shell then has to
 * mirror.
 */
class Supervisor {
  constructor(opts = {}) {
    this.repoRoot = opts.repoRoot || path.resolve(__dirname, "..");
    this.serverScript = opts.serverScript || path.join(this.repoRoot, "server.js");
    this.ptyScript = opts.ptyScript || path.join(this.repoRoot, "pty-server.js");
    this.resourcesPath = opts.resourcesPath || null;
    this.onLog = opts.onLog || (() => {});
    this.onExit = opts.onExit || (() => {});
    this.env = opts.env || process.env;
    this.dbDir = opts.dbDir || null;
    this.preferredPort = opts.port || 3000;
    this.preferredPtyPort = opts.ptyPort || 3001;
    // Mirrors lib/env.mjs's CALANDRIA_X-falls-back-to-ORCH_X alias by hand — this
    // file is CommonJS and can't import the ESM reader.
    this.shutdownGraceMs = Number(this.env.CALANDRIA_SHUTDOWN_GRACE_MS || this.env.ORCH_SHUTDOWN_GRACE_MS || 5000);
    this.children = [];
    this.port = null;
    this.ptyPort = null;
    this.stopping = false;
    this.tail = [];
    // Set only while start() is waiting for readiness; see the race there.
    this.notifyBootExit = null;
  }

  /** Last N log lines, for the "it failed to start" screen. */
  recentLog(n = 40) {
    return this.tail.slice(-n).join("\n");
  }

  log(line) {
    for (const l of String(line).split(/\r?\n/)) {
      if (!l.trim()) continue;
      this.tail.push(l);
      if (this.tail.length > 400) this.tail.shift();
      this.onLog(l);
    }
  }

  async start() {
    // Which tree the sidecars are about to run out of. Packaged that is
    // resources/app-payload, unpackaged the checkout, and CALANDRIA_REPO_ROOT
    // overrides both — one line that distinguishes a self-contained install
    // from one still leaning on somebody's working copy, which is exactly the
    // thing a packaged test run has to be able to see (desktop/e2e/06-packaged
    // .spec.ts). It goes to the boot screen too, so a launch that dies below
    // says where it looked rather than only what it did not find.
    this.log(`[shell] payload: ${this.repoRoot}`);
    if (!fs.existsSync(this.serverScript)) {
      throw new Error(`server entrypoint not found: ${this.serverScript}`);
    }
    const next = path.join(this.repoRoot, ".next");
    if (path.basename(this.serverScript) === "server.js" && !fs.existsSync(next)) {
      // NODE_ENV=production + no build = a boot loop of Next errors that reads
      // like a wrapper bug. Say the real thing instead.
      throw new Error(`no production build found at ${next} — run \`npm run build\` in ${this.repoRoot} first`);
    }
    // PATH repair comes FIRST: it decides whether `node`, `git`, `gh` and
    // `codex` are findable at all, and resolveNode below is one of its readers.
    this.effectiveEnv = this.env;
    if (needsPathRepair(this.env)) {
      const repaired = loginShellPath({ env: this.env });
      if (repaired) {
        this.effectiveEnv = { ...this.env, PATH: repaired };
        this.log(`[shell] PATH looked like launchd's stub — took the login shell's instead`);
      } else {
        this.log(`[shell] WARN: PATH looks minimal and the login-shell probe failed; git/gh/codex may not resolve`);
      }
    }

    const node = resolveNode({ env: this.effectiveEnv, resourcesPath: this.resourcesPath });
    this.node = node;
    this.log(`[shell] node: ${node.path} ${node.version} (${node.source})`);

    const ports = await pickPorts({ port: this.preferredPort, ptyPort: this.preferredPtyPort });
    this.port = ports.port;
    this.ptyPort = ports.ptyPort;
    if (this.port !== this.preferredPort) {
      this.log(`[shell] port ${this.preferredPort} busy — using ${this.port}`);
    }
    const env = sidecarEnv({ env: this.effectiveEnv, port: this.port, ptyPort: this.ptyPort, dbDir: this.dbDir });

    // The readiness wait races against this: it resolves the moment either
    // sidecar exits, which is a boot that has already failed no matter how long
    // the deadline still had to run. Live only for the duration of start() —
    // afterwards an exit is the shell's business (`onExit`), not the launch's.
    const bootExit = new Promise((resolve) => {
      this.notifyBootExit = resolve;
    });

    // pty first: server.js proxies /pty and logs its target at boot, so having
    // the sidecar already listening keeps the first terminal open from racing.
    this.spawnChild("pty", this.ptyScript, env);
    this.spawnChild("app", this.serverScript, env);

    // The timeout stays the backstop for the OTHER failure — a sidecar that is
    // alive and simply never answers (a wedged Next build, a half-migrated db).
    // Nothing about that case can be learned from a process that is still
    // running, so there the deadline is the only evidence there is.
    const abort = new AbortController();
    const ready = waitForReady(this.port, {
      timeoutMs: Number(this.env.CALANDRIA_READY_TIMEOUT_MS || 90_000),
      signal: abort.signal,
    }).then(
      (version) => ({ version }),
      (error) => ({ error })
    );
    const died = bootExit.then((rec) => {
      // Stop polling a port whose server is gone: without this the loser of the
      // race keeps fetching for the rest of the 90s, and under a caller that
      // retries the launch those probes outlive the Supervisor that made them.
      abort.abort();
      return { error: bootExitError(rec, this.recentLog(80)) };
    });

    try {
      const { version, error } = await Promise.race([ready, died]);
      if (error) throw error;
      this.log(`[shell] ready on http://127.0.0.1:${this.port} (version ${version?.version ?? "?"})`);
      return { url: `http://127.0.0.1:${this.port}`, port: this.port, ptyPort: this.ptyPort, version };
    } catch (err) {
      await this.stop();
      throw err;
    } finally {
      this.notifyBootExit = null;
      abort.abort();
    }
  }

  spawnChild(name, script, env) {
    const child = spawn(this.node.path, [script], {
      cwd: this.repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // No `detached` — these must die with the shell, and on Windows
      // `detached` means "new console window", which is exactly wrong here.
      windowsHide: true,
    });
    child.stdout.on("data", (d) => this.log(`[${name}] ${d}`));
    child.stderr.on("data", (d) => this.log(`[${name}] ${d}`));
    child.on("exit", (code, signal) => {
      const rec = this.children.find((c) => c.name === name);
      if (rec) rec.exited = { code, signal };
      this.log(`[shell] ${name} exited (code ${code}, signal ${signal ?? "none"})`);
      if (!this.stopping) {
        // The db lock is the expected non-crash exit: server.js catches
        // DbLockHeldError, prints the holder, and exit(1)s. Surfacing the code
        // lets the shell say "another Calandria is already running" instead of
        // "the app crashed".
        const rec = { name, code, signal, dbLockHeld: name === "app" && code === 1 && /already (running|holds)/i.test(this.recentLog(20)) };
        // Before `onExit`, which is somebody else's callback: main.js's ends in
        // `app.exit(1)` and never returns. Resolving here only queues a
        // microtask, so the shell's handler still runs first either way — this
        // ordering just means a start() in flight can't be stranded on the 90s
        // timeout by a host callback that throws or never comes back.
        this.notifyBootExit?.(rec);
        this.onExit(rec);
      }
    });
    this.children.push({ name, child, exited: null });
    return child;
  }

  /**
   * POST /api/instance/drain and wait for it, bounded.
   *
   * Best-effort by contract, like the boot pings on the other side of the
   * lifecycle: a refused connection (the app died before we got here), a 404
   * (an older build without the route) and a hang are all "stop anyway" — a
   * quit that never completes is worse than one that skipped a settlement.
   * The bound mirrors server.js's own: CALANDRIA_SHUTDOWN_GRACE_MS, which is
   * what the route waits for server-side, plus headroom for the round trip, so
   * we never abandon a drain we asked for a moment before it finishes.
   *
   * Reads SERVICE_TOKEN off the env the SIDECARS were given rather than this
   * process's, since that is the one the server is checking against.
   */
  async drainApp(drainMs) {
    const app = this.children.find((c) => c.name === "app");
    if (!this.port || !app || app.exited) return;
    const env = this.effectiveEnv || this.env;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), drainMs ?? this.shutdownGraceMs + 3000);
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/api/instance/drain`, {
        method: "POST",
        headers: env.SERVICE_TOKEN ? { "x-service-token": env.SERVICE_TOKEN } : {},
        signal: controller.signal,
      });
      this.log(`[shell] drained in-flight turns (status ${res.status})`);
    } catch (err) {
      this.log(`[shell] drain request failed, stopping anyway: ${err?.message || err}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Drain, then SIGTERM, then wait, with SIGKILL as the backstop.
   *
   * The drain is an HTTP POST THIS process makes rather than a signal
   * server.js catches, because Windows has no deliverable SIGTERM: there
   * `child.kill("SIGTERM")` is a TerminateProcess, server.js's own handler
   * never runs, and quitting mid-turn cut the turn off with nothing durable
   * recorded. Asking over loopback works the same on every platform, and
   * leaves the signal path as the backstop rather than the mechanism — on
   * POSIX server.js still POSTs the same route on SIGTERM, which by then finds
   * nothing in flight and returns immediately. The same order is what a
   * systemd/service wrapper would want, which is why it lives here and not in
   * main.js.
   */
  async stop({ graceMs, drainMs } = {}) {
    if (this.stopping) return;
    this.stopping = true;
    await this.drainApp(drainMs);
    const wait = graceMs ?? this.shutdownGraceMs + 4000;
    const live = this.children.filter((c) => !c.exited);
    for (const { child } of live) {
      try { child.kill("SIGTERM"); } catch {}
    }
    const deadline = Date.now() + wait;
    while (Date.now() < deadline && this.children.some((c) => !c.exited)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    let killed = false;
    for (const { name, child, exited } of this.children) {
      if (exited) continue;
      this.log(`[shell] ${name} did not exit in ${wait}ms — SIGKILL`);
      try { child.kill("SIGKILL"); killed = true; } catch {}
    }
    // Return only once everything is reaped: the shell calls this from
    // `before-quit` and a still-running sidecar would outlive the window,
    // holding the db lock against the next launch.
    if (killed) {
      const hard = Date.now() + 2000;
      while (Date.now() < hard && this.children.some((c) => !c.exited)) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
}

module.exports = {
  Supervisor,
  pickPorts,
  preferredPorts,
  portFree,
  resolveNode,
  sidecarEnv,
  waitForReady,
  needsPathRepair,
  loginShellPath,
  MIN_NODE_MAJOR,
};
