/* Bind-address resolution for server.js.
 *
 * Its own module, and a pure function of an env object, so the rule can be
 * tested WITHOUT the ambient environment deciding the outcome — which is the
 * entire bug this exists to prevent. Plain CommonJS because server.js needs it
 * synchronously before listen(); it must be COPY'd into the runtime image
 * (Dockerfile), like every other lib/ file server.js reaches at runtime.
 *
 * Two rules, both deliberate:
 *
 * 1. ONLY CALANDRIA_HOSTNAME (or its deprecated ORCH_HOSTNAME spelling) is
 *    read. Bare HOSTNAME is ignored, because it is not ours: Fedora's
 *    /etc/profile exports HOSTNAME=<machine name> to every login shell, Docker
 *    injects the container id, and CI systems and service managers set it too.
 *    Calandria used to read it directly, so `npm start` on Fedora tried to bind
 *    the machine hostname — binding a LAN interface, breaking
 *    http://localhost:3000, or failing outright when the name did not resolve
 *    (reported in PR #3). There is no reliable way to tell a user who set
 *    HOSTNAME on purpose from a platform that injected it, so honouring it as a
 *    fallback would keep the collision alive for exactly the users who hit it —
 *    the ones who configured nothing.
 *
 * 2. The default is loopback. In local mode the app is unauthenticated and
 *    hands out a shell, so binding every interface published it to the whole
 *    subnet. The cross-origin gate (lib/auth/local-origin.mjs) stops hostile
 *    web PAGES, but it is a header check and cannot defend a published socket:
 *    a LAN client that forges `Host: localhost:3000` walks straight through it
 *    to a shell. Only the bind address closes that. Containers set
 *    CALANDRIA_HOSTNAME=0.0.0.0 themselves, which is correct inside the
 *    namespace — isolation there comes from publishing on the host's loopback.
 *
 * The CALANDRIA_X-falls-back-to-ORCH_X alias is hand-rolled here (not imported
 * from lib/env.mjs's readEnv) because this file is CommonJS and must resolve
 * synchronously, before listen() — a dynamic import of the ESM alias reader
 * would not settle in time.
 */

const DEFAULT_HOSTNAME = "127.0.0.1";

/** Bind addresses someone would only ever set on purpose. A machine name (the
 * ambient-HOSTNAME case) is deliberately NOT in here. */
const INTENTIONAL_BIND = /^(0\.0\.0\.0|::|\[::\]|127\.0\.0\.1|::1|\[::1\]|localhost)$/i;

/** CALANDRIA_HOSTNAME, falling back to the deprecated ORCH_HOSTNAME spelling.
 * Hand-rolled rather than lib/env.mjs's readEnv (see the file header) — this
 * file is CommonJS and needs the value synchronously, before listen().
 * @param {Record<string, string|undefined>} env
 * @returns {string} trimmed value, "" when neither is set */
function hostnameEnv(env) {
  const next = String(env.CALANDRIA_HOSTNAME || "").trim();
  return next || String(env.ORCH_HOSTNAME || "").trim();
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {string} the address to listen on
 */
function resolveHostname(env = process.env) {
  const explicit = hostnameEnv(env);
  return explicit || DEFAULT_HOSTNAME;
}

/**
 * A one-time migration notice, and only for the case that is genuinely
 * ambiguous: HOSTNAME holds something that looks like a deliberate bind address
 * while neither CALANDRIA_HOSTNAME nor its deprecated ORCH_HOSTNAME spelling is
 * set. That is very likely an older deployment whose remote access is about to
 * become loopback-only. A bare machine name does NOT warn — on Fedora that
 * would fire on every single boot, which is noise, and that case is the bug
 * rather than a configuration worth preserving.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} the warning to print, or null
 */
function hostnameMigrationWarning(env = process.env) {
  const legacy = String(env.HOSTNAME || "").trim();
  if (!legacy || hostnameEnv(env)) return null;
  if (!INTENTIONAL_BIND.test(legacy)) return null;
  return (
    `HOSTNAME=${legacy} is set but is no longer read — it collided with the ` +
    `machine hostname that shells and container runtimes inject. Binding ` +
    `${DEFAULT_HOSTNAME} instead. Set CALANDRIA_HOSTNAME=${legacy} to keep the old behaviour.`
  );
}

module.exports = { resolveHostname, hostnameMigrationWarning, DEFAULT_HOSTNAME };
