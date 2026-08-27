// Opt-in pipeline auto-start.
//
// A blocked task never starts on its own — deliberately — unless the user set
// its `auto_start` flag ("Start when unblocked"). When a blocker reaches a
// TERMINAL status, this module finds its auto-start dependents whose LAST
// unfinished blocker just cleared and launches each one's first turn, exactly as
// if the user had pressed "Start session".
//
// Terminal means done OR cancelled, matching blocks() below — and that pairing
// is load-bearing rather than incidental. The sweep used to fire only on the
// transition into done, so cancelling a task cleared its edge (blocks() has
// always treated cancelled as terminal, or a dependent would deadlock behind a
// task that will never finish) while launching nothing: the dependent sat
// unblocked-but-never-launched, Start button live, forever. Two callers can
// reach that state — PATCH /api/tasks/[id] when the user cancels, and the
// withdraw_suggestion agent tool — and the scheduling decision has to follow
// from the resulting state, not from which endpoint produced it, or the same
// row means two different things depending on how it got there.
//
// The launch mirrors the initial-turn branch of POST /api/tasks/[id]/messages
// (claim the turn slot, ensure the worktree under the per-task lock, persist +
// publish the generic opening prompt, hand off to lib/runner.ts) — kept in
// step with that route; the turn itself runs detached exactly like any other.
//
// lib/runner.ts is reached through a call-time `await import()`, NOT a static
// import, and that is load-bearing in the production build. The runner imports
// the driver registry and therefore both ESM-only agent SDKs, which Turbopack
// emits as ASYNC externals — so lib/runner.ts compiles to an async module,
// whose `module.namespaceObject` is a PROMISE until its factory settles, and
// so does every static importer of it. This module's own importers are
// ordinary route entries (PATCH /api/tasks/[id], the agent-edits route, the
// two internal agent-tools routes), and a route entry Turbopack compiled sync
// reading an async dependency is exactly how /api/services/grant 500'd: every
// export back as undefined. So the rule here is the same one the PINNED list
// in tests/importGraph.test.ts enforces elsewhere — this file must have NO
// STATIC path to an agent SDK — and the dynamic import is how it keeps one
// while still launching turns. Pinned by the DYNAMIC_ONLY case in that test.
//
// It used to be justified by a CYCLE instead, and that cycle is now gone
// (issue #40). The Claude driver's update_task/withdraw_suggestion tools
// imported this module back at call time:
//
//   autoStart → runner → agents/registry → agents/claude/driver → autoStart
//
// Turbopack saw the cycle and bailed out of propagating async-ness to this
// file even along its then-static runner edge: every emitted copy was a plain
// sync factory, so `startTurn` was read off a pending Promise and auto-start
// died with "startTurn is not a function" on every single launch, while dev
// and vitest stayed green. A dynamic import was immune and stopped the
// symptom; what removed the cycle is AUTO_START_HOOKS below — the driver is
// handed a callback by whoever launched the turn instead of importing the
// module (lib/agents/types.ts's TurnHooks).

