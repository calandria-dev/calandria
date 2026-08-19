import { NextResponse } from "next/server";
import { getSchedule } from "@/lib/schedule/store";

export const dynamic = "force-dynamic";

// Fire now, out of band. Uses the same unattended policy as a real firing (a
// scheduled prompt must behave identically whether a human pressed the button
// or the clock did) and deliberately does NOT move the next occurrence.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getSchedule(id)) return NextResponse.json({ error: "no such schedule" }, { status: 404 });
  const { runScheduleNow } = await import("@/lib/scheduler");
  try {
    const run = await runScheduleNow(id);
    // null means the durable claim was lost — a real tick, or a second press,
    // already owns this instant. Anything else now THROWS rather than reporting
    // the same "already claimed" (see claimRun), so it lands below with the
    // actual reason instead of a 409 that sends the user looking for a run that
    // does not exist.
    if (!run) return NextResponse.json({ error: "a run is already starting for this schedule" }, { status: 409 });
    return NextResponse.json(run, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
