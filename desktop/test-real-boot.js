/* Boots the real Calandria server through the shell's supervisor, no
 * Electron, no window. Run with `node desktop/test-real-boot.js`.
 *
 * test-supervisor.js checks the supervision logic against stubs; this checks
 * that server.js and pty-server.js come up under a plain `node <script>`
 * spawn with the shell's env, on ports the shell picked, and that stopping
 * them reaps both without escalation. It does not assert the drain that
 * precedes the kill: test-supervisor.js covers that against stubs it can
 * hold open, and desktop/e2e/03-quit-drain.spec.ts covers it against a real
 * in-flight turn.
 *
 * Requires `npm ci` and `npm run build` in the repo root first. Uses a
 * throwaway CALANDRIA_DB_DIR so it never contends for the lock on the real
 * database.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Supervisor } = require("./supervisor");

(async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-shell-db-"));
  const sup = new Supervisor({
    dbDir,
    // A dev server or a live instance may already hold the default ports;
    // that's expected, not a failure.
    port: Number(process.env.PORT || 3000),
    ptyPort: Number(process.env.PTY_PORT || 3001),
    env: { ...process.env, CALANDRIA_DB_DIR: dbDir, CALANDRIA_SCHEDULER: "off" },
    onLog: (l) => process.env.VERBOSE && console.log(l),
  });

  let failures = 0;
  const check = (name, fn) => {
    try {
      fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failures++;
      console.log(`FAIL ${name}\n     ${err?.message || err}`);
    }
  };

  try {
    const started = Date.now();
    const { url, port, ptyPort, version } = await sup.start();
    const bootMs = Date.now() - started;
    console.log(`booted in ${bootMs}ms at ${url} (pty ${ptyPort}), version ${version?.version}`);

    check("server answers /api/version", () => assert.equal(typeof version.version, "string"));

    const home = await fetch(url, { headers: { accept: "text/html" } });
    const html = await home.text();
    check("server renders the app shell", () => {
      assert.equal(home.status, 200);
      assert.match(html, /<html/i);
    });

    const log = sup.recentLog(200);
    check("server bound the port the shell picked", () => assert.ok(log.includes(`:${port}`), `no mention of :${port}`));
    check("server proxies /pty at the shell's sidecar port", () =>
      assert.ok(log.includes(`ws://127.0.0.1:${ptyPort}`), "server.js did not report the pty target we set"));
    check("pty sidecar came up", () => assert.ok(/\[pty\].*listening/.test(log), "no pty listening line"));
    check("db lives in the throwaway dir", () => assert.ok(log.includes(dbDir), "server did not report our CALANDRIA_DB_DIR"));

    await sup.stop();
    check("both sidecars were reaped by stop()", () => assert.ok(sup.children.every((c) => c.exited)));
    // True on both platforms: POSIX because the server drained and exited
    // within the grace window, Windows because the first kill is already
    // terminal since the drain already landed over HTTP. An escalation line
    // here means a real server outlived its stop.
    check("nothing needed the SIGKILL backstop", () => assert.ok(!sup.recentLog(400).includes("SIGKILL")));
  } catch (err) {
    failures++;
    console.log(`FAIL boot\n     ${err?.message || err}\n${sup.recentLog(30)}`);
    await sup.stop();
  } finally {
    fs.rmSync(dbDir, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
