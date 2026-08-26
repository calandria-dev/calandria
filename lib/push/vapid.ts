// VAPID (RFC 8292): the keypair that identifies THIS instance to the browsers'
// push services, and the signed JWT each request carries.
//
// Hand-rolled on node:crypto rather than the `web-push` package: the whole
// protocol is one ECDSA signature here and one ECDH + HKDF + AES-GCM pass in
// encrypt.ts, both pinned by tests (the RFC's own vector for the latter), and
// that is smaller than the dependency tree it would replace.
//
// Key storage: VAPID_PRIVATE_KEY (env) wins; otherwise `<CALANDRIA_DB_DIR>/vapid.json`,
// minted on first use. It sits beside the database on purpose — a subscription
// is bound to the key it was created under (the push service rejects a push
// signed by any other), so the key must travel with the subscriptions or every
// phone goes quiet with nothing in the UI to say why.

import { createECDH, createPrivateKey, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DB_DIR, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from "@/lib/config";

export const b64url = {
  encode: (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64url"),
  decode: (s: string): Buffer => Buffer.from(s, "base64url"),
};

export interface VapidKeys {
  /** Uncompressed P-256 point (65 bytes), base64url — what the browser's
   *  `applicationServerKey` wants and what `k=` carries. */
  publicKey: string;
  /** Raw 32-byte scalar, base64url. */
  privateKey: string;
}

const KEY_FILE = "vapid.json";

/** Derive the public point from a raw private scalar; throws on a bad scalar. */
export function publicKeyFor(privateKey: string): string {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(b64url.decode(privateKey));
  return b64url.encode(ecdh.getPublicKey());
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64url.encode(ecdh.getPublicKey()), privateKey: b64url.encode(ecdh.getPrivateKey()) };
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaVapid: { keys: VapidKeys; source: "env" | "file" } | undefined;
}

function validScalar(s: string): boolean {
  try { return b64url.decode(s).length === 32 && !!publicKeyFor(s); } catch { return false; }
}

/**
 * The instance's VAPID keypair, minting and persisting one on first call.
 * Cached on globalThis so the file is read once per process (and survives HMR).
 */
export function vapidKeys(): VapidKeys {
  if (global.__calandriaVapid) return global.__calandriaVapid.keys;
  if (VAPID_PRIVATE_KEY) {
    if (!validScalar(VAPID_PRIVATE_KEY)) throw new Error("VAPID_PRIVATE_KEY is not a base64url-encoded 32-byte P-256 private key");
    const keys = { privateKey: VAPID_PRIVATE_KEY, publicKey: publicKeyFor(VAPID_PRIVATE_KEY) };
    global.__calandriaVapid = { keys, source: "env" };
    return keys;
  }
  const file = path.join(DB_DIR, KEY_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<VapidKeys>;
    if (typeof parsed.privateKey === "string" && validScalar(parsed.privateKey)) {
      // The public half is re-derived rather than trusted: a hand-edited file
      // with a mismatched pair would sign with one key and advertise another,
      // and every subscription made under the advertised one would be rejected.
      const keys = { privateKey: parsed.privateKey, publicKey: publicKeyFor(parsed.privateKey) };
      global.__calandriaVapid = { keys, source: "file" };
      return keys;
    }
    console.warn(`[push] ${file} is unusable; minting a new VAPID key (existing subscriptions will stop working)`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const keys = generateVapidKeys();
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...keys, createdAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  global.__calandriaVapid = { keys, source: "file" };
  return keys;
}

/** Test seam: forget the cached pair so the next call re-reads (or re-mints). */
export function resetVapidCache(): void {
  global.__calandriaVapid = undefined;
}

function privateKeyObject(keys: VapidKeys): KeyObject {
  const pub = b64url.decode(keys.publicKey);
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: b64url.encode(pub.subarray(1, 33)),
      y: b64url.encode(pub.subarray(33, 65)),
    },
  });
}

/** The push service's origin — the JWT audience RFC 8292 requires. */
export function pushAudience(endpoint: string): string {
  return new URL(endpoint).origin;
}

// Tokens are per audience (one per push service, not per subscription) and
// good for 12h; re-signed with an hour to spare so a cached one never reaches
// a service expired. RFC 8292 caps `exp` at 24h.
const TOKEN_TTL_S = 12 * 60 * 60;
const TOKEN_RENEW_S = 60 * 60;
const tokens = new Map<string, { jwt: string; exp: number }>();

/**
 * Sign a VAPID JWT for `audience` (ES256 over header.claims, signature as the
 * raw r||s the JWS spec wants — hence ieee-p1363, not DER).
 */
export function signVapidJwt(audience: string, keys: VapidKeys, nowS = Math.floor(Date.now() / 1000)): { jwt: string; exp: number } {
  const exp = nowS + TOKEN_TTL_S;
  const header = b64url.encode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url.encode(Buffer.from(JSON.stringify({ aud: audience, exp, sub: VAPID_SUBJECT })));
  const data = `${header}.${claims}`;
  const sig = sign("sha256", Buffer.from(data), { key: privateKeyObject(keys), dsaEncoding: "ieee-p1363" });
  return { jwt: `${data}.${b64url.encode(sig)}`, exp };
}

/** The `Authorization: vapid t=<jwt>, k=<public key>` header value for a subscription. */
export function vapidAuthorization(endpoint: string): string {
  const keys = vapidKeys();
  const aud = pushAudience(endpoint);
  const nowS = Math.floor(Date.now() / 1000);
  let tok = tokens.get(aud);
  if (!tok || tok.exp - nowS < TOKEN_RENEW_S) {
    tok = signVapidJwt(aud, keys, nowS);
    tokens.set(aud, tok);
  }
  return `vapid t=${tok.jwt}, k=${keys.publicKey}`;
}

/** Test seam. */
export function resetVapidTokens(): void {
  tokens.clear();
}
