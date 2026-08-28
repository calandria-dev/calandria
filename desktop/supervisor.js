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

const MIN_NODE_MAJOR = 22; // package.json engines: >=22

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
 * SET — ports, NODE_ENV, and on Windows a SHELL, because pty-server.js falls
 * back to "/bin/zsh" when SHELL is unset (docs/WINDOWS.md). Setting it here is
 * a shell-side mitigation that needs no app change.
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
  if (process.platform === "win32" && !out.SHELL) {
    out.SHELL = out.COMSPEC || "powershell.exe";
  }
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

    // pty first: server.js proxies /pty and logs its target at boot, so having
    // the sidecar already listening keeps the first terminal open from racing.
    this.spawnChild("pty", this.ptyScript, env);
    this.spawnChild("app", this.serverScript, env);

    try {
      const version = await waitForReady(this.port, { timeoutMs: Number(this.env.CALANDRIA_READY_TIMEOUT_MS || 90_000) });
      this.log(`[shell] ready on http://127.0.0.1:${this.port} (version ${version?.version ?? "?"})`);
      return { url: `http://127.0.0.1:${this.port}`, port: this.port, ptyPort: this.ptyPort, version };
    } catch (err) {
      await this.stop();
      throw err;
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
        this.onExit({ name, code, signal, dbLockHeld: name === "app" && code === 1 && /already (running|holds)/i.test(this.recentLog(20)) });
      }
    });
    this.children.push({ name, child, exited: null });
    return child;
  }

  /**
   * SIGTERM, then wait. server.js's own handler POSTs /api/instance/drain and
   * exits when in-flight turns have settled (CALANDRIA_SHUTDOWN_GRACE_MS), so the
   * shell's job is only to not out-run it. SIGKILL is the backstop.
   * On Windows there is no SIGTERM: the .kill() lands as TerminateProcess, so
   * the drain is skipped — a known gap, listed in the spike doc.
   */
  async stop({ graceMs } = {}) {
    if (this.stopping) return;
    this.stopping = true;
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
  portFree,
  resolveNode,
  sidecarEnv,
  waitForReady,
  needsPathRepair,
  loginShellPath,
  MIN_NODE_MAJOR,
};
