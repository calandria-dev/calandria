/* Calandria — terminal sidecar.
 * A tiny WebSocket server that bridges xterm.js (browser) to a real PTY
 * (node-pty) so the UI gets a full interactive shell. Bound to localhost only.
 *
 * Protocol:
 *   client -> server : JSON  { type: 'input', data } | { type: 'resize', cols, rows }
 *   server -> client : binary frames = terminal output; text JSON = control
 *                      ({ type: 'ready', cwd } | { type: 'exit', exitCode })
 */
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");

// Structured logging (lib/log.mjs) — same lazy shape as server.js: this
// entrypoint is CommonJS and can only reach an ES module through import(), so
// `log` starts as a console shim printing what the module's default text format
// prints and is replaced once the import lands. The sidecar is a separate
// process, so it reads CALANDRIA_LOG_FORMAT itself; an instance set to json
// would otherwise emit half its output unparseable.
let log = {
  info: (msg) => console.log(`[pty-server] ${msg}`),
  warn: (msg) => console.warn(`[pty-server] ${msg}`),
  error: (msg) => console.error(`[pty-server] ${msg}`),
};
import("./lib/log.mjs").then((m) => {
  log = m.createLogger("pty-server");
});

// Mirrors num() in lib/config.ts — duplicated because this plain-Node
// entrypoint can't import TS. Falls back to `def` and warns once when the
// var is set but not a number (issue #18 item 1).
function numEnv(name, raw, def) {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    log.warn(`${name}=${JSON.stringify(raw)} is not a number; using default ${def}`);
    return def;
  }
  return n;
}

// Per-instance overrides (see docs/SELF_HOSTING.md "Configuration"). The sidecar stays bound
// to loopback by default — the browser never talks to it directly; server.js
// proxies /pty upgrades to it on the same machine.
const PORT = numEnv("PTY_PORT", process.env.PTY_PORT, 3001);
const HOST = process.env.PTY_HOST || "127.0.0.1";

const IS_WINDOWS = process.platform === "win32";

/** First name in `names` that exists in a PATH directory, or null. */
function onPath(names) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      try {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
      } catch {}
    }
  }
  return null;
}

/** First path in `candidates` that exists, or the last one as a last resort. */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return candidates[candidates.length - 1];
}

// The shell every terminal tab spawns. CALANDRIA_PTY_SHELL -> $SHELL -> a
// platform default. The knob is read here rather than in lib/config.ts because
// this plain-Node entrypoint can't import TS; it is documented in .env.example
// and docs/SELF_HOSTING.md's configuration table like every other env var.
//
// $SHELL alone was the whole resolution and it is only a POSIX convention: it
// is unset on native Windows and under systemd/trimmed environments, and the
// old `/bin/zsh` fallback exists on neither Windows nor most Linux boxes, so
// the drawer just failed to spawn. The defaults are therefore probed rather
// than assumed. On win32 that means a real PowerShell if one is on PATH
// (pwsh.exe is the nicer shell) falling back to COMSPEC, which is the
// guaranteed one; on POSIX, zsh then bash then sh.
function resolveShell() {
  if (process.env.CALANDRIA_PTY_SHELL) return process.env.CALANDRIA_PTY_SHELL;
  if (process.env.SHELL) return process.env.SHELL;
  if (IS_WINDOWS) {
    return onPath(["pwsh.exe", "powershell.exe"]) || process.env.COMSPEC || "cmd.exe";
  }
  return firstExisting(["/bin/zsh", "/bin/bash", "/bin/sh"]);
}

const SHELL = resolveShell();

// Last-resort process guards, the same backstop server.js installs and for the
// same reason — except the blast radius here is bigger than it looks. `npm
// start` runs the two processes under one launcher (scripts/start.mjs) that
// takes the app down when the sidecar dies: one malformed frame on one
// terminal socket would take
// down every in-flight agent turn across every project plus all SSE streams.
// A terminal tab is not allowed to be that load-bearing. Individual call sites
// are fixed to degrade gracefully; these catch the rest of the class. We log
// LOUDLY rather than exit — the noise is deliberate, since this can mask real
// bugs: every occurrence is a bug to chase, not a state to live in.
process.on("unhandledRejection", (reason) => {
  log.error("UNHANDLED REJECTION (kept alive — investigate)", { err: reason });
});
process.on("uncaughtException", (err) => {
  log.error("UNCAUGHT EXCEPTION (kept alive — investigate)", { err });
});

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("calandria pty-server");
});

// The sidecar's gate mirrors the app's, mode for mode. It must not simply
// assume it is sitting behind server.js's gate — anything that completes a
// handshake here gets a shell, so a browser page on this box that reaches
// PTY_PORT directly has to be turned away on its own merits. But it also must
// not enforce the WRONG mode's policy: applying the local-mode Host allowlist
// while the app runs behind Cloudflare Access is what used to kill the terminal
// on every Access deployment that left PUBLIC_BASE_URL empty (the tunnel Host
// is in no allowlist), and the log line said only "rejected connection".
// jose is ESM-only, hence the dynamic imports from this CommonJS file.
const localOriginImport = import("./lib/auth/local-origin.mjs");
const originImport = import("./lib/auth/origin.mjs");

