import { NextResponse, type NextRequest } from "next/server";
import { getProject } from "@/lib/store";
import { listGroupsForAgent, resolveTargetProject } from "@/lib/agentTools";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `list_groups` tool for the stdio MCP bridge
// (scripts/orch-mcp.mjs) — the same read the Claude driver serves in-process.
// Auth is the per-instance SERVICE_TOKEN (middleware.ts, isAgentToolPath).
//
// `projectId` is where the SESSION runs; the optional `project` names a
// different board to read. Resolution is shared with the in-process server and
// strict — an unrecognized `project` is a 400, never a quiet fallback to the
// session's own. Read-only: nothing here creates a group (that is
// suggest_task's `group`, which resolves inside the project it files into).
export async function POST(req: NextRequest) {
  let body: { projectId?: string; project?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const callingProject = body.projectId ? getProject(body.projectId) : undefined;
  if (!callingProject) return NextResponse.json({ error: "unknown project" }, { status: 404 });

  const target = resolveTargetProject(callingProject, body.project);
  if ("error" in target) return NextResponse.json({ error: target.error }, { status: 400 });

  return NextResponse.json({ ok: true, project: target.project.name, groups: listGroupsForAgent(target.project) });
}
