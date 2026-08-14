import { NextResponse } from "next/server";
import { deleteSchedule, getSchedule, listRuns, updateSchedule } from "@/lib/schedule/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const schedule = getSchedule(id);
  if (!schedule) return NextResponse.json({ error: "no such schedule" }, { status: 404 });
  return NextResponse.json({ schedule, runs: listRuns(id, 20) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getSchedule(id)) return NextResponse.json({ error: "no such schedule" }, { status: 404 });
  const body = await req.json();
  const fields: Record<string, unknown> = {};
  for (const k of ["name", "prompt", "days_mask", "time_of_day", "timezone", "agent", "permission_mode", "priority", "catch_up_ms"]) {
    if (body[k] !== undefined) fields[k] = body[k];
  }
  // Pause/resume. Resuming recomputes from NOW, so unpausing a schedule parked
  // for a month doesn't greet the user with a month of missed occurrences.
  if (body.enabled !== undefined) fields.enabled = body.enabled ? 1 : 0;
  if (body.send_context !== undefined) fields.send_context = body.send_context ? 1 : 0;
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
