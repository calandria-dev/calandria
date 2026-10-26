// The /pty upgrade gate in server.js, as one function shared by the upgrade
// handler and the `/pty/preflight` HTTP route. The browser WebSocket API hides
// the status of a refused upgrade, so the terminal asks the preflight route why
// its socket failed. Both paths must run this same function so the answer the
// preflight gives is the verdict the upgrade got.
//
// The preflight only reports a verdict. It never spawns or proxies a pty.

/** Path of the HTTP route that reports the /pty gate's verdict. */
export const PTY_PREFLIGHT_PATH = "/pty/preflight";

/**
 * @typedef {{ ok: true } | { ok: false, reason: "origin" | "access" }} PtyGateVerdict
 */

/**
 * Evaluate the /pty gate for a Node request (an upgrade or the preflight POST).
 * `cfAccess` is lib/auth/origin.mjs and `localOrigin` is
 * lib/auth/local-origin.mjs, injected so server.js keeps its own load order.
 *
 * Reasons: `origin` means the page's Host/Origin pair is not allowed (local
 * mode's target allowlist, or a cross-origin page in Access mode). `access`
 * means no valid Cloudflare Access assertion came with the request.
 *
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @param {{ cfAccess: { originAuthEnabled(): boolean, verifyOriginNodeRequest(req: unknown): Promise<unknown> },
 *           localOrigin: { localWebSocketRequestAllowed(r: {host?: string|null, origin?: string|null}): boolean,
 *                          sameOriginWebSocketRequestAllowed(r: {host?: string|null, origin?: string|null}): boolean } }} deps
 * @returns {Promise<PtyGateVerdict>}
 */
export async function ptyGateVerdict(req, { cfAccess, localOrigin }) {
  const pair = { host: headerOf(req, "host"), origin: headerOf(req, "origin") };
  if (!cfAccess.originAuthEnabled()) {
    // Local mode: Host is the DNS-rebinding defense and Origin proves intent.
    return localOrigin.localWebSocketRequestAllowed(pair) ? { ok: true } : { ok: false, reason: "origin" };
  }
  // Access mode: the Access cookie is SameSite=None, so a valid assertion
  // proves identity only. Same-origin proves intent.
  if (!localOrigin.sameOriginWebSocketRequestAllowed(pair)) return { ok: false, reason: "origin" };
  try {
    await cfAccess.verifyOriginNodeRequest(req);
    return { ok: true };
  } catch {
    return { ok: false, reason: "access" };
  }
}

/** One log line naming why the gate refused a request. */
export function ptyGateRefusalMessage(reason) {
  return reason === "access"
    ? "refused /pty: no valid Access assertion"
    : "refused /pty: origin not allowed for this host";
}

function headerOf(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
