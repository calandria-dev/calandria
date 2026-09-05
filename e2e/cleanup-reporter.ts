// Removes the hermetic run root (e2e/env.ts), but only when the suite went
// green.
//
// The root holds the SQLite DB, every task worktree, the cloned/seeded fixture
// repos and whatever the app wrote during the run, and it is exactly the
// evidence needed when a spec fails: the transcript rows, the worktree the
// diff was read from, the branch a merge left behind. A red run keeps it and
// prints where it is; a green one leaves nothing, since the root exists for
// post-mortem and a passing run has no post-mortem.
//
// **Why a reporter and not `globalTeardown`.** Playwright runs global teardown
// as part of the task list, and the task list tears down in reverse order:
// globalSetup's cleanup, then globalTeardown, then the *plugins*, which is
// where the `webServer` is stopped. A `globalTeardown` therefore deletes the
// tree while `npm start` is still running it: the app is still writing to the
// DB, and on Windows the open SQLite handle refuses the unlink outright.
// `finishTaskRun()` runs the reporters only after every task has torn down, so
// they are the only hooks that see a stopped server and the run's status,
// which `globalTeardown` is not given at all.
//
// The work is split across the two of them. `onEnd` is where the status
// arrives, but it is not reliably last: the list reporter prints its whole
// epilogue (the failure detail and the `1 failed` line) from its own `onEnd`,
// and being second in `reporter: []` does not run this after it. `onExit` is
// called for every reporter only after every `onEnd` has resolved, so that is
// where the path gets printed and the tree removed, putting the line the
// developer needs under the failures it belongs to.
//
// Escape hatches: `CALANDRIA_E2E_KEEP_ROOT=1` keeps a green run's root too, and
// exporting `CALANDRIA_E2E_ROOT` yourself means you own that directory and this
// never touches it.

import fs from "node:fs";
import type { FullResult, Reporter } from "@playwright/test/reporter";
import { E2E_ROOT, E2E_ROOT_OWNED } from "./env";

export default class CleanupReporter implements Reporter {
  private status: FullResult["status"] = "failed";

  onEnd(result: FullResult): void {
    this.status = result.status;
  }

  async onExit(): Promise<void> {
    if (!E2E_ROOT_OWNED) return; // a root the developer named is theirs to delete
    if (process.env.CALANDRIA_E2E_KEEP_ROOT === "1") {
      console.log(`\n[e2e] run root kept (CALANDRIA_E2E_KEEP_ROOT=1): ${E2E_ROOT}`);
      return;
    }
    if (this.status !== "passed") {
      // Also the path taken when `onEnd` never ran at all (the field's initial
      // value): a run that died before reporting is the last one whose
      // evidence should be thrown away.
      console.log(`\n[e2e] run root kept for post-mortem (${this.status}): ${E2E_ROOT}`);
      return;
    }
    try {
      // Same shape as tests/setup.ts's teardown, for the same reason: POSIX
      // lets an open file be unlinked and disappear, Windows refuses with
      // EBUSY/EPERM/ENOTEMPTY while any handle is open. Playwright's webServer
      // teardown has already killed the `npm start` process tree, so what is
      // left is the transient kind (a Defender scan of a freshly written
      // worktree, an indexer), which is what Node's retry covers. A residual
      // failure must not red a green suite: the directory is under the temp
      // dir, so it is reported.
      fs.rmSync(E2E_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (err) {
      console.warn(`[e2e] could not remove ${E2E_ROOT}:`, err);
    }
  }
}
