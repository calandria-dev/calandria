// Who is behind a review decision. The actor is always set by the server from
// the request's authenticated context and is never read from a body: the local
// no-login mode has one human, the instance owner, and Access mode names the
// verified subject. A request that carries a service-token or bearer
// credential is an automation transport, never human authority, so it is
// refused here even if middleware let it through.

import { originAuthEnabled, verifyOriginRequest } from "../auth/origin.mjs";
import { LOCAL_OWNER_ACTOR, ReviewError, type HumanActor } from "./types";

export { LOCAL_OWNER_ACTOR };

function cookie(header: string | null, name: string): string | undefined {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header ?? "");
  return m ? decodeURIComponent(m[1]) : undefined;
}

export async function resolveHumanActor(req: Request): Promise<HumanActor> {
  const h = req.headers;
  if (h.get("x-service-token") || h.get("authorization") || h.get("x-calandria-capability") || h.get("x-calandria-turn-capability")) {
    throw new ReviewError("human_required", "a person has to make this decision from the browser");
  }
  if (!originAuthEnabled()) return { id: LOCAL_OWNER_ACTOR };
  try {
    const cookieHeader = h.get("cookie");
    const who = await verifyOriginRequest({
      headers: h,
      cookies: { get: (n: string) => { const v = cookie(cookieHeader, n); return v ? { value: v } : undefined; } },
    });
    const id = who.email || (typeof who.payload?.sub === "string" ? who.payload.sub : null);
    if (!id) throw new Error("no subject");
    return { id: `access:${id}` };
  } catch {
    throw new ReviewError("human_required", "the signed-in person could not be verified");
  }
}
