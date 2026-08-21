import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { activeRun, createSchedule, lastRun, listRuns, listSchedules } from "@/lib/schedule/store";
import { getRunbook } from "@/lib/runbooks/store";
import { PRIORITIES } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Each schedule with the history the landing card needs to be trustworthy. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "no such project" }, { status: 404 });
  // Lazily start the ticker: a dev boot that missed the self-ping still works.
  const { startScheduler, schedulerHealth } = await import("@/lib/scheduler");
  startScheduler();
  // `runs` is a 5-row history window (scheduled_for DESC) — after enough skips
  // pile up on top of it, the actually-running row that's blocking them falls
  // out of that window entirely. The client's Stop control needs the live run
  // named explicitly rather than found by scanning a truncated list.
  const schedules = listSchedules(id).map((s) => ({ ...s, last_run: lastRun(s.id), runs: listRuns(s.id, 5), active_run: activeRun(s.id) }));
  return NextResponse.json({ schedules, scheduler: schedulerHealth() });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "no such project" }, { status: 404 });
  const body = await req.json();
  // Type-checked, not just optional-chained: `body?.name?.trim()` only guards
  // nullish values, so a non-string `name` (e.g. a number from a malformed
  // client) would sail past it into `.trim()` and throw OUTSIDE this function's
  // try/catch below, turning a 400 into an unhandled 500.
  if (typeof body?.name !== "string" || !body.name.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (typeof body?.prompt !== "string" || !body.prompt.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 });
  // Both objects are project-scoped, so a cross-project link would fire the
  // wrong repo's recipe under this schedule's name. Refused at save time as
  // well as at fire time (resolveScheduleRecipe) — a 400 now beats a red run
  // tomorrow morning that nobody is awake to read.
  if (body.runbook_id !== undefined && body.runbook_id !== null) {
    if (typeof body.runbook_id !== "string") return NextResponse.json({ error: "runbook_id must be a string or null" }, { status: 400 });
    const rb = getRunbook(body.runbook_id);
    if (!rb) return NextResponse.json({ error: "no such runbook" }, { status: 400 });
    if (rb.project_id !== id) return NextResponse.json({ error: "that runbook belongs to a different project" }, { status: 400 });
  }
  // Every other field here is validated before use; priority wasn't, and the
  // column has no CHECK constraint to catch a bad value at the DB layer.
  if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) {
    return NextResponse.json({ error: `priority must be one of: ${PRIORITIES.join(", ")}` }, { status: 400 });
  }
  try {
    // createSchedule computes next_fire_at and throws on an unusable spec — a
    // 400 now beats a schedule that silently never fires.
    const schedule = createSchedule({
      project_id: id,
      name: String(body.name).trim(),
      prompt: String(body.prompt),
      days_mask: Number(body.days_mask),
      time_of_day: String(body.time_of_day),
      timezone: String(body.timezone),
      agent: typeof body.agent === "string" ? body.agent : undefined,
      permission_mode: typeof body.permission_mode === "string" ? body.permission_mode : undefined,
      send_context: typeof body.send_context === "boolean" ? body.send_context : undefined,
      priority: body.priority,
      catch_up_ms: typeof body.catch_up_ms === "number" ? body.catch_up_ms : undefined,
      runbook_id: typeof body.runbook_id === "string" ? body.runbook_id : null,
    });
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
    return NextResponse.json(schedule, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
