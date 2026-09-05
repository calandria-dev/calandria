/* Stand-in for server.js, used only by test-supervisor.js.
 *
 * Mimics the four behaviours the shell depends on: it binds PORT on
 * loopback, answers GET /api/version, takes a moment over
 * POST /api/instance/drain, and on SIGTERM it drains for a moment before
 * exiting 0, so a supervisor that kills too eagerly fails the test.
 *
 * The drain POST is also recorded to STUB_DRAIN_LOG when set: a file rather
 * than only stdout, since the process is later hard-killed and a line still
 * sitting in a pipe whose reader is tearing down does not prove the drain
 * landed.
 *
 * STUB_MODE tweaks it for the unhappy paths:
 *   never-ready  listens but 503s /api/version
 *   lock-held    prints the db-lock message and exits 1, like a second instance
 *   ignore-term  never exits on SIGTERM, so SIGKILL is exercised
 *   drain-hang   accepts the drain POST and never answers it
 */
"use strict";
const fs = require("node:fs");
const http = require("node:http");

const mode = process.env.STUB_MODE || "ok";
const port = Number(process.env.PORT || 0);

if (mode === "lock-held") {
  console.error("[server] another Calandria process already holds this database (pid 4242 on devBox)");
  process.exit(1);
}

const drainLog = process.env.STUB_DRAIN_LOG || "";

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/api/instance/drain")) {
    // Recorded, not required. The supervisor test asserts that the shell
    // sends the same header server.js does when SERVICE_TOKEN is set, which
    // is what gets a request past middleware.ts under Cloudflare Access mode.
    if (drainLog) fs.appendFileSync(drainLog, `drain token=${req.headers["x-service-token"] || "none"}\n`);
    console.log("[stub-server] drain requested");
    // Never answered, so only the supervisor's own timeout ends the quit.
    if (mode === "drain-hang") return;
    // A real drain waits for in-flight turns to settle, so this must take long
    // enough that a supervisor which fired and forgot would kill mid-drain.
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, aborted: 0 }));
      console.log("[stub-server] drain complete");
    }, 200);
    return;
  }
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
  // test-supervisor.js reads three facts back out of this line: the env the
  // shell built for us (NODE_ENV without a POSIX `NODE_ENV=x` prefix, and a
  // SHELL the pty sidecar can spawn), and that we started as a bare node
  // process, not through an npm/cmd wrapper.
  console.log(
    `[stub-server] listening on 127.0.0.1:${server.address().port}` +
      ` shell=${process.env.SHELL || "unset"} nodeenv=${process.env.NODE_ENV || "unset"}` +
      ` argv0=${require("node:path").basename(process.argv[0])} ppid=${process.ppid}`
  );
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
