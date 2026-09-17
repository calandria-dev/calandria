/* Stand-in for pty-server.js. Binds PTY_PORT and exits cleanly on SIGTERM. */
"use strict";
const http = require("node:http");
const server = http.createServer((_req, res) => res.writeHead(404).end());
server.listen(Number(process.env.PTY_PORT || 0), "127.0.0.1", () => {
  console.log(`[stub-pty] listening on 127.0.0.1:${server.address().port}`);
});
process.on("SIGTERM", () => process.exit(0));
