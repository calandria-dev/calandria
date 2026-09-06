import { NextResponse } from "next/server";
import { getProject, listPermissionRules, addPermissionRule } from "@/lib/store";
import { gatewayBaseUrl } from "@/lib/agentEnv";
import { gatewayKey } from "@/lib/litellm-key";
import { gatewayMcpCatalog, probeGatewayMcpMount } from "@/lib/gatewayMcp";
import { ruleForGatewayMcpServer } from "@/lib/permissions";
import { LITELLM_MCP } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * The gateway's hosted MCP servers, project-scoped (docs/AGENTS.md,
 * "Hosted MCP servers"): GET <gateway>/v1/mcp/server plus a tool-name preview
 * from GET <gateway>/mcp-rest/tools/list, merged with which aliases this
 * project has already trusted (a remembered `mcp_server` permission_rules
 * row) so the picker can show "Trusted" without a second round trip.
 *
 * Disabled instance-wide by CALANDRIA_LITELLM_MCP, or when no gateway is
 * configured at all: both answer the same "not enabled" shape instead of a
 * 404, since the picker asks unconditionally and reads `enabled` either way,
 * the same contract GET /api/projects/[id]/models keeps for a cloud project.
 *
 * `?probe=<alias>` runs a live mount check instead of the catalog: a JSON-RPC
 * tools/list against `<gateway>/<alias>/mcp` with the instance key. A wrong
 * key can answer HTTP 400, so probeGatewayMcpMount reads the response body
 * instead of trusting the status.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const gateway = gatewayBaseUrl();
  if (!LITELLM_MCP || !gateway) {
    return NextResponse.json({ enabled: false, base_url: gateway, reachable: false, servers: [], error: null });
  }

  const url = new URL(req.url);
  const probeAlias = (url.searchParams.get("probe") || "").trim();
  if (probeAlias) {
    const result = await probeGatewayMcpMount(gateway, probeAlias, gatewayKey());
    return NextResponse.json({ alias: probeAlias, ...result });
  }

  const catalog = await gatewayMcpCatalog(gateway, gatewayKey());
  const trusted = new Set(
    listPermissionRules(id)
      .filter((r) => r.match_kind === "mcp_server")
      .map((r) => r.value)
  );
  return NextResponse.json({
    enabled: true,
    base_url: catalog.base_url,
    reachable: catalog.reachable,
    error: catalog.error,
    servers: catalog.servers.map((s) => ({ ...s, trusted: trusted.has(s.alias) })),
  });
}

/**
 * "Trust this server": mints a remembered `mcp__<alias>__*` permission rule
 * through the same permission_rules path a Bash prefix uses
 * (lib/permissions.ts), so it shows in Settings → Run defaults and can be
 * revoked there. One-way: the picker only ever mints, matching the card's own
 * "Always allow". Revocation is Settings' job, not a second path here.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!LITELLM_MCP) return NextResponse.json({ error: "Hosted MCP servers are disabled on this instance." }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { alias?: string };
  const drafted = ruleForGatewayMcpServer(body.alias ?? "");
  if (!drafted.ok) return NextResponse.json({ error: drafted.error }, { status: 400 });
  const rule = addPermissionRule({ project_id: id, tool: drafted.tool, match_kind: drafted.match_kind, value: drafted.value });
  return NextResponse.json({ rule });
}
