import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { publishGlobal } from "@/lib/events";
import { createRunbook, lastRunOf, listRunbooks, schedulesUsing } from "@/lib/runbooks/store";
import type { Priority } from "@/lib/types";

export const dynamic = "force-dynamic";

const PRIORITIES: Priority[] = ["hi", "med", "lo"];

/** Each runbook with the two facts the card needs beyond its own row. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "no such project" }, { status: 404 });
  const runbooks = listRunbooks(id).map((r) => {
    const last = lastRunOf(r.id);
    return {
      ...r,
      // Not the whole task — the card shows when it last ran and links to it.
      last_run: last ? { id: last.id, title: last.title, status: last.status, created_at: last.created_at } : null,
      // Naming the schedules is the point: "editing this changes what fires at
      // 08:30" is only actionable if you know which 08:30.
      used_by: schedulesUsing(r.id),
    };
  });
  return NextResponse.json({ runbooks });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "no such project" }, { status: 404 });
  const body = await req.json();
  // Type-checked, not just optional-chained: `body?.name?.trim()` only guards
  // nullish values, so a non-string name would sail past it into .trim() and
  // turn a 400 into an unhandled 500. Same shape as the schedules POST.
  if (typeof body?.name !== "string" || !body.name.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (typeof body?.prompt !== "string" || !body.prompt.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 });
  // Unlike permission_mode above, priority has no "unrecognized degrades to
  // the default" resolver behind it and no CHECK constraint — refuse it here.
  if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) {
    return NextResponse.json({ error: `priority must be one of: ${PRIORITIES.join(", ")}` }, { status: 400 });
  }
  const runbook = createRunbook({
    project_id: id,
    name: body.name.trim(),
    description: typeof body.description === "string" ? body.description : "",
    prompt: body.prompt,
    agent: typeof body.agent === "string" ? body.agent : undefined,
    // Unvalidated like the task routes' copy: the driver resolves anything it
    // doesn't recognize (permissionModeFor), so a stale or cross-agent value
    // degrades to the default instead of 400ing.
    permission_mode: typeof body.permission_mode === "string" ? body.permission_mode : undefined,
    send_context: typeof body.send_context === "boolean" ? body.send_context : undefined,
    priority: body.priority,
  });
  // "" because no task published this — see the runbooks_changed note in lib/events.ts.
  publishGlobal("", { type: "runbooks_changed", projectId: id });
  return NextResponse.json(runbook, { status: 201 });
}
