import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Graceful-shutdown trigger. server.js's SIGTERM/SIGINT handler pings this
// over loopback (mirroring the services-restore/scheduler boot pings) BEFORE
// calling process.exit(0), so run()'s finally (lib/runner.ts) gets a bounded
// window to abort every in-flight turn and persist its interrupted state — the
// same DENIED_INTERRUPTED permission-card settlement a Stop-button press
// produces — instead of a bare exit cutting a mid-write turn off with nothing
// durable recorded.
//
// lib/runner is imported DYNAMICALLY for the reason documented on the sibling
// boot-ping routes: its module graph reaches the ESM agent-SDK externals,
// which Turbopack compiles as async modules, so a static import can read back
// undefined in the production build.
export async function POST() {
  const { drainActiveTurns } = await import("@/lib/runner");
  const result = await drainActiveTurns();
  return NextResponse.json({ ok: true, ...result });
}
