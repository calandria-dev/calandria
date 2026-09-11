import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { createTask, getProject, listAllTasksLite, listAllTagsLite, getTag } from "@/lib/store";
import { adoptDraftUploads, removeTaskUploads } from "@/lib/uploads";
import { attachmentKindOf, joinAttachmentText } from "@/lib/uploadTypes";

export const dynamic = "force-dynamic";

// Powers the ⌘K palette's search: every real task across all active projects,
// labeled with its project and (since tags) the features it's part of, plus
// the tags themselves, which are jumpable targets in their own right, not
// just badges. Both fetched fresh each time the palette opens.
export async function GET() {
  return NextResponse.json({ tasks: listAllTasksLite(), tags: listAllTagsLite() });
}

export async function POST(req: Request) {
  const body = await req.json();
  if (!body?.project_id || !getProject(body.project_id))
    return NextResponse.json({ error: "valid project_id required" }, { status: 400 });
  if (!body?.title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });
  // Same screen the PATCH route applies: every tag must exist and belong to
  // this task's project, since a tag can't span repositories.
  let tagIds: string[] = [];
  if (body.tag_ids !== undefined) {
    if (!Array.isArray(body.tag_ids) || body.tag_ids.some((t: unknown) => typeof t !== "string"))
      return NextResponse.json({ error: "tag_ids must be an array of tag ids" }, { status: 400 });
    tagIds = [...new Set(body.tag_ids as string[])];
    for (const id of tagIds) {
      const tag = getTag(id);
      if (!tag) return NextResponse.json({ error: "no such tag" }, { status: 400 });
      if (tag.project_id !== body.project_id)
        return NextResponse.json({ error: "tag belongs to another project. A tag can't span projects" }, { status: 400 });
    }
  }
  // Files the dialog staged through POST /api/uploads before the task had
  // an id. They move into the new task's own dir and land in the description
  // as marker lines after the brief (lib/uploadTypes.ts), the same lines a
  // chat attachment uses, so the session's context and the task header both
  // read them the way the transcript does. A path that isn't a staged draft
  // file is a 400 and nothing is created.
  if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.some((a: unknown) => typeof a !== "string")))
    return NextResponse.json({ error: "attachments must be an array of staged paths" }, { status: 400 });
  const id = nanoid();
  let description: string = typeof body.description === "string" ? body.description : "";
  if (Array.isArray(body.attachments) && body.attachments.length) {
    let staged: string[];
    try {
      staged = adoptDraftUploads(id, body.attachments);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    description = joinAttachmentText(description, staged.map((p) => ({ kind: attachmentKindOf(p), path: p })));
  }
  let task;
  try {
    task = createTask({
    id,
    project_id: body.project_id,
    title: body.title.trim(),
    description,
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
    // Settable up front for the same reason `startNow` exists: the New-task
    // dialog can launch the first turn in the same gesture, and a follow-up
    // PATCH would land after that turn already picked a model. Shape-checked
    // like the PATCH route's copy (the catalog is instance config, so content
    // stays the driver's problem) and length-capped so a runaway value can't
    // reach the CLI's argv.
    model: typeof body.model === "string" && body.model.trim() && body.model.length <= 2048 && !/[\0-\x1f\x7f]/.test(body.model)
      ? body.model.trim()
      : undefined,
    tag_ids: tagIds,
    });
  } catch (e) {
    // The files moved under the id that now has no row: reclaim them, since
    // nothing else will ever name that dir.
    removeTaskUploads(id);
    throw e;
  }
  return NextResponse.json(task, { status: 201 });
}
