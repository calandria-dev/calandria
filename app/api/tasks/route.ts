import { NextResponse } from "next/server";
import { createTask, getProject, listAllTasksLite } from "@/lib/store";

export const dynamic = "force-dynamic";

// Powers the ⌘K palette's session search: every real task across all active
// projects, labeled with its project. Fetched fresh each time the palette opens.
export async function GET() {
  return NextResponse.json({ tasks: listAllTasksLite() });
}

export async function POST(req: Request) {
  const body = await req.json();
  if (!body?.project_id || !getProject(body.project_id))
    return NextResponse.json({ error: "valid project_id required" }, { status: 400 });
  if (!body?.title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });
  const task = createTask({
    project_id: body.project_id,
    title: body.title.trim(),
    description: body.description ?? "",
    priority: body.priority ?? "med",
    suggested: !!body.suggested,
    // Agent is chosen at creation and fixed for the task's life (sessions can't
    // migrate between CLIs); createTask falls back to the project default.
    agent: typeof body.agent === "string" ? body.agent : undefined,
    // Whether sessions get the saved project context; falls back to the
    // project's send_context setting when omitted.
    send_context: typeof body.send_context === "boolean" ? body.send_context : undefined,
    // Settable up front so a task created to run UNATTENDED can be pinned to a
    // mode that won't stop to ask. Unvalidated like the PATCH route's copy: the
    // driver resolves anything it doesn't recognize (permissionModeFor), so a
    // stale or cross-agent value degrades to the default instead of 400ing.
    permission_mode: typeof body.permission_mode === "string" ? body.permission_mode : undefined,
  });
  return NextResponse.json(task, { status: 201 });
}
