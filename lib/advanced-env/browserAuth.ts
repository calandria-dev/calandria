/* The browser-only guard the advanced-settings mutations sit behind.
 *
 * middleware.ts already gates every HTTP route, and in local mode it allows a
 * raw loopback client with no Origin at all, which is right for curl, health
 * checks and the MCP bridge. Editing the environment a server and its agent
 * sessions run under is not one of those paths, so these routes require the
 * two things only a real browser fetch from this app sends: an Origin that
 * belongs to this instance, and `Sec-Fetch-Site: same-origin`.
 *
 * The rule is the same in both auth modes. Access mode's own HTTP rule accepts
 * an absent Origin on purpose (a link from an email sends none), and local
 * mode's accepts one too; this guard layers the mandatory pair on top of each
 * mode's existing origin check instead of replacing it.
 *
 * The service token is never consulted. A caller holding SERVICE_TOKEN or
 * CALANDRIA_FLEET_TOKEN gets no authority here, and a raw token client sends
 * no Fetch Metadata, so it is refused by the same check.
 *
 * This is a control over Calandria's supported request paths. It makes no
 * claim about an unrestricted process running as the same OS account, which
 * can read or alter any file that account owns, this settings file included.
 */

import { originAuthEnabled } from "../auth/origin.mjs";
import { localHttpRequestAllowed, sameOriginHttpRequestAllowed } from "../auth/local-origin.mjs";

export type BrowserGuardResult = { ok: true } | { ok: false; reason: string };

/**
 * Decide from request headers alone, so a test can pass literals and the
 * WebSocket path could reuse it later.
 */
export function browserMutationAllowed(
  headers: { host?: string | null; origin?: string | null; secFetchSite?: string | null },
  env: Record<string, string | undefined> = process.env,
): BrowserGuardResult {
  const { host, origin, secFetchSite } = headers;
  if (!origin) return { ok: false, reason: "This request must come from the Calandria web app." };
  if (String(secFetchSite || "").toLowerCase() !== "same-origin") {
    return { ok: false, reason: "This request must come from the Calandria web app." };
  }
  const allowed = originAuthEnabled()
    ? sameOriginHttpRequestAllowed({ host, origin }, env)
    : localHttpRequestAllowed({ host, origin, secFetchSite }, env);
  if (!allowed) return { ok: false, reason: "This request must come from the Calandria web app." };
  return { ok: true };
}

/** The same decision for a route handler's Request. */
export function requestFromBrowser(req: Request, env?: Record<string, string | undefined>): BrowserGuardResult {
  return browserMutationAllowed(
    {
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      secFetchSite: req.headers.get("sec-fetch-site"),
    },
    env,
  );
}
