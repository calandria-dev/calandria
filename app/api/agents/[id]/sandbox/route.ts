import { NextResponse } from "next/server";
import { getDriverStrict } from "@/lib/agents/registry";
import { getAgentSandboxBroken } from "@/lib/agents/connections";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Re-check whether the agent's own sandbox can be created on this host, and
// record the answer (lib/agents/codex/sandbox.ts).
//
// The fix for a broken sandbox is a host change (a sysctl, an AppArmor
// profile, a reboot) made outside Calandria, so nothing tells the app when it
// happens. This button lets the user find out without re-verifying a working
// login or spending a full turn. A turn clears the flag on its own once the
// sandbox works again.
//
// GET reads the recorded verdict without spawning anything, so the card can
// render before anyone presses the button.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getDriverStrict(id)) return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  return NextResponse.json({ sandboxBroken: getAgentSandboxBroken(id) });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const driver = getDriverStrict(id);
  if (!driver) return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  // An agent that runs unsandboxed has nothing to check and is not an error:
  // report a clean bill so one generic card can call this for any agent.
  if (!driver.sandboxHealth) return NextResponse.json({ ok: true, reason: null, error: null, sandboxBroken: null });

  const health = await driver.sandboxHealth();
  return NextResponse.json({ ...health, sandboxBroken: getAgentSandboxBroken(id) });
}
