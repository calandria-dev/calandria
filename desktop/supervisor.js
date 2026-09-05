/* Calandria desktop shell: sidecar supervisor.
 *
 * SPIKE CODE.
 *
 * Contains no `require("electron")`: finding a Node that can load
 * better-sqlite3, picking ports that don't fight a `npm run dev` the user
 * already has, waiting for readiness, and draining in-flight turns on quit
 * is process management, not window management. Staying Electron-free keeps
 * it testable with plain `node` (test-supervisor.js) and lets the shell be
 * swapped later without rewriting this.
 *
 * The sidecars must run under a real node binary, never under Electron's
 * (`ELECTRON_RUN_AS_NODE`): better-sqlite3 is a V8-ABI addon and the npm
 * prebuild for Node 22 (ABI 127) will not load into Electron 44 (ABI 149)
 * without @electron/rebuild, and lib/agents/codex/driver.ts spawns the MCP
 * bridge via `process.execPath`, which under Electron is the Electron
 * binary, so a Codex turn would launch a GUI process instead of the tool
 * bridge.
 */
"use strict";

const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnvFile } = require("./env-file");

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
 * Reads `PORT`/`PTY_PORT` off an environment, as the Supervisor's
 * `port`/`ptyPort` options. A preference, not a demand: `pickPorts` still
 * steps past a busy one, so a second Calandria on a dev box still starts.
 *
 * Lives here, not in `main.js`, so it can be tested without a display and
 * the shell's own wiring stays a plain spread. Junk values (non-numeric, 0,
 * out of range) are dropped: `pickPorts` would probe from a bad value and
 * `sidecarEnv` treats 0 as unset, so a typo'd PORT would land the app back
 * on 3000 with no warning.
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
 * Prefers the documented defaults (3000/3001) so a user's bookmarks, their
 * `PUBLIC_BASE_URL`, and any project's managed services keep working, but
 * never fails to launch just because something else holds those ports. A
 * `npm run dev` already running in a terminal is an expected collision, not
 * an error.
 */
