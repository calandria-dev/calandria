/* The OAuth half of instance sign-in: RFC 8252, run in the user's real browser.
 *
 * WHY THIS EXISTS. The shell used to sign in the only way a browser can — load
 * the origin, let whatever identity provider stands in front of it render its
 * login page in the window, and wait for the cookie. That works for a password
 * form and it does not work for a passkey. Electron has no WebAuthn
 * implementation, so an authenticator lives in the system browser's credential
 * manager or a password-manager extension, neither of which this window can
 * reach. Providers know that, so their login page HANDS OFF: it navigates the
 * SYSTEM browser to the ceremony and expects the callback to come back to the
 * session that started the flow.
 *
 * It does not come back to that session. The window and the browser are two
 * cookie jars, so the callback arrives carrying a session the state was never
 * minted against, and the proxy rejects it — measured against an authentik
 * forward-auth outpost as `mismatched session ID` followed by HTTP 400, and
 * then, on the retry that finally worked in the browser, a burst of requests
 * from the window that still had no cookie. Even a SUCCESSFUL browser login
 * does not reach the app. See docs/DESKTOP_APP.md §8.8.
 *
 * The fix is the native-app pattern the RFC was written for: the WHOLE flow
 * happens in the system browser, in one cookie jar, so passkeys, security keys,
 * TOTP and conditional mediation all behave exactly as they do on the web. What
 * comes back to the app is not a cookie but a token, delivered to a loopback
 * redirect this process is listening on, and instance-auth.js turns that into
 * the header every later request carries.
 *
 * NO ELECTRON HERE, and no `fetch` of its own — the caller injects one, which
 * is how main.js makes these requests through the INSTANCE'S session (its proxy
 * settings and its TLS trust store) while `node desktop/test-supervisor.js`
 * drives the same code against a stub on a box with no display.
 */
"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

/** OpenID Connect Discovery 1.0 §4. Appended to the issuer, not spliced in. */
const DISCOVERY_PATH = "/.well-known/openid-configuration";

/** What a native client asks for by default: identity, plus a token it can renew. */
const DEFAULT_SCOPE = "openid profile email offline_access";

/** How long the browser has to finish. Long, because a passkey may be on a phone. */
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Bound on every request this module makes to the identity provider. */
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A PKCE verifier and its S256 challenge (RFC 7636).
 *
 * Not optional and not configurable. A public client has no secret, so the
 * authorization code is the whole credential in flight, and the loopback
 * redirect it comes back to is reachable by every other process on this
 * machine. PKCE is what makes an intercepted code useless.
 */
function createPkce(randomBytes = crypto.randomBytes) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** The `state` parameter — CSRF protection for the callback, compared constant-time. */
function createState(randomBytes = crypto.randomBytes) {
  return base64url(randomBytes(16));
}

/** Timing-safe string compare that does not leak length through an early return. */
function secretEquals(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Where to read the provider's metadata.
 *
 * A pasted discovery URL is taken as-is, because that is what half of the
 * providers print on their own application page and re-deriving it from the
 * issuer would be a second chance to get it wrong. Anything else is an issuer
 * and gets the well-known path appended, which is the OIDC Discovery rule and
 * what authentik, Keycloak, Okta and Auth0 all serve — deliberately NOT RFC
 * 8414's insert-before-the-path form, which none of them answer on.
 */
function discoveryUrl(issuer) {
  const raw = String(issuer ?? "").trim();
  if (!raw) throw new Error("Enter the issuer URL of the identity provider.");
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`"${raw}" is not a valid issuer URL.`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("The issuer must be an http:// or https:// URL.");
  }
  if (u.pathname.endsWith(DISCOVERY_PATH)) return u.toString();
  return `${u.origin}${u.pathname.replace(/\/$/, "")}${DISCOVERY_PATH}`;
}

/** Two issuer strings are the same issuer if they differ only by a trailing slash. */
function sameIssuer(a, b) {
  const trim = (v) => String(v ?? "").trim().replace(/\/$/, "");
  return trim(a) !== "" && trim(a) === trim(b);
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // A login page, an error page, an nginx default — anything but the document
    // asked for. Quoting the first line of it beats "unexpected token <".
    const head = text.trim().split("\n")[0]?.slice(0, 120) || "an empty body";
    throw new Error(`answered with something that is not JSON (${head})`);
  }
}

/**
 * Read the provider's metadata document.
 *
 * The `issuer` it reports is CHECKED against the one that was asked for, which
 * is the one substantive validation here (RFC 8414 §3.3): without it, an open
 * redirect or a typo'd host could hand back a document naming somebody else's
 * authorization endpoint, and the app would happily send the user there to
 * approve access for a client id that does not belong to them.
 */
