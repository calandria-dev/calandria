/* CALANDRIA_* environment reader, with a compatibility fallback to the ORCH_*
 * names this fork shipped before the rename.
 *
 * A bare rename would fall every existing .env, systemd unit or compose file
 * back to defaults: a task's worktrees would move, the database would move,
 * and the instance would just look brand new with no other symptom. So the
 * old names keep working, and boot prints one line naming the ones still in
 * use (see `deprecatedEnvWarning`, printed by server.js).
 *
 * Precedence is new-wins: CALANDRIA_X if set, else ORCH_X, else undefined. An
 * empty value counts as unset on both sides: .env.example ships every key
 * with a blank value and compose forwards blanks for anything the host has
 * not exported, so a present-but-empty CALANDRIA_X must not shadow a real
 * ORCH_X. Callers keep their own `|| default`, so undefined is the shape they
 * already handle.
 *
 * Plain .mjs, env-only on purpose: no fs, no imports, nothing from lib/. Both
 * CommonJS entrypoints (server.js, pty-server.js) dynamic-import it before Next
 * exists, TS modules import it directly, and it must stay SDK-free
 * (tests/importGraph.test.ts) and COPY'd into the runtime image (Dockerfile).
 */

const PREFIX = "CALANDRIA_";
const LEGACY_PREFIX = "ORCH_";

/**
 * Every knob that answers to both names. The list is explicit instead of
 * derived so the boot warning is complete at boot time: the reads themselves
 * are spread across two module realms (server.js loads this through Node's ESM
 * loader, lib/config.ts through Turbopack's bundle) and most of them happen
 * long after the line is printed.
 *
 * Names not listed here are renamed outright, since both ends are ours: the
 * Codex MCP bridge's CALANDRIA_TASK_ID / _PROJECT_ID / _BASE_URL (injected per
 * turn), and the test-only CALANDRIA_E2E_* / CALANDRIA_TEST_*. The
 * compose-only vars (ORCH_USER/PORT/CPUS/MEM/IMAGE/RUNTIME) are read by
 * docker-compose, never by this process, and are renamed with the rest of the
 * container surface.
 */
export const ALIASED_ENV_VARS = [
  "CALANDRIA_ALLOWED_ORIGINS",
  "CALANDRIA_ALLOW_API_KEY_ENV",
  "CALANDRIA_BACKGROUND_LINGER",
  "CALANDRIA_BACKGROUND_LINGER_MS",
  "CALANDRIA_BUILT_AT",
  "CALANDRIA_DB_DIR",
  "CALANDRIA_DB_LOCK",
  "CALANDRIA_DB_LOCK_WAIT_MS",
  "CALANDRIA_FEATURE_LIVE_PREVIEW",
  "CALANDRIA_FEATURE_OMNI_SEARCH",
  "CALANDRIA_FEATURE_SERVICES",
  "CALANDRIA_FLEET_TOKEN",
  "CALANDRIA_GH_BIN",
  "CALANDRIA_GIT_FETCH",
  "CALANDRIA_GIT_FETCH_COOLDOWN_MS",
  "CALANDRIA_GIT_FETCH_TIMEOUT_MS",
  "CALANDRIA_GIT_SHA",
  "CALANDRIA_HOSTNAME",
  "CALANDRIA_INTERNAL_BASE_URL",
  "CALANDRIA_PERMISSION_PROMPT_TIMEOUT_MS",
  "CALANDRIA_PERMISSION_UNATTENDED_MS",
  "CALANDRIA_PLAN_USAGE",
  "CALANDRIA_PLAN_USAGE_MIN_FETCH_MS",
  "CALANDRIA_PROJECTS_DIR",
  "CALANDRIA_PTY_ALLOW_REMOTE",
  "CALANDRIA_PUBLIC_HOST",
  "CALANDRIA_SCHEDULER",
  "CALANDRIA_SCHEDULE_CATCHUP_MS",
  "CALANDRIA_SCHEDULE_PROBE_MS",
  "CALANDRIA_SCHEDULE_TICK_MS",
  "CALANDRIA_SERVICE_HOSTS",
  "CALANDRIA_SERVICE_LOG_LINES",
  "CALANDRIA_SERVICE_PORT_BASE",
  "CALANDRIA_SHUTDOWN_GRACE_MS",
  "CALANDRIA_WORKTREES_DIR",
];

/** The deprecated spelling of a CALANDRIA_* name, or null for anything else.
 * @param {string} name */
export function legacyNameOf(name) {
  return name.startsWith(PREFIX) ? LEGACY_PREFIX + name.slice(PREFIX.length) : null;
}

/** @param {string | undefined} v */
const isSet = (v) => v !== undefined && String(v).trim() !== "";

/* Deprecated names actually read by this process, across every module realm
 * that loaded this file. Uses globalThis for the same reason lib/db-lock.mjs
 * does: server.js and the Next bundle each get their own module instance. */
const recorded = (globalThis.__calandriaDeprecatedEnv ||= new Set());

/**
 * The value of `name`, falling back to its deprecated ORCH_* spelling.
 * @param {string} name a CALANDRIA_* variable name
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined} undefined when neither name carries a value
 */
export function readEnv(name, env = process.env) {
  const value = env[name];
  if (isSet(value)) return value;
  const legacy = legacyNameOf(name);
  if (legacy) {
    const old = env[legacy];
    if (isSet(old)) {
      recorded.add(legacy);
      return old;
    }
  }
  return undefined;
}

/**
 * Deprecated names this instance is relying on: every ORCH_* that is set while
 * its CALANDRIA_* replacement is not. Sorted, so the boot line is stable.
 *
 * The scan is complete on its own, since ALIASED_ENV_VARS is the whole alias
 * table; `recorded` is folded in as a safety net for a name some caller reads
 * through `readEnv` without having listed there. That net only applies to the
 * default env, because it describes what this process actually read: a caller
 * passing an explicit env object is asking about that object, and answering
 * with names read from somewhere else would be wrong.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function deprecatedEnvInUse(env = process.env) {
  const names = new Set(env === process.env ? recorded : []);
  for (const name of ALIASED_ENV_VARS) {
    const legacy = legacyNameOf(name);
    if (legacy && isSet(env[legacy]) && !isSet(env[name])) names.add(legacy);
  }
  return [...names].sort();
}

/**
 * The single boot-time deprecation line, or null when nothing old is in use.
 * Shaped like lib/resolveHostname.js's migration notice: the caller decides how
 * to print it, the rule is testable without the ambient environment.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function deprecatedEnvWarning(env = process.env) {
  const names = deprecatedEnvInUse(env);
  if (!names.length) return null;
  const pairs = names.map((n) => `${n} is deprecated, use ${PREFIX + n.slice(LEGACY_PREFIX.length)}`);
  return `${pairs.join("; ")}. The old names still work, but will not forever.`;
}
