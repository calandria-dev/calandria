import { NextResponse } from "next/server";
import { internalUsageLast30Days } from "@/lib/internalUsage";

export const dynamic = "force-dynamic";

// Settings opens this once. There is no polling: historical spend is context
// for a decision, and it does not update live.
export async function GET() {
  return NextResponse.json({ jobs: internalUsageLast30Days() });
}