async function pickPorts({ port = 3000, ptyPort = 3001, probes = 20 } = {}) {
  // `claimed` keeps this from being two independent searches: with 3000 and
  // 3001 both busy, both would converge on 3002, and the second sidecar to
  // bind would lose with EADDRINUSE while the readiness probe talks to
  // whichever one won.
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
 * Finds a Node the sidecars can run under, in order of preference:
 *   1. CALANDRIA_NODE: explicit override, always wins.
 *   2. A node bundled into the packaged app's resources (extraResources).
 *   3. The current process's execPath, only when it is already plain Node
 *      (under Electron this is the Electron binary; see the file header).
 *   4. `node` on PATH.
 * Returns { path, version, source } or throws with an actionable message.
 *
 * `execPath`/`isElectron` are injectable so the Electron case, where
 * execPath must be rejected, can be tested without running inside Electron.
 */
function resolveNode({
  env = process.env,
  resourcesPath = null,
  execPath = process.execPath,
  // Set even under ELECTRON_RUN_AS_NODE, the case this must reject.
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
    // Probe with the same env the sidecars will get: otherwise a bare `node`
    // resolves against the supervisor's own PATH and reports a runtime the
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
 * The env the sidecars run with.
 *
 * Strips every ELECTRON_* var: the server spawns agent CLIs, MCP bridges,
 * and (through pty-server) the user's login shell, and all of them inherit
 * this env, so a leaked ELECTRON_RUN_AS_NODE would turn any `electron` a
 * task's build invokes into a headless node, and ELECTRON_IS_DEV or
 * _RUN_AS_NODE showing up in a user's terminal would be confusing.
 *
 * Sets ports, PTY_HOST, and optionally NODE_ENV. An inherited SHELL passes
 * through untouched; win32 shell selection goes through its own probe
 * (CALANDRIA_PTY_SHELL -> $SHELL -> pwsh.exe -> powershell.exe -> COMSPEC,
 * docs/WINDOWS.md).
 *
 * NODE_ENV is the caller's choice (`nodeEnv`), not unconditionally
 * "production": the app sidecar still gets `nodeEnv: "production"` below,
 * since it ships a prebuilt `.next` and server.js:118 keys `dev` off
 * NODE_ENV. A turn spawned from that sidecar must not inherit
 * NODE_ENV=production for its own subprocess, since that makes `npm
 * install` in a user's project skip devDependencies and still exit 0;
 * lib/agentEnv.ts strips it back out of the env each turn's subprocess
 * gets.
 */
function sidecarEnv({ env = process.env, port, ptyPort, dbDir = null, nodeEnv = null, extra = {} } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("ELECTRON_")) continue;
    if (v !== undefined) out[k] = v;
  }
  if (nodeEnv) out.NODE_ENV = nodeEnv;
  else delete out.NODE_ENV;
  if (port) out.PORT = String(port);
  if (ptyPort) out.PTY_PORT = String(ptyPort);
  out.PTY_HOST = env.PTY_HOST || "127.0.0.1";
  if (dbDir) out.CALANDRIA_DB_DIR = dbDir;
  return { ...out, ...extra };
}

// The PATH launchd hands a macOS .app opened from Finder or Spotlight. A GUI
// app inherits this PATH, so `codex`, `gh`, a Homebrew git, and an
// nvm-managed node can be invisible to a double-clicked Calandria even
// though they resolve fine in the same user's terminal.
const LAUNCHD_PATH_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin"]);

/**
 * Does this PATH look like the stub launchd gives GUI apps? Only then is a
 * login-shell probe worth its cost: shell startup (rc files, version
 * managers) can take hundreds of ms, so it should not run on every launch
 * when the PATH is already the user's real one.
 */
function needsPathRepair(env = process.env) {
  if (process.platform === "win32") return false;
  const parts = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  if (parts.length === 0) return true;
  return parts.every((p) => LAUNCHD_PATH_DIRS.has(p));
}

/**
 * Asks the user's login shell what PATH it has. The sentinel fences the
 * value: an interactive login shell also prints motd text, version-manager
 * banners, and whatever else lives in the rc files.
 * Returns null on any failure: a wrapper that refuses to launch over a
 * timed-out shell probe is worse than one that runs with a short PATH.
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

/**
 * Polls GET /api/version until it answers 200, or gives up.
 *
 * `env` is the env the sidecars were given, matching drainApp(): SERVICE_TOKEN
 * can arrive from the desktop env file (desktop/env-file.js), which
 * Electron's own process.env never sees. Reading process.env here would poll
 * an authenticated instance with no token and time the boot out on a 401.
 */
async function waitForReady(port, { timeoutMs = 60_000, intervalMs = 250, signal = null, env = process.env } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("readiness wait aborted");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/version`, {
        headers: env.SERVICE_TOKEN ? { "x-service-token": env.SERVICE_TOKEN } : {},
        // Passed to the fetch too: an abort arriving mid-probe ends the wait
        // immediately, without waiting on this request and the next sleep.
        signal,
      });
      if (res.ok) {
        // Checks the response shape as well as the status: pty-server.js
        // answers every path with its own banner, so a port mismatch would
        // otherwise read as ready and load the pty sidecar into the window.
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
 * Builds the rejection `start()` gives its caller when a sidecar dies before
 * the app answers.
 *
 * `waitForReady` only polls a port. A sidecar that exited early still costs
 * the full CALANDRIA_READY_TIMEOUT_MS (90s) and then reports a generic
 * timeout that hides the real cause, so this reads the cause from the
 * exiting child's own log output.
 *
 * The reason is read straight from the log tail, where a sidecar's own
 * message lives, e.g. `[app] [server] another Calandria process already
 * holds this database (pid 4242 on devBox)`. Only lines from the child that
 * died are used: the other sidecar's boot chatter is often the last thing
 * printed and could otherwise be mistaken for the explanation.
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
 * Not an EventEmitter: the shell needs exactly three callbacks (log line,
 * unexpected exit, ready) plus a promise-shaped start/stop, and a spike is
 * a bad place to invent an event vocabulary the shell would have to mirror.
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
    // Mirrors lib/env.mjs's CALANDRIA_X-falls-back-to-ORCH_X alias by hand:
    // this file is CommonJS and can't import the ESM reader.
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
    // Which tree the sidecars run out of: packaged is resources/app-payload,
    // unpackaged is the checkout, and CALANDRIA_REPO_ROOT overrides both.
    // This is what lets a packaged test run tell a self-contained install
    // from one still leaning on a working copy (desktop/e2e/06-packaged
    // .spec.ts). It also goes to the boot screen, so a failed launch below
    // shows where it looked as well as what it did not find.
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
    this.effectiveEnv = this.env;

    // The desktop app is the only Calandria launch path with no wrapper
    // script in front of it. `npm start`/`npm run dev` inherit whatever
    // exported the shell that ran them, but a Finder double-click, a Dock
    // click, or a Login Item hands main.js launchd's own minimal
    // environment, with nothing sourced and nothing exported.
    // desktop/env-file.js is the desktop replacement for that launcher: a
    // small, predictable file read before either sidecar spawns. It does not
    // strip ANTHROPIC_API_KEY and friends here: both sidecars already call
    // stripInheritedAgentKeys() on their own process.env at boot
    // (pty-server.js:237, server.js), and stripping here first would break
    // the CALANDRIA_ALLOW_API_KEY_ENV opt-in that the env file itself can
    // set.
    const loaded = loadEnvFile({ env: this.env });
    if (loaded.found) {
      const names = Object.keys(loaded.vars);
      if (names.length) this.effectiveEnv = { ...this.effectiveEnv, ...loaded.vars };
      // Names only, never values: this log is shown verbatim on the failure
      // screen, and this file is where people put tokens.
      this.log(`[env] ${loaded.path}: ${names.length} variable(s) — ${names.join(", ")}`);
      for (const s of loaded.skipped) this.log(`[env] WARN: ${loaded.path}:${s.line} ignored (${s.reason})`);
    } else {
      this.log(`[env] no env file at ${loaded.path}`);
    }

    // PATH repair comes next: it decides whether `node`, `git`, `gh` and
    // `codex` are findable at all, and resolveNode below reads its result.
    // Both reads go through effectiveEnv, so an env file that sets SHELL or
    // PATH is honored by the probe itself.
    //
    // CALANDRIA_DESKTOP_PATH_PROBE is the escape hatch for a smaller trap in
    // needsPathRepair(): it fires only when every PATH entry is in the
    // launchd stub set, so a machine whose GUI PATH carries one extra
    // plausible directory gets no repair and no warning. Probing is not
    // unconditional by default: the repair costs a full login-shell startup
    // (rc files, version managers) on every launch, and "auto" already covers
    // the documented failure mode.
    const probeMode = String(this.effectiveEnv.CALANDRIA_DESKTOP_PATH_PROBE || "auto").toLowerCase();
    let wantProbe;
    if (probeMode === "off") wantProbe = false;
    else if (probeMode === "always") wantProbe = true;
    else wantProbe = needsPathRepair(this.effectiveEnv);

    if (Object.prototype.hasOwnProperty.call(loaded.vars, "PATH")) {
      // An operator who wrote PATH into the env file means it: probing over
      // the top of an explicit value would overwrite what they asked for
      // with the login shell's PATH.
      this.log(`[env] PATH supplied by ${loaded.path} — skipping the launchd-stub probe`);
    } else if (wantProbe) {
      const repaired = loginShellPath({ env: this.effectiveEnv });
      if (repaired) {
        this.effectiveEnv = { ...this.effectiveEnv, PATH: repaired };
        this.log(`[shell] PATH looked like launchd's stub — took the login shell's instead`);
      } else {
        this.log(`[shell] WARN: PATH looks minimal and the login-shell probe failed; git/gh/codex may not resolve`);
      }
    } else {
      // Logs even on the branch that decides whether every agent CLI
      // resolves, so "the app can't find codex" is diagnosable from a log,
      // and desktop/e2e/08-macos-launchd.spec.ts can tell a broken repair
      // from a machine that was never handed the launchd stub.
      this.log(`[shell] PATH is not launchd's stub, using it as-is: ${this.effectiveEnv.PATH}`);
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
    const ptyEnv = sidecarEnv({ env: this.effectiveEnv, port: this.port, ptyPort: this.ptyPort, dbDir: this.dbDir });
    // The app sidecar alone keeps NODE_ENV=production: it ships a prebuilt
    // `.next` and server.js:118 keys its own dev/prod branch off it. The pty
    // sidecar, and through it every terminal tab and agent turn, gets none.
    // See the NODE_ENV paragraph on sidecarEnv above.
    const appEnv = sidecarEnv({ env: this.effectiveEnv, port: this.port, ptyPort: this.ptyPort, dbDir: this.dbDir, nodeEnv: "production" });

    // The readiness wait races against this: it resolves the moment either
    // sidecar exits, which is a boot failure regardless of how much of the
    // deadline remained. Live only for the duration of start(); after that
    // an exit is the shell's business (`onExit`).
    const bootExit = new Promise((resolve) => {
      this.notifyBootExit = resolve;
    });

    // pty first: server.js proxies /pty and logs its target at boot, so having
    // the sidecar already listening keeps the first terminal open from racing.
    this.spawnChild("pty", this.ptyScript, ptyEnv);
    this.spawnChild("app", this.serverScript, appEnv);

    // The timeout is the backstop for the other failure: a sidecar that is
    // alive but never answers (a wedged Next build, a half-migrated db).
    // Nothing about that case can be learned from a process that is still
    // running, so the deadline is the only evidence available.
    const abort = new AbortController();
    const ready = waitForReady(this.port, {
      timeoutMs: Number(this.effectiveEnv.CALANDRIA_READY_TIMEOUT_MS || 90_000),
      signal: abort.signal,
      env: this.effectiveEnv,
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
      // No `detached`: these must die with the shell, and on Windows
      // `detached` means "new console window", which is wrong here.
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
        // Before `onExit`, which is somebody else's callback: main.js's ends
        // in `app.exit(1)` and never returns. Resolving here only queues a
        // microtask, so the shell's handler still runs first either way. This
        // ordering keeps a start() in flight from being stranded on the 90s
        // timeout by a host callback that throws or never returns.
        this.notifyBootExit?.(rec);
        this.onExit(rec);
      }
    });
    this.children.push({ name, child, exited: null });
    return child;
  }

  /**
   * POSTs /api/instance/drain and waits for it, bounded.
   *
   * Best-effort by contract, like the boot pings on the other side of the
   * lifecycle: a refused connection (the app died before this ran), a 404
   * (an older build without the route), and a hang are all "stop anyway": a
   * quit that never completes is worse than one that skipped a settlement.
   * The bound mirrors server.js's own CALANDRIA_SHUTDOWN_GRACE_MS, which is
   * what the route waits for server-side, plus headroom for the round trip,
   * so a drain already requested is not abandoned moments before it
   * finishes.
   *
   * Reads SERVICE_TOKEN off the env the sidecars were given, since that is
   * what the server checks against.
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
   * Drains, then sends SIGTERM, then waits, with SIGKILL as the backstop.
   *
   * The drain is an HTTP POST this process makes over loopback: Windows has
   * no deliverable SIGTERM, so `child.kill("SIGTERM")` there is a
   * TerminateProcess that server.js's own handler never runs, which would
   * cut a turn in flight off with nothing durable recorded. Asking over
   * loopback works the same on every platform and leaves the signal path as
   * a pure backstop: on POSIX, server.js still POSTs the same route on
   * SIGTERM, which by then finds nothing in flight and returns immediately.
   * This lives here, matching what a systemd/service wrapper would do.
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
