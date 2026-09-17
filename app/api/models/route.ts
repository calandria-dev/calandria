import { NextResponse } from "next/server";

import { modelsTreeForEnvironment } from "@/lib/providers/catalog";
import { isAgentId } from "@/lib/agents/capabilities";
import type { EnvironmentId } from "@/lib/providers/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const requested = new URL(req.url).searchParams.get("agent");
  // The mock driver is registered only when CALANDRIA_E2E_MOCK_AGENT=1. Keep
  // this route aligned with the SDK-free registry so test-only environments
  // work without importing the driver registry or any agent SDK.
  if (!requested || !isAgentId(requested)) {
    return NextResponse.json({ error: "agent must name a registered environment" }, { status: 400 });
  }
  const agent = requested as EnvironmentId;
  // The mock driver mirrors Claude's provider surface and is test-only. Its
  // model catalog uses the Claude environment's provider placement rules.
  const catalogEnvironment = requested === "mock" ? "claude" : agent;
  return NextResponse.json(await modelsTreeForEnvironment(catalogEnvironment));
}
