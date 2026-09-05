// Encrypts a push message body per RFC 8291 (Web Push) using the aes128gcm
// content encoding from RFC 8188, on node:crypto only. Always emits a single
// record with no padding: payloads are a few hundred bytes of server-composed
// text, well under the 4096-byte record size every push service accepts.
//
// tests/webpush.test.ts checks this against RFC 8291 Appendix A byte-for-byte,
// so the salt and the application-server keypair are injectable; production
// callers leave both to the CSPRNG.

import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { b64url } from "./vapid";

export const RECORD_SIZE = 4096;
// A record is plaintext + one delimiter octet + the 16-byte GCM tag, and must
// fit in RECORD_SIZE; the -1 keeps a whole-record payload from needing a
// second (empty) record.
export const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1 - 1;

/** The receiver's half of a subscription: its P-256 public key and auth secret. */
export interface ReceiverKeys {
  /** base64url, uncompressed point (65 bytes). */
  p256dh: string;
  /** base64url, 16 bytes. */
  auth: string;
}

export interface EncryptOptions {
  /** 16 random bytes; injectable for the RFC test vector. */
  salt?: Buffer;
  /** The application server's ephemeral private scalar (32 bytes); injectable for the RFC test vector. */
  asPrivate?: Buffer;
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

/**
 * Encrypt `plaintext` for the subscription described by `receiver`. Returns the
 * complete aes128gcm body: header (salt · rs · idlen · as_public) followed by
 * the single encrypted record.
 */
export function encryptPushPayload(plaintext: Buffer, receiver: ReceiverKeys, opts: EncryptOptions = {}): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`push payload too large (${plaintext.length} > ${MAX_PLAINTEXT} bytes)`);
  const uaPublic = b64url.decode(receiver.p256dh);
  const authSecret = b64url.decode(receiver.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("subscription p256dh is not an uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("subscription auth secret is not 16 bytes");

  const ecdh = createECDH("prime256v1");
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);

  // RFC 8291 §3.3–3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
  // RFC 8188 §2.2: CEK and NONCE from the salt.
  const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);

  // Last (only) record: plaintext, then the 0x02 delimiter.
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1 + 65);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = 65;
  asPublic.copy(header, 21);
  return Buffer.concat([header, ciphertext]);
}
