import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Boot trigger for the persisted service registry. server.js pings this over
// loopback right after listen (with the service token, mirroring the health
// probes) so managed services with desired_state='running' restart with the
// server, not only on the first user request. Idempotent: restoreServices()
// runs once per process, so re-hitting this (or a user beating the ping) is
// safe. An instrumentation.ts hook would be the idiomatic home, but Turbopack
// dev tries to bundle better-sqlite3 into its edge variant and breaks the app.
//
// lib/services is imported dynamically because its module graph reaches the
// ESM agent-SDK externals, which Turbopack compiles as an async module, so a
// static import can read back undefined in the production build (a 500 on
// every boot ping). `await import()` waits for the module to finish
// initializing.
export async function POST() {
  const { restoreServices } = await import("@/lib/services");
  await restoreServices();
  return NextResponse.json({ ok: true });
}
