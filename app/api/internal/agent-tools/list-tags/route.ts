import { NextResponse, type NextRequest } from "next/server";
import { getProject } from "@/lib/store";
import { listTagsForAgent, resolveTargetProject } from "@/lib/agentTools";
import { logAgentToolArrival } from "@/lib/agentToolLog";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `list_tags` tool for the stdio MCP bridge
// (scripts/calandria-mcp.mjs), the same read the Claude driver serves in-process.
// Auth is the per-instance SERVICE_TOKEN (middleware.ts, isAgentToolPath).
//
// `projectId` is where the SESSION runs; the optional `project` names a
// different board to read. Resolution is shared with the in-process server and
// strict: an unrecognized `project` is a 400, never a fallback to the session's
// own. Read-only: nothing here creates a tag (that is suggest_task's `tags`,
// which resolve inside the project it files into).
export async function POST(req: NextRequest) {
  let body: { projectId?: string; project?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("list_tags", "bridge", undefined);

  const callingProject = body.projectId ? getProject(body.projectId) : undefined;
  if (!callingProject) return NextResponse.json({ error: "unknown project" }, { status: 404 });

  const target = resolveTargetProject(callingProject, body.project);
  if ("error" in target) return NextResponse.json({ error: target.error }, { status: 400 });

  return NextResponse.json({ ok: true, project: target.project.name, tags: listTagsForAgent(target.project) });
}
