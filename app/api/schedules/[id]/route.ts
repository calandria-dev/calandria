import { NextResponse } from "next/server";
import { deleteSchedule, getSchedule, listRuns, updateSchedule } from "@/lib/schedule/store";
import { getRunbook } from "@/lib/runbooks/store";
import type { Priority } from "@/lib/types";

export const dynamic = "force-dynamic";

const PRIORITIES: Priority[] = ["hi", "med", "lo"];

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const schedule = getSchedule(id);
  if (!schedule) return NextResponse.json({ error: "no such schedule" }, { status: 404 });
  return NextResponse.json({ schedule, runs: listRuns(id, 20) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const schedule = getSchedule(id);
  if (!schedule) return NextResponse.json({ error: "no such schedule" }, { status: 404 });
  const body = await req.json();
  // Unlike the fields copied below, priority has a fixed legal set and no
  // CHECK constraint behind it, so a bad value needs to be refused here.
  if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) {
    return NextResponse.json({ error: `priority must be one of: ${PRIORITIES.join(", ")}` }, { status: 400 });
  }
  const fields: Record<string, unknown> = {};
  for (const k of ["name", "prompt", "days_mask", "time_of_day", "timezone", "agent", "permission_mode", "priority", "catch_up_ms"]) {
    if (body[k] !== undefined) fields[k] = body[k];
  }
  // Pause/resume. Resuming recomputes from NOW, so unpausing a schedule parked
  // for a month doesn't greet the user with a month of missed occurrences.
  if (body.enabled !== undefined) fields.enabled = body.enabled ? 1 : 0;
  if (body.send_context !== undefined) fields.send_context = body.send_context ? 1 : 0;
  // Link or unlink the runbook this schedule fires. Compared against the
  // SCHEDULE's project, not a path id — see the POST route's note on why a
  // cross-project link is refused rather than resolved.
  if (body.runbook_id !== undefined) {
    if (body.runbook_id === null || body.runbook_id === "") {
      fields.runbook_id = null;
    } else if (typeof body.runbook_id !== "string") {
      return NextResponse.json({ error: "runbook_id must be a string or null" }, { status: 400 });
    } else {
      const rb = getRunbook(body.runbook_id);
      if (!rb) return NextResponse.json({ error: "no such runbook" }, { status: 400 });
      if (rb.project_id !== schedule.project_id) {
        return NextResponse.json({ error: "that runbook belongs to a different project" }, { status: 400 });
      }
      fields.runbook_id = body.runbook_id;
    }
  }
  try {
    const schedule = updateSchedule(id, fields);
    return NextResponse.json(schedule);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Hard delete, like everything else here. The tasks it minted survive
  // (tasks.schedule_id is ON DELETE SET NULL) — deleting the schedule must not
  // delete the work it produced.
  deleteSchedule(id);
  return NextResponse.json({ ok: true });
}
