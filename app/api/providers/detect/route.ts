import { NextResponse } from "next/server";

import { endpointModels } from "@/lib/modelEndpoint";
import { listProviders } from "@/lib/providers/store";
import type { ProviderType } from "@/lib/providers/types";

export const dynamic = "force-dynamic";

const CANDIDATES: Array<{ type: ProviderType; base_url: string }> = [
  { type: "ollama", base_url: "http://localhost:11434" },
  { type: "lmstudio", base_url: "http://localhost:1234" },
];

export async function GET() {
  const configured = new Set(
    listProviders().flatMap((provider) =>
      provider.config.base_url ? [provider.config.base_url] : [],
    ),
  );
  const results = await Promise.all(
    CANDIDATES.map(async (candidate) => ({ candidate, result: await endpointModels(candidate.base_url) })),
  );
  const servers = results.flatMap(({ candidate, result }) =>
    result.reachable && !configured.has(result.base_url)
      ? [{ ...candidate, model_count: result.models.length }]
      : [],
  );
  return NextResponse.json({ servers });
}
