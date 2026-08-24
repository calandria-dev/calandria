/* Orchestrator — custom Next.js server.
 *
 * Why this exists: the integrated terminal is a WebSocket to the node-pty
 * sidecar (pty-server.js, bound to 127.0.0.1). Behind a Cloudflare Tunnel only
 * ONE hostname/origin is exposed, so the browser cannot reach a second port.
 * This server fronts Next.js on a single port and proxies WebSocket upgrades on
 * `/pty` to the local sidecar — so one origin carries both the app and the
 * terminal, and the terminal works from a remote device over https/wss.
 *
 * HMR/Fast-Refresh upgrades (dev) are forwarded to Next via getUpgradeHandler();
 * everything else on the socket layer is the /pty proxy.
 *
 * `next({ dev })` uses Turbopack by default, matching the old `next dev
 * --turbopack` behaviour. server.js itself is plain Node (not bundled), so keep
 * it CommonJS and compatible with the running Node version.
 */
const http = require("node:http");
const nextImport = require("next");
const { resolveHostname, hostnameMigrationWarning } = require("./lib/resolveHostname");

// Mirrors num() in lib/config.ts — duplicated because this plain-Node
// entrypoint can't import TS. Falls back to `def` and warns once when the
// var is set but not a number, so a typo'd PORT fails loud at boot instead
// of a NaN deep inside http.listen() (issue #18 item 1).
function numEnv(name, raw, def) {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[server] ${name}=${JSON.stringify(raw)} is not a number; using default ${def}`);
    return def;
  }
  return n;
}

// Last-resort process guards. Turns run detached (lib/runner.ts), owned by this
// process and not awaited by any request — so a stray rejection or throw from a
// background turn would, under Node's default policy, terminate the server and
// take down EVERY other tenant's in-flight turn plus all terminal/SSE sockets.
// (The concrete trigger we hardened for: deleting a project mid-turn leaves the
// runner writing to now-deleted task rows, hitting FOREIGN KEY errors.) The
// individual call sites are fixed to degrade gracefully; these are the backstop
// for the whole class. We log LOUDLY rather than exit — a single bad turn must
// not be able to kill the shared process. This can mask real bugs, so the noise
// is deliberate: every occurrence is a bug to chase, not a state to live in.
process.on("unhandledRejection", (reason) => {
  console.error("[server] UNHANDLED REJECTION (kept alive — investigate):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] UNCAUGHT EXCEPTION (kept alive — investigate):", err);
});

// Origin auth enforcement (lib/auth/origin.mjs selects the provider: open local
// mode by default, or Cloudflare Access when configured). middleware.ts
// covers the HTTP routes; WebSocket upgrades never reach Next middleware, so
// THIS file is the auth boundary for the terminal — an unverified /pty upgrade
// would hand out a shell. jose v6 is ESM-only, hence the dynamic import from
// this CommonJS file.
const cfAccessImport = import("./lib/auth/origin.mjs");
const localOriginImport = import("./lib/auth/local-origin.mjs");

// Host-header router for public service hostnames (<slug>--<appHost>, e.g.
// calc--myhost.example.com). Opt-in via ORCH_SERVICE_HOSTS (the services
// feature flag alone exposes nothing); no-ops entirely (returns false,
// requests fall through to Next) when that, the feature flag, or
// PUBLIC_BASE_URL says no. Service hostnames carry their OWN per-service auth
// (visibility: private/shared/public — see lib/service-router.mjs), so they
// bypass the app-session origin gate below on purpose.
const serviceRouterImport = import("./lib/service-router.mjs");

// Inherited-credential guard (issue #4): an ANTHROPIC_API_KEY that leaked in
// from the launch environment would make every SDK turn bill per-token while
// the UI reports the subscription login. Strip such keys before we serve a
// single request (persisted keys are re-applied from their 0600 files at db
// init; ORCH_ALLOW_API_KEY_ENV=1 opts in to keeping env-provided keys).
const envKeysImport = import("./lib/env-keys.mjs");

// One app process per orchestrator.db. Two processes against one database
// silently corrupt each other — the loser of the race is whichever one is
// mid-turn when the other boots and runs its crash-recovery pass. Claimed HERE,
// before app.prepare(), so nothing can open a turn, a service or a schedule
// against a database we don't own; and only from this entrypoint, so `next
// build` and the test suite never contend for a lock they shouldn't hold.
// See lib/db-lock.mjs.
const dbLockImport = import("./lib/db-lock.mjs");

// Per-instance overrides (see docs/SELF_HOSTING.md "Configuration"). PTY_HOST/PTY_PORT must
// match what pty-server.js binds — the sidecar is loopback-only by default and
// is reached exclusively through this proxy.
const dev = process.env.NODE_ENV !== "production";
const port = numEnv("PORT", process.env.PORT, 3000);
// ORCH_HOSTNAME only, defaulting to loopback — bare HOSTNAME is ignored because
// shells and container runtimes inject it, and the default must not publish an
// unauthenticated shell to the network. See lib/resolveHostname.js.
const hostname = resolveHostname();
const ptyHost = process.env.PTY_HOST || "127.0.0.1";
const ptyPort = numEnv("PTY_PORT", process.env.PTY_PORT, 3001);
// Mirrors lib/config.ts's SHUTDOWN_GRACE_MS — kept in sync per this file's own
// env-var convention (see numEnv above). Used below by the SIGTERM/SIGINT
// graceful-shutdown handler.
const shutdownGraceMs = numEnv("ORCH_SHUTDOWN_GRACE_MS", process.env.ORCH_SHUTDOWN_GRACE_MS, 5000);

const next = typeof nextImport === "function" ? nextImport : nextImport.default;
const app = next({ dev });
const handle = app.getRequestHandler();

// Last-request timestamp. Not read by anything today (the /api/instance/idle
// consumer was removed in issue #20) — kept solely because tests/schedulerBoot
// pins countsAsActivity's exclusion list; see issue #22 discussion before
// deleting further.
const bootAt = Date.now();
const activity = (globalThis.__orchActivity ??= { lastRequestAt: bootAt });
// Health/metadata probes (version, usage) never count as user activity —
// otherwise a monitor's own loopback polling would keep lastRequestAt pinned
// to "just now" forever. Mirrors the service-token path list in middleware.ts.
const countsAsActivity = (url) => {
  const p = String(url || "").split("?")[0];
  return (
    p !== "/api/instance/usage" &&
    p !== "/api/version" &&
    p !== "/api/instance/services-restore" &&
    p !== "/api/instance/scheduler"
  );
};

// Loopback boot pings: work the SERVER must start on its own, without waiting
// for a browser. The service token clears the origin gate the same way the
// health probes do; retries paper over Next's route compilation on a cold dev
// boot.
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
        else console.warn(`[${label}] boot ping failed: ${err?.message || err}`);
      });
  };
  ping();
}

