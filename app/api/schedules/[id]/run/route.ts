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
  const run = await runScheduleNow(id);
  if (!run) return NextResponse.json({ error: "a run is already starting for this schedule" }, { status: 409 });
  return NextResponse.json(run, { status: 201 });
}
