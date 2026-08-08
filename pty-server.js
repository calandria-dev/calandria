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

// Per-instance overrides (see README "Configuration"). The sidecar stays bound
// to loopback by default — the browser never talks to it directly; server.js
// proxies /pty upgrades to it on the same machine.
const PORT = process.env.PTY_PORT ? Number(process.env.PTY_PORT) : 3001;
const HOST = process.env.PTY_HOST || "127.0.0.1";

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("orchestrator pty-server");
});

const wss = new WebSocketServer({
  server,
  verifyClient: (info, callback) => {
    import("./lib/auth/local-origin.mjs")
      .then((localOrigin) => {
        const allowed = localOrigin.localWebSocketRequestAllowed({
          host: info.req.headers.host,
          origin: info.origin,
        });
        callback(allowed);
      })
      .catch((err) => {
        console.error("[pty-server] Failed to load local-origin.mjs", err);
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
    if (msg.type === "input") term.write(msg.data);
    else if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) {
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
