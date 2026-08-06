import { NextResponse } from "next/server";
import { internalUsageLast30Days } from "@/lib/internalUsage";

export const dynamic = "force-dynamic";

// Settings opens this once. There is intentionally no polling: historical
// spend is context for a decision, not a live meter.
export async function GET() {
  return NextResponse.json({ jobs: internalUsageLast30Days() });
}
