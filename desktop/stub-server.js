/* Stand-in for server.js, used only by test-supervisor.js.
 *
 * Mimics the three behaviours the shell actually depends on: it binds PORT on
 * loopback, answers GET /api/version, and on SIGTERM it "drains" for a moment
 * before exiting 0 — so a supervisor that kills too eagerly fails the test.
 *
 * STUB_MODE tweaks it for the unhappy paths:
 *   never-ready  — listens but 503s /api/version
 *   lock-held    — prints the db-lock message and exits 1, like a second instance
 *   ignore-term  — never exits on SIGTERM, so SIGKILL is exercised
 */
"use strict";
const http = require("node:http");

const mode = process.env.STUB_MODE || "ok";
const port = Number(process.env.PORT || 0);

if (mode === "lock-held") {
  console.error("[server] another Calandria process already holds this database (pid 4242 on devBox)");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/version")) {
    if (mode === "never-ready") {
      res.writeHead(503).end("warming up");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "stub", sha: "stub", builtAt: "stub" }));
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[stub-server] listening on 127.0.0.1:${server.address().port} shell=${process.env.SHELL || "unset"}`);
});

process.on("SIGTERM", () => {
  if (mode === "ignore-term") {
    console.log("[stub-server] ignoring SIGTERM");
    return;
  }
  console.log("[stub-server] draining");
  setTimeout(() => {
    console.log("[stub-server] drained, exiting");
    process.exit(0);
  }, 200);
});
