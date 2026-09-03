import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { taskProvider, isGatewayEndpoint } from "@/lib/agentEnv";
import { endpointModels } from "@/lib/modelEndpoint";
import { gatewayModelCatalog, gatewayModelOptions, type GatewayFitAgent } from "@/lib/gatewayModels";
import { gatewayKey } from "@/lib/litellm-key";

function fitAgentFor(id: string | null | undefined): GatewayFitAgent {
  return id === "codex" ? "codex" : id === "gemini" ? "gemini" : "claude";
}

export const dynamic = "force-dynamic";

/**
 * The models this project's endpoint reports — what turns the model picker into
 * a free-form field with real suggestions when the project runs on a local
 * server instead of the agent's cloud login.
 *
 * The probe is server-side (lib/modelEndpoint.ts says why) and this route is
 * the browser's only way to it. `?base_url=` probes a URL that hasn't been
 * saved yet, which is the whole point in the project settings dialog: the
 * suggestions have to appear while the URL is being typed, before there is a
 * stored override to read. It is not a wider reach than the caller already has
 * — the same person can save any URL to the project and have every turn talk to
 * it — and all this does with the answer is list model ids.
 *
 * A cloud project answers with an empty, reachable-false body rather than a
 * 400: the picker asks unconditionally and reads `models` either way.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const url = new URL(req.url);
  const asked = (url.searchParams.get("base_url") || "").trim();
  const provider = taskProvider(project);
  const base = asked || provider.anthropic_base_url || provider.openai_base_url || "";
  if (!base) {
    return NextResponse.json({ base_url: "", reachable: false, api: null, models: [], error: null });
  }

  // The gateway states its own catalog (GET <gateway>/model/info) instead of
  // the Ollama/OpenAI shapes endpointModels() probes for — asking it there
  // would 404 — so this branches ahead of that probe rather than falling
  // through to it. `?agent=` says which driver's picker this is for, since
  // the gateway's fit filter differs by driver (lib/gatewayModels.ts);
  // unset/unrecognized falls back to the project's own default agent.
  //
  // Checked against `base` (what's actually being probed) rather than
  // `provider.kind`: `?base_url=` exists precisely so the picker can ask about
  // a URL that isn't saved yet, and typing the gateway's own address into a
  // project whose SAVED override is something else must still hit this
  // branch rather than 404 the Ollama/OpenAI probe against it.
  if (isGatewayEndpoint(base)) {
    const agent = fitAgentFor(url.searchParams.get("agent") || project.default_agent);
    const catalog = await gatewayModelCatalog(base, gatewayKey());
    const model_options = gatewayModelOptions(catalog.models, agent);
    return NextResponse.json({
      base_url: catalog.base_url,
      reachable: catalog.reachable,
      api: "gateway",
      models: model_options.map((m) => m.value),
      model_options,
      error: catalog.error,
    });
  }

  return NextResponse.json(await endpointModels(base));
}