async function discover(issuer, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = {}) {
  const url = discoveryUrl(issuer);
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${err?.message || err}`);
  }
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}.`);
  let doc;
  try {
    doc = await readJson(res);
  } catch (err) {
    throw new Error(`${url} ${err.message}`);
  }
  if (typeof doc?.authorization_endpoint !== "string" || typeof doc?.token_endpoint !== "string") {
    throw new Error(`${url} is not an OpenID Connect discovery document.`);
  }
  if (doc.issuer !== undefined && !sameIssuer(doc.issuer, issuer) && !sameIssuer(doc.issuer, new URL(url).origin)) {
    throw new Error(
      `${url} says its issuer is ${doc.issuer}, not ${issuer}. Use the issuer exactly as the provider prints it.`,
    );
  }
  const methods = Array.isArray(doc.code_challenge_methods_supported) ? doc.code_challenge_methods_supported : null;
  if (methods && !methods.includes("S256")) {
    throw new Error(
      `${issuer} does not advertise PKCE with S256 (it offers ${methods.join(", ") || "nothing"}). ` +
        "This app will not sign in without it.",
    );
  }
  return {
    issuer: typeof doc.issuer === "string" ? doc.issuer : String(issuer),
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
    endSessionEndpoint: typeof doc.end_session_endpoint === "string" ? doc.end_session_endpoint : null,
  };
}

/**
 * The URL to open in the user's browser.
 *
 * `prompt` is deliberately absent: whether to re-prompt is the provider's
 * policy, and forcing it would make every launch a fresh passkey ceremony on
 * an instance whose session is still good.
 */
function authorizeUrl({ authorizationEndpoint, clientId, redirectUri, scope, state, challenge, audience }) {
  const u = new URL(authorizationEndpoint);
  const q = u.searchParams;
  q.set("response_type", "code");
  q.set("client_id", clientId);
  q.set("redirect_uri", redirectUri);
  q.set("scope", scope || DEFAULT_SCOPE);
  q.set("state", state);
  q.set("code_challenge", challenge);
  q.set("code_challenge_method", "S256");
  // Only providers that federate to an API (Auth0, and authentik when the
  // provider has an audience mapping) need this, and sending an empty one is an
  // invalid_request on the rest.
  if (audience) q.set("audience", audience);
  return u.toString();
}

/**
 * Read the authorization response out of the loopback request's query.
 *
 * `state` is checked BEFORE `code` is looked at, so a request that guessed the
 * port but not the state never gets as far as being an authorization response
 * at all.
 */
function parseCallback(query, expectedState) {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams(String(query ?? ""));
  if (!secretEquals(params.get("state") || "", expectedState)) {
    throw new Error("The sign-in came back with the wrong state. Start it again.");
  }
  const error = params.get("error");
  if (error) {
    const detail = params.get("error_description") || params.get("error_uri") || "";
    throw new Error(`The identity provider refused the sign-in: ${error}${detail ? ` — ${detail}` : ""}`);
  }
  const code = params.get("code");
  if (!code) throw new Error("The sign-in came back without an authorization code.");
  return { code };
}