const wss = new WebSocketServer({
  server,
  verifyClient: (info, callback) => {
    Promise.all([localOriginImport, originImport])
      .then(async ([localOrigin, origin]) => {
        // Peer address first: it is the one thing in this handshake the caller
        // cannot forge. server.js proxies from this same machine, so a
        // non-loopback peer found PTY_PORT directly.
        const peer = info.req.socket?.remoteAddress;
        if (!localOrigin.isLoopbackPeer(peer)) {
          log.warn("rejected connection — peer is not loopback", { peer });
          return callback(false, 401, "Unauthorized");
        }
        const headers = { host: info.req.headers.host, origin: info.origin };
        if (!origin.originAuthEnabled()) {
          const allowed = localOrigin.localWebSocketRequestAllowed(headers);
          if (!allowed) log.warn("rejected connection — origin not allowed in local mode", { origin: info.origin || "(none)" });
          return callback(allowed);
        }
        // Access mode. Same two checks the app makes, for the same two reasons:
        // same-origin proves the handshake wasn't initiated by a hostile page
        // (the Access cookie is SameSite=None), the assertion proves who it is.
        // server.js forwards the upgrade's headers verbatim, so both are here.
        if (!localOrigin.sameOriginWebSocketRequestAllowed(headers)) {
          log.warn("rejected connection — origin does not match host", { origin: info.origin || "(none)", host: headers.host || "(none)" });
          return callback(false, 401, "Unauthorized");
        }
        try {
          await origin.verifyOriginNodeRequest(info.req);
        } catch (err) {
          log.warn("rejected connection — no valid Access assertion", { err: err?.message || err });
          return callback(false, 401, "Unauthorized");
        }
        callback(true);
      })
      .catch((err) => {
        log.error("failed to evaluate the connection gate", { err });
        callback(false);
      });
  },
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  let cwd = url.searchParams.get("cwd") || os.homedir();
  try {
    if (!cwd || !fs.statSync(cwd).isDirectory()) cwd = os.homedir();
  } catch {
    cwd = os.homedir();
  }

  // The project's deterministic port (projects.port), injected as PORT so a dev
  // server the user launches by hand in this shell binds the same address the
  // Calandria's managed services + future subdomain routing expect.
  const port = Number(url.searchParams.get("port"));
  const env = { ...process.env };
  // POSIX only: ConPTY doesn't read TERM, and setting it leaks a variable that
  // makes cross-platform tooling believe it's talking to a POSIX terminal.
  if (!IS_WINDOWS) env.TERM = "xterm-256color";
  if (port > 0) env.PORT = String(port);
  const term = pty.spawn(SHELL, [], {
    name: "xterm-256color",
    cols: Number(url.searchParams.get("cols")) || 80,
    rows: Number(url.searchParams.get("rows")) || 24,
    cwd,
    env,
  });

  term.onData((d) => {
    try { ws.send(Buffer.from(d, "utf8")); } catch {}
  });
  term.onExit(({ exitCode }) => {
    try { ws.send(JSON.stringify({ type: "exit", exitCode })); ws.close(); } catch {}
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    // Well-formed JSON is not a well-formed message. `null` parses fine and
    // would throw a TypeError on the .type lookup below, and write() throws
    // ERR_INVALID_ARG_TYPE on a non-string — either escapes this handler and,
    // but for the process guards above, exits the sidecar, which the shared
    // lifetime in scripts/start.mjs turns into an app-wide outage. So every field is
    // checked before use. The try/catch additionally covers a write that races
    // the shell's own exit.
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "input" && typeof msg.data === "string") {
      try { term.write(msg.data); } catch {}
    } else if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) {
      try { term.resize(msg.cols, msg.rows); } catch {}
    }
  });
  ws.on("close", () => { try { term.kill(); } catch {} });

  try { ws.send(JSON.stringify({ type: "ready", cwd })); } catch {}
});

// Separate process from server.js, so it needs its own inherited-credential
// guard (issue #4): every pty shell inherits this env, and a leaked
// ANTHROPIC_API_KEY would silently switch `claude` in a terminal tab to
// per-token billing. Listen only after the strip so no shell can spawn with
// the key still present. See lib/env-keys.mjs (CALANDRIA_ALLOW_API_KEY_ENV opts in).
import("./lib/env-keys.mjs").then((envKeys) => {
  for (const name of envKeys.stripInheritedAgentKeys()) {
    log.warn(`WARN: ${name} was set in the environment — unsetting it (CALANDRIA_ALLOW_API_KEY_ENV=1 to keep).`);
  }
  server.listen(PORT, HOST, () => {
    log.info(`listening on ws://${HOST}:${PORT}`);
  });
});
