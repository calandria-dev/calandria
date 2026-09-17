import { NextResponse } from "next/server";
import { getUpdateState } from "@/lib/updates/check";

export const dynamic = "force-dynamic";

/**
 * What the titlebar pill and the Settings field render: the running version,
 * the newest published release, and every release in between.
 *
 * Served from the server's cache, so a page load costs nothing and no browser
 * ever calls github.com. The check that fills the cache runs on a six-hourly
 * ticker (lib/updates/check.ts). Behind the ordinary origin auth gate: only
 * the page calls it.
 */
export async function GET() {
  return NextResponse.json(getUpdateState());
}
