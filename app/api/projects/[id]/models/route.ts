import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { taskProvider } from "@/lib/agentEnv";
import { endpointModels } from "@/lib/modelEndpoint";

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

  const asked = (new URL(req.url).searchParams.get("base_url") || "").trim();
  const provider = taskProvider(project);
  const base = asked || provider.anthropic_base_url || provider.openai_base_url || "";
  if (!base) {
    return NextResponse.json({ base_url: "", reachable: false, api: null, models: [], error: null });
  }
  return NextResponse.json(await endpointModels(base));
}