/** POST a form to the token endpoint and return its JSON, or throw the OAuth error. */
async function tokenRequest(tokenEndpoint, params, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = {}) {
  const body = new URLSearchParams(params);
  let res;
  try {
    res = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Could not reach the token endpoint: ${err?.message || err}`);
  }
  let doc = null;
  try {
    doc = await readJson(res);
  } catch (err) {
    if (res.ok) throw new Error(`The token endpoint ${err.message}`);
  }
  if (!res.ok) {
    // RFC 6749 §5.2 gives an error body even on a 400, and it is the only thing
    // that says WHICH of the six things was wrong.
    const code = doc?.error ? String(doc.error) : `HTTP ${res.status}`;
    const detail = doc?.error_description ? ` — ${doc.error_description}` : "";
    throw new Error(`The token endpoint refused the request: ${code}${detail}`);
  }
  return doc;
}

/**
 * Turn a token response into the credential instance-auth.js stores.
 *
 * `previous` carries a refresh token forward. Providers that rotate them send a
 * new one on every refresh, but plenty send none at all on a refresh response,
 * and dropping the old one there would silently turn a renewable session into
 * one that has to be signed in again by hand tomorrow.
 */
function credentialFromTokenResponse(doc, { now = Date.now(), previous = null } = {}) {
  const accessToken = typeof doc?.access_token === "string" ? doc.access_token : "";
  if (!accessToken) throw new Error("The token endpoint answered without an access token.");
  const expiresIn = Number(doc.expires_in);
  return {
    kind: "oauth",
    tokenType: typeof doc.token_type === "string" && doc.token_type.trim() ? doc.token_type.trim() : "Bearer",
    accessToken,
    refreshToken: typeof doc.refresh_token === "string" && doc.refresh_token ? doc.refresh_token : previous?.refreshToken || null,
    idToken: typeof doc.id_token === "string" && doc.id_token ? doc.id_token : previous?.idToken || null,
    scope: typeof doc.scope === "string" ? doc.scope : previous?.scope || null,
    obtainedAt: now,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
  };
}

async function exchangeCode({ tokenEndpoint, clientId, code, verifier, redirectUri }, opts = {}) {
  const doc = await tokenRequest(
    tokenEndpoint,
    { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri },
    opts,
  );
  return credentialFromTokenResponse(doc, { now: opts.now });
}

async function refreshCredential({ tokenEndpoint, clientId, credential, scope }, opts = {}) {
  if (!credential?.refreshToken) throw new Error("This sign-in has no refresh token, so it cannot be renewed.");
  const params = { grant_type: "refresh_token", client_id: clientId, refresh_token: credential.refreshToken };
  // Only when it was asked for at authorize time: an omitted scope means "the
  // same as before", which is what is wanted, and sending a DIFFERENT one is
  // how a refresh silently narrows a session.
  if (scope) params.scope = scope;
  const doc = await tokenRequest(tokenEndpoint, params, opts);
  return credentialFromTokenResponse(doc, { now: opts.now, previous: credential });
}

/* ------------------------------------------------------------------------- *
 * The loopback receiver (RFC 8252 §7.3).
 * ------------------------------------------------------------------------- */

const DONE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Signed in</title><style>
:root{color-scheme:light dark}
body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b0d10;color:#e6e8eb}
h1{font-size:17px;font-weight:600;margin:0}p{color:#8b939c;font-size:13px;margin:0}
</style></head><body><h1>Signed in</h1><p>You can close this tab and go back to Calandria.</p></body></html>`;

/**
 * A one-shot HTTP server on 127.0.0.1 that the provider redirects back to.
 *
 * PORT 0 BY DEFAULT. RFC 8252 §7.3 requires an authorization server to accept
 * any port on a loopback redirect for exactly this reason: a fixed port is one
 * the app may not be able to bind, and one any other process can squat first.
 * `port` is the escape hatch for a provider that insists on an exact redirect
 * URI rather than a pattern.
 *
 * ONE-SHOT, and narrow on purpose. It answers one path, only GET, only from a
 * loopback peer, and it stops the moment it has an answer — this is a hole in
 * the local machine's port space that holds an authorization code, so the
 * window in which it exists is the security property. The `state` check in
 * `parseCallback` is what makes a request from another local process useless;
 * this is what makes the window short.
 */
class LoopbackReceiver {
  constructor({ port = 0, path = "/callback", timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS } = {}) {
    this.port = port;
    this.path = path;
    this.timeoutMs = timeoutMs;
    this.server = null;
    this.redirectUri = null;
    this._settle = null;
    this._timer = null;
    this._result = new Promise((resolve, reject) => {
      this._settle = { resolve, reject };
    });
    // Nothing may await this before `wait()`, and an early rejection with no
    // handler is an unhandled rejection that takes the process down.
    this._result.catch(() => {});
  }

  /** Bind, and return the redirect_uri to register with the provider. */
  async start() {
    this.server = http.createServer((req, res) => this._onRequest(req, res));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    }).catch((err) => {
      const why = err?.code === "EADDRINUSE" ? `port ${this.port} is already in use` : err?.message || String(err);
      throw new Error(`Could not listen for the sign-in redirect: ${why}`);
    });
    this.redirectUri = `http://127.0.0.1:${this.server.address().port}${this.path}`;
    this._timer = setTimeout(() => {
      this._reject(new Error("The sign-in did not finish in time. Try again."));
    }, this.timeoutMs);
    // A five-minute timer must not be the reason the app cannot quit.
    this._timer.unref?.();
    return this.redirectUri;
  }

  /** Resolve with the callback's query string, or reject with why it did not come. */
  wait() {
    return this._result;
  }

  /** Give up. Safe to call twice, and safe to call before `start`. */
  cancel(reason = "The sign-in was cancelled.") {
    this._reject(new Error(reason));
  }

  close() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    const s = this.server;
    this.server = null;
    if (s) s.close(() => {});
  }

  _resolve(value) {
    if (!this._settle) return;
    const { resolve } = this._settle;
    this._settle = null;
    resolve(value);
    this.close();
  }

  _reject(err) {
    if (!this._settle) return;
    const { reject } = this._settle;
    this._settle = null;
    reject(err);
    this.close();
  }

  _onRequest(req, res) {
    const remote = req.socket.remoteAddress || "";
    // Belt and braces over binding to 127.0.0.1: a request from anywhere else
    // is not the browser this process just opened.
    if (!/^(::ffff:)?127\.\d+\.\d+\.\d+$|^::1$/.test(remote)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" }).end();
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== this.path) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found\n");
      return;
    }
    // The page is written BEFORE the promise settles, because settling closes
    // the server and a half-written response would leave the browser on a
    // connection-reset error page after a sign-in that actually worked.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The code is in this URL. Nothing about this page should reach anywhere.
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(DONE_PAGE, () => this._resolve(url.searchParams));
  }
}

module.exports = {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_SCOPE,
  DISCOVERY_PATH,
  LoopbackReceiver,
  authorizeUrl,
  createPkce,
  createState,
  credentialFromTokenResponse,
  discover,
  discoveryUrl,
  exchangeCode,
  parseCallback,
  refreshCredential,
  sameIssuer,
  secretEquals,
  tokenRequest,
};
