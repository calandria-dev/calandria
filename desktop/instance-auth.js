/* How the shell proves who it is to an instance that is behind something.
 *
 * THE SEAM. `instances.js` says WHERE a server is; this says how to be let in
 * to it. Both halves are plain data and file IO with no `electron` require, for
 * the reason supervisor.js and env-file.js are: the risky parts have to be
 * verifiable from `node desktop/test-supervisor.js` on a box with no display.
 *
 * TWO KINDS, and neither of them is a login the window performs.
 *
 *   `oauth`  — the RFC 8252 flow in oauth.js. The user signs in with their real
 *              browser, in one cookie jar, so a passkey or a security key works
 *              exactly as it does on the web; what comes back to the app is a
 *              bearer token, renewed from a refresh token without asking again.
 *   `header` — a credential the user already has, sent verbatim. An authentik
 *              app password, a Cloudflare Access service token's two headers, a
 *              PAT for whatever is out front. Weakest on revocation, strongest
 *              on "works this afternoon", and the only option when the thing in
 *              front of the instance speaks no OIDC.
 *
 * WHAT BOTH PRODUCE IS THE SAME THING: request headers. That is the whole of
 * how this reaches the app. A reverse proxy doing forward-auth wants a session
 * cookie OR an Authorization header, and a cookie is the one a native app
 * cannot obtain outside its own window — so the app obtains the other one and
 * main.js stamps it on every request the instance's session makes, page loads,
 * SSE and WebSocket upgrades alike. Nothing about Calandria's own two auth
 * modes changes; this is a client talking to whatever is in front of them.
 *
 * WHERE THE SECRETS LIVE. Not in instances.json. That file is documented as
 * hand-editable and is written in the clear on every change; a refresh token in
 * it would be a credential in a config file the user is invited to open. They
 * go in `credentials.json` beside it, encrypted with Electron's safeStorage
 * when the platform has a keyring to back it, and 0600 with a `plain` marker
 * and a logged line when it does not — see `saveCredentials`.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { instancesFilePath } = require("./instances-path");

/** Renew this long before the token actually expires. */
const REFRESH_SKEW_MS = 60_000;

/** Never schedule a renewal further out than this, so a clock jump self-heals. */
const MAX_REFRESH_DELAY_MS = 6 * 60 * 60 * 1000;

/**
 * Headers the app refuses to send on a user's behalf.
 *
 * Three groups, one reason each. `host`, `origin` and the `sec-fetch-*` family
 * are what the server's own origin gate reads (lib/auth/local-origin.mjs), and
 * letting a config file rewrite them would hand the user a way to defeat the
 * check that is protecting them. `cookie` would fight the session's own jar,
 * which is the thing that actually holds a Cloudflare Access assertion. The
 * rest are hop-by-hop or framing, and rewriting them corrupts the request.
 */
const REFUSED_HEADERS = new Set([
  "host",
  "origin",
  "referer",
  "cookie",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "te",
  "trailer",
  "proxy-authorization",
]);

/** RFC 7230 token, which is what a header name is allowed to be. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/* ------------------------------------------------------------------------- *
 * The per-instance auth CONFIG — the non-secret half, saved in instances.json.
 * ------------------------------------------------------------------------- */

/**
 * Coerce a saved or typed auth config into something usable, or throw with a
 * sentence the dialog can show.
 *
 * `null` means "no configured sign-in", which is not the same as "no auth": it
 * is today's behaviour, where the window loads the origin and whatever cookie
 * jar it already has decides. Local mode and a Cloudflare Access login that a
 * plain form can complete both live there, and both keep working untouched.
 */
function normalizeAuth(raw) {
  if (raw === null || raw === undefined || raw === "" || raw?.kind === "none") return null;
  if (typeof raw !== "object") throw new Error("The sign-in settings are not readable.");
  if (raw.kind === "header") return { kind: "header" };
  if (raw.kind !== "oauth") throw new Error(`"${raw.kind}" is not a kind of sign-in this app knows.`);

  const issuer = String(raw.issuer ?? "").trim();
  if (!issuer) throw new Error("Enter the issuer URL of the identity provider.");
  const clientId = String(raw.clientId ?? "").trim();
  if (!clientId) throw new Error("Enter the client ID of the application you registered.");
  // A confidential client's secret has no place in a desktop app: it ships to
  // every user, so it is not a secret, and a provider that requires one has not
  // been configured as a public client. Saying so is more use than silently
  // failing at the token endpoint with `invalid_client`.
  if (raw.clientSecret) {
    throw new Error(
      "This app signs in as a public client with PKCE and cannot use a client secret. " +
        "Register the provider as a public client instead.",
    );
  }
  const auth = { kind: "oauth", issuer, clientId };
  const scope = String(raw.scope ?? "").trim();
  if (scope) auth.scope = scope;
  const audience = String(raw.audience ?? "").trim();
  if (audience) auth.audience = audience;
  if (raw.redirectPort !== undefined && raw.redirectPort !== null && raw.redirectPort !== "") {
    const n = Number(raw.redirectPort);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`"${raw.redirectPort}" is not a valid port for the sign-in redirect.`);
    }
    auth.redirectPort = n;
  }
  return auth;
}

