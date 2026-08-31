// The worktree half of retention (issue #15 item 2), and the disk-usage warning
// that runs whether or not it is switched on.
//
// Per-task git worktrees are the single biggest disk-growth vector in the
// product — a full checkout of the project repo per task, deliberately outside
// every repo (CALANDRIA_WORKTREES_DIR) — and until now they were reclaimed only
// by hand, through Settings → Storage. lib/retention.ts prunes the tables; this
// prunes the checkouts, on the same ticker, against the same predicate.
//
// TWO RULES ARE LOAD-BEARING, and both exist because reclaiming a worktree is
// not obviously destructive: `ensureWorktree` SELF-HEALS a missing checkout on
// the next turn, so removing the wrong one "works" — the task simply cuts a new
// worktree from the branch tip and carries on, having silently thrown away
// whatever was in the old one.
//
//   1. TERMINAL ONLY. The candidate list is prunableTaskIds() from
//      lib/retention.ts — verbatim, not a variant. That predicate is where
//      "a done task can still be live" is decided (running, awaiting a
//      permission card, snoozed, a parked follow-up, an in-flight scheduled
//      run), and a second copy of it here would be the copy that goes stale.
//      Only the CUTOFF differs: a checkout is worth reclaiming in weeks, while
//      a transcript is worth keeping for months.
//   2. NEVER OVER WORK. Every removal is gated on worktreePruneSafety()
//      (lib/git.ts) — the same read the Storage sweep and a discard-move gate
//      on. Unsafe means uncommitted edits, or commits the base branch has not
//      absorbed; either way the sweep SKIPS and reports rather than asking for
//      a stronger acknowledgement, because there is nobody here to give one.
//      The refusal is phrased in lib/taskMove.ts's words (UNSAFE_DISCARD_REASON),
//      so a log line about a skipped checkout and a refused discard-move say the
//      same thing rather than inventing a second vocabulary for one question.
//
// The task's staged CHAT ATTACHMENTS go with the checkout. Any file type can be
// attached (lib/uploads.ts), so an instance can be sitting on gigabytes of PDFs
// and log bundles that outlive every worktree they were staged for. They are
// swept here rather than in one of the other teardowns because this is the only
// one whose licence is "this task has been terminal and untouched for weeks":
// a reclaim fires the instant a PR lands, on a task the user may still be
// reading, and a project MOVE keeps the task alive with its transcript intact —
// deleting its uploads in either would break marker links under a live task.
// Hard delete and the transcript prune already cover their own cases.
//
// The branch is always KEPT (`keepBranch: true`, as the Storage sweep's safe
// path does). A worktree can be re-cut; a deleted branch takes the task's diff
// with it, and this sweep fires on a CLOCK — "cold for fourteen days" is not
// evidence that the diff is anywhere else. lib/reclaim.ts is the case where it
// is: a merged PR (or a local merge) says the work is in the base branch, and
// that reclaim does delete the local branch, optionally unattended. Same
// teardown, different licence, and the licence is the landing.
//
// Off by default, unlike the table prune. The table prune's defaults (180/400
// days) are longer than most instances have existed, so switching it on for
// everyone changes nothing today; a worktree window measured in weeks would
// start deleting checkouts on the first tick after an upgrade nobody opted into.
//
// DB + git subprocesses + fs; no runner, no SDK, no bus (pinned by
// tests/importGraph.test.ts).

import fs from "node:fs";
import {
  WORKTREES_DIR,
  WORKTREES_DISK_WARN_BYTES,
  WORKTREE_RETENTION_MS,
  WORKTREE_SWEEP_ENABLED,
  RETENTION_SWEEP_MS,
} from "@/lib/config";
import { prunableTaskIds } from "@/lib/retention";
import { clearTaskWorktreePath, getProject, getTask } from "@/lib/store";
import { removeWorktree, worktreeDiskUsage, worktreePruneSafety } from "@/lib/git";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { UNSAFE_DISCARD_REASON } from "@/lib/taskMove";
import { withTaskLock } from "@/lib/taskLock";
import { withRepoLock } from "@/lib/repoLock";
import { heldHandleHint } from "@/lib/paths";
import { hasTurn } from "@/lib/abort";
import { removeTaskUploads, taskUploadsDir } from "@/lib/uploads";

/** One reclaimed checkout. `bytes` is what it was costing before removal —
 *  the working tree plus the task's staged chat attachments, which go with it. */
export interface ReclaimedWorktree {
  taskId: string;
  bytes: number;
}

