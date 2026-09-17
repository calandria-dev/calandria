import { NextResponse } from "next/server";

import {
  flatProviderModels,
  policyForEnabledIds,
  readProviderModels,
} from "@/lib/providers/catalog";
import { getProvider, updateProvider } from "@/lib/providers/store";
import type { EnvironmentId } from "@/lib/providers/types";

export const dynamic = "force-dynamic";

function environmentFor(provider: NonNullable<ReturnType<typeof getProvider>>, req: Request): EnvironmentId {
  const asked = new URL(req.url).searchParams.get("agent") as EnvironmentId | null;
  return asked && provider.environments.includes(asked) ? asked : provider.environments[0];
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = getProvider(id);
  if (!provider) return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  return NextResponse.json(flatProviderModels(await readProviderModels(provider, environmentFor(provider, req))));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = getProvider(id);
  if (!provider) return NextResponse.json({ error: "Provider not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const ids = body && typeof body === "object" ? (body as { ids?: unknown }).ids : null;
  if (!Array.isArray(ids) || ids.some((model) => typeof model !== "string")) {
    return NextResponse.json({ error: "ids must be an array of model ids" }, { status: 400 });
  }

  const agent = environmentFor(provider, req);
  const current = await readProviderModels(provider, agent);
  const placed = [...current.on, ...current.off, ...current.duplicates];
  const policy = policyForEnabledIds(current.nextPolicy, placed, ids);
  const updated = updateProvider(provider.id, { model_policy: policy })!;
  return NextResponse.json(flatProviderModels(await readProviderModels(updated, agent)));
}
