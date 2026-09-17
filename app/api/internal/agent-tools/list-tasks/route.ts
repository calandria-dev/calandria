import { NextResponse, type NextRequest } from "next/server";
import { getProject } from "@/lib/store";
import { listTasksForAgent, resolveTagRefs, resolveTargetProject } from "@/lib/agentTools";
import { logAgentToolArrival } from "@/lib/agentToolLog";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `list_tasks` tool for the stdio MCP bridge
// (scripts/calandria-mcp.mjs), the same board the Claude driver serves in-process.
// Auth is the per-instance SERVICE_TOKEN (middleware.ts, isAgentToolPath).
//
// `projectId` is where the SESSION runs; the optional `project` names a
// different board to read. Resolution is shared with the in-process server and
// strict: an unrecognized `project` is a 400, never a fallback to the session's
// own. `taskId` only decides which row comes back flagged `current`.
export async function POST(req: NextRequest) {
  let body: {
    projectId?: string;
    taskId?: string;
    project?: string;
    include_done?: boolean;
    tags?: string[];
    match?: "any" | "all";
  };
  try {
    const raw: unknown = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "invalid request body" }, { status: 400 });
    }
    body = raw as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string"))) {
    return NextResponse.json({ error: "tags must be an array of strings" }, { status: 400 });
  }
  if (body.match !== undefined && body.match !== "any" && body.match !== "all") {
    return NextResponse.json({ error: "match must be \"any\" or \"all\"" }, { status: 400 });
  }
  logAgentToolArrival("list_tasks", "bridge", body.taskId);

  const callingProject = body.projectId ? getProject(body.projectId) : undefined;
  if (!callingProject) return NextResponse.json({ error: "unknown project" }, { status: 404 });

  const target = resolveTargetProject(callingProject, body.project);
  if ("error" in target) return NextResponse.json({ error: target.error }, { status: 400 });

  // The tag filter is resolved the same strict way, in the target project: a
  // ref nobody recognizes must not hand back the whole board as if that were
  // the feature's membership. This is read-only and never creates a tag.
  const tagRefs = resolveTagRefs(target.project, body.tags ?? []);
  if ("error" in tagRefs) return NextResponse.json({ error: `Could not list tasks: ${tagRefs.error}.` }, { status: 400 });

  return NextResponse.json({
    ok: true,
    project: target.project.name,
    tasks: listTasksForAgent(
      target.project,
      body.taskId ?? "",
      body.include_done === true,
      { ids: tagRefs.tags.map((tag) => tag.id), match: body.match ?? "any" },
    ),
  });
}
