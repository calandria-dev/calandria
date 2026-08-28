import { NextResponse } from "next/server";
import { ensureNotifier } from "@/lib/notifications/dispatcher";
import { startPrPolling } from "@/lib/prState";

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
  // The notification bus subscriber rides the same boot ping: Web Push has to
  // reach a phone when NO tab is open, and until now the subscriber was only
  // attached by the first GET /api/events — i.e. by a tab. Idempotent too.
  ensureNotifier();
  const { startScheduler, schedulerHealth } = await import("@/lib/scheduler");
  startScheduler();
  // The queued-start sweep (lib/deferredStart.ts) rides the same ping: a task
  // queued for the 3am usage reset has to launch with the SERVER, no tab open.
  // Not gated by CALANDRIA_SCHEDULER — it isn't a schedule.
  const { startDeferredStartTicker } = await import("@/lib/deferredStart");
  startDeferredStartTicker();
  // The PR-state sweep rides the same ping so an instance that restarts with
  // open PRs starts watching them again without waiting for someone to open a
  // task. Statically imported, unlike the two above: lib/prState.ts is
  // SDK-free (PINNED), so there is no async-module hazard to dodge. It starts
  // nothing when no task has an open PR.
  startPrPolling();
  return NextResponse.json({ ok: true, ...schedulerHealth() });
}

export async function GET() {
  const { schedulerHealth } = await import("@/lib/scheduler");
  return NextResponse.json(schedulerHealth());
}
