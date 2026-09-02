import { NextResponse } from "next/server";
import { listDrivers } from "@/lib/agents/registry";
import type { PlanUsageSnapshot } from "@/lib/types";

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
  const agents = Object.fromEntries(settled.filter((e): e is [string, PlanUsageSnapshot] => e != null));
  return NextResponse.json({ now: Date.now(), agents });
}
