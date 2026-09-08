// VAPID (RFC 8292): the keypair that identifies this instance to the browsers'
// push services, and the signed JWT each request carries.
//
// Hand-rolled on node:crypto instead of the `web-push` package: the whole
// protocol is one ECDSA signature plus ECDH + HKDF + AES-GCM in encrypt.ts,
// both pinned by tests and smaller than the dependency tree a library adds.
//
// Key storage: VAPID_PRIVATE_KEY (env) wins, else `<CALANDRIA_DB_DIR>/vapid.json`,
// minted on first use and kept beside the database since a subscription is
// bound to the key it was created under and must travel with it. Written
// owner-only via lib/secretFile.ts, best-effort; see vapidKeys() below.

import { createECDH, createPrivateKey, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DB_DIR, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from "@/lib/config";
import { writeSecretFile } from "@/lib/secretFile";

export const b64url = {
  encode: (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64url"),
  decode: (s: string): Buffer => Buffer.from(s, "base64url"),
};

export interface VapidKeys {
  /** Uncompressed P-256 point (65 bytes), base64url: what the browser's
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

/** Left-pad a raw scalar to the 32 bytes P-256 coordinates use, or null if it
 *  can't be one. `ecdh.getPrivateKey()` returns OpenSSL's minimal big-endian
 *  bignum, so a scalar with a zero top byte comes back one byte short. It is
 *  the same scalar (`setPrivateKey` accepts either), and RFC 7518 §6.2.2.1
 *  wants `d` zero-padded to the coordinate size, so the short form gets fixed
 *  here instead of rejected. */
function padScalar(raw: Buffer): Buffer | null {
  if (raw.length === 0 || raw.length > 32) return null;
  return raw.length === 32 ? raw : Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const d = padScalar(ecdh.getPrivateKey());
  // Unreachable: the curve fixes the width, so the only variable is how many
  // leading zeros OpenSSL trimmed. Asserts instead of coercing, since a
  // scalar this isn't would be a key that can't sign.
  if (!d) throw new Error("generated VAPID scalar is not a P-256 private key");
  return { publicKey: b64url.encode(ecdh.getPublicKey()), privateKey: b64url.encode(d) };
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaVapid: { keys: VapidKeys; source: "env" | "file" } | undefined;
}

/** The canonical 32-byte base64url form of a raw P-256 scalar, or null if it
 *  isn't one. Padding on the way IN as well as on the way out is what keeps a
 *  key minted by an older build usable: rejecting a short-but-valid scalar
 *  re-mints the file, and every subscription made under the old key goes quiet
 *  with nothing in the UI to say why. */
function normalizeScalar(s: string): string | null {
  try {
    const d = padScalar(b64url.decode(s));
    if (!d) return null;
    const out = b64url.encode(d);
    return publicKeyFor(out) ? out : null;
  } catch { return null; }
}

/**
 * The instance's VAPID keypair, minting and persisting one on first call.
 * Cached on globalThis so the file is read once per process (and survives HMR).
 */
export function vapidKeys(): VapidKeys {
  if (global.__calandriaVapid) return global.__calandriaVapid.keys;
  if (VAPID_PRIVATE_KEY) {
    const env = normalizeScalar(VAPID_PRIVATE_KEY);
    if (!env) throw new Error("VAPID_PRIVATE_KEY is not a base64url-encoded 32-byte P-256 private key");
    const keys = { privateKey: env, publicKey: publicKeyFor(env) };
    global.__calandriaVapid = { keys, source: "env" };
    return keys;
  }
  const file = path.join(DB_DIR, KEY_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<VapidKeys>;
    const stored = typeof parsed.privateKey === "string" ? normalizeScalar(parsed.privateKey) : null;
    if (stored) {
      // The public half is always re-derived from the private key: a hand-edited
      // file with a mismatched pair would otherwise sign with one key while
      // advertising another, and every subscription made under the advertised
      // key would be rejected.
      const keys = { privateKey: stored, publicKey: publicKeyFor(stored) };
      global.__calandriaVapid = { keys, source: "file" };
      return keys;
    }
    console.warn(`[push] ${file} is unusable; minting a new VAPID key (existing subscriptions will stop working)`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const keys = generateVapidKeys();
  // Owner-only, and on Windows that means an ACL: `mode: 0o600` there only
  // toggles the read-only attribute, leaving the signing key readable by every
  // other local account (docs/WINDOWS.md §3). Non-fatal, unlike a pasted API
  // key: nobody is in the loop when this is minted, so failing closed on a
  // filesystem with no ACLs would turn off push for the whole instance with no
  // one to notice.
  writeSecretFile(file, JSON.stringify({ ...keys, createdAt: new Date().toISOString() }, null, 2) + "\n", {
    fatal: false,
    advice: "Set VAPID_PRIVATE_KEY in the environment to keep the signing key off disk.",
  });
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

/** The push service's origin: the JWT audience RFC 8292 requires. */
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
 * raw r||s the JWS spec wants, hence ieee-p1363, not DER).
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
