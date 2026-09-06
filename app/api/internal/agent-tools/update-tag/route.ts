import { NextResponse, type NextRequest } from "next/server";
import { getProject } from "@/lib/store";
import { updateTagForAgent } from "@/lib/agentTools";
import { logAgentToolArrival } from "@/lib/agentToolLog";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `update_tag` tool for the stdio MCP bridge
// (scripts/calandria-mcp.mjs), the same write the Claude driver mounts
// in-process. Auth is the per-instance SERVICE_TOKEN (middleware.ts,
// isAgentToolPath).
//
// `projectId` is where the SESSION runs. Unlike the other tools there is no
// `project` override: a tag never spans repositories, so the ref is resolved
// inside the caller's own project and nothing the model sends can point it
// elsewhere. Membership is not handled here either; that's `update_task`'s
// `tags`.
//
// All of the policy (strict id-or-exact-name resolution, the rename conflict,
// the branch-name check, "" clearing the default) is in updateTagForAgent,
// shared with the in-process server so the two cannot drift.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; tag?: string; name?: string; description?: string; color?: string; base_branch?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("update_tag", "bridge", undefined);

  const project = body.projectId ? getProject(body.projectId) : undefined;
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });

  const { tag, text } = updateTagForAgent(project, body.tag ?? "", {
    // Only a real string is forwarded for each: `undefined` means "leave this
    // field alone" and "" is a meaningful value for two of them (clear the
    // colour, clear the base branch), so a malformed value must not arrive as
    // the second one.
    name: typeof body.name === "string" ? body.name : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    color: typeof body.color === "string" ? body.color : undefined,
    base_branch: typeof body.base_branch === "string" ? body.base_branch : undefined,
  });
  if (!tag) return NextResponse.json({ error: text }, { status: 400 });
  return NextResponse.json({ ok: true, id: tag.id, name: tag.name, base_branch: tag.base_branch, text });
}
