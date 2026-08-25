/* Supervisor tests — plain `node desktop/test-supervisor.js`, no deps, no GUI.
 *
 * Deliberately NOT a vitest file: the point of this spike is that the shell's
 * risky half (process supervision) can be verified on a headless box with
 * nothing installed, including under Electron's own runtime
 * (`ELECTRON_RUN_AS_NODE=1 electron desktop/test-supervisor.js`). Folding it
 * into the repo suite would drag `desktop/` into everyone's `npm test` before
 * anyone has decided the wrapper ships at all.
 */
"use strict";
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { Supervisor, pickPorts, resolveNode, sidecarEnv, waitForReady, needsPathRepair, loginShellPath } = require("./supervisor");

const HERE = __dirname;
const stubOpts = (extra = {}) => ({
  repoRoot: HERE,
  serverScript: path.join(HERE, "stub-server.js"),
  ptyScript: path.join(HERE, "stub-pty.js"),
  ...extra,
});

let failures = 0;
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name} (${Date.now() - started}ms)\n     ${err?.stack || err}`);
  }
}

function hold(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

(async () => {
  console.log(`runtime: node ${process.versions.node}${process.versions.electron ? ` / electron ${process.versions.electron}` : ""} (modules ABI ${process.versions.modules})`);

  await test("resolveNode finds a usable Node and never returns the Electron binary", async () => {
    const n = resolveNode({ env: process.env });
    assert.match(n.version, /^v\d+\./);
    assert.ok(!/electron/i.test(path.basename(n.path)), `resolved ${n.path} — must not be Electron`);
    // Under Electron (including ELECTRON_RUN_AS_NODE) execPath is the Electron
    // binary, so it must not be what we picked.
    if (process.versions.electron) assert.notEqual(n.source, "execPath");
  });

  await test("resolveNode honours CALANDRIA_NODE", async () => {
    const real = resolveNode({ env: process.env }).path;
    const n = resolveNode({ env: { ...process.env, CALANDRIA_NODE: real } });
    assert.equal(n.source, "CALANDRIA_NODE");
    assert.equal(n.path, real);
  });

  await test("resolveNode rejects the Electron binary and falls through to PATH", async () => {
    const n = resolveNode({ env: process.env, execPath: "/fake/electron", isElectron: true });
    assert.equal(n.source, "PATH");
    assert.match(n.version, /^v\d+\./);
  });

  await test("resolveNode fails loudly with an actionable message", async () => {
    assert.throws(
      () =>
        resolveNode({
          env: { CALANDRIA_NODE: "/nonexistent/node", PATH: "/nonexistent" },
          execPath: "/nonexistent/electron",
          isElectron: true,
        }),
      (err) => err.code === "ENONODE" && /CALANDRIA_NODE/.test(err.message) && /Tried:/.test(err.message)
    );
  });

  await test("sidecarEnv strips ELECTRON_* and pins ports", async () => {
    const env = sidecarEnv({
      env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", ELECTRON_IS_DEV: "1", HOME: "/home/x" },
      port: 4123,
      ptyPort: 4124,
    });
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.ELECTRON_IS_DEV, undefined);
    assert.equal(env.PORT, "4123");
    assert.equal(env.PTY_PORT, "4124");
    assert.equal(env.PTY_HOST, "127.0.0.1");
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.HOME, "/home/x");
  });

  await test("needsPathRepair fires on launchd's stub PATH and not on a real one", async () => {
    assert.equal(needsPathRepair({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }), true);
    assert.equal(needsPathRepair({}), true);
    assert.equal(needsPathRepair({ PATH: "" }), true);
    assert.equal(needsPathRepair({ PATH: "/opt/homebrew/bin:/usr/bin:/bin" }), false);
    assert.equal(needsPathRepair({ PATH: `${process.env.HOME}/.local/bin:/usr/bin` }), false);
  });

  await test("loginShellPath fences the PATH out of a chatty login shell", async () => {
    // /bin/sh is the one shell present on every POSIX box CI might run on.
    const p = loginShellPath({ env: { ...process.env, SHELL: "/bin/sh" } });
    if (p === null) {
      console.log("     (skipped: no login shell available in this environment)");
      return;
    }
    assert.ok(p.includes("/bin"), `unexpected PATH: ${p}`);
    assert.ok(!p.includes("__CAL_PATH"), "sentinel leaked into the value");
    assert.ok(!/\n/.test(p), "shell chatter leaked into the value");
  });

  await test("loginShellPath returns null rather than throwing when the shell is broken", async () => {
    assert.equal(loginShellPath({ env: { SHELL: "/nonexistent/shell" }, timeoutMs: 1000 }), null);
  });

  await test("pickPorts steps past a port someone else holds", async () => {
    const base = 45050;
    const held = await hold(base);
    try {
      const { port, ptyPort } = await pickPorts({ port: base, ptyPort: base + 10 });
      assert.notEqual(port, base);
      assert.ok(port > base && port < base + 20, `got ${port}`);
      assert.notEqual(port, ptyPort);
    } finally {
      held.close();
    }
  });

  await test("pickPorts never hands both sidecars the same port", async () => {
    // The real case: 3000 and 3001 are both busy, so two independent searches
    // would both land on 3002 and one sidecar would fail to bind.
    const base = 45070;
    const a = await hold(base);
    const b = await hold(base + 1);
    try {
      const { port, ptyPort } = await pickPorts({ port: base, ptyPort: base + 1 });
      assert.notEqual(port, ptyPort, `both got ${port}`);
      assert.equal(port, base + 2);
      assert.ok(ptyPort > base + 2, `pty got ${ptyPort}`);
    } finally {
      a.close();
      b.close();
    }
  });

  await test("waitForReady rejects a 200 that isn't the app (a port mix-up)", async () => {
    const impostor = require("node:http").createServer((_q, r) => r.writeHead(200).end("orchestrator pty-server"));
    await new Promise((r) => impostor.listen(45090, "127.0.0.1", r));
    try {
      await assert.rejects(() => waitForReady(45090, { timeoutMs: 500, intervalMs: 100 }), /not as the app/);
    } finally {
      impostor.close();
    }
  });

  await test("start() boots both sidecars, resolves with a ready URL", async () => {
    const sup = new Supervisor(stubOpts({ port: 45100, ptyPort: 45101 }));
    try {
      const res = await sup.start();
      assert.equal(res.url, `http://127.0.0.1:${res.port}`);
      assert.equal(res.version.version, "stub");
      const probe = await fetch(`${res.url}/api/version`);
      assert.equal(probe.status, 200);
      assert.equal(sup.children.length, 2);
      assert.ok(sup.children.every((c) => !c.exited), "both sidecars should still be alive");
    } finally {
      await sup.stop();
    }
  });

  await test("stop() lets the server drain before it exits, and reaps both", async () => {
    const sup = new Supervisor(stubOpts({ port: 45120, ptyPort: 45121 }));
    await sup.start();
    await sup.stop();
    assert.ok(sup.recentLog(50).includes("draining"), "server should have run its drain handler");
    assert.ok(sup.recentLog(50).includes("drained, exiting"), "drain should have been allowed to finish");
    assert.ok(sup.children.every((c) => c.exited), "every sidecar should be reaped");
    assert.equal(sup.children.find((c) => c.name === "app").exited.code, 0);
  });

  await test("stop() SIGKILLs a sidecar that ignores SIGTERM", async () => {
    const sup = new Supervisor(
      stubOpts({ port: 45140, ptyPort: 45141, env: { ...process.env, STUB_MODE: "ignore-term" } })
    );
    await sup.start();
    await sup.stop({ graceMs: 400 });
    assert.ok(sup.recentLog(50).includes("SIGKILL"), "should have escalated");
    const app = sup.children.find((c) => c.name === "app");
    assert.ok(app.exited, "killed child should be reaped");
    assert.equal(app.exited.signal, "SIGKILL");
  });

  await test("a server that never becomes ready fails start() and leaves nothing running", async () => {
    const sup = new Supervisor(
      stubOpts({ port: 45160, ptyPort: 45161, env: { ...process.env, STUB_MODE: "never-ready", CALANDRIA_READY_TIMEOUT_MS: "1500" } })
    );
    await assert.rejects(() => sup.start(), /did not become ready/);
    assert.ok(sup.children.every((c) => c.exited), "failed start must not leak sidecars");
  });

  await test("a db-lock exit is reported as such, not as a crash", async () => {
    const exits = [];
    const sup = new Supervisor(
      stubOpts({
        port: 45180,
        ptyPort: 45181,
        env: { ...process.env, STUB_MODE: "lock-held", CALANDRIA_READY_TIMEOUT_MS: "1500" },
        onExit: (e) => exits.push(e),
      })
    );
    await assert.rejects(() => sup.start());
    const app = exits.find((e) => e.name === "app");
    assert.ok(app, "app exit should have been reported");
    assert.equal(app.code, 1);
    assert.equal(app.dbLockHeld, true);
  });

  await test("start() refuses to launch the real server without a production build", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-shell-"));
    fs.writeFileSync(path.join(empty, "server.js"), "");
    const sup = new Supervisor({ repoRoot: empty, ptyScript: path.join(HERE, "stub-pty.js") });
    await assert.rejects(() => sup.start(), /npm run build/);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  await test("waitForReady gives up rather than hanging", async () => {
    await assert.rejects(() => waitForReady(45199, { timeoutMs: 400, intervalMs: 50 }), /did not become ready/);
  });

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
