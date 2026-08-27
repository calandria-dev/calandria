/* One line-emitter for the whole app, so logs can be READ BY A MACHINE without
 * every call site being rewritten.
 *
 * Before this, ~43 console sites were bracket-tagged (`[runner] …`) but
 * otherwise free prose: fine to read over someone's shoulder, useless to ship
 * at a log collector, and the runner in particular logged only failures — a
 * turn that worked left no trace at all, so "how long do turns take here" and
 * "which task burned the tokens" had no answer outside the database.
 *
 * Two shapes, one call site:
 *
 *   text (default)  [runner] turn ok task=abc ms=8412 tokens_total=51203
 *   json            {"ts":"…","level":"info","component":"runner","msg":"turn ok","task":"abc",…}
 *
 * The default is deliberately the CURRENT format, character for character —
 * `[component] message` with the fields appended as `key=value`. Nobody's
 * `docker logs | grep` breaks by upgrading; `CALANDRIA_LOG_FORMAT=json` is what
 * you set when something downstream is parsing.
 *
 * Plain .mjs, zero imports, so BOTH plain-Node entrypoints (server.js,
 * pty-server.js — CommonJS, dynamic-import only) and the TS modules under lib/
 * share one implementation. That means it must stay SDK-free
 * (tests/importGraph.test.ts) and be COPY'd into the runtime image
 * (Dockerfile) — Next's build output doesn't include it.
 *
 * CALANDRIA_LOG_FORMAT is read straight off process.env rather than through
 * lib/env.mjs's readEnv, because that reader's job is to keep PRE-RENAME
 * ORCH_* spellings resolving. This knob is new, so it has no old spelling to
 * honor; routing it through readEnv would mint `ORCH_LOG_FORMAT` as a
 * deprecated alias for a variable that never existed.
 */

/** Fields that would collide with the envelope, so a caller can't overwrite them. */
const RESERVED = new Set(["ts", "level", "component", "msg"]);

/** Printed at most once per module realm for an unrecognized value. */
let warnedAboutFormat = false;

/**
 * `"json"` or `"text"`. Anything unrecognized (including empty/unset) is
 * `"text"`, the documented default; a non-empty typo says so once rather than
 * silently serving a format nobody asked for.
 *
 * Read per emit, not cached at import: it is one property lookup, logging is
 * not a hot path, and a cached value would make this untestable from a suite
 * that loads the module graph before it sets env.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {"json" | "text"}
 */
export function resolveLogFormat(env = process.env) {
  const raw = String(env.CALANDRIA_LOG_FORMAT || "").trim().toLowerCase();
  if (raw === "json") return "json";
  if (raw && raw !== "text" && env === process.env && !warnedAboutFormat) {
    warnedAboutFormat = true;
    console.warn(`[log] CALANDRIA_LOG_FORMAT=${JSON.stringify(raw)} is not "json" or "text"; using text`);
  }
  return "text";
}

/** An Error rendered for JSON output: the stack carries the message, but a
 *  collector indexing `err.message` shouldn't have to parse it back out. */
function jsonError(err) {
  return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
}

/** An Error rendered for text output — the stack, which is what
 *  `console.error(msg, err)` already printed at these call sites. */
function textError(err) {
  return err.stack || `${err.name}: ${err.message}`;
}

/**
 * JSON that cannot throw. A logger is often handed whatever an error path
 * happened to be holding — `process.on("unhandledRejection")` in server.js
 * passes the raw reason — and a circular object (or a throwing `toJSON`) would
 * otherwise turn "log this" into a second, uncaught failure inside the handler
 * that exists to report the first one.
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      const seen = new WeakSet();
      return JSON.stringify(value, (_k, v) => {
        if (typeof v !== "object" || v === null) return v;
        if (seen.has(v)) return "[circular]";
        seen.add(v);
        return v;
      });
    } catch {
      return JSON.stringify(String(value));
    }
  }
}

/** `key=value`, quoting only when the value would otherwise break the pairing. */
function textField(key, value) {
  if (value instanceof Error) return `${key}=${textError(value)}`;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return `${key}=${String(value)}`;
  if (typeof value === "string") return /[\s"=]/.test(value) ? `${key}=${safeStringify(value)}` : `${key}=${value}`;
  return `${key}=${safeStringify(value)}`;
}

/**
 * One rendered line, without the trailing newline. Pure — exported so the
 * shape can be pinned by tests without capturing console.
 *
 * `undefined` field values are DROPPED in both formats, so a call site can
 * pass an optional field unconditionally (`{ error: turnError ?? undefined }`)
 * instead of building the object conditionally.
 *
 * @param {{ level: string, component: string, msg: string, fields?: Record<string, unknown>, ts?: number }} entry
 * @param {"json" | "text"} format
 * @returns {string}
 */
export function formatLogLine(entry, format) {
  const { level, component, msg } = entry;
  const fields = entry.fields || {};
  const at = entry.ts === undefined ? Date.now() : entry.ts;
  if (format === "json") {
    /** @type {Record<string, unknown>} */
    const out = { ts: new Date(at).toISOString(), level, component, msg };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || RESERVED.has(k)) continue;
      out[k] = v instanceof Error ? jsonError(v) : v;
    }
    return safeStringify(out);
  }
  const pairs = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => textField(k, v));
  return `[${component}] ${msg}${pairs.length ? " " + pairs.join(" ") : ""}`;
}

/** stdout for info, stderr for warn/error — the split console already made,
 *  kept so JSON mode doesn't reroute anyone's existing stream redirection. */
function write(level, line) {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * A logger tagged with one component name — the thing that used to be the
 * `[bracket]` prefix, and is a queryable field in JSON mode.
 *
 * @param {string} component
 */
export function createLogger(component) {
  const emit = (level) => (
    /** @param {string} msg @param {Record<string, unknown>} [fields] */
    (msg, fields) => write(level, formatLogLine({ level, component, msg, fields }, resolveLogFormat()))
  );
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}