export interface WorktreeSweepResult {
  reclaimed: ReclaimedWorktree[];
  /** Candidates left alone, each with the reason — never silently dropped. */
  skipped: { taskId: string; reason: string }[];
  /** Total bytes the removed checkouts were occupying. */
  bytes: number;
}

/** Bytes as GB, one decimal — the unit these numbers are talked about in. */
const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

const EMPTY = (): WorktreeSweepResult => ({ reclaimed: [], skipped: [], bytes: 0 });

/**
 * One worktree-reclaim pass. Async and sequential, unlike the table prune: each
 * candidate costs a handful of git subprocesses, and a hundred of them at once
 * would fork an army inside the ticker's own sweep.
 *
 * Locks in the same order lib/taskMove.ts takes them — the task lock, then the
 * repo lock — so the two can only ever wait on each other in one direction. The
 * task lock is what makes the safety read mean anything: it is the lock a turn
 * launch holds through registerTurn(), so nothing can start writing into a
 * checkout between "this is clean" and `git worktree remove`.
 */
export async function sweepWorktrees(
  now = Date.now(),
  opts: { retentionMs?: number } = {}
): Promise<WorktreeSweepResult> {
  const retentionMs = opts.retentionMs ?? WORKTREE_RETENTION_MS;
  const result = EMPTY();
  // 0 turns this half off the way it does for the table windows, and a window
  // of zero would otherwise mean "reclaim every terminal task's checkout the
  // moment it is marked done".
  if (retentionMs <= 0) return result;

  for (const id of prunableTaskIds(now - retentionMs, now)) {
    // Cheap screen before taking any lock: most terminal tasks have no checkout
    // on record at all (never started, already reclaimed, merged and pruned).
    if (!getTask(id)?.worktree_path) continue;

    await withTaskLock(id, async () => {
      // Re-read under the lock — the pre-screen above raced anything that could
      // have reclaimed or re-cut this checkout in the meantime.
      const task = getTask(id);
      if (!task?.worktree_path) return;
      // The row's own flags cannot see a live turn (they are the resting state
      // after one); the abort registry can. prunableTaskIds() already excluded
      // `running`, so this is the belt to its braces.
      if (hasTurn(id)) {
        result.skipped.push({ taskId: id, reason: "a turn is currently running" });
        return;
      }
      const project = getProject(task.project_id);
      if (!project?.repo_path) {
        // A path on record with no repo to remove it from. Deleting the
        // directory anyway would mean rm-ing a tree without git's registry ever
        // confirming it is ours, which is the one thing this sweep must not do.
        result.skipped.push({ taskId: id, reason: "the project has no repo" });
        return;
      }

      await withRepoLock(project.repo_path, async () => {
        const safety = await worktreePruneSafety({
          repoPath: project.repo_path,
          worktreePath: task.worktree_path,
          workBranch: task.work_branch,
          baseBranch: resolveBaseBranch(task, project),
        });
        if (!safety.safe) {
          result.skipped.push({ taskId: id, reason: `${UNSAFE_DISCARD_REASON}: ${safety.reason}` });
          return;
        }
        const bytes = await worktreeDiskUsage(task.worktree_path);
        // keepBranch is not an option here — see the header. The branch is the
        // diff base a reopened task is read against.
        await removeWorktree(project.repo_path, task.worktree_path, task.work_branch, { keepBranch: true });
        // removeWorktree never throws, so a surviving directory is only visible
        // by looking. Leave the column pointing at it: worktree paths are keyed
        // by task id, and a row that claims no checkout while a directory sits
        // at the path the next launch wants is how a task ends up adopting a
        // stale tree.
        if (fs.existsSync(task.worktree_path)) {
          result.skipped.push({
            taskId: id,
            reason: `the worktree directory could not be removed${heldHandleHint()}`,
          });
          return;
        }
        clearTaskWorktreePath(id);
        // Best-effort and after the checkout is confirmed gone, so a skipped
        // worktree never loses its attachments (see the header).
        const uploadBytes = await worktreeDiskUsage(taskUploadsDir(id));
        const total = bytes + (removeTaskUploads(id) ? uploadBytes : 0);
        result.reclaimed.push({ taskId: id, bytes: total });
        result.bytes += total;
      });
    });
  }
  return result;
}

/** Apparent size of the whole worktrees directory, or 0 if it isn't there. */
export async function worktreesDiskUsage(): Promise<number> {
  return worktreeDiskUsage(WORKTREES_DIR);
}

interface WorktreeSweepState {
  /** When the last reclaim pass finished; the ticker's interval is not the cadence. */
  lastSweepAt: number;
  /** When the disk was last measured, and what it said. */
  diskCheckedAt: number;
  diskBytes: number;
  /** What the last pass reclaimed and refused, for the health payload. */
  lastReclaimed: number;
  lastBytes: number;
  lastSkipped: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaWorktreeSweep: WorktreeSweepState | undefined;
}