import fs from "node:fs";
import {
  getTask,
  getProject,
  getTaskDeps,
  updateTask,
  addMessage,
  listAutoStartCandidates,
} from "@/lib/store";
import { claimTurn, unregisterTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { publish } from "@/lib/events";
import { ensureWorktree } from "@/lib/git";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { INITIAL_TASK_PROMPT } from "@/lib/agents/shared";
import { DEPENDENCY_RUN_CONTEXT } from "@/lib/runContext";
import type { TurnHooks } from "@/lib/agents/types";
import type { Task } from "@/lib/types";

// Is this dependency still blocking? Mirrors the client's blockerTitles():
// done AND cancelled are terminal — a cancelled blocker will never finish, so
// waiting on it would deadlock the dependent forever. A dep whose row was
// deleted doesn't block either (the edge cascades away with it). Exported for
// lib/deferredStart.ts, the other unattended launcher, so the two can't
// disagree about what "blocked" means.
export function blocks(depId: string): boolean {
  const dep = getTask(depId);
  return !!dep && dep.status !== "done" && dep.status !== "cancelled";
}

/**
 * The auto-start dependents of `clearedTaskId` that are now fully unblocked.
 * Pure DB read (no side effects) — split out so tests can pin the selection
 * rules without launching turns.
 */
export function readyAutoStartDependents(clearedTaskId: string): Task[] {
  return listAutoStartCandidates(clearedTaskId).filter(
    (t) => !getTaskDeps(t.id).some(blocks)
  );
}

/**
 * Called after a task's status reaches a terminal one (done or cancelled) from
 * a non-terminal one — i.e. after it stopped blocking. Launches every ready
 * auto-start dependent, fire-and-forget: the caller is an HTTP PATCH (or an
 * agent tool call) that must not wait on worktree creation, and a failed launch
 * must never break the status change. setTaskDeps' cycle guard means a cleared
 * task can never (transitively) depend on anything this launches, so a launch
 * can't re-block the trigger.
 */
export function maybeAutoStartDependents(clearedTaskId: string): void {
  const cleared = getTask(clearedTaskId);
  // The note rides the runner's syncNote slot: persisted + published at the
  // top of the turn, so the transcript records WHY this session began — and
  // "cancelled" reads very differently from "done" to an agent about to work
  // on top of it, so the cause travels rather than being flattened.
  const clearedWord = cleared?.status === "cancelled" ? "was cancelled" : "is done";
  const note = cleared?.title ? `▶ Auto-started — "${cleared.title}" ${clearedWord}.` : `▶ Auto-started — last blocker ${clearedWord}.`;
  for (const t of readyAutoStartDependents(clearedTaskId)) {
    // Re-checked under the lock: the toggle can be flipped off, or the task
    // parked on_hold, between the selection above and the launch.
    launchInitialTurn(t.id, note, (fresh) => !!fresh.auto_start && fresh.status === "not_started").catch((err) => {
      console.error(`[autoStart] could not start task ${t.id}:`, err);
    });
  }
}

/**
 * What every turn launch hands the driver so a tool call that clears a blocker
 * can reach this sweep — the one thing a driver needs from this module and
 * must never import (lib/agents/types.ts's TurnHooks explains why; the header
 * note above records what happened when one did). Every startTurn /
 * startResumeTurn caller passes this same object: POST /api/tasks/[id]/messages,
 * lib/dispatch.ts (runbooks + schedules), lib/deferredStart.ts, and the launch
 * below. A new launch path that forgets it doesn't break its turn — the tools
 * still work — it just leaves the dependents of anything the agent marks done
 * sitting unstarted, so pass it.
 */
export const AUTO_START_HOOKS: TurnHooks = {
  onTaskCleared: (taskId) => maybeAutoStartDependents(taskId),
};

/**
 * Start a never-started task's first turn, exactly like the POST /messages
 * initial branch. Every non-launch exit releases the claim (or the task would
 * read "running" forever); every guard re-checks under the per-task lock,
 * because a user click can race this launch. `admit` is the caller's own
 * re-check on the freshly read row (the dependency toggle here, the queued
 * deadline in lib/deferredStart.ts) — the guards every unattended launch
 * shares (never started, not a suggestion, not blocked) are applied here and
 * not left to the callers. Resolves true when a turn was handed to the runner.
 */
export async function launchInitialTurn(taskId: string, note: string, admit: (fresh: Task) => boolean): Promise<boolean> {
  const task = getTask(taskId);
  if (!task) return false;
  const project = getProject(task.project_id);
  // No working directory — the same precondition the route enforces. Leave the
  // task blocked-but-startable; the user gets the route's error when they try.
  if (!project || !project.repo_path.trim()) return false;
  // Atomically claim the turn slot. Occupied means a turn is already live
  // (e.g. the user pressed Start in the same instant) — nothing to do. Claimed
  // before the first await, deliberately: the claim is what makes a concurrent
  // launch a no-op rather than a double turn, and tests/autoStart.ts reads its
  // synchronous absence as proof that no launch is in flight at all.
  const controller = claimTurn(taskId);
  if (!controller) return false;
  let launched = false;
  // Set as soon as we have a generation to report a failure against — which is
  // BEFORE the row is marked `running`, so a throw from the worktree self-heal
  // below still has somewhere to unwind to, not just a launch failure after
  // running=1. Null while there's nothing to undo.
  let claimedGen: number | null = null;
  // See the header note on why this import is dynamic. Resolved outside the
  // per-task lock (loading the runner pulls in both agent SDKs the first time)
  // and before anything is written, so a module that fails to load unwinds
  // through the finally's claim release and nothing else.
  let runner: typeof import("@/lib/runner") | null = null;
  try {
    const { startTurn } = (runner = await import("@/lib/runner"));
    fs.mkdirSync(project.repo_path, { recursive: true });
    // Same lock the merge/sync routes and the POST route hold: never launch a
    // turn into a worktree mid-rewrite.
    await withTaskLock(taskId, async () => {
      // Re-read under the lock — the task may have been started, deleted,
      // re-statused, or had its deps changed while we waited.
      const fresh = getTask(taskId);
      if (!fresh || fresh.started || fresh.suggested || !admit(fresh)) return;
      if (getTaskDeps(taskId).some(blocks)) return;
      const userText = INITIAL_TASK_PROMPT;
      const gen = fresh.generation;
      claimedGen = gen;

      // Give the task its own worktree + branch (self-heals a pruned one).
      // ensureWorktree returning null (non-git/empty repo) is a legitimate,
      // silent fallback to repo_path. THROWING is different — a stale
      // index.lock from a crashed process, a disk-full git op, a detached
      // HEAD — and nobody is watching an auto-start launch: swallowing it here
      // would run the turn unattended in the user's real checkout instead of
      // an isolated worktree. So it isn't caught here — it escapes to this
      // function's own catch below, which already turns a launch failure into
      // a visible transcript line via publishTurnError and unwinds the row to
      // retryable, the same path a broken runner import takes.
      if (!fresh.worktree_path || !fs.existsSync(fresh.worktree_path)) {
        const wt = await ensureWorktree(project.repo_path, fresh.id, resolveBaseBranch(fresh, project));
        if (wt) {
          fresh.worktree_path = wt.path;
          fresh.work_branch = wt.branch;
          fresh.base_sha = wt.baseSha;
          // Pin the base at the cut — see lib/baseBranch.ts. "" means the branch
          // didn't exist and the cut fell back to HEAD, which is not something to
          // record as this task's base.
          if (wt.baseBranch) fresh.base_branch = wt.baseBranch;
          updateTask(taskId, {
            worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha,
            ...(wt.baseBranch ? { base_branch: wt.baseBranch } : {}),
          });
        }
      }

      const userMsg = addMessage(taskId, gen, "user", userText);
      // Mark running immediately, but defer `started` until the agent actually
      // opens a session — a failed launch leaves the task cleanly retryable.
      updateTask(taskId, { running: 1, awaiting_input: 0 });
      publish(taskId, { type: "user", content: userMsg.content, msgId: userMsg.id, generation: gen, ts: userMsg.created_at });
      // Declared, not inferred: nobody clicked this launch (issue #37).
      startTurn(fresh, project, userText, note, controller, { ...DEPENDENCY_RUN_CONTEXT }, AUTO_START_HOOKS);
      launched = true;
    });
    return launched;
  } catch (err) {
    // Nobody is watching this launch — it's fire-and-forget behind a status
    // change — so a throw after the row was marked running would leave the task
    // spinning forever on a turn that never started, with an opening prompt and
    // no answer, until the next server boot's recoverFromCrash() noticed. Undo
    // the flag and put the failure where the user will actually see it: the
    // task's own transcript, through the same notice the runner uses when a
    // turn dies. Honours the promise the comment above makes — a failed launch
    // leaves the task cleanly retryable.
    if (claimedGen !== null) {
      updateTask(taskId, { running: 0 });
      runner?.publishTurnError(taskId, claimedGen, err instanceof Error ? err.message : String(err));
    }
    throw err;
  } finally {
    if (!launched) unregisterTurn(taskId, controller);
  }
}
