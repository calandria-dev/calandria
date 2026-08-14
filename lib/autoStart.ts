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

import fs from "node:fs";
import {
  getTask,
  getProject,
  getTaskDeps,
  updateTask,
  addMessage,
  listAutoStartCandidates,
} from "@/lib/store";
import { startTurn } from "@/lib/runner";
import { claimTurn, unregisterTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { publish } from "@/lib/events";
import { ensureWorktree } from "@/lib/git";
import { INITIAL_TASK_PROMPT } from "@/lib/agents/shared";
import type { Task } from "@/lib/types";

// Is this dependency still blocking? Mirrors the client's blockerTitles():
// done AND cancelled are terminal — a cancelled blocker will never finish, so
// waiting on it would deadlock the dependent forever. A dep whose row was
// deleted doesn't block either (the edge cascades away with it).
function blocks(depId: string): boolean {
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
  for (const t of readyAutoStartDependents(clearedTaskId)) {
    launchInitialTurn(t.id, cleared?.title ?? "", cleared?.status === "cancelled").catch((err) => {
      console.error(`[autoStart] could not start task ${t.id}:`, err);
    });
  }
}

// Start a never-started task's first turn, exactly like the POST /messages
// initial branch. Every non-launch exit releases the claim (or the task would
// read "running" forever); every guard re-checks under the per-task lock,
// because a user click can race this launch.
async function launchInitialTurn(taskId: string, blockerTitle: string, blockerCancelled = false): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;
  const project = getProject(task.project_id);
  // No working directory — the same precondition the route enforces. Leave the
  // task blocked-but-startable; the user gets the route's error when they try.
  if (!project || !project.repo_path.trim()) return;
  // Atomically claim the turn slot. Occupied means a turn is already live
  // (e.g. the user pressed Start in the same instant) — nothing to do.
  const controller = claimTurn(taskId);
  if (!controller) return;
  let launched = false;
  try {
    fs.mkdirSync(project.repo_path, { recursive: true });
    // Same lock the merge/sync routes and the POST route hold: never launch a
    // turn into a worktree mid-rewrite.
    await withTaskLock(taskId, async () => {
      // Re-read under the lock — the task may have been started, deleted,
      // re-statused, or had its deps changed while we waited.
      const fresh = getTask(taskId);
      if (!fresh || fresh.started || fresh.suggested || fresh.status !== "not_started" || !fresh.auto_start) return;
      if (getTaskDeps(taskId).some(blocks)) return;
      const userText = INITIAL_TASK_PROMPT;

      // Give the task its own worktree + branch (self-heals a pruned one),
      // falling back to repo_path on any git hiccup — same as the route.
      if (!fresh.worktree_path || !fs.existsSync(fresh.worktree_path)) {
        try {
          const wt = await ensureWorktree(project.repo_path, fresh.id, project.branch);
          if (wt) {
            fresh.worktree_path = wt.path;
            fresh.work_branch = wt.branch;
            fresh.base_sha = wt.baseSha;
            updateTask(taskId, { worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha });
          }
        } catch {
          // fall back to repo_path
        }
      }

      const gen = fresh.generation;
      const userMsg = addMessage(taskId, gen, "user", userText);
      // Mark running immediately, but defer `started` until the agent actually
      // opens a session — a failed launch leaves the task cleanly retryable.
      updateTask(taskId, { running: 1, awaiting_input: 0 });
      publish(taskId, { type: "user", content: userMsg.content, msgId: userMsg.id, generation: gen, ts: userMsg.created_at });
      // The note rides the runner's syncNote slot: persisted + published at the
      // top of the turn, so the transcript records WHY this session began — and
      // "cancelled" reads very differently from "done" to an agent about to work
      // on top of it, so the cause travels rather than being flattened.
      const cleared = blockerCancelled ? "was cancelled" : "is done";
      const note = blockerTitle ? `▶ Auto-started — "${blockerTitle}" ${cleared}.` : `▶ Auto-started — last blocker ${cleared}.`;
      startTurn(fresh, project, userText, note, controller);
      launched = true;
    });
  } finally {
    if (!launched) unregisterTurn(taskId, controller);
  }
}
