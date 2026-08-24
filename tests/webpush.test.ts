// The Web Push channel. The protocol half is pinned against the RFC's own
// numbers (a hand-rolled RFC 8291 has exactly one way to be wrong that a
// round-trip test can't see: agreeing with itself and nobody else), the
// delivery half against a fake push service, and the policy half — prune on
// 410, record everything else, one row per browser — against the DB.
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB_DIR, VAPID_SUBJECT } from "@/lib/config";
import { encryptPushPayload, MAX_PLAINTEXT } from "@/lib/push/encrypt";
import {
  b64url, generateVapidKeys, publicKeyFor, pushAudience, resetVapidCache, resetVapidTokens, signVapidJwt,
  vapidAuthorization, vapidKeys,
} from "@/lib/push/vapid";
import { pushNotification, pushTopic, sendWebPush, taskUrl, toPushMessage } from "@/lib/push/send";
import {
  deletePushSubscription, getPushSubscription, listPushSubscriptions, toPushDevice, upsertPushSubscription,
} from "@/lib/push/store";
import { getDb } from "@/lib/db";
import { emitTestNotification, resetNotificationDedupe } from "@/lib/notifications/notify";
import type { NotificationPayload } from "@/lib/notifications/types";
import { DELETE as unsubscribeRoute, GET as listRoute, POST as subscribeRoute } from "@/app/api/notifications/push/route";
import { DELETE as removeRoute } from "@/app/api/notifications/push/[id]/route";
import { classifyPushSupport, deviceLabel } from "@/app/orchestrator/usePush";

// RFC 8291 Appendix A — every intermediate value the spec publishes.
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

// A browser's side of a subscription: its keypair and auth secret, plus the
// decrypt the receiver performs (RFC 8291 §3 read backwards).
function receiver() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: b64url.encode(ecdh.getPublicKey()), auth: b64url.encode(auth) };
  const decrypt = (body: Buffer): Buffer => {
    const salt = body.subarray(0, 16);
    const rs = body.readUInt32BE(16);
    const idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen);
    const ciphertext = body.subarray(21 + idlen);
    expect(rs).toBe(4096);
    const secret = ecdh.computeSecret(asPublic);
    const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync("sha256", secret, auth, keyInfo, 32));
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const d = createDecipheriv("aes-128-gcm", cek, nonce);
    d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const padded = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
    // Last record: strip the 0x02 delimiter and any zero padding after it.
    let end = padded.length - 1;
    while (end >= 0 && padded[end] === 0) end--;
    expect(padded[end]).toBe(0x02);
    return padded.subarray(0, end);
  };
  return { keys, decrypt };
}

