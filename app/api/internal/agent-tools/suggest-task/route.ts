import { NextResponse, type NextRequest } from "next/server";
import { getProject } from "@/lib/store";
import { createSuggestedTask, resolveTargetProject } from "@/lib/agentTools";
import { publish } from "@/lib/events";
import type { Priority } from "@/lib/types";

export const dynamic = "force-dynamic";

// Internal endpoint the stdio MCP bridge (scripts/calandria-mcp.mjs) proxies the
// `suggest_task` tool call to, so non-Claude agents (Codex, future CLIs) get the
// same tool the Claude driver mounts in-process. Auth is the per-instance
// SERVICE_TOKEN, enforced in middleware.ts (isAgentToolPath). The bridge has
// already resolved any title refs in `blocked_by` to task ids.
//
// `projectId` is where the SESSION is running; the optional `project` names
// where the task should be FILED (an id or a name), which may be a different
// project entirely. Resolution is shared with the in-process server so the two
// can't drift, and is strict: an unrecognized `project` is a 400, never a quiet
// fallback to the session's own project.
export async function POST(req: NextRequest) {
  let body: {
    projectId?: string;
    taskId?: string;
    project?: string;
    title?: string;
    description?: string;
    priority?: Priority;
    blocked_by?: string[];
    tags?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const callingProject = body.projectId ? getProject(body.projectId) : undefined;
  if (!callingProject) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  if (!body.title?.trim()) return NextResponse.json({ error: "title is required" }, { status: 400 });

  const target = resolveTargetProject(callingProject, body.project);
  // 400, not 404: the request is well-formed but names a project that doesn't
  // exist. The bridge surfaces `error` as the tool's failure text, which is
  // what tells the agent to call list_projects and retry.
  if ("error" in target) return NextResponse.json({ error: target.error }, { status: 400 });

  const { task, text } = createSuggestedTask(target.project, {
    title: body.title,
    description: body.description ?? "",
    priority: body.priority,
    blocked_by: Array.isArray(body.blocked_by) ? body.blocked_by : undefined,
    // The tag refs as the model typed them — resolved (and created on a miss)
    // against the TARGET project inside createSuggestedTask, so a suggestion
    // filed into another project tags there rather than here. `taskId` is the
    // trusted caller, recorded as a new tag's origin when one is created; it is
    // never read from a model-set field.
    tags: Array.isArray(body.tags) ? body.tags : undefined,
    origin_task_id: body.taskId ?? null,
  });
  if (!task) return NextResponse.json({ error: text }, { status: 404 });

  // Announce it on the calling task's channel — the same event the Claude
  // driver yields, so GET /api/events refreshes the receiving project's tray
  // live. Without this the bridge path is silent on the bus entirely and a
  // Codex suggestion only appears after a reload. Not persisted, matching the
  // runner's handling of the driver's own `suggested` event.
  if (body.taskId) publish(body.taskId, { type: "suggested", title: task.title, projectId: target.project.id });

  return NextResponse.json({ ok: true, id: task.id, title: task.title, projectId: target.project.id, projectName: target.project.name, text });
}
