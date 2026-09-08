import { NextResponse, type NextRequest } from "next/server";
import { getProject } from "@/lib/store";
import { createSuggestedTask, resolveTargetProject } from "@/lib/agentTools";
import { publish } from "@/lib/events";
import { attachSuggestionToCall } from "@/lib/suggestionCard";
import { logAgentToolArrival } from "@/lib/agentToolLog";
import type { Priority } from "@/lib/types";

export const dynamic = "force-dynamic";

// Internal endpoint the stdio MCP bridge (scripts/calandria-mcp.mjs)
// proxies the `suggest_task` tool call to, so non-Claude agents (Codex,
// future CLIs) get the same tool the Claude driver mounts in-process. Auth
// is the per-instance SERVICE_TOKEN, enforced in middleware.ts
// (isAgentToolPath). The bridge has already resolved any title refs in
// `blocked_by` to task ids.
//
// `projectId` is where the session is running; the optional `project`
// names where the task should be filed (an id or a name), which may be a
// different project entirely. Resolution is shared with the in-process
// server so the two can't drift, and is strict: an unrecognized `project`
// is a 400, never a fallback to the session's own project.
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
    provider?: "local" | "cloud";
    model?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("suggest_task", "bridge", body.taskId);

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
    // The tag refs as the model typed them, resolved (and created on a
    // miss) against the target project inside createSuggestedTask, so a
    // suggestion filed into another project tags there instead of here.
    // `taskId` is the trusted caller, recorded as a new tag's origin when
    // one is created; it is never read from a model-set field.
    tags: Array.isArray(body.tags) ? body.tags : undefined,
    origin_task_id: body.taskId ?? null,
    provider: body.provider === "local" || body.provider === "cloud" ? body.provider : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
  });
  if (!task) return NextResponse.json({ error: text }, { status: 404 });

  // Two things happen on the calling task's channel, and only if the
  // calling task is known.
  //
  // First the transcript card: the runner settles one onto the
  // suggest_task tool row for a driver whose suggestions ride its event
  // stream, but this endpoint is reached out-of-band by a Codex session's
  // MCP client and never passes through that loop, so the row is found and
  // patched here instead (see lib/suggestionCard.ts for why
  // newest-unclaimed-first is the correlation). A miss is fine: the call
  // hasn't streamed its tool row yet, or this driver reports no tool name,
  // and the suggestion just lives in the tray.
  //
  // Then the event itself, the same one the Claude driver yields, so GET
  // /api/events refreshes the receiving project's tray live. Without it the
  // bridge path is silent on the bus entirely and a Codex suggestion only
  // appears after a reload. `msgId` rides along so an open transcript
  // patches the card in without refetching.
  if (body.taskId) {
    const msgId = attachSuggestionToCall(body.taskId, { taskId: task.id, projectId: target.project.id });
    publish(body.taskId, {
      type: "suggested",
      title: task.title,
      projectId: target.project.id,
      taskId: task.id,
      ...(msgId ? { msgId } : {}),
    });
  }

  return NextResponse.json({ ok: true, id: task.id, title: task.title, projectId: target.project.id, projectName: target.project.name, text });
}
