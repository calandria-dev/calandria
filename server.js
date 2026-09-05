/* Calandria: custom Next.js server.
 *
 * Proxies WebSocket upgrades on `/pty` to the node-pty sidecar (pty-server.js,
 * loopback-only), so the app and terminal share one origin behind a tunnel
 * that exposes only one hostname. Dev HMR upgrades go to Next instead; in
 * production `/pty` is the only upgrade. Next middleware never sees upgrades,
 * so this file is the auth boundary for them: rules in the upgrade handler
 * below. Plain Node, not bundled, so it stays CommonJS.
 */
const http = require("node:http");
const nextImport = require("next");
const { resolveHostname, hostnameMigrationWarning } = require("./lib/resolveHostname");

// Structured logging (lib/log.mjs), dynamic-imported like the other lib/*.mjs
// modules this CommonJS entrypoint needs. Until the import resolves, `log` is
// a console shim; only numEnv's parse warning below can run in that window.
let log = {
  info: (msg) => console.log(`[server] ${msg}`),
  warn: (msg) => console.warn(`[server] ${msg}`),
  error: (msg) => console.error(`[server] ${msg}`),
};
const logImport = import("./lib/log.mjs").then((m) => {
  log = m.createLogger("server");
  return m;
});

// Mirrors num() in lib/config.ts, duplicated because this plain-Node
// entrypoint can't import TS. Falls back to `def` and warns once if the var
// is set but not a number, so a bad PORT fails at boot instead of producing
// NaN inside http.listen().
function numEnv(name, raw, def) {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    log.warn(`${name}=${JSON.stringify(raw)} is not a number; using default ${def}`);
    return def;
  }
  return n;
}

// Last-resort process guards. Turns run detached and unawaited (lib/runner.ts),
// so an uncaught rejection or throw from one would otherwise terminate the
// process and take down every other task's turn and all terminal/SSE sockets.
// Log loudly and keep running instead of exiting; each occurrence is still a
// bug to fix at its call site.
process.on("unhandledRejection", (reason) => {
  log.error("UNHANDLED REJECTION (kept alive — investigate)", { err: reason });
});
process.on("uncaughtException", (err) => {
  log.error("UNCAUGHT EXCEPTION (kept alive — investigate)", { err });
});

// Origin auth provider (lib/auth/origin.mjs): open local mode by default, or
// Cloudflare Access when configured. middleware.ts covers HTTP routes; this
// file gates WebSocket upgrades, since an unverified /pty upgrade hands out a
// shell. jose v6 is ESM-only, so the import is dynamic from this CommonJS file.
const cfAccessImport = import("./lib/auth/origin.mjs");
const localOriginImport = import("./lib/auth/local-origin.mjs");

// Host-header router for public service hostnames (<slug>--<appHost>). Opt-in
// via CALANDRIA_SERVICE_HOSTS; a no-op (requests fall through to Next) when
// that, the services feature flag, or PUBLIC_BASE_URL is unset. Rule: service
// hostnames carry their own visibility-based auth (private/shared/public, see
// lib/service-router.mjs) and bypass the app-session origin gate below.
const serviceRouterImport = import("./lib/service-router.mjs");

// Strips an inherited ANTHROPIC_API_KEY before serving any request: left set,
// it would bill every SDK turn per-token while the UI still shows the
// subscription login. Persisted keys are re-applied from their 0600 files at
// db init; CALANDRIA_ALLOW_API_KEY_ENV=1 opts in to keeping an env-provided key.
const envKeysImport = import("./lib/env-keys.mjs");

// CALANDRIA_*/ORCH_* alias reader (lib/env.mjs), dynamic-imported like the
// other lib/*.mjs modules above. Needed before listen() (SHUTDOWN_GRACE_MS,
// SCHEDULER) and for the deprecation notice printed below.
const envImport = import("./lib/env.mjs");

