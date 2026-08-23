import { NextResponse } from "next/server";
import { getDriver } from "@/lib/agents/registry";
import { setOnboardingAccount } from "@/lib/onboarding";
import { getAgentConnection, setAgentConnection } from "@/lib/agents/connections";

export const dynamic = "force-dynamic";

// The wizard's Verify step. Reads the resolved account/plan and runs a one-shot
// test turn through the same `claude` binary the SDK drives, so a green result
// means real turns will work — not just that credentials exist on disk.
export async function POST() {
  const driver = getDriver("claude");
  const status = await driver.authStatus();
  const turn = await driver.verify();

  // The turn is the real proof (it can pass even when `auth status` is terse,
  // e.g. on the API-key path); status fills in the friendly "Connected as …".
  const connected = turn.ok;
  if (connected) {
    setOnboardingAccount(status.email, status.plan);
    // Mirror into the generic per-agent connection record so the task-creation
    // gating (GET /api/agents) sees Claude as connected without a re-verify.
    const method = getAgentConnection("claude")?.method ?? (status.plan === "API" ? "api_key" : "subscription");
    setAgentConnection("claude", { method, email: status.email, plan: status.plan });
  }

  return NextResponse.json({
    connected,
    email: status.email,
    plan: status.plan,
    method: status.method,
    error: connected ? null : turn.error || status.error || "could not reach Claude",
  });
}
