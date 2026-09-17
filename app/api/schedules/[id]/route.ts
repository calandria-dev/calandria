import { NextResponse } from "next/server";
import { deleteSchedule, getSchedule, listRuns, updateSchedule } from "@/lib/schedule/store";
import { getRunbook } from "@/lib/runbooks/store";
import { getProvider } from "@/lib/providers/store";
import { PRIORITIES } from "@/lib/types";

export const dynamic = "force-dynamic";

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
  // Same screen as the task routes': a provider must exist, and model is a
  // shape check only (provider-native ids and inference-profile ARNs are the
  // driver's business); a control character would reach a spawned process.
  if ("provider_id" in body && body.provider_id !== null && (typeof body.provider_id !== "string" || !getProvider(body.provider_id)))
    return NextResponse.json({ error: "valid provider_id required" }, { status: 400 });
  if ("model" in body && body.model !== null) {
    if (typeof body.model !== "string") return NextResponse.json({ error: "model must be a string or null" }, { status: 400 });
    if (body.model.length > 2048 || /[\0-\x1f\x7f]/.test(body.model))
      return NextResponse.json({ error: "invalid model id" }, { status: 400 });
  }
  const fields: Record<string, unknown> = {};
  // once_date rides the same copy loop: '' switches a schedule back to weekly,
  // 'YYYY-MM-DD' makes it one-time, and updateSchedule validates the merged
  // spec before anything is written.
  for (const k of ["name", "prompt", "days_mask", "time_of_day", "timezone", "agent", "permission_mode", "priority", "catch_up_ms", "once_date", "provider_id"]) {
    if (body[k] !== undefined) fields[k] = body[k];
  }
  if (body.model !== undefined) fields.model = typeof body.model === "string" ? (body.model.trim() || null) : null;
  // Pause/resume. Resuming recomputes from NOW, so unpausing a schedule parked
  // for a month does not surface a month of missed occurrences.
  if (body.enabled !== undefined) fields.enabled = body.enabled ? 1 : 0;
  if (fields.once_date !== undefined && typeof fields.once_date !== "string") {
    return NextResponse.json({ error: "once_date must be 'YYYY-MM-DD' or ''" }, { status: 400 });
  }
  if (body.send_context !== undefined) fields.send_context = body.send_context ? 1 : 0;
  // Link or unlink the runbook this schedule fires, compared against the
  // SCHEDULE's project. See the POST route's note on why a cross-project link
  // is refused.
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
  // Hard delete. The tasks it minted survive (tasks.schedule_id is ON DELETE
  // SET NULL); deleting the schedule must not delete the work it produced.
  deleteSchedule(id);
  return NextResponse.json({ ok: true });
}
