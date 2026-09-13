import { NextResponse } from "next/server";
import { getInsightsData } from "@/lib/store";
import { gatewayBaseUrl } from "@/lib/providers/resolve";

export const dynamic = "force-dynamic";

// The Insights dashboard's single data fetch: per-day facts grouped by
// (day, project, agent), plus Calandria jobs grouped by job, covering the widest range (90d) plus the same width
// again, so the client can compute prior-period deltas and switch every
// filter locally without refetching. See InsightsData in lib/store.ts.
const WINDOW_DAYS = 180;

/** The host `task_usage.provider` records for a gateway turn: the same
 *  `new URL(...).host` that lib/agentEnv.ts's `describeProvider()` computes,
 *  so the cache-hit query matches the exact string a gateway turn wrote. ""
 *  when no gateway is configured. */
function gatewayHost(): string {
  const baseUrl = gatewayBaseUrl();
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

export async function GET() {
  const since = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return NextResponse.json(getInsightsData(since, gatewayHost()));
}
