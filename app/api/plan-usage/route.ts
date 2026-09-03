import { NextResponse } from "next/server";
import { listDrivers } from "@/lib/agents/registry";
import { LITELLM_BASE_URL } from "@/lib/config";
import { gatewayHealth } from "@/lib/gatewayHealth";
import { gatewayKey } from "@/lib/litellm-key";
import { GATEWAY_PLAN_ID, type PlanUsageSnapshot } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Subscription plan usage per agent (the titlebar session/week meter). Polled
 * by the client while a tab is open; each driver that implements planUsage()
 * answers from an instance-wide cache and decides for itself when a real
 * provider fetch is warranted (see lib/agents/claude/planUsage.ts — the whole
 * rate-limit-respecting policy lives behind the driver seam, so this route is
 * just the fan-out). Agents without the hook, or with nothing to show (feature
 * off, API-key auth), are simply absent from the map.
 */
export async function GET() {
  // Concurrently, not in sequence: the drivers' sources are unrelated, and they
  // are not equally fast — Claude answers from a cached HTTP fetch while Codex
  // spawns a short-lived `codex app-server`. Serially, one slow agent's whole
  // timeout would be added to every other agent's meter on every poll.
  const settled = await Promise.all(
    listDrivers().map(async (d): Promise<[string, PlanUsageSnapshot] | null> => {
      if (!d.planUsage) return null;
      try {
        const snap = await d.planUsage();
        return snap ? [d.id, snap] : null;
      } catch {
        // One driver's broken usage source must not blank the others' meters.
        return null;
      }
    }),
  );
  const agents: Record<string, PlanUsageSnapshot> = Object.fromEntries(
    settled.filter((e): e is [string, PlanUsageSnapshot] => e != null),
  );
  // The gateway key's LiteLLM budget, synthesized into the same snapshot shape
  // (docs/design/litellm.md, "Attribution, budgets and failures"): no agent
  // driver reports it, because it isn't per-agent — one instance key's budget
  // covers every gateway task regardless of which CLI ran it. `gatewayHealth`
  // is already cached (GATEWAY_CACHE_MS), so polling this every minute costs
  // nothing beyond what Settings → Agents already pays. Absent when no
  // gateway is configured, or its database doesn't report a budget.
  if (LITELLM_BASE_URL) {
    const health = await gatewayHealth(LITELLM_BASE_URL, gatewayKey());
    if (health.database && health.spend != null) {
      const utilization = health.max_budget ? Math.min(100, (health.spend / health.max_budget) * 100) : 0;
      const resetsAt = health.budget_reset_at ? Date.parse(health.budget_reset_at) : NaN;
      agents[GATEWAY_PLAN_ID] = {
        available: true,
        reason: null,
        plan: null,
        windows: [
          {
            id: "gateway_budget",
            label: "Gateway budget",
            utilization,
            resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
            kind: "gateway_budget",
          },
        ],
        status: health.max_budget != null && health.spend >= health.max_budget ? "rejected" : "allowed",
        statusWindow: "gateway_budget",
        statusResetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
        fetchedAt: Date.now(),
        stale: false,
      };
    }
  }
  return NextResponse.json({ now: Date.now(), agents });
}