/** The second line of the auth row in the manage dialog. One place, three callers. */
function describeAuth(auth) {
  if (!auth) return "Sign in in the window (no native flow configured)";
  if (auth.kind === "header") return "A credential you supply, sent as request headers";
  return `Browser sign-in at ${auth.issuer}`;
}

/* ------------------------------------------------------------------------- *
 * Header credentials — the `header` kind's secret, typed as text.
 * ------------------------------------------------------------------------- */

/**
 * Read `Name: value` lines into the header map to send.
 *
 * A textarea rather than one name and one value, because the credentials people
 * actually hold come in both shapes: `Authorization: Bearer …` is one header
 * and a Cloudflare Access service token is two (`CF-Access-Client-Id` and
 * `CF-Access-Client-Secret`). One field that takes both beats a form that
 * takes one and a follow-up issue for the other.
 *
 * Throws on anything it will not send, naming the line — a credential that is
 * silently dropped here surfaces as an unexplained 403 an hour later.
 */
function parseHeaderLines(text) {
  const headers = {};
  const lines = String(text ?? "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf(":");
    if (at < 1) throw new Error(`"${trimmed.slice(0, 40)}" is not a "Name: value" header line.`);
    const name = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (!HEADER_NAME_RE.test(name)) throw new Error(`"${name}" is not a valid header name.`);
    if (REFUSED_HEADERS.has(name.toLowerCase())) {
      throw new Error(`This app will not send a ${name} header — it is part of how the request is framed or checked.`);
    }
    if (!value) throw new Error(`The ${name} header has no value.`);
    // A header value is bytes on a wire. Anything that could end the line early
    // is a request-splitting attempt or a bad paste, and both want refusing.
    if (/[\r\n\0]/.test(value) || /[^\x20-\x7e]/.test(value)) {
      throw new Error(`The ${name} header's value has characters that cannot be sent in a header.`);
    }
    headers[name] = value;
  }
  if (!Object.keys(headers).length) throw new Error("Enter at least one header, as \"Name: value\".");
  return headers;
}