function fakeService(answers: Record<string, number>) {
  const calls: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, headers, body: Buffer.from(init?.body as Uint8Array) });
    const status = answers[url] ?? 201;
    return new Response(status >= 400 ? "nope" : null, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const payload: NotificationPayload = {
  id: "awaiting_input:t1", kind: "awaiting_input", taskId: "t1", projectId: "p1",
  title: "Waiting for input", body: "Review the migration · Inbox Zero", ts: 1_700_000_000_000,
};

beforeEach(() => {
  getDb().prepare("DELETE FROM push_subscriptions").run();
  resetNotificationDedupe();
  resetVapidTokens();
});

describe("RFC 8291 encryption", () => {
  it("reproduces the RFC's Appendix A ciphertext byte for byte", () => {
    expect(publicKeyFor(RFC.asPrivate)).toBe(RFC.asPublic);
    const out = encryptPushPayload(
      b64url.decode(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: b64url.decode(RFC.salt), asPrivate: b64url.decode(RFC.asPrivate) },
    );
    expect(b64url.encode(out.subarray(0, 86))).toBe(RFC.header);
    expect(b64url.encode(out.subarray(86))).toBe(RFC.ciphertext);
  });

  it("round-trips a fresh keypair and salt through the receiver's decrypt", () => {
    const r = receiver();
    const text = Buffer.from(JSON.stringify({ hello: "phone", n: 42 }));
    const a = encryptPushPayload(text, r.keys);
    const b = encryptPushPayload(text, r.keys);
    expect(r.decrypt(a).toString()).toBe(text.toString());
    expect(r.decrypt(b).toString()).toBe(text.toString());
    // Fresh salt and ephemeral key per message — two encryptions never match.
    expect(a.equals(b)).toBe(false);
  });

  it("refuses a payload that would need a second record, and malformed receiver keys", () => {
    const r = receiver();
    expect(() => encryptPushPayload(Buffer.alloc(MAX_PLAINTEXT), r.keys)).not.toThrow();
    expect(() => encryptPushPayload(Buffer.alloc(MAX_PLAINTEXT + 1), r.keys)).toThrow(/too large/);
    expect(() => encryptPushPayload(Buffer.from("x"), { p256dh: b64url.encode(Buffer.alloc(33)), auth: r.keys.auth })).toThrow(/p256dh/);
    expect(() => encryptPushPayload(Buffer.from("x"), { p256dh: r.keys.p256dh, auth: b64url.encode(Buffer.alloc(8)) })).toThrow(/auth/);
  });
});

describe("VAPID", () => {
  it("signs an ES256 JWT the push service can verify with the advertised key", () => {
    const keys = generateVapidKeys();
    const { jwt, exp } = signVapidJwt("https://push.example.org", keys, 1_000_000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(b64url.decode(h).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(b64url.decode(c).toString());
    expect(claims).toEqual({ aud: "https://push.example.org", exp, sub: VAPID_SUBJECT });
    expect(exp - 1_000_000).toBe(12 * 60 * 60);
    const pub = b64url.decode(keys.publicKey);
    const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64url.encode(pub.subarray(1, 33)), y: b64url.encode(pub.subarray(33)) } });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, b64url.decode(s))).toBe(true);
    // 64 raw bytes (r||s), not DER — a DER signature is what a hand-rolled
    // ES256 gets wrong first.
    expect(b64url.decode(s).length).toBe(64);
  });

  it("mints a keypair on first use, keeps it in ORCH_DB_DIR, and reads it back", () => {
    const file = path.join(DB_DIR, "vapid.json");
    fs.rmSync(file, { force: true });
    resetVapidCache();
    const first = vapidKeys();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    resetVapidCache();
    expect(vapidKeys()).toEqual(first);
    // The public half is re-derived from the private one on read, so a file
    // that lies about it can't advertise a key it can't sign for.
    fs.writeFileSync(file, JSON.stringify({ privateKey: first.privateKey, publicKey: "BOGUS" }));
    resetVapidCache();
    expect(vapidKeys().publicKey).toBe(first.publicKey);
  });

  it("caches one token per push service and scopes it to that origin", () => {
    const a = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc");
    const b = vapidAuthorization("https://fcm.googleapis.com/fcm/send/def");
    const c = vapidAuthorization("https://web.push.apple.com/xyz");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(a.endsWith(`k=${vapidKeys().publicKey}`)).toBe(true);
    expect(pushAudience("https://web.push.apple.com/xyz")).toBe("https://web.push.apple.com");
  });
});

