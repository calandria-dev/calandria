/* Orchestrator — terminal sidecar.
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
const { WebSocketServer } = require("ws");
const pty = require("node-pty");

// Per-instance overrides (see docs/SELF_HOSTING.md "Configuration"). The sidecar stays bound
// to loopback by default — the browser never talks to it directly; server.js
// proxies /pty upgrades to it on the same machine.
const PORT = process.env.PTY_PORT ? Number(process.env.PTY_PORT) : 3001;
const HOST = process.env.PTY_HOST || "127.0.0.1";

// Last-resort process guards, the same backstop server.js installs and for the
// same reason — except the blast radius here is bigger than it looks. `npm
// start` runs the two processes under `concurrently -k`, so -k kills the app
// when the sidecar dies: one malformed frame on one terminal socket would take
// down every in-flight agent turn across every project plus all SSE streams.
// A terminal tab is not allowed to be that load-bearing. Individual call sites
// are fixed to degrade gracefully; these catch the rest of the class. We log
// LOUDLY rather than exit — the noise is deliberate, since this can mask real
// bugs: every occurrence is a bug to chase, not a state to live in.
process.on("unhandledRejection", (reason) => {
  console.error("[pty-server] UNHANDLED REJECTION (kept alive — investigate):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[pty-server] UNCAUGHT EXCEPTION (kept alive — investigate):", err);
});

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("orchestrator pty-server");
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
          console.warn(`[pty-server] rejected connection from ${peer} (not loopback)`);
          return callback(false, 401, "Unauthorized");
        }
        const headers = { host: info.req.headers.host, origin: info.origin };
        if (!origin.originAuthEnabled()) {
          const allowed = localOrigin.localWebSocketRequestAllowed(headers);
          if (!allowed) console.warn(`[pty-server] rejected connection — origin ${info.origin || "(none)"} not allowed in local mode`);
          return callback(allowed);
        }
        // Access mode. Same two checks the app makes, for the same two reasons:
        // same-origin proves the handshake wasn't initiated by a hostile page
        // (the Access cookie is SameSite=None), the assertion proves who it is.
        // server.js forwards the upgrade's headers verbatim, so both are here.
        if (!localOrigin.sameOriginWebSocketRequestAllowed(headers)) {
          console.warn(`[pty-server] rejected connection — origin ${info.origin || "(none)"} does not match host ${headers.host || "(none)"}`);
          return callback(false, 401, "Unauthorized");
        }
        try {
          await origin.verifyOriginNodeRequest(info.req);
        } catch (err) {
          console.warn(`[pty-server] rejected connection — no valid Access assertion (${err?.message || err})`);
          return callback(false, 401, "Unauthorized");
        }
        callback(true);
      })
      .catch((err) => {
        console.error("[pty-server] Failed to evaluate the connection gate", err);
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

  const shell = process.env.SHELL || "/bin/zsh";
  // The project's deterministic port (projects.port), injected as PORT so a dev
  // server the user launches by hand in this shell binds the same address the
  // orchestrator's managed services + future subdomain routing expect.
  const port = Number(url.searchParams.get("port"));
  const env = { ...process.env, TERM: "xterm-256color" };
  if (port > 0) env.PORT = String(port);
  const term = pty.spawn(shell, [], {
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
    // but for the process guards above, exits the sidecar, which
    // `concurrently -k` turns into an app-wide outage. So every field is
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
// the key still present. See lib/env-keys.mjs (ORCH_ALLOW_API_KEY_ENV opts in).
import("./lib/env-keys.mjs").then((envKeys) => {
  for (const name of envKeys.stripInheritedAgentKeys()) {
    console.warn(`[pty-server] WARN: ${name} was set in the environment — unsetting it (ORCH_ALLOW_API_KEY_ENV=1 to keep).`);
  }
  server.listen(PORT, HOST, () => {
    console.log(`[pty-server] listening on ws://${HOST}:${PORT}`);
  });
});
