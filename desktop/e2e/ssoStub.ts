/* A stand-in for the exact deployment that motivated instance sign-in: a
 * Calandria behind a forward-auth proxy, and an OIDC provider beside it.
 *
 * The "app" server refuses everything without the right bearer token, exactly
 * as an authentik outpost refuses a request with no proxy session. The "idp"
 * server is a real discovery + authorize + token endpoint with PKCE enforced,
 * so 15-instance-auth.spec.ts exercises the app's whole flow end to end rather
 * than mocking it at a seam. Ported from a standalone spike script
 * (`/tmp/cal-sso-play-working.mjs` + `/tmp/cal-sso-stub.js`) that proved the
 * flow works against the real desktop shell.
 *
 * Both servers bind to 127.0.0.1 on port 0 and log every request they answer,
 * so a spec can assert on the exchange (PKCE verified, the right grant type,
 * the token landing where it should) without a seam inside the app itself.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export type SsoStub = {
  /** `http://127.0.0.1:<port>` for the fake identity provider. */
  idpOrigin: string;
  /** `http://127.0.0.1:<port>` for the fake instance behind it. */
  appOrigin: string;
  /** The bearer token the idp hands out and the app checks for. */
  token: string;
  /** The client_id both servers expect the desktop shell to send. */
  clientId: string;
  /** Every request line either server answered, in order. */
  log: string[];
  stop(): Promise<void>;
};

const CLIENT_ID = "calandria-desktop";

/**
 * Start the pair. `token` may be pinned by the caller — case 5 (a `header`-kind
 * instance) pre-seeds a credential file with a bearer value and needs the app
 * server to check for that exact value, never running the oauth half at all.
 */
export function startSsoStub(token = `the-access-token-${crypto.randomBytes(4).toString("hex")}`): Promise<SsoStub> {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const log: string[] = [];
  const note = (line: string) => log.push(line);

  let idpPort = 0;
  let appPort = 0;

  const idp = http.createServer((req, res) => {
    const u = new URL(req.url || "/", `http://127.0.0.1:${idpPort}`);
    if (u.pathname === "/.well-known/openid-configuration") {
      note("discovery");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: `http://127.0.0.1:${idpPort}`,
          authorization_endpoint: `http://127.0.0.1:${idpPort}/authorize`,
          token_endpoint: `http://127.0.0.1:${idpPort}/token`,
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }
    if (u.pathname === "/authorize") {
      const redirect = u.searchParams.get("redirect_uri") || "";
      const challenge = u.searchParams.get("code_challenge") || "";
      const state = u.searchParams.get("state") || "";
      note(`authorize redirect=${redirect} method=${u.searchParams.get("code_challenge_method")}`);
      if (!challenge || u.searchParams.get("code_challenge_method") !== "S256") {
        res.writeHead(400).end("no pkce");
        return;
      }
      const code = crypto.randomBytes(6).toString("hex");
      codes.set(code, { challenge, redirect });
      // The browser's half of the flow, and the whole point of the fix: the
      // redirect goes to the app's loopback port, not back into a webview.
      res.writeHead(302, { location: `${redirect}?code=${code}&state=${state}` });
      res.end();
      return;
    }
    if (u.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const p = new URLSearchParams(body);
        const entry = codes.get(p.get("code") || "");
        const verifier = p.get("code_verifier") || "";
        const derived = crypto.createHash("sha256").update(verifier).digest("base64url");
        const pkceOk = !!entry && derived === entry.challenge;
        note(`token grant=${p.get("grant_type")} client=${p.get("client_id")} pkce_ok=${pkceOk}`);
        if (!entry || !pkceOk || p.get("client_id") !== CLIENT_ID) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "pkce or client mismatch" }));
          return;
        }
        codes.delete(p.get("code") || "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ access_token: token, refresh_token: `r-${token}`, token_type: "Bearer", expires_in: 3600 }),
        );
      });
      return;
    }
    if (u.pathname === "/login") {
      note("login page served");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Sign in</title><h1>Provider login</h1>");
      return;
    }
    if (u.pathname === "/asset") {
      // A third-party resource the app page references (case 6): proves the
      // instance's bearer token is scoped to the instance's own origin and
      // never reaches a different one loaded in the same window.
      note(`GET /asset auth=${req.headers.authorization ? "present" : "none"}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("asset");
      return;
    }
    res.writeHead(404).end();
  });

  const app = http.createServer((req, res) => {
    const auth = req.headers.authorization || "";
    const ok = auth === `Bearer ${token}`;
    note(`${req.method} ${req.url} auth=${ok ? "ok" : auth ? "wrong" : "none"}`);
    if (!ok) {
      // What an outpost does to an unauthenticated request: redirect to the
      // login page, which answers 200 with HTML — the shape `probeVersion`
      // reads as "a sign-in is needed" rather than as a dead server.
      res.writeHead(302, { location: `http://127.0.0.1:${idpPort}/login` });
      res.end();
      return;
    }
    if ((req.url || "").startsWith("/api/version")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.8.0", instanceName: "Stub instance" }));
      return;
    }
    if ((req.url || "").startsWith("/api/projects")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if ((req.url || "").startsWith("/api/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return; // held open
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><title>Stub Calandria</title><h1 id="app-loaded">Stub Calandria</h1>` +
        `<img src="http://127.0.0.1:${idpPort}/asset" alt="" />`,
    );
  });

  return new Promise((resolve) => {
    idp.listen(0, "127.0.0.1", () => {
      idpPort = (idp.address() as AddressInfo).port;
      app.listen(0, "127.0.0.1", () => {
        appPort = (app.address() as AddressInfo).port;
        resolve({
          idpOrigin: `http://127.0.0.1:${idpPort}`,
          appOrigin: `http://127.0.0.1:${appPort}`,
          token,
          clientId: CLIENT_ID,
          log,
          async stop() {
            await new Promise<void>((r) => idp.close(() => r()));
            await new Promise<void>((r) => app.close(() => r()));
          },
        });
      });
    });
  });
}

/**
 * The `xdg-open` shim that stands in for the system browser (RFC 8252 §7.3
 * expects one to exist). It follows the authorize redirect the way a real
 * browser does — straight to the app's loopback receiver — and logs both the
 * URL it was asked to open and where following it landed, which is what lets
 * the spec assert on the PKCE challenge and the callback shape without a real
 * browser under a headless display.
 */
export function xdgOpenScript(logFile: string): string {
  return (
    `#!/usr/bin/env bash\n` +
    `echo "OPENED $1" >> ${logFile}\n` +
    `curl -sSL -o /dev/null -w 'FOLLOWED %{http_code} %{url_effective}\\n' "$1" >> ${logFile} 2>&1\n`
  );
}