describe("delivery", () => {
  it("posts an aes128gcm body the receiver decrypts to the composed message, with the RFC 8030 headers", async () => {
    const r = receiver();
    const row = upsertPushSubscription({ endpoint: "https://push.example/one", keys: r.keys }, "Pixel · Chrome");
    const svc = fakeService({});
    const results = await pushNotification(payload, svc.fetchImpl);
    expect(results).toEqual([{ status: 201, ok: true, gone: false, error: "" }]);
    expect(svc.calls).toHaveLength(1);
    const { headers, body } = svc.calls[0];
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers.ttl).toBe(String(24 * 60 * 60));
    expect(headers.urgency).toBe("normal");
    expect(headers.topic).toBe(pushTopic(payload.id));
    expect(headers.topic.length).toBeLessThanOrEqual(32);
    expect(headers.topic).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(headers.authorization).toMatch(/^vapid t=/);
    expect(JSON.parse(r.decrypt(body).toString())).toEqual(toPushMessage(payload));
    expect(toPushMessage(payload).url).toBe("/?project=p1&task=t1");
    expect(getPushSubscription(row.id)!.last_status).toBe(201);
  });

  it("marks failures urgent", async () => {
    upsertPushSubscription({ endpoint: "https://push.example/one", keys: receiver().keys }, "");
    const svc = fakeService({});
    await pushNotification({ ...payload, id: "turn_failed:t1", kind: "turn_failed" }, svc.fetchImpl);
    expect(svc.calls[0].headers.urgency).toBe("high");
  });

  it("prunes a subscription the service reports gone, records every other failure, and never throws", async () => {
    const ok = upsertPushSubscription({ endpoint: "https://push.example/ok", keys: receiver().keys }, "ok");
    const gone = upsertPushSubscription({ endpoint: "https://push.example/gone", keys: receiver().keys }, "gone");
    const missing = upsertPushSubscription({ endpoint: "https://push.example/missing", keys: receiver().keys }, "missing");
    const flaky = upsertPushSubscription({ endpoint: "https://push.example/flaky", keys: receiver().keys }, "flaky");
    const badKeys = upsertPushSubscription({ endpoint: "https://push.example/bad", keys: { p256dh: "AAAA", auth: "AAAA" } }, "bad");
    const svc = fakeService({ "https://push.example/gone": 410, "https://push.example/missing": 404, "https://push.example/flaky": 503 });
    const down = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;

    const results = await pushNotification(payload, svc.fetchImpl);
    expect(results.map((r) => r.status).sort()).toEqual([0, 201, 404, 410, 503]);
    const left = listPushSubscriptions().map((s) => s.id).sort();
    expect(left).toEqual([badKeys.id, flaky.id, ok.id].sort());
    expect(getPushSubscription(gone.id)).toBeUndefined();
    expect(getPushSubscription(missing.id)).toBeUndefined();
    expect(getPushSubscription(flaky.id)!.last_status).toBe(503);
    expect(getPushSubscription(flaky.id)!.last_error).toBe("503: nope");
    expect(getPushSubscription(badKeys.id)!.last_error).toMatch(/^encrypt: /);

    // A dead network is a status-0 result on every row, not a rejection (the
    // bad-keys row still fails before it reaches the network).
    const again = await pushNotification(payload, down);
    expect(again.every((r) => r.status === 0 && !r.gone)).toBe(true);
    expect(again.filter((r) => /ECONNRESET/.test(r.error))).toHaveLength(2);
    expect(listPushSubscriptions()).toHaveLength(3);
  });

  it("sends nothing and touches no network when nobody subscribed", async () => {
    const svc = fakeService({});
    expect(await pushNotification(payload, svc.fetchImpl)).toEqual([]);
    expect(svc.calls).toHaveLength(0);
  });

  it("is fanned out by the emitter's single exit, so a test send reaches the phone too", async () => {
    upsertPushSubscription({ endpoint: "https://push.example/phone", keys: receiver().keys }, "iPhone · Safari (app)");
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 201 }));
    const real = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      expect(emitTestNotification()).not.toBeNull();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(String(fetchMock.mock.calls[0][0])).toBe("https://push.example/phone");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("sendWebPush reports a 410 as gone without deciding anything", async () => {
    const svc = fakeService({ "https://push.example/x": 410 });
    const r = await sendWebPush({ endpoint: "https://push.example/x", ...receiver().keys }, Buffer.from("hi"), { ttl: 60, urgency: "low" }, svc.fetchImpl);
    expect(r).toEqual({ status: 410, ok: false, gone: true, error: "410: nope" });
    expect(svc.calls[0].headers.topic).toBeUndefined();
  });
});

describe("the subscription store", () => {
  it("keeps one row per endpoint: a re-post refreshes keys and last_seen, and keeps the label when none is sent", () => {
    const a = upsertPushSubscription({ endpoint: "https://push.example/e", keys: { p256dh: "k1", auth: "a1" } }, "  Mac · Chrome  ");
    expect(a.label).toBe("Mac · Chrome");
    const b = upsertPushSubscription({ endpoint: "https://push.example/e", keys: { p256dh: "k2", auth: "a2" }, expirationTime: 5 }, "");
    expect(b.id).toBe(a.id);
    expect(b.p256dh).toBe("k2");
    expect(b.label).toBe("Mac · Chrome");
    expect(b.expiration_time).toBe(5);
    expect(listPushSubscriptions()).toHaveLength(1);
    expect(deletePushSubscription(a.id)).toBe(true);
    expect(deletePushSubscription(a.id)).toBe(false);
  });

  it("keeps the endpoint and keys off the device list", () => {
    const row = upsertPushSubscription({ endpoint: "https://web.push.apple.com/QW3", keys: { p256dh: "k", auth: "a" } }, "iPhone");
    const d = toPushDevice(row);
    expect(d).not.toHaveProperty("endpoint");
    expect(d).not.toHaveProperty("p256dh");
    expect(d.service).toBe("web.push.apple.com");
  });
});

