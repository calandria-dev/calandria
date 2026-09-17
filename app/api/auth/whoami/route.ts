import { type NextRequest, NextResponse } from "next/server";
import { activeProvider, verifyOriginRequest } from "@/lib/auth/origin.mjs";

export const dynamic = "force-dynamic";

/**
 * Who is signed in to THIS instance, and under which origin provider. Drives the
 * Log out control at the foot of the settings nav, which renders only when a
 * real session exists to end (i.e. not in open local dev), and the desktop app's
 * sign-in flow. Reachable only behind the origin gate, so a successful verify
 * here is expected.
 */
export async function GET(req: NextRequest) {
  const provider = activeProvider();
  if (provider === "none") {
    return NextResponse.json({ provider, signedIn: false, email: null });
  }
  try {
    const { email } = await verifyOriginRequest(req);
    return NextResponse.json({ provider, signedIn: true, email: email ?? null });
  } catch {
    return NextResponse.json({ provider, signedIn: false, email: null });
  }
}
