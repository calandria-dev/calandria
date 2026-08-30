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
const http = require("node:http");
const { Supervisor, pickPorts, preferredPorts, resolveNode, sidecarEnv, waitForReady, needsPathRepair, loginShellPath } = require("./supervisor");
const {
  AppEvents,
  NeedsYou,
  createSseParser,
  overlayIconName,
  selectedTaskFromUrl,
  shouldNotify,
  trayTooltip,
} = require("./notifier");
const {
  confirmTrayResidency,
  parseDbusBoolean,
  parseDbusPid,
  parseDbusStrings,
  probeTrayResidency,
  splitTrayItem,
} = require("./tray-residency");

const HERE = __dirname;
// Three cases below assert POSIX process semantics rather than merely using
// them, and one asserts the win32 branch. Following tests/platform.ts's rule:
// a construct a test only USES gets a portable spelling; a test ABOUT a
// platform's semantics gets a branch that says what the other platform does,
// never a skip that quietly pins nothing.
const IS_WIN = process.platform === "win32";
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

  await test("sidecarEnv never invents a SHELL — the pty sidecar probes a better one", async () => {
    // pty-server.js resolves CALANDRIA_PTY_SHELL, then $SHELL, then a probed
    // default (docs/WINDOWS.md). The supervisor used to fill $SHELL in on win32
    // from COMSPEC, back when that probe was a hardcoded "/bin/zsh"; now that it
    // prefers pwsh.exe, setting $SHELL SHORT-CIRCUITS it and pins every desktop
    // terminal tab to cmd.exe. So the same assertion holds on both platforms:
    // an inherited SHELL is passed through, and an absent one stays absent.
    const win = sidecarEnv({ env: { COMSPEC: "C:\\Windows\\system32\\cmd.exe" }, port: 1, ptyPort: 2 });
    const noComspec = sidecarEnv({ env: {}, port: 1, ptyPort: 2 });
    const preset = sidecarEnv({ env: { SHELL: "C:\\ProgramData\\nu\\nu.exe", COMSPEC: "cmd.exe" }, port: 1, ptyPort: 2 });
    assert.equal(win.SHELL, undefined, "COMSPEC is not promoted to SHELL");
    assert.equal(noComspec.SHELL, undefined, "and nothing is invented when neither is set");
    assert.equal(preset.SHELL, "C:\\ProgramData\\nu\\nu.exe", "an inherited SHELL is never overwritten");
  });

  await test("needsPathRepair fires on launchd's stub PATH and not on a real one", async () => {
    if (IS_WIN) {
      // There is no launchd and no GUI-vs-shell PATH split on Windows: a
      // process started from Explorer inherits the same machine+user PATH a
      // console does. So the repair is refused outright rather than reaching
      // for a login shell that does not exist — asserted here, because the
      // failure mode of getting this wrong is a `sh -ilc` spawn on every
      // desktop launch.
      assert.equal(needsPathRepair({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }), false);
      assert.equal(needsPathRepair({}), false);
      assert.equal(needsPathRepair({ PATH: "C:\\Windows\\system32" }), false);
      return;
    }
    assert.equal(needsPathRepair({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }), true);
    assert.equal(needsPathRepair({}), true);
    assert.equal(needsPathRepair({ PATH: "" }), true);
    assert.equal(needsPathRepair({ PATH: "/opt/homebrew/bin:/usr/bin:/bin" }), false);
    assert.equal(needsPathRepair({ PATH: `${process.env.HOME}/.local/bin:/usr/bin` }), false);
  });

  await test("loginShellPath fences the PATH out of a chatty login shell", async () => {
    if (IS_WIN) {
      // Not "unavailable here" — refused by contract. `-ilc`, `printf` and
      // `$PATH` are POSIX shell syntax, and there is nothing on Windows that
      // both understands them and would answer with a PATH worth adopting.
      assert.equal(loginShellPath({ env: { ...process.env, SHELL: "powershell.exe" } }), null);
      return;
    }
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
    const impostor = require("node:http").createServer((_q, r) => r.writeHead(200).end("calandria pty-server"));
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

  await test("a sidecar is a bare node process carrying the env the shell built", async () => {
    // The end-to-end half of `sidecarEnv` above: what the child's OWN
    // process.env says, after a real spawn. Both facts are Windows facts.
    //
    //   nodeenv  — package.json's scripts reach NODE_ENV through cross-env
    //              because an inline `NODE_ENV=production node …` prefix is
    //              POSIX shell syntax that cmd.exe reads as a program name.
    //              The shell sidesteps the question entirely: it spawns the
    //              resolved node binary with the script as argv[1] and puts
    //              NODE_ENV in the env object, so no shell parses anything.
    //   argv0    — the same claim from the other side. `npm`/`npm.cmd` or a
    //              `shell: true` spawn would put a wrapper here.
    const sup = new Supervisor(stubOpts({ port: 45110, ptyPort: 45111 }));
    try {
      await sup.start();
      const line = sup.recentLog(50).split("\n").find((l) => l.includes("[stub-server] listening"));
      assert.ok(line, "the stub never announced itself");
      assert.match(line, /nodeenv=production/);
      assert.match(line, IS_WIN ? /argv0=node\.exe/i : /argv0=node/);
      assert.match(line, new RegExp(`ppid=${process.pid}\\b`), "the sidecar's parent should be this process, with no shell in between");
      // No $SHELL assertion here on purpose: the supervisor deliberately does
      // not invent one (see the sidecarEnv test above), so what the child sees
      // is whatever the launching desktop session had — and on Windows that is
      // usually nothing, which is the case pty-server.js's own probe handles.
    } finally {
      await sup.stop();
    }
  });

  await test("stop() POSTs the drain and waits for it before killing, and reaps both", async () => {
    const drainLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "calandria-drain-")), "drain.log");
    fs.writeFileSync(drainLog, ""); // so "never drained" reads as an empty file rather than an ENOENT
    const sup = new Supervisor(
      stubOpts({
        port: 45120,
        ptyPort: 45121,
        env: { ...process.env, STUB_DRAIN_LOG: drainLog, SERVICE_TOKEN: "stub-token" },
      })
    );
    await sup.start();
    await sup.stop();
    assert.ok(sup.children.every((c) => c.exited), "every sidecar should be reaped");
    // The platform-independent half, and the point of the whole route: the
    // drain is a request the SHELL made, carrying the same header server.js
    // sends, so it lands without any signal having to be deliverable.
    assert.equal(fs.readFileSync(drainLog, "utf8").trim(), "drain token=stub-token");
    const log = sup.recentLog(50);
    assert.ok(log.includes("drain complete"), "stop() should have waited for the drain, not fired and forgotten");
    assert.ok(log.includes("[shell] drained in-flight turns (status 200)"), "the shell should say it drained");
    if (IS_WIN) {
      // There is still no deliverable SIGTERM here — `child.kill("SIGTERM")`
      // is a TerminateProcess and the stub's signal handler never runs. That
      // is now a property of the BACKSTOP rather than a gap: everything the
      // app needed to settle settled over HTTP a moment earlier.
      assert.ok(!log.includes("drained, exiting"), "a SIGTERM handler cannot have run on win32");
      return;
    }
    // On POSIX the signal path still runs afterwards, unchanged — server.js
    // POSTs the same route from its own handler and exits 0. It finds nothing
    // left in flight, which is why the drain above is the mechanism and this
    // is the backstop.
    assert.ok(log.includes("draining"), "server should have run its own SIGTERM drain handler too");
    assert.ok(log.includes("drained, exiting"), "the signal-side drain should have been allowed to finish");
    assert.equal(sup.children.find((c) => c.name === "app").exited.code, 0);
  });

  await test("the drain still lands when the signal buys nothing (the Windows case, on any box)", async () => {
    // `ignore-term` stands in for TerminateProcess semantics on a POSIX box:
    // the signal accomplishes nothing the server can act on, so a drain that
    // rode on it would not happen at all. What is asserted is the ORDER —
    // drained, then killed — because "the file exists afterwards" would also
    // be true of a shell that drained a corpse.
    const drainLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "calandria-drain-")), "drain.log");
    fs.writeFileSync(drainLog, ""); // so "never drained" reads as an empty file rather than an ENOENT
    const sup = new Supervisor(
      stubOpts({
        port: 45130,
        ptyPort: 45131,
        env: { ...process.env, STUB_MODE: "ignore-term", STUB_DRAIN_LOG: drainLog },
      })
    );
    await sup.start();
    await sup.stop({ graceMs: 400 });
    // No SERVICE_TOKEN in this env: the header is sent only when there is one,
    // exactly as server.js does it.
    assert.equal(fs.readFileSync(drainLog, "utf8").trim(), "drain token=none");
    const lines = sup.recentLog(80).split("\n");
    const drained = lines.findIndex((l) => l.includes("drain complete"));
    const gone = lines.findIndex((l) => l.includes("[shell] app exited"));
    assert.ok(drained >= 0, "the stub never saw a drain request");
    assert.ok(gone > drained, "the app was killed before its drain finished");
    assert.ok(sup.children.every((c) => c.exited), "every sidecar should be reaped");
  });

  await test("a drain that never answers doesn't hold the quit open forever", async () => {
    // The bound is why this can be awaited from `before-quit` at all: a wedged
    // server (or a route that never becomes reachable) must cost the quit a
    // known number of seconds, not the window's lifetime.
    const sup = new Supervisor(
      stubOpts({ port: 45135, ptyPort: 45136, env: { ...process.env, STUB_MODE: "drain-hang" } })
    );
    await sup.start();
    const started = Date.now();
    await sup.stop({ drainMs: 600, graceMs: 1000 });
    const took = Date.now() - started;
    assert.ok(took < 4000, `stop() took ${took}ms — the drain wait looks unbounded`);
    assert.ok(sup.recentLog(50).includes("drain request failed"), "an abandoned drain should say so in the log");
    assert.ok(sup.children.every((c) => c.exited), "every sidecar should still be reaped");
  });

  await test("stop() SIGKILLs a sidecar that ignores SIGTERM", async () => {
    const sup = new Supervisor(
      stubOpts({ port: 45140, ptyPort: 45141, env: { ...process.env, STUB_MODE: "ignore-term" } })
    );
    await sup.start();
    await sup.stop({ graceMs: 400 });
    const app = sup.children.find((c) => c.name === "app");
    assert.ok(app.exited, "killed child should be reaped");
    if (IS_WIN) {
      // "ignore-term" is unreachable on Windows — the first kill is already
      // the termination, so there is nothing left to escalate to. Asserting
      // the ABSENCE of the escalation is what makes that visible: a SIGKILL
      // line here would mean a child had somehow survived a TerminateProcess.
      assert.ok(!sup.recentLog(50).includes("SIGKILL"), "nothing to escalate: the first kill is terminal");
      return;
    }
    assert.ok(sup.recentLog(50).includes("SIGKILL"), "should have escalated");
    assert.equal(app.exited.signal, "SIGKILL");
  });

  await test("a server that never becomes ready fails start() and leaves nothing running", async () => {
    const sup = new Supervisor(
      stubOpts({ port: 45160, ptyPort: 45161, env: { ...process.env, STUB_MODE: "never-ready", CALANDRIA_READY_TIMEOUT_MS: "1500" } })
    );
    await assert.rejects(() => sup.start(), /did not become ready/);
    assert.ok(sup.children.every((c) => c.exited), "failed start must not leak sidecars");
  });

  await test("a sidecar that dies during boot fails start() at once, naming the real cause", async () => {
    // The bug: waitForReady polls a port and knows nothing about the process it
    // is waiting for, so an app that exited one second in still sat out the
    // whole readiness timeout and then rejected with "server did not become
    // ready … (fetch failed)". The db lock is just the cheapest way to make a
    // sidecar die on purpose; the fix is about ANY boot-time exit.
    //
    // The timeout here is deliberately far larger than the assertion below: a
    // start() that merely got faster would still pass a small one, whereas
    // 30s-vs-5s can only be met by not waiting for the deadline at all.
    const sup = new Supervisor(
      stubOpts({
        port: 45170,
        ptyPort: 45171,
        env: { ...process.env, STUB_MODE: "lock-held", CALANDRIA_READY_TIMEOUT_MS: "30000" },
      })
    );
    const started = Date.now();
    await assert.rejects(
      () => sup.start(),
      (err) => {
        // Not the timeout's words: the child's own. Both halves matter — a
        // message that merely said "the app sidecar exited" would be fast and
        // still send the user looking in the wrong place.
        assert.ok(!/did not become ready/.test(err.message), `still the timeout's error: ${err.message}`);
        assert.match(err.message, /app sidecar exited with code 1/);
        assert.match(err.message, /already holds this database/);
        assert.equal(err.code, "ESIDECAREXIT");
        assert.equal(err.child.dbLockHeld, true);
        return true;
      }
    );
    const took = Date.now() - started;
    assert.ok(took < 5000, `start() took ${took}ms — it waited out the readiness timeout`);
    assert.ok(sup.children.every((c) => c.exited), "a failed start must not leak the surviving sidecar");
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

  await test("preferredPorts reads PORT/PTY_PORT and ignores junk", async () => {
    assert.deepEqual(preferredPorts({ PORT: "4830", PTY_PORT: "4831" }), { port: 4830, ptyPort: 4831 });
    assert.deepEqual(preferredPorts({ PORT: " 4830 " }), { port: 4830 });
    // Absent/unusable values must leave the option UNSET, not pass a 0 or NaN
    // through — the Supervisor's `opts.port || 3000` fallback is the intended
    // default, and sidecarEnv treats 0 as "don't set PORT at all".
    assert.deepEqual(preferredPorts({}), {});
    for (const bad of ["", "0", "-1", "70000", "http://x", "3000.5", "3000a"]) {
      assert.deepEqual(preferredPorts({ PORT: bad, PTY_PORT: bad }), {}, `PORT=${bad} should be dropped`);
    }
  });

  await test("a PORT/PTY_PORT preference is honoured, and still stepped past when busy", async () => {
    const base = 45210;
    const held = await hold(base);
    const sup = new Supervisor(stubOpts(preferredPorts({ PORT: String(base), PTY_PORT: String(base + 10) })));
    try {
      assert.equal(sup.preferredPort, base);
      assert.equal(sup.preferredPtyPort, base + 10);
      const res = await sup.start();
      // Preference, not demand: base is taken, so the app lands just past it —
      // what makes a second Calandria on a dev box survivable. The free
      // preference is honoured exactly.
      assert.equal(res.port, base + 1);
      assert.equal(res.ptyPort, base + 10);
      assert.equal(res.url, `http://127.0.0.1:${base + 1}`);
    } finally {
      // In the finally, not after the asserts: a failed assertion here would
      // otherwise leave both stubs holding the very ports the next run probes.
      await sup.stop();
      held.close();
    }
  });

  await test("main.js actually passes the env ports to the Supervisor", async () => {
    // The bug this pins was entirely in the WIRING: supervisor.js supported
    // `port`/`ptyPort` all along and main.js never passed them, so a documented
    // PORT=4830 launch bound 3002. Nothing here can be exercised without a
    // display, so assert on the source — main.js is `require("electron")` at
    // line 1 and cannot be loaded by this runner.
    const src = fs.readFileSync(path.join(HERE, "main.js"), "utf8");
    const ctor = src.indexOf("new Supervisor(");
    const wiring = src.indexOf("...preferredPorts(process.env)");
    assert.notEqual(ctor, -1, "main.js should construct a Supervisor");
    assert.notEqual(wiring, -1, "main.js must pass PORT/PTY_PORT to the Supervisor");
    assert.ok(wiring > ctor, "the ports must go INTO the Supervisor's options");
  });

  // ---------------------------------------------------------------------------
  // Notifications, badge, tray (notifier.js). Everything below runs headless on
  // purpose: the policy — which events raise a toast, what the badge counts,
  // when a toast would be redundant — is exactly the part a display cannot
  // check for you, and desktop/e2e is where the Electron calls get exercised.
  // ---------------------------------------------------------------------------

  await test("the SSE reader reassembles frames split across chunks and drops keep-alives", async () => {
    const got = [];
    const parser = createSseParser((d) => got.push(d));
    // Exactly what /api/events writes on connect, then a frame torn in half by
    // a chunk boundary — the case that makes this a push parser rather than a
    // split().
    parser.push(": connected\n\n");
    parser.push('data: {"type":"task","taskId":"a"}\n\ndata: {"type":"notif');
    assert.deepEqual(got, ['{"type":"task","taskId":"a"}']);
    parser.push('ication"}\n\n: ping\n\n');
    assert.deepEqual(got, ['{"type":"task","taskId":"a"}', '{"type":"notification"}']);
    assert.equal(parser.pending, "", "a complete stream should leave nothing buffered");
    // A half-written frame is held, not delivered.
    parser.push("data: {\"partial\"");
    assert.equal(got.length, 2);
    assert.notEqual(parser.pending, "");
  });

  await test("the badge counts every live project, and asks to reseed when it cannot", async () => {
    const n = new NeedsYou();
    // Deprecated projects are excluded here for the same reason the titlebar
    // pill excludes them (app/shell/useShell.ts) — an archived project must not
    // badge the dock.
    assert.equal(
      n.seed([
        { id: "p1", awaiting_count: 2 },
        { id: "p2", awaiting_count: 1 },
        { id: "p3", awaiting_count: 7, deprecated: 1 },
      ]),
      3,
    );
    // A task event carries its own project's fresh count; the total is the sum.
    assert.equal(n.apply({ type: "task", projectId: "p2", awaiting_count: 4 }), "ok");
    assert.equal(n.total, 6);
    assert.equal(n.apply({ type: "task_deleted", projectId: "p1", awaiting_count: 0 }), "ok");
    assert.equal(n.total, 4);
    // Silent on events that say nothing about the count.
    assert.equal(n.apply({ type: "agent_auth", agent: "claude", broken: true }), null);
    assert.equal(n.total, 4);
    // The two cases only the server can settle.
    assert.equal(n.apply({ type: "task", projectId: "brand-new", awaiting_count: 1 }), "reseed");
    assert.equal(n.apply({ type: "tasks_moved", taskIds: ["t"], fromProjectIds: ["p1"], toProjectId: "p2" }), "reseed");
  });

  await test("the shell suppresses exactly one toast: the task you are looking at", async () => {
    const payload = { id: "awaiting_input:t1", taskId: "t1", title: "Waiting for input", body: "…" };
    // The whole rule, matching shouldDisplay in app/shell/useNotifications.ts.
    assert.equal(shouldNotify(payload, { focused: true, selectedTaskId: "t1" }), false);
    assert.equal(shouldNotify(payload, { focused: true, selectedTaskId: "t2" }), true);
    // Hidden to the tray, or behind the editor: this is what the shell is for.
    assert.equal(shouldNotify(payload, { focused: false, selectedTaskId: "t1" }), true);
    // A test send (Settings → "Send test notification") belongs to no task, so
    // it must show even while that very screen is focused.
    assert.equal(shouldNotify({ id: "test", taskId: "", title: "Test" }, { focused: true, selectedTaskId: null }), true);
    // Nothing to say, nothing shown.
    assert.equal(shouldNotify(null, { focused: false, selectedTaskId: null }), false);
    assert.equal(shouldNotify({ id: "x", taskId: "t1", title: "" }, { focused: false, selectedTaskId: null }), false);
  });

  await test("the selected task is readable off the window URL alone", async () => {
    // This is what makes the suppression above possible with no preload and no
    // IPC: the app mirrors its selection into the query string
    // (app/shell/persist.ts), so webContents.getURL() is the answer.
    assert.equal(selectedTaskFromUrl("http://127.0.0.1:3000/?project=p1&task=t9"), "t9");
    assert.equal(selectedTaskFromUrl("http://127.0.0.1:3000/?project=p1"), null);
    assert.equal(selectedTaskFromUrl(`file://${path.join(HERE, "loading.html")}`), null);
    assert.equal(selectedTaskFromUrl(""), null);
  });

  await test("every taskbar overlay the badge can ask for is a file that ships", async () => {
    assert.equal(overlayIconName(0), null);
    assert.equal(overlayIconName(-1), null);
    assert.equal(overlayIconName(NaN), null);
    assert.equal(overlayIconName(1), "badge-1.png");
    assert.equal(overlayIconName(9), "badge-9.png");
    // Windows' overlay is 16x16: past one digit it is a symbol, not a number.
    assert.equal(overlayIconName(10), "badge-9plus.png");
    assert.equal(overlayIconName(4711), "badge-9plus.png");
    const assets = path.join(HERE, "assets");
    for (let i = 1; i <= 12; i++) {
      const name = overlayIconName(i);
      assert.ok(fs.existsSync(path.join(assets, name)), `missing overlay asset ${name}`);
    }
    // The tray icons, including the macOS template pair — a Tray constructed
    // from a missing path throws, which would take the whole shell down at boot.
    for (const f of ["tray.png", "trayTemplate.png", "trayTemplate@2x.png"]) {
      assert.ok(fs.existsSync(path.join(assets, f)), `missing tray asset ${f}`);
    }
  });

  await test("the tray tooltip says the count in words, and gets the plural right", async () => {
    assert.equal(trayTooltip(0), "Calandria");
    assert.equal(trayTooltip(1), "Calandria — 1 task needs you");
    assert.equal(trayTooltip(3), "Calandria — 3 tasks need you");
  });

  await test("the event subscription seeds the badge, delivers notifications, and reconnects", async () => {
    // A stand-in for /api/events and /api/projects, so the whole loop —
    // seed, subscribe, parse, drop, reconnect, reseed — runs with no display
    // and no server build.
    const notified = [];
    const badges = [];
    let streams = 0;
    /** @type {import("node:http").ServerResponse | null} */
    let live = null;
    let awaiting = 2;
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/api/projects")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: "p1", awaiting_count: awaiting }, { id: "p2", awaiting_count: 0, deprecated: 1 }]));
        return;
      }
      streams += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      live = res;
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const events = new AppEvents({
      origin,
      onProjects: (projects) => badges.push(new NeedsYou().seed(projects)),
      onEvent: (ev) => ev.type === "notification" && notified.push(ev.payload),
      onLog: () => {},
      minBackoffMs: 10,
      maxBackoffMs: 10,
    });
    const until = async (fn, what) => {
      for (let i = 0; i < 200; i++) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.fail(`timed out waiting for ${what}`);
    };
    try {
      // Seeded from the project list before a single event arrives — a fresh
      // launch usually has work waiting from the last session, and a badge that
      // only appears on the next turn boundary would be wrong until then.
      await events.refreshProjects();
      assert.deepEqual(badges, [2]);
      events.start();
      await until(() => live, "the stream to open");
      live.write(`data: ${JSON.stringify({ type: "notification", payload: { id: "awaiting_input:t1", title: "Waiting for input", body: "Do the thing", taskId: "t1", projectId: "p1" } })}\n\n`);
      await until(() => notified.length === 1, "the notification to arrive");
      assert.equal(notified[0].title, "Waiting for input");
      // The server goes away mid-stream (a restart, a sleep). The shell has to
      // come back on its own AND refetch the project list, because this stream
      // is a live tail: whatever was published while it was dark is gone.
      awaiting = 5;
      live.end();
      live = null;
      await until(() => streams === 2, "the stream to reconnect");
      await until(() => badges.length === 2, "the reconnect to reseed the badge");
      assert.equal(badges[1], 5, "the count after a reconnect must come from the server, not from before the drop");
    } finally {
      events.stop();
      live?.end();
      server.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Is the tray icon really there? (tray-residency.js). The probe talks to a
  // session bus, so every case below injects the `exec` instead — what is being
  // pinned is the VERDICT each reply implies, and in particular the difference
  // between "the session said no" and "the session could not be asked", which
  // is the distinction the close handler hangs on.
  // ---------------------------------------------------------------------------

  // Replies as the two CLIs really print them, captured on the bench.
  const GDBUS_TRUE = "(<true>,)\n";
  const GDBUS_FALSE = "(<false>,)\n";
  const GDBUS_ITEMS = (...names) => `(<[${names.map((n) => `'${n}'`).join(", ")}]>,)\n`;
  const GDBUS_PID = (pid) => `(uint32 ${pid},)\n`;
  const DBUS_SEND_TRUE = "method return time=1 sender=:1.5 -> destination=:1.99\n   variant       boolean true\n";
  const DBUS_SEND_ITEMS = (...names) =>
    `method return time=1\n   variant       array [\n${names.map((n) => `      string "${n}"\n`).join("")}   ]\n`;
  const busEnv = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };

  /**
   * An `exec` over a table of `[file, argMatcher] -> reply`. A reply that is an
   * Error is thrown, which is how a D-Bus error or a missing binary is spelled.
   */
  const fakeExec = (handler, seen = []) => {
    const fn = async (file, args) => {
      seen.push(`${file} ${args.join(" ")}`);
      const reply = handler(file, args);
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new Error(`unexpected call: ${file} ${args.join(" ")}`);
      return reply;
    };
    fn.calls = seen;
    return fn;
  };

  const serviceUnknown = () => {
    const err = new Error(
      "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.kde.StatusNotifierWatcher was not provided by any .service files",
    );
    return err;
  };
  const enoent = () => Object.assign(new Error("spawn gdbus ENOENT"), { code: "ENOENT" });

  await test("D-Bus replies parse the same whichever CLI printed them", async () => {
    // gdbus single-quotes and dbus-send double-quotes; the parsers tolerate
    // both rather than branching, which is what lets either tool answer.
    assert.deepEqual(parseDbusStrings(GDBUS_ITEMS(":1.25/StatusNotifierItem", ":1.9")), [
      ":1.25/StatusNotifierItem",
      ":1.9",
    ]);
    assert.deepEqual(parseDbusStrings(DBUS_SEND_ITEMS(":1.25/StatusNotifierItem")), [":1.25/StatusNotifierItem"]);
    // An empty status area is the reply that matters most, and it carries no
    // strings at all in either dialect.
    assert.deepEqual(parseDbusStrings("(<@as []>,)"), []);
    assert.deepEqual(parseDbusStrings("   variant       array [\n   ]\n"), []);

    assert.equal(parseDbusBoolean(GDBUS_TRUE), true);
    assert.equal(parseDbusBoolean(GDBUS_FALSE), false);
    assert.equal(parseDbusBoolean(DBUS_SEND_TRUE), true);
    assert.equal(parseDbusBoolean("()"), null, "a reply with no boolean must not read as false");

    assert.equal(parseDbusPid(GDBUS_PID(4242)), 4242);
    assert.equal(parseDbusPid("   uint32 4242\n"), 4242);
    assert.equal(parseDbusPid("()"), null);

    // The watcher glues the item's object path onto the bus name; an entry
    // without one means the spec's default.
    assert.deepEqual(splitTrayItem(":1.25/org/ayatana/NotificationItem/x"), {
      service: ":1.25",
      objectPath: "/org/ayatana/NotificationItem/x",
    });
    assert.deepEqual(splitTrayItem(":1.25"), { service: ":1.25", objectPath: "/StatusNotifierItem" });
  });

  await test("an icon owned by this process, in a hosted status area, is hosted", async () => {
    const exec = fakeExec((file, args) => {
      if (args.includes("IsStatusNotifierHostRegistered")) return GDBUS_TRUE;
      if (args.includes("RegisteredStatusNotifierItems")) return GDBUS_ITEMS(":1.9", ":1.25/StatusNotifierItem");
      // Somebody else's icon first, ours second — the reason the match is on
      // the connection's pid and not on the item's name.
      if (args.includes(":1.9")) return GDBUS_PID(777);
      if (args.includes(":1.25")) return GDBUS_PID(4242);
      return undefined;
    });
    const v = await probeTrayResidency({ platform: "linux", env: busEnv, pid: 4242, exec });
    assert.equal(v.hosted, true, v.reason);
    assert.match(v.reason, /:1\.25\/StatusNotifierItem/);
  });

  await test("a session with no status-notifier host is a definite no", async () => {
    // THE BENCH BUG, in the shape it reaches us: xfce4-panel's systray plugin
    // crashes when Electron registers its item and takes the watcher name off
    // the bus with it. `new Tray()` succeeded; there is no icon.
    const exec = fakeExec(() => serviceUnknown());
    const v = await probeTrayResidency({ platform: "linux", env: busEnv, pid: 4242, exec });
    assert.equal(v.hosted, false, v.reason);
    assert.match(v.reason, /no owner/);
  });

  await test("a watcher with no host, and a host that never took our icon, are both no", async () => {
    // A watcher can exist with nothing drawing for it — that is what
    // `IsStatusNotifierHostRegistered` is for.
    const noHost = fakeExec((file, args) =>
      args.includes("IsStatusNotifierHostRegistered") ? GDBUS_FALSE : undefined,
    );
    const a = await probeTrayResidency({ platform: "linux", env: busEnv, pid: 4242, exec: noHost });
    assert.equal(a.hosted, false, a.reason);
    assert.match(a.reason, /no host has registered/);

    // And a host that is drawing somebody else's icons but not ours.
    const notOurs = fakeExec((file, args) => {
      if (args.includes("IsStatusNotifierHostRegistered")) return GDBUS_TRUE;
      if (args.includes("RegisteredStatusNotifierItems")) return GDBUS_ITEMS(":1.9");
      if (args.includes(":1.9")) return GDBUS_PID(777);
      return undefined;
    });
    const b = await probeTrayResidency({ platform: "linux", env: busEnv, pid: 4242, exec: notOurs });
    assert.equal(b.hosted, false, b.reason);
    assert.match(b.reason, /none of its 1 item\(s\)/);
  });

  await test("a session that cannot be ASKED answers null, never false", async () => {
    // The distinction the close handler hangs on: `main.js` moves its flag only
    // on an answer, so a machine with no D-Bus CLI keeps whatever boot found
    // instead of turning every X into a quit.
    const noTools = fakeExec(() => enoent());
    const missing = await probeTrayResidency({ platform: "linux", env: busEnv, pid: 4242, exec: noTools });
    assert.equal(missing.hosted, null, missing.reason);
    assert.equal(missing.retryable, false, "an absent binary will not appear by waiting");
    assert.deepEqual(
      noTools.calls.map((c) => c.split(" ")[0]),
      ["gdbus", "dbus-send"],
      "both CLIs should be tried before giving up",
    );

    // A timeout is the same kind of non-answer.
    const timedOut = fakeExec(() => Object.assign(new Error("Command failed: timeout"), { killed: true }));
    const slow = await probeTrayResidency({ platform: "linux", env: busEnv, pid: 4242, exec: timedOut });
    assert.equal(slow.hosted, null, slow.reason);
  });

  await test("dbus-send answers when gdbus is not installed", async () => {
    const exec = fakeExec((file, args) => {
      if (file === "gdbus") return enoent();
      if (args.some((a) => a.includes("IsStatusNotifierHostRegistered"))) return DBUS_SEND_TRUE;
      if (args.some((a) => a.includes("RegisteredStatusNotifierItems"))) return DBUS_SEND_ITEMS(":1.25");
      if (args.includes("string::1.25")) return "   uint32 4242\n";
      return undefined;
    });
    const v = await probeTrayResidency({ platform: "linux", env: busEnv, pid: 4242, exec });
    assert.equal(v.hosted, true, v.reason);
    // The working tool is remembered: gdbus is tried once, not once per call.
    assert.equal(v.reason.includes(":1.25"), true);
    assert.equal(exec.calls.filter((c) => c.startsWith("gdbus ")).length, 1);
  });

  await test("no session bus, and the platforms that own their own status area, skip the bus entirely", async () => {
    const exec = fakeExec(() => new Error("should not have been called"));
    // Nowhere for Electron to have registered the icon either — a definite no,
    // and checked here rather than left to the CLI because gdbus would try to
    // autolaunch a bus daemon of its own.
    const linux = await probeTrayResidency({ platform: "linux", env: {}, pid: 1, exec });
    assert.equal(linux.hosted, false, linux.reason);
    assert.equal(exec.calls.length, 0);
    // An address that is SET but dead is the same no, and it is the one every
    // CI lane in this suite runs under: e2e/fixtures.ts points
    // DBUS_SESSION_BUS_ADDRESS at a socket that does not exist so libnotify
    // fails fast (docs/DESKTOP_E2E.md §1). Both CLIs' real wording, measured.
    for (const stderr of [
      "Error connecting: Could not connect: No such file or directory",
      'Failed to open connection to "session" message bus: Failed to connect to socket /nope: No such file or directory',
    ]) {
      const dead = fakeExec(() => new Error(stderr));
      const v = await probeTrayResidency({ platform: "linux", env: busEnv, pid: 4242, exec: dead });
      assert.equal(v.hosted, false, v.reason);
      assert.equal(v.retryable, false, "a bus that is not there will not turn up by waiting");
    }
    // Windows always has a notification area and macOS always has a menu bar;
    // there is no question to ask and no bus to ask it on.
    for (const platform of ["win32", "darwin"]) {
      const v = await probeTrayResidency({ platform, env: {}, pid: 1, exec });
      assert.equal(v.hosted, true, `${platform}: ${v.reason}`);
    }
    assert.equal(exec.calls.length, 0);
  });

  await test("confirmation waits for a panel that is still picking the icon up", async () => {
    // Registration is a round trip after `new Tray()` returns, so a single read
    // would report a healthy session as trayless. Two misses, then the item
    // appears.
    let round = 0;
    const exec = fakeExec((file, args) => {
      if (args.includes("IsStatusNotifierHostRegistered")) return GDBUS_TRUE;
      if (args.includes("RegisteredStatusNotifierItems")) return round++ < 2 ? GDBUS_ITEMS() : GDBUS_ITEMS(":1.25");
      if (args.includes(":1.25")) return GDBUS_PID(4242);
      return undefined;
    });
    const slept = [];
    const v = await confirmTrayResidency({
      platform: "linux",
      env: busEnv,
      pid: 4242,
      exec,
      timeoutMs: 5000,
      intervalMs: 400,
      sleep: async (ms) => slept.push(ms),
    });
    assert.equal(v.hosted, true, v.reason);
    assert.deepEqual(slept, [400, 400]);

    // ...but it does not spend the budget on an answer waiting cannot change.
    const never = [];
    const flat = await confirmTrayResidency({
      platform: "linux",
      env: {},
      pid: 4242,
      exec,
      timeoutMs: 5000,
      sleep: async (ms) => never.push(ms),
    });
    assert.equal(flat.hosted, false);
    assert.deepEqual(never, []);
  });

  await test("main.js wires the shell half of all of that", async () => {
    // main.js is `require("electron")` at line 1 and cannot be loaded by this
    // runner, so the wiring — as opposed to the policy above — is asserted on
    // the source. Same approach as the port-wiring case, and for the same
    // reason: every one of these was once absent and none of them has a
    // headless failure mode.
    const src = fs.readFileSync(path.join(HERE, "main.js"), "utf8");
    // The main process is the notification channel, so the renderer's must be
    // off — granting both gives two toasts per event out of one payload.
    assert.ok(
      /setPermissionRequestHandler[\s\S]{0,400}?callback\(permission === "clipboard-sanitized-write"\)/.test(src),
      "the renderer must NOT be granted the notifications permission",
    );
    assert.ok(/new Notification\(/.test(src), "main.js should raise notifications itself");
    assert.ok(/calandria:goto-task/.test(src), "clicking a notification must select the task");
    assert.ok(/new Tray\(/.test(src) && /setContextMenu/.test(src), "main.js should build a tray with a menu");
    assert.ok(/setBadgeCount/.test(src) && /setOverlayIcon/.test(src), "both badge APIs should be wired");
    // Close hides; quitting is asked for by name. If this ever flips back,
    // desktop/e2e/03-quit-drain.spec.ts and §5.1 of docs/DESKTOP_APP.md have to
    // move with it.
    const close = src.indexOf('win.on("close"');
    assert.notEqual(close, -1, "main.js should intercept the window close");
    const body = src.slice(close, close + 700);
    // The handler itself now only defers: the answer is a question for the
    // session bus, so it prevents the close unconditionally and hands over.
    assert.ok(/event\.preventDefault\(\)/.test(body), "the close must be prevented before it is decided");
    assert.ok(/decideClose\(\)/.test(body), "the close decision should be made in decideClose()");
    const decide = src.indexOf("async function decideClose()");
    assert.notEqual(decide, -1, "main.js should have a decideClose()");
    const decideBody = src.slice(decide, decide + 700);
    assert.ok(/win\.hide\(\)/.test(decideBody), "closing the window should hide it");
    // ...but only where there is something to come back from, and NOT merely
    // where `new Tray()` returned an object: on Linux it does that on a session
    // with no status area, and hiding into one of those is how a user loses the
    // app. The answer comes from the session (tray-residency.js), which is also
    // why this is re-read per close rather than trusted from boot.
    assert.ok(/refreshTrayResidency\(/.test(decideBody), "hiding must be gated on a confirmed tray");
    assert.ok(/app\.quit\(\)/.test(decideBody), "an unconfirmed tray must fall back to quitting");
    // The one message that tells the user where the window went. Raised on a
    // session with no icon, it sends them looking for something that is not
    // there — worse than saying nothing.
    const announce = src.indexOf("function announceTrayResidency()");
    assert.notEqual(announce, -1, "main.js should announce the first hide");
    assert.ok(
      /!trayHosted/.test(src.slice(announce, announce + 500)),
      "the tray-residency toast must be gated on a confirmed tray, not on `tray`",
    );
  });

  // ---- updater.js ---------------------------------------------------------
  //
  // The full policy is pinned by tests/desktopUpdater.test.ts, which runs in the
  // ordinary `npm test` lane. These are the two facts the DESKTOP lane should
  // fail on by itself, because both are about this directory's own wiring: an
  // update must never restart the app around the drain, and a .deb must never
  // reach electron-updater at all.

  await test("an update installs only on an explicit request against a real download", async () => {
    const { quitAction } = require("./updater");
    assert.equal(quitAction({ installRequested: true, phase: "ready" }), "install");
    // A quit is not consent to be upgraded.
    assert.equal(quitAction({ installRequested: false, phase: "ready" }), "exit");
    // And a stale request with nothing downloaded would hang the quit on an
    // empty installer path rather than fail it.
    assert.equal(quitAction({ installRequested: true, phase: "downloading" }), "exit");
    assert.equal(quitAction({}), "exit");
  });

  await test("only an AppImage self-updates on Linux", async () => {
    const { updaterDisposition } = require("./updater");
    const linux = (appImage) => updaterDisposition({ env: {}, platform: "linux", packaged: true, appImage });
    assert.equal(linux("/opt/Calandria.AppImage").enabled, true);
    // Because a `publish` config is configured, the .deb carries a
    // resources/package-type marker, and electron-updater answers that marker
    // with a DebUpdater that installs via `sudo dpkg -i`. main.js must not be on
    // that path, so the gate runs before the require.
    const deb = linux(null);
    assert.equal(deb.enabled, false);
    assert.equal(deb.code, "linux-package");
  });

  await test("main.js drains before it installs, and requires the updater lazily", async () => {
    // Comments stripped: this file names the calls it forbids, in prose.
    const src = fs
      .readFileSync(path.join(__dirname, "main.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    // electron-updater's default installs from `app.on("quit")`, which fires
    // after our before-quit has already drained and exited.
    assert.ok(/autoInstallOnAppQuit\s*=\s*false/.test(src), "install-on-quit must be off");
    assert.equal((src.match(/\.quitAndInstall\(/g) || []).length, 1, "one install call site only");
    const finishQuit = src.slice(src.indexOf("function finishQuit()"), src.indexOf("function messageBox("));
    assert.ok(finishQuit.includes(".quitAndInstall("), "the install belongs in the drain's tail");
    // The gate has to precede the require: the module picks its implementation
    // on first property access.
    const start = src.slice(src.indexOf("function startUpdater()"), src.indexOf("function trayUpdateItem()"));
    assert.ok(
      start.indexOf('require("electron-updater")') > start.indexOf("if (!updateDisposition.enabled)"),
      "electron-updater must be required after the disposition gate",
    );
  });

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