// Forward a WebSocket upgrade on /pty to the node-pty sidecar. The sidecar reads
// cwd/cols/rows from the query string, so strip only the `/pty` prefix and keep
// the rest of the path + query intact.
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

// Claim the database, THEN prepare Next — sequenced, not raced: preparing Next
// warms route modules that can reach getDb(), and a process about to be told it
// may not run must not have touched the database first.
let dbDir; // resolved by acquireDbLock() below; reused for the boot summary line
const prepared = dbLockImport
  .then(async (dbLock) => {
    const held = await dbLock.acquireDbLock();
    dbDir = held.dir;
    if (held.mode === "bypass") {
      console.warn(
        "[server] WARN: ORCH_DB_LOCK=off — the single-instance check is DISABLED. " +
          "If a second process is running against this database, the two will overwrite " +
          "each other's running tasks, queued follow-ups and open permission prompts.",
      );
    }
  })
  .catch((err) => {
    // Not a crash — a refusal. The only useful thing to say is who has it.
    console.error(`[server] ${err.message}`);
    process.exit(1);
  })
  .then(() => app.prepare());

Promise.all([prepared, cfAccessImport, localOriginImport, serviceRouterImport, envKeysImport]).then(([, cfAccess, localOrigin, serviceRouter, envKeys]) => {
  // Before listen (= before any request can read env): drop inherited billing
  // keys so turns can't silently switch from the subscription login to
  // per-token API billing. See lib/env-keys.mjs.
  for (const name of envKeys.stripInheritedAgentKeys()) {
    console.warn(
      `[server] WARN: ${name} was set in the environment — unsetting it. ` +
        `Turns authenticate via the connected agent login (or a key saved in Settings). ` +
        `Set ORCH_ALLOW_API_KEY_ENV=1 to bill an environment-provided key on purpose.`,
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
      // WebSockets are not protected by the browser's same-origin policy. In
      // local mode, validate both Host (DNS-rebinding defense) and Origin before
      // proxying /pty to a full shell or handing an upgrade to Next dev HMR.
      if (localOrigin.localWebSocketRequestAllowed({
        host: req.headers.host,
        origin: req.headers.origin,
      })) {
        return route();
      }
      return deny();
    }
    // Authenticated mode still needs an origin check, for a different reason
    // than local mode does. The Access cookie is SameSite=None by default, so a
    // hostile page can open wss://<your tunnel>/pty in the victim's browser and
    // the edge will hand us a genuinely valid assertion for the real user —
    // identity proven, intent not. Same-origin is what proves intent. (See
    // lib/auth/local-origin.mjs; the sidecar repeats both checks.)
    if (!localOrigin.sameOriginWebSocketRequestAllowed({
      host: req.headers.host,
      origin: req.headers.origin,
    })) {
      return deny();
    }
    cfAccess.verifyOriginNodeRequest(req).then(route).catch(deny);
  });

  // Graceful shutdown (issue #14 item 1). docker/entrypoint.sh's trap forwards
  // SIGTERM/SIGINT straight to THIS process's pid, not to its descendants —
  // the claude/codex CLI children the Agent SDKs spawn per turn are not
  // detached, so a plain `docker stop` never reaches them directly either.
  // A bare process.exit(0) here used to cut every in-flight turn off mid-write
  // with nothing durable recorded. Instead, ping POST /api/instance/drain
  // (loopback, same pattern as the boot pings above) so lib/runner.ts's
  // drainActiveTurns() can abort every live turn — the same abortTurn() a
  // Stop-button press calls — and give each one's finally a bounded window to
  // persist its interrupted state (DENIED_INTERRUPTED permission cards,
  // running/awaiting_input settled, turn_end published) before we exit.
  //
  // The route's own wait is bounded by ORCH_SHUTDOWN_GRACE_MS
  // (lib/config.ts's SHUTDOWN_GRACE_MS); the hardTimeout here is that plus
  // headroom for the HTTP round trip, so a hung fetch — or a drain route that
  // never becomes reachable — still exits instead of hanging until the
  // container runtime's own SIGKILL deadline. Managed services (killed by
  // lib/services.ts's 'exit' hook) and the db lock (released by lib/db-lock.mjs's
  // 'exit' hook) are untouched by any of this: both fire from process.exit(0)
  // exactly as before, just AFTER the drain instead of immediately. Register a
  // fallback only when nothing else handles the signal, to avoid preempting
  // Next's own shutdown in dev.
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
      .catch((err) => console.warn(`[server] shutdown drain request failed (exiting anyway): ${err?.message || err}`))
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
    console.log(
      `[server] orchestrator ready on http://${hostname}:${port} ` +
        `(${dev ? "dev" : "production"}); /pty -> ws://${ptyHost}:${ptyPort}; ${auth}`,
    );
    // One-line boot summary (issue #18 item 4): "is it configured the way I
    // think" as a log-grep instead of a source read, alongside the warnings below.
    const schedulerOn = !["0", "off", "false", "no"].includes(String(process.env.ORCH_SCHEDULER || "").toLowerCase());
    console.log(
      `[server] config: bind=${hostname}:${port} pty=${ptyHost}:${ptyPort} ` +
        `cfAccess=${cfAccess.originAuthEnabled() ? "on" : "off"} ` +
        `serviceToken=${(process.env.SERVICE_TOKEN || "").trim() ? "set" : "unset"} ` +
        `scheduler=${schedulerOn ? "on" : "off"} db=${dbDir}`,
    );
    // An older deployment that set HOSTNAME deliberately just became
    // loopback-only; say so rather than letting remote access vanish silently.
    const migration = hostnameMigrationWarning();
    if (migration) console.warn(`[server] WARN: ${migration}`);
    // Binding past loopback publishes the app AND the terminal. The origin gate
    // stops hostile web pages, not a peer with a socket that can forge a Host
    // header, so that combination needs real auth.
    if (!cfAccess.originAuthEnabled() && !/^(127\.0\.0\.1|::1|\[::1\]|localhost)$/i.test(hostname)) {
      console.warn(
        `[server] WARN: bound to ${hostname} with origin auth OFF — anyone who can reach ` +
          `this port gets the app and a shell. Set CF_ACCESS_*, or unset ORCH_HOSTNAME.`,
      );
    }
    // Half-configured Access is the dangerous shape: enforcement is ON iff BOTH
    // variables are set, so setting one and typo'ing the other leaves the origin
    // wide open while the operator believes it is gated. The generic warning
    // above only fires past loopback, and the container binds 0.0.0.0 either
    // way, so say this explicitly.
    const cfSet = ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"].filter((k) => (process.env[k] || "").trim());
    if (cfSet.length === 1) {
      console.warn(
        `[server] WARN: ${cfSet[0]} is set but the other CF_ACCESS_* variable is not — ` +
          `Cloudflare Access enforcement needs BOTH and is currently OFF.`,
      );
    }
    // SERVICE_TOKEN is documented as optional, and it is — except in Access
    // mode, where it is the only credential the non-browser callers inside the
    // box can present. Without it the Docker HEALTHCHECK 403s (container never
    // reports healthy), boot restore of managed services 403s, and the stdio MCP
    // bridge the non-Claude agents use 403s. docker/entrypoint.sh generates one
    // so a container never lands here; a bare-node deploy has to be told.
    if (cfAccess.originAuthEnabled() && !(process.env.SERVICE_TOKEN || "").trim()) {
      console.warn(
        `[server] WARN: Cloudflare Access is ON but SERVICE_TOKEN is unset — health probes, ` +
          `boot restore of managed services, and the agent-tool bridge have no way to ` +
          `authenticate and will get 403. Generate one: openssl rand -hex 32`,
      );
    }
    if (dev) {
      // One-time heads-up: dev mode compiles each route on first hit (Turbopack +
      // React dev build) and is MUCH slower than the production build. Users who
      // just want to USE the app should not be running it this way.
      console.warn(
        "[server] ============================================================\n" +
          "[server]  DEV MODE — routes compile on demand; everything is slower.\n" +
          "[server]  For actually using the app, run:  npm run build && npm start\n" +
          "[server] ============================================================",
      );
    }
  });
});
