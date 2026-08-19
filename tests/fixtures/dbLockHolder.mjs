// Child process for tests/dbLock.test.ts. The boot lock is a cross-PROCESS
// mutex, so the only honest way to test it is with a second real process.
//
//   node dbLockHolder.mjs <dbDir> <waitMs> <hold|exit>
//
// Prints exactly one line of JSON describing the outcome, then either stays
// alive holding the lock (`hold`, until the parent kills it) or exits cleanly
// (`exit`, exercising the release-on-exit hook).

import { acquireDbLock } from "../../lib/db-lock.mjs";

const [dir, waitMs, mode] = process.argv.slice(2);

try {
  const state = await acquireDbLock({ dir, waitMs: Number(waitMs) });
  console.log(JSON.stringify({ ok: true, mode: state.mode, pid: process.pid }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, message: String(err.message), holder: err.holder ?? null }));
  process.exit(1);
}

if (mode === "hold") {
  // Keep the event loop alive; the parent SIGKILLs or SIGTERMs us.
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
