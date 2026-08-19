import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Boot trigger for the schedule ticker. server.js pings this over loopback
// right after listen (with the service token, mirroring the health probes and
// the services restore) so schedules fire with the SERVER, not with a browser —
// the whole point is a run at 08:30 with nobody logged in.
//
// Idempotent: startScheduler() is guarded on globalThis, so re-pinging (or a
// user request beating the ping) is safe.
//
// Deliberately its OWN route rather than folded into
// /api/instance/services-restore: that route is PINNED SDK-free by
// tests/importGraph.test.ts, whose walker follows dynamic import() too, and the
// scheduler reaches lib/runner.ts and therefore both agent SDKs. An
// instrumentation.ts hook would be the idiomatic home and breaks Turbopack dev
// on better-sqlite3, same as documented on the services-restore route.
//
// lib/scheduler is imported DYNAMICALLY for the reason spelled out on that
// route: its graph reaches the ESM agent-SDK externals, which Turbopack
// compiles as async modules, and a static namespace import can be read back
// before the async factory resolves.
export async function POST() {
  const { startScheduler, schedulerHealth } = await import("@/lib/scheduler");
  startScheduler();
  return NextResponse.json({ ok: true, ...schedulerHealth() });
}

export async function GET() {
  const { schedulerHealth } = await import("@/lib/scheduler");
  return NextResponse.json(schedulerHealth());
}
