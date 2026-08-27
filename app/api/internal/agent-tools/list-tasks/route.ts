import { NextResponse, type NextRequest } from "next/server";
import { getProject } from "@/lib/store";
import { listTasksForAgent, resolveTagRefs, resolveTargetProject } from "@/lib/agentTools";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `list_tasks` tool for the stdio MCP bridge
// (scripts/calandria-mcp.mjs) — the same board the Claude driver serves in-process.
// Auth is the per-instance SERVICE_TOKEN (middleware.ts, isAgentToolPath).
//
// `projectId` is where the SESSION runs; the optional `project` names a
// different board to read. Resolution is shared with the in-process server, and
// strict — an unrecognized `project` is a 400, never a quiet fallback to the
// session's own. `taskId` only decides which row comes back flagged `current`.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; taskId?: string; project?: string; include_done?: boolean; tag?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const callingProject = body.projectId ? getProject(body.projectId) : undefined;
  if (!callingProject) return NextResponse.json({ error: "unknown project" }, { status: 404 });

  const target = resolveTargetProject(callingProject, body.project);
  if ("error" in target) return NextResponse.json({ error: target.error }, { status: 400 });

  // The tag filter is resolved the same strict way, in the target project: a
  // ref nobody recognizes must not quietly hand back the whole board as if that
  // were the feature's membership. Never creates — this is a read.
  const tag = resolveTagRefs(target.project, typeof body.tag === "string" && body.tag ? [body.tag] : []);
  if ("error" in tag) return NextResponse.json({ error: `Could not list tasks: ${tag.error}.` }, { status: 400 });

  return NextResponse.json({
    ok: true,
    project: target.project.name,
    tasks: listTasksForAgent(target.project, body.taskId ?? "", body.include_done === true, tag.tags[0]?.id ?? null),
  });
}
