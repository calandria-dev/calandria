import { NextResponse } from "next/server";

import { flatProviderModels, readProviderModels } from "@/lib/providers/catalog";
import { getProvider } from "@/lib/providers/store";
import type { EnvironmentId } from "@/lib/providers/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = getProvider(id);
  if (!provider) return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  const asked = new URL(req.url).searchParams.get("agent") as EnvironmentId | null;
  const agent = asked && provider.environments.includes(asked) ? asked : provider.environments[0];
  const read = await readProviderModels(provider, agent, true);
  return NextResponse.json(flatProviderModels(read));
}
