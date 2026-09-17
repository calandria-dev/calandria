import { NextResponse } from "next/server";
import { runUpdateCheck } from "@/lib/updates/check";

export const dynamic = "force-dynamic";

/**
 * Check now, from the Settings field or the popover.
 *
 * One request in flight per instance: a second press while a check runs awaits
 * the same promise. With the check turned off this answers the current state
 * with `enabled: false` and asks nothing, which is a 200: the caller asked a
 * question the server is allowed to decline.
 */
export async function POST() {
  return NextResponse.json(await runUpdateCheck());
}