// Where the database and per-task worktrees live, including the pre-rename
// fallback (lib/config.ts and lib/db-lock.mjs read the same module rather
// than inlining `env || default`). Dynamic-imported: plain CommonJS
// entrypoint, ES module.
const storageImport = import("./lib/storage.mjs");

// One app process per database: two processes against the same database
// corrupt each other if the loser is mid-turn when the other's crash-recovery
// pass runs. Claimed here, before app.prepare(), so nothing opens a turn,
// service or schedule against a database this process doesn't own; only this
// entrypoint claims it, so `next build` and the test suite never contend for
// the lock. See lib/db-lock.mjs.
const dbLockImport = import("./lib/db-lock.mjs");

// PTY_HOST/PTY_PORT must match what pty-server.js binds: the sidecar is
// loopback-only by default and reached only through this proxy.
const dev = process.env.NODE_ENV !== "production";
const port = numEnv("PORT", process.env.PORT, 3000);
// CALANDRIA_HOSTNAME only, defaulting to loopback. Bare HOSTNAME is ignored
// because shells and container runtimes inject it; the default must not
// expose an unauthenticated shell to the network. See lib/resolveHostname.js.
const hostname = resolveHostname();
const ptyHost = process.env.PTY_HOST || "127.0.0.1";
const ptyPort = numEnv("PTY_PORT", process.env.PTY_PORT, 3001);
// Mirrors lib/config.ts's SHUTDOWN_GRACE_MS via this file's own numEnv
// convention. Used by the SIGTERM/SIGINT handler below; assigned once
// envImport resolves, since it reads CALANDRIA_SHUTDOWN_GRACE_MS through
// lib/env.mjs's readEnv.
let shutdownGraceMs;

const next = typeof nextImport === "function" ? nextImport : nextImport.default;
const app = next({ dev });
const handle = app.getRequestHandler();

// Last-request timestamp. Not read by anything today; kept because
// tests/schedulerBoot pins countsAsActivity's exclusion list below.
const bootAt = Date.now();
const activity = (globalThis.__calandriaActivity ??= { lastRequestAt: bootAt });
// Health/metadata probes (version, usage) never count as user activity, or a
// monitor's own loopback polling would keep lastRequestAt pinned to "just
// now" forever. Mirrors the service-token path list in middleware.ts.
const countsAsActivity = (url) => {
  const p = String(url || "").split("?")[0];
  return (
    p !== "/api/instance/usage" &&
    p !== "/api/version" &&
    p !== "/api/instance/services-restore" &&
    p !== "/api/instance/scheduler"
  );
};

// Loopback boot pings: work the server starts on its own, without waiting for
// a browser. The service token clears the origin gate like the health probes
// do; retries cover Next's route compilation on a cold dev boot.
function bootPing(label, path) {
  const url = `http://127.0.0.1:${port}${path}`;
  const headers = process.env.SERVICE_TOKEN
    ? { "x-service-token": process.env.SERVICE_TOKEN }
    : {};
  let attempts = 0;
  const ping = () => {
    attempts++;
    fetch(url, { method: "POST", headers })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
      })
      .catch((err) => {
        if (attempts < 5) setTimeout(ping, 3000).unref?.();
        else log.warn("boot ping failed", { ping: label, err: err?.message || err });
      });
  };
  ping();
}

