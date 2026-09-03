import { NextResponse } from "next/server";
import { LITELLM_BASE_URL } from "@/lib/config";
import { clearGatewayKey, hasGatewayKey, setGatewayKey } from "@/lib/litellm-key";
import { clearGatewayProbeCache } from "@/lib/gatewayHealth";

export const dynamic = "force-dynamic";

// The instance's LiteLLM virtual key, the other way in beside
// CALANDRIA_LITELLM_KEY (lib/litellm-key.ts). Settings → Agents writes it here
// so an instance that isn't configured from a compose file can still reach a
// gateway that wants one.
//
// There is no GET. The key is write-only from the browser's point of view:
// whether one EXISTS is on GET /api/agents' gateway card, and the value itself
// never crosses back, which is the same rule the project override obeys by not
// storing it at all.

function state() {
  return NextResponse.json({ ok: true, has_key: hasGatewayKey() });
}

export async function POST(req: Request) {
  if (!LITELLM_BASE_URL) {
    return NextResponse.json({ error: "no gateway is configured — set CALANDRIA_LITELLM_BASE_URL first" }, { status: 400 });
  }
  const { key } = (await req.json().catch(() => ({}))) as { key?: string };
  if (!key || !key.trim()) return NextResponse.json({ error: "missing key" }, { status: 400 });
  try {
    setGatewayKey(key);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  // The card's model count and database line were probed WITHOUT this key.
  clearGatewayProbeCache();
  return state();
}

export async function DELETE() {
  clearGatewayKey();
  clearGatewayProbeCache();
  return state();
}