/** The reverse, for re-opening the dialog on a credential already stored. */
function formatHeaderLines(headers) {
  return Object.entries(headers || {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

/* ------------------------------------------------------------------------- *
 * Credentials — what a sign-in produced.
 * ------------------------------------------------------------------------- */

/** Is this credential past its usable life? A credential with no expiry never is. */
function credentialExpired(cred, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  if (!cred?.expiresAt) return false;
  return cred.expiresAt - skewMs <= now;
}

/**
 * When to renew, in milliseconds from now, or `null` for "never on a timer".
 *
 * Clamped at both ends. The floor stops a token that is already inside the skew
 * from scheduling a busy loop against the provider; the ceiling means a
 * credential minted with a year's life (or under a wrong clock) is still
 * re-examined this afternoon rather than never.
 */
function refreshDelay(cred, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  if (!cred?.refreshToken || !cred?.expiresAt) return null;
  return Math.min(MAX_REFRESH_DELAY_MS, Math.max(5_000, cred.expiresAt - skewMs - now));
}

/**
 * The headers this credential contributes to a request, or `null` for none.
 *
 * An EXPIRED oauth credential contributes nothing rather than its stale token:
 * sending it produces a 401 the app then has to classify, where sending nothing
 * produces the same redirect an unauthenticated client gets and lands on the
 * sign-in screen, which is where the user needs to be either way.
 */
function authHeaders(cred, now = Date.now()) {
  if (!cred) return null;
  if (cred.kind === "header") {
    const headers = cred.headers && typeof cred.headers === "object" ? cred.headers : null;
    return headers && Object.keys(headers).length ? { ...headers } : null;
  }
  if (cred.kind !== "oauth" || !cred.accessToken) return null;
  if (credentialExpired(cred, now, 0)) return null;
  return { Authorization: `${cred.tokenType || "Bearer"} ${cred.accessToken}` };
}

/** What the sign-in state reads as in the dialog and the log. */
function describeCredential(cred, now = Date.now()) {
  if (!cred) return "Not signed in";
  if (cred.kind === "header") return `${Object.keys(cred.headers || {}).length} header(s) stored`;
  if (credentialExpired(cred, now, 0)) return cred.refreshToken ? "Signed in (token expired, will renew)" : "Signed in (expired)";
  if (!cred.expiresAt) return "Signed in";
  const mins = Math.round((cred.expiresAt - now) / 60000);
  return mins >= 60 ? `Signed in (${Math.round(mins / 60)}h left)` : `Signed in (${Math.max(mins, 0)}m left)`;
}

/* ------------------------------------------------------------------------- *
 * Persistence.
 * ------------------------------------------------------------------------- */

/** `credentials.json`, beside instances.json and resolved exactly the same way. */
function credentialsFilePath(env = process.env) {
  if (env.CALANDRIA_CREDENTIALS_FILE) return env.CALANDRIA_CREDENTIALS_FILE;
  return path.join(path.dirname(instancesFilePath(env)), "credentials.json");
}

/**
 * A cipher that does nothing, for a platform with no keyring and for the tests.
 *
 * Named rather than implied, because `available: false` is what makes
 * `saveCredentials` write the `plain` marker and what makes main.js log that it
 * did — a fallback that looked identical to the encrypted path would be a
 * refresh token in a readable file with nothing said about it.
 */
const NO_CIPHER = { available: false, encrypt: null, decrypt: null };

function decodeEntry(entry, cipher) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.enc === "plain") return entry.data && typeof entry.data === "object" ? entry.data : null;
  if (entry.enc !== "safeStorage" || typeof entry.data !== "string") return null;
  if (!cipher?.available || !cipher.decrypt) return null;
  try {
    return JSON.parse(cipher.decrypt(Buffer.from(entry.data, "base64")));
  } catch {
    // A keyring that changed, a file copied between machines, a different OS
    // user. Unreadable is "not signed in", never a crash on launch.
    return null;
  }
}

/**
 * Read the stored credentials. Never throws: a missing file is the common case
 * and an unreadable one must not stop the app, so both come back empty.
 *
 * Returns `{ path, found, credentials: Map<instanceId, credential>, plain }`,
 * where `plain` names the instances whose secrets are on disk in the clear —
 * the caller logs it, because it is a fact about the user's machine they should
 * be able to find out without reading the file.
 */
function loadCredentials({ env = process.env, file = null, cipher = NO_CIPHER } = {}) {
  const p = file || credentialsFilePath(env);
  const credentials = new Map();
  const plain = [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    return { path: p, found: false, credentials, plain, error: err?.code === "ENOENT" ? null : err };
  }
  const entries = raw && typeof raw.credentials === "object" ? raw.credentials : {};
  for (const [id, entry] of Object.entries(entries)) {
    const cred = decodeEntry(entry, cipher);
    if (!cred || (cred.kind !== "oauth" && cred.kind !== "header")) continue;
    credentials.set(id, cred);
    if (entry.enc === "plain") plain.push(id);
  }
  return { path: p, found: true, credentials, plain };
}

/**
 * Write the credentials, atomically and 0600.
 *
 * The mode is set on the TEMP file before the content goes in, not on the final
 * one after the rename: a `chmod` after the write leaves a window in which the
 * refresh token is world-readable, and the rename is what publishes it.
 *
 * Encryption is best-effort by design. safeStorage needs a keyring, and there
 * are real installs without one — a headless Linux box, a session started
 * outside a desktop environment. Refusing to persist there would mean a browser
 * sign-in on every launch, which is exactly the friction that pushes people
 * back to leaving an instance unauthenticated. So it falls back, marks what it
 * did, and the caller says so out loud.
 */
function saveCredentials(credentials, { env = process.env, file = null, cipher = NO_CIPHER } = {}) {
  const p = file || credentialsFilePath(env);
  const out = {};
  const plain = [];
  for (const [id, cred] of credentials instanceof Map ? credentials : Object.entries(credentials || {})) {
    if (!cred) continue;
    if (cipher?.available && cipher.encrypt) {
      out[id] = { enc: "safeStorage", data: Buffer.from(cipher.encrypt(JSON.stringify(cred))).toString("base64") };
    } else {
      out[id] = { enc: "plain", data: cred };
      plain.push(id);
    }
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, credentials: out }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, p);
  return { path: p, plain };
}

module.exports = {
  MAX_REFRESH_DELAY_MS,
  NO_CIPHER,
  REFRESH_SKEW_MS,
  REFUSED_HEADERS,
  authHeaders,
  credentialExpired,
  credentialsFilePath,
  describeAuth,
  describeCredential,
  formatHeaderLines,
  loadCredentials,
  normalizeAuth,
  parseHeaderLines,
  refreshDelay,
  saveCredentials,
};