// Forwards a WebSocket upgrade on /pty to the node-pty sidecar. The sidecar
// reads cwd/cols/rows from the query string, so only the `/pty` prefix is
// stripped; the rest of the path and query pass through.
function proxyPtyUpgrade(req, socket, head) {
  const rest = req.url.slice("/pty".length);
  const upstreamPath = rest.startsWith("/") ? rest : "/" + rest; // "" -> "/", "?q" -> "/?q"

  // Push any bytes already read with the upgrade back onto the client socket so
  // they get piped upstream (canonical reverse-proxy handshake).
  if (head && head.length) socket.unshift(head);

  const proxyReq = http.request({
    host: ptyHost,
    port: ptyPort,
    method: req.method,
    path: upstreamPath,
    headers: req.headers,
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`];
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
      else lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);

    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on("error", () => { try { socket.destroy(); } catch {} });
  socket.on("error", () => { try { proxyReq.destroy(); } catch {} });
  proxyReq.end();
}

// Claim the database, then prepare Next: preparing Next warms route modules
// that can reach getDb(), so a process that has not been granted the lock
// must not touch the database first.
let dbDir; // resolved by acquireDbLock() below; reused for the boot summary line
const prepared = dbLockImport
  .then(async (dbLock) => {
    const held = await dbLock.acquireDbLock();
    dbDir = held.dir;
    if (held.mode === "bypass") {
      log.warn(
        "WARN: CALANDRIA_DB_LOCK=off — the single-instance check is DISABLED. " +
          "If a second process is running against this database, the two will overwrite " +
          "each other's running tasks, queued follow-ups and open permission prompts.",
      );
    }
    // This process owns the database now, before Next has warmed a route
    // that could open it: refuse a file stamped by a newer build here, with
    // a message in `docker compose logs`, instead of writing to a schema
    // this build has never seen. See lib/schema-version.mjs.
    const schemaVersion = await import("./lib/schema-version.mjs");
    schemaVersion.assertSchemaVersionAtBoot(held.dir);
  })
  .catch((err) => {
    // Not a crash: a refusal. The only useful thing to say is who holds it.
    log.error(err.message);
    process.exit(1);
  })
  .then(() => app.prepare());

Promise.all([prepared, cfAccessImport, localOriginImport, serviceRouterImport, envKeysImport, envImport, storageImport, logImport]).then(([, cfAccess, localOrigin, serviceRouter, envKeys, env, storage, logMod]) => {
  // One-line deprecation notice (lib/env.mjs) for any ORCH_* names still in
  // use: the old spellings keep working, and this is the only heads-up an
  // operator gets, so print it before the app starts serving.
  const deprecation = env.deprecatedEnvWarning();
  if (deprecation) log.warn("WARN: " + deprecation);

  // Same for the on-disk locations: an install that predates the rename keeps
  // running on ~/.zen-orchestrator / ~/.agent-orchestrator, since moving a
  // live instance's data is the operator's call. See lib/storage.mjs.
  const legacyStorage = storage.legacyStorageWarning();
  if (legacyStorage) log.warn(legacyStorage);

  // Resolved here (not at top-level) because it reads CALANDRIA_SHUTDOWN_GRACE_MS
  // through lib/env.mjs's readEnv, which needs envImport settled.
  shutdownGraceMs = numEnv("CALANDRIA_SHUTDOWN_GRACE_MS", env.readEnv("CALANDRIA_SHUTDOWN_GRACE_MS"), 5000);

  // Before listen, so no request can read env first: drop inherited billing
  // keys so a turn can't switch from the subscription login to per-token API
  // billing. See lib/env-keys.mjs.
  for (const name of envKeys.stripInheritedAgentKeys()) {
    log.warn(
      `WARN: ${name} was set in the environment — unsetting it. ` +
        `Turns authenticate via the connected agent login (or a key saved in Settings). ` +
        `Set CALANDRIA_ALLOW_API_KEY_ENV=1 to bill an environment-provided key on purpose.`,
    );
  }

  // getUpgradeHandler() is only valid after prepare().
  const upgradeHandler = app.getUpgradeHandler();
  const server = http.createServer((req, res) => {
    if (countsAsActivity(req.url)) activity.lastRequestAt = Date.now();
    // Service hostnames never reach Next: the router proxies (or answers with
    // its branded status page) and enforces the service's own visibility.
    if (serviceRouter.handleServiceRequest(req, res)) return;
    handle(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    activity.lastRequestAt = Date.now();
    // Service-host WebSocket upgrades (Vite/Next HMR inside a proxied preview)
    // are authenticated per service by the router, not by the app-session gate.
    if (serviceRouter.handleServiceUpgrade(req, socket, head)) return;
    let pathname = "/";
    try { pathname = new URL(req.url, "http://localhost").pathname; } catch {}
    const route = () => {
      if (pathname === "/pty" || pathname.startsWith("/pty/")) {
        proxyPtyUpgrade(req, socket, head);
      } else {
        // Next dev HMR / Fast Refresh websocket (dev runs with Access off; in
        // production /pty is the only upgrade, so gating ALL upgrades is safe).
        upgradeHandler(req, socket, head);
      }
    };
    const deny = () => {
      try { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); } catch {}
      socket.destroy();
    };
    if (!cfAccess.originAuthEnabled()) {
      // WebSockets bypass the browser's same-origin policy. Local mode rule:
      // validate both Host (DNS-rebinding defense) and Origin before proxying
      // /pty to a shell or handing the upgrade to Next dev HMR.
      if (localOrigin.localWebSocketRequestAllowed({
        host: req.headers.host,
        origin: req.headers.origin,
      })) {
        return route();
      }
      return deny();
    }
    // Access mode rule: still check origin, for a different reason than local
    // mode. The Access cookie is SameSite=None, so a hostile page can open
    // wss://<tunnel>/pty in the victim's browser and get a valid assertion for
    // the real user: identity proven, intent not. Same-origin proves intent.
    // See lib/auth/local-origin.mjs; the sidecar repeats both checks.
    if (!localOrigin.sameOriginWebSocketRequestAllowed({
      host: req.headers.host,
      origin: req.headers.origin,
    })) {
      return deny();
    }
    cfAccess.verifyOriginNodeRequest(req).then(route).catch(deny);
  });

  // Graceful shutdown. docker/entrypoint.sh's trap forwards SIGTERM/SIGINT to
  // this process's pid only, not its descendants, so ping POST
  // /api/instance/drain (loopback, like the boot pings above) so
  // lib/runner.ts's drainActiveTurns() can abort every live turn (the same
  // abortTurn() a Stop-button press calls) and give each one's finally a
  // bounded window to persist interrupted state before exit.
  //
  // The route's own wait is bounded by CALANDRIA_SHUTDOWN_GRACE_MS; hardTimeout
  // here adds headroom for the HTTP round trip, so a hung fetch or unreachable
  // drain route still exits instead of waiting for SIGKILL. Managed services
  // and the db lock release from their own 'exit' hooks after the drain.
  // Register a fallback signal handler only when nothing else handles it, so
  // dev's own Next shutdown isn't preempted.
  let shuttingDown = false;
  function gracefulShutdown() {
    if (shuttingDown) return; // second signal mid-drain: let the first attempt finish
    shuttingDown = true;
    const exit = () => process.exit(0);
    const hardTimeout = setTimeout(exit, shutdownGraceMs + 3000);
    hardTimeout.unref?.();
    const url = `http://127.0.0.1:${port}/api/instance/drain`;
    const headers = process.env.SERVICE_TOKEN ? { "x-service-token": process.env.SERVICE_TOKEN } : {};
    fetch(url, { method: "POST", headers })
      .catch((err) => log.warn("shutdown drain request failed (exiting anyway)", { err: err?.message || err }))
      .finally(() => {
        clearTimeout(hardTimeout);
        exit();
      });
  }
  for (const sig of ["SIGTERM", "SIGINT"]) {
    if (process.listenerCount(sig) === 0) {
      process.on(sig, gracefulShutdown);
    }
  }

  server.listen(port, hostname, () => {
    // Managed dev servers with desired_state='running' restart with the box.
    bootPing("services", "/api/instance/services-restore");
    // Scheduled tasks fire with the server, not with a browser. The same ping
    // attaches the notification bus subscriber, so Web Push reaches a phone
    // when no tab is open anywhere.
    bootPing("scheduler", "/api/instance/scheduler");
    const auth = cfAccess.originAuthEnabled()
      ? `origin auth ON — Cloudflare Access (team ${process.env.CF_ACCESS_TEAM_DOMAIN})`
      : "origin auth OFF — set CF_ACCESS_*" +
        (dev ? " (fine for local dev)" : "; DO NOT expose this origin unauthenticated");
    // Kept as prose, since splitting this into fields would turn the auth
    // sentence into noise; the config line below is the machine-readable
    // version of the same facts.
    log.info(
      `calandria ready on http://${hostname}:${port} ` +
        `(${dev ? "dev" : "production"}); /pty -> ws://${ptyHost}:${ptyPort}; ${auth}`,
    );
    // One-line boot summary: "is it configured the way I think" as a
    // log-grep instead of a source read, alongside the warnings below.
    const schedulerOn = !["0", "off", "false", "no"].includes(String(env.readEnv("CALANDRIA_SCHEDULER") || "").toLowerCase());
    log.info("config", {
      bind: `${hostname}:${port}`,
      pty: `${ptyHost}:${ptyPort}`,
      cfAccess: cfAccess.originAuthEnabled() ? "on" : "off",
      serviceToken: (process.env.SERVICE_TOKEN || "").trim() ? "set" : "unset",
      scheduler: schedulerOn ? "on" : "off",
      logFormat: logMod.resolveLogFormat(),
      db: dbDir,
    });
    // An older deployment that set HOSTNAME just became loopback-only; warn
    // instead of letting remote access disappear with no explanation.
    const migration = hostnameMigrationWarning();
    if (migration) log.warn(`WARN: ${migration}`);
    // Binding past loopback publishes the app and the terminal. The origin
    // gate stops hostile web pages, not a peer that can forge a Host header,
    // so that combination needs real auth.
    if (!cfAccess.originAuthEnabled() && !/^(127\.0\.0\.1|::1|\[::1\]|localhost)$/i.test(hostname)) {
      log.warn(
        `WARN: bound to ${hostname} with origin auth OFF — anyone who can reach ` +
          `this port gets the app and a shell. Set CF_ACCESS_*, or unset CALANDRIA_HOSTNAME.`,
      );
    }
    // Rule: Access enforcement is on only if BOTH CF_ACCESS_* vars are set, so
    // one set and the other typo'd leaves the origin open while it looks
    // gated. The warning above only fires past loopback, and the container
    // binds 0.0.0.0 either way, so this needs its own check.
    const cfSet = ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"].filter((k) => (process.env[k] || "").trim());
    if (cfSet.length === 1) {
      log.warn(
        `WARN: ${cfSet[0]} is set but the other CF_ACCESS_* variable is not — ` +
          `Cloudflare Access enforcement needs BOTH and is currently OFF.`,
      );
    }
    // SERVICE_TOKEN is optional except in Access mode, where it is the only
    // credential non-browser callers inside the box can present. Without it
    // the Docker HEALTHCHECK, boot restore of managed services, and the stdio
    // MCP bridge all 403. docker/entrypoint.sh generates one automatically;
    // a bare-node deploy has to be told.
    if (cfAccess.originAuthEnabled() && !(process.env.SERVICE_TOKEN || "").trim()) {
      log.warn(
        `WARN: Cloudflare Access is ON but SERVICE_TOKEN is unset — health probes, ` +
          `boot restore of managed services, and the agent-tool bridge have no way to ` +
          `authenticate and will get 403. Generate one: openssl rand -hex 32`,
      );
    }
    if (dev) {
      // Dev mode compiles each route on first hit and is much slower than
      // the production build; not for anyone who just wants to use the app.
      log.warn(
        "============================================================\n" +
          "  DEV MODE — routes compile on demand; everything is slower.\n" +
          "  For actually using the app, run:  npm run build && npm start\n" +
          "  ============================================================",
      );
    }
  });
});