describe("the routes", () => {
  const json = (method: string, body?: unknown) =>
    new Request("http://x/api/notifications/push", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("GET hands out the public key and the device list", async () => {
    upsertPushSubscription({ endpoint: "https://push.example/e", keys: { p256dh: "k", auth: "a" } }, "Phone");
    const r = await (await listRoute()).json();
    expect(r.publicKey).toBe(vapidKeys().publicKey);
    expect(b64url.decode(r.publicKey).length).toBe(65);
    expect(r.subscriptions).toHaveLength(1);
    expect(r.subscriptions[0].label).toBe("Phone");
  });

  it("POST registers a browser's subscription and refuses a malformed one", async () => {
    const good = await subscribeRoute(json("POST", { subscription: { endpoint: "https://push.example/new", expirationTime: null, keys: { p256dh: "k", auth: "a" } }, label: "Pixel · Chrome" }));
    expect(good.status).toBe(200);
    expect((await good.json()).device.label).toBe("Pixel · Chrome");
    for (const bad of [
      {},
      { subscription: { endpoint: "http://insecure/x", keys: { p256dh: "k", auth: "a" } } },
      { subscription: { endpoint: "https://push.example/x", keys: { p256dh: "k" } } },
      { subscription: "https://push.example/x" },
    ]) {
      expect((await subscribeRoute(json("POST", bad))).status).toBe(400);
    }
    expect((await subscribeRoute(new Request("http://x/api/notifications/push", { method: "POST", body: "{not json" }))).status).toBe(400);
    expect(listPushSubscriptions()).toHaveLength(1);
  });

  it("DELETE forgets this browser by endpoint, and /[id] forgets any device", async () => {
    upsertPushSubscription({ endpoint: "https://push.example/mine", keys: { p256dh: "k", auth: "a" } }, "mine");
    const other = upsertPushSubscription({ endpoint: "https://push.example/other", keys: { p256dh: "k", auth: "a" } }, "other");
    expect(await (await unsubscribeRoute(json("DELETE", { endpoint: "https://push.example/mine" }))).json()).toEqual({ ok: true, removed: true });
    expect(await (await unsubscribeRoute(json("DELETE", { endpoint: "https://push.example/mine" }))).json()).toEqual({ ok: true, removed: false });
    expect((await unsubscribeRoute(json("DELETE", {}))).status).toBe(400);
    const params = (id: string) => ({ params: Promise.resolve({ id }) });
    expect((await removeRoute(json("DELETE"), params(other.id))).status).toBe(200);
    expect((await removeRoute(json("DELETE"), params(other.id))).status).toBe(404);
    expect(listPushSubscriptions()).toHaveLength(0);
  });
});

describe("the service worker", () => {
  const sw = fs.readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8");

  it("handles push, click and subscription rotation", () => {
    for (const ev of ["push", "notificationclick", "pushsubscriptionchange"]) {
      expect(sw).toContain(`addEventListener("${ev}"`);
    }
  });

  it("has NO fetch handler — it must never become an offline cache", () => {
    // docs/FEATURES.md "Install as an app": everything on screen is live
    // server state, and a stale cache intercepting the SSE streams would be
    // worse than a browser error page.
    expect(sw).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(sw).not.toMatch(/\bonfetch\b/);
    expect(sw).not.toMatch(/caches\.open/);
  });

  it("posts a rotated subscription back with credentials, so it passes the Access gate", () => {
    expect(sw).toContain('credentials: "include"');
    expect(sw).toContain('"/api/notifications/push"');
  });

  it("steers a focused client to the deep link by navigating, not only by postMessage", () => {
    // A warm PWA foregrounded by the tap keeps its previous view; postMessage
    // races page state (and is often undelivered on iOS), so the click handler
    // must navigate the client to ?project/&task. postMessage stays only as the
    // no-navigate fallback.
    expect(sw).toMatch(/\.navigate\(url\)/);
    const click = sw.slice(sw.indexOf('addEventListener("notificationclick"'));
    // The navigate() call comes before the postMessage() call site (its
    // fallback). Match the actual call, not the word in the comment above it.
    expect(click.indexOf(".navigate(url)")).toBeLessThan(click.indexOf("page.postMessage("));
  });
});

describe("the browser half", () => {
  it("classifies push support with the secure-context check first and iOS's install rule second", () => {
    const base = { secureContext: true, hasServiceWorker: true, hasPushManager: true, ios: false, standalone: false };
    expect(classifyPushSupport(base)).toBe("ready");
    expect(classifyPushSupport({ ...base, secureContext: false, hasPushManager: false })).toBe("insecure");
    expect(classifyPushSupport({ ...base, hasPushManager: false, ios: true })).toBe("needs_install");
    expect(classifyPushSupport({ ...base, hasPushManager: false, ios: true, standalone: true })).toBe("unsupported");
    expect(classifyPushSupport({ ...base, ios: true })).toBe("ready");
    expect(classifyPushSupport({ ...base, hasServiceWorker: false })).toBe("unsupported");
  });

  it("labels a device from its user agent", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
    const pixel = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
    expect(deviceLabel(iphone, true)).toBe("iPhone · Safari (app)");
    expect(deviceLabel(pixel, false)).toBe("Android · Chrome");
    expect(deviceLabel(edge, false)).toBe("Windows · Edge");
  });

  it("deep-links with the app's own ?project/?task keys", () => {
    expect(taskUrl({ projectId: "p", taskId: "t" })).toBe("/?project=p&task=t");
    expect(taskUrl({ projectId: "", taskId: "t" })).toBe("/?task=t");
    expect(taskUrl({ projectId: "p", taskId: "" })).toBe("/");
  });
});

afterEach(() => vi.restoreAllMocks());
