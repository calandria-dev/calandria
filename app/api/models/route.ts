import { NextResponse } from "next/server";

import { modelsTreeForEnvironment } from "@/lib/providers/catalog";
import type { EnvironmentId } from "@/lib/providers/types";

export const dynamic = "force-dynamic";

const ENVIRONMENTS = new Set<EnvironmentId>(["claude", "codex", "gemini"]);

export async function GET(req: Request) {
  const agent = new URL(req.url).searchParams.get("agent") as EnvironmentId | null;
  if (!agent || !ENVIRONMENTS.has(agent)) {
    return NextResponse.json({ error: "agent must name a registered environment" }, { status: 400 });
  }
  return NextResponse.json(await modelsTreeForEnvironment(agent));
}