const state = (): WorktreeSweepState =>
  (global.__calandriaWorktreeSweep ??= {
    lastSweepAt: 0,
    diskCheckedAt: 0,
    diskBytes: 0,
    lastReclaimed: 0,
    lastBytes: 0,
    lastSkipped: 0,
  });

/**
 * The disk-usage measurement, and the warning when it crosses the threshold.
 *
 * Deliberately independent of the sweep: the instance that has NOT opted into
 * automatic reclaim is exactly the one that needs telling its worktrees are
 * eating the volume, since the only fix is a human opening Settings → Storage.
 *
 * Measured after any sweep in the same tick, so the number reported is the one
 * that is true now rather than the one that justified the sweep.
 */
export async function checkWorktreeDisk(now = Date.now()): Promise<number> {
  const s = state();
  const bytes = await worktreesDiskUsage();
  s.diskBytes = bytes;
  s.diskCheckedAt = now;
  if (WORKTREES_DISK_WARN_BYTES > 0 && bytes >= WORKTREES_DISK_WARN_BYTES) {
    // Repeated every pass while it is over, not once per crossing: a warning
    // that fires once and then goes quiet is one nobody sees, and at the sweep
    // cadence (6h by default) this is four lines a day, not a flood.
    console.warn(
      `[worktrees] ${WORKTREES_DIR} is using ${gb(bytes)} GB, over the ` +
        `${gb(WORKTREES_DISK_WARN_BYTES)} GB warning threshold ` +
        `(CALANDRIA_WORKTREES_DISK_WARN_GB). Reclaim finished tasks' checkouts in ` +
        `Settings → Storage, or set CALANDRIA_WORKTREE_RETENTION=on to sweep them ` +
        `automatically.`
    );
  }
  return bytes;
}

/** What the ticker's health payload reports about the worktrees on disk. */
export const worktreeSweepHealth = () => {
  const s = state();
  return {
    enabled: WORKTREE_SWEEP_ENABLED,
    retentionMs: WORKTREE_RETENTION_MS,
    lastSweepAt: s.lastSweepAt,
    lastReclaimed: s.lastReclaimed,
    lastReclaimedBytes: s.lastBytes,
    lastSkipped: s.lastSkipped,
    // 0/0 when the warning is switched off: nothing measures on this clock
    // then. The Settings panel reads the directory directly either way.
    diskBytes: s.diskBytes,
    diskCheckedAt: s.diskCheckedAt,
    diskWarnBytes: WORKTREES_DISK_WARN_BYTES,
    diskOverThreshold: WORKTREES_DISK_WARN_BYTES > 0 && s.diskBytes >= WORKTREES_DISK_WARN_BYTES,
  };
};

/**
 * The ticker's entry point, mirroring maybeSweepRetention(): its own clock (the
 * retention cadence, since both are policies measured in days), returning null
 * when it isn't due.
 *
 * The DISK CHECK runs on the same clock but not the same switch — with the
 * sweep off, this degrades to "measure and warn", which is item 2 of the issue.
 */
export async function maybeSweepWorktrees(now = Date.now()): Promise<WorktreeSweepResult | null> {
  const s = state();
  if (now - s.lastSweepAt < RETENTION_SWEEP_MS) return null;
  s.lastSweepAt = now;

  let result: WorktreeSweepResult | null = null;
  if (WORKTREE_SWEEP_ENABLED) {
    result = await sweepWorktrees(now);
    s.lastReclaimed = result.reclaimed.length;
    s.lastBytes = result.bytes;
    s.lastSkipped = result.skipped.length;
    if (result.reclaimed.length > 0) {
      console.log(
        `[worktrees] reclaimed ${result.reclaimed.length} worktree` +
          `${result.reclaimed.length === 1 ? "" : "s"} (${gb(result.bytes)} GB)`
      );
    }
    // Every refusal is named. A sweep that silently declines the same three
    // checkouts every six hours reads as "there is nothing to reclaim", when
    // what it means is "three tasks have work nobody has landed".
    for (const skip of result.skipped) {
      console.log(`[worktrees] kept ${skip.taskId}: ${skip.reason}`);
    }
  }

  // Skipped entirely when the threshold is off — this is a `du` over every
  // checkout on the box, and there is nothing to compare it against. Settings →
  // Storage measures on demand regardless, so turning the warning off costs the
  // panel nothing.
  if (WORKTREES_DISK_WARN_BYTES > 0) await checkWorktreeDisk(Date.now());
  return result;
}
