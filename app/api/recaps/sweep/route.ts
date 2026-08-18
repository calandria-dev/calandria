import { NextResponse } from "next/server";
import { sweepRecaps } from "@/lib/recap";
import { automaticRecapsEnabled } from "@/lib/backgroundJobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Generate recaps for any stale projects with new activity. Called by the
// client on load and on an interval; idempotent (only touches projects due).
export async function POST() {
  if (!automaticRecapsEnabled()) return NextResponse.json({ generated: 0, disabled: true });
  const generated = await sweepRecaps();
  return NextResponse.json({ generated });
}
