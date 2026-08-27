// Mint a task from a saved prompt and launch its first turn.
//
// This is the body of lib/scheduler.ts's fireSchedule(), lifted out so a
// runbook can reach it too. The two callers differ only in what surrounds it: a
// schedule adds a clock, a durable run claim, a ledger and an unattended
// RunContext; a runbook adds a button. Everything between "we have a prompt and
// a project" and "a turn is streaming" is identical, and was identical before
// this module existed — the risk of two copies drifting is the whole reason it
// does.
//
// What deliberately stays OUT of here:
//   - schedule_runs claiming/settling and next_fire_at. lib/scheduler.ts owns
//     the ledger; a dispatcher that knew about runs would have to invent one
//     for runbooks, which by design they don't need.
//   - the background_jobs setting, which governs UNATTENDED work. A runbook is
//     a button press; gating it here would switch off a thing the user is
//     watching happen.
//
// Reaches lib/runner.ts, so this module is NOT in tests/importGraph.test.ts's
// SDK-free PINNED set. The static import is fine — unlike lib/autoStart.ts this
// file sits in no cycle with the async graph (nothing in the driver imports it
// back), which is exactly the condition that makes Turbopack's async-ness
// propagation reliable. Routes should still reach IT through `await import()`,
// as they already do for lib/scheduler.ts.

import fs from "node:fs";
import { getProject, createTask, updateTask, addMessage } from "@/lib/store";
import { validatePrompt } from "@/lib/schedule/commands";
import { startTurn, publishTurnError } from "@/lib/runner";
import { AUTO_START_HOOKS } from "@/lib/autoStart";
import { claimTurn, unregisterTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { publish } from "@/lib/events";
import { ensureWorktree } from "@/lib/git";
import { isAgentConnected } from "@/lib/agents/connections";
import type { RunContext } from "@/lib/runContext";
import type { Priority, Task } from "@/lib/types";

export interface DispatchInput {
  project_id: string;
  title: string;
  /** The minted task's brief — buildProjectContext() injects it. */
  description: string;
  /**
   * The FIRST USER MESSAGE, not the description. A slash command only expands
   * when it arrives as a user turn; the ordinary first-turn path sends the
   * generic INITIAL_TASK_PROMPT instead, which would leave "/jira-sweep" as
   * inert text in a system prompt.
   */
  prompt: string;
  agent: string;
  permission_mode: string | null;
  send_context: boolean;
  priority: Priority;
  /** The "▶ …" line recording WHY this session began, persisted at the top of the turn. */
  note: string;
  /** Schedules pass SCHEDULED_RUN_CONTEXT. A runbook passes nothing: someone is watching. */
  runContext?: RunContext;
  schedule_id?: string | null;
  runbook_id?: string | null;
  /**
   * Called with the new task id after createTask and BEFORE the launch. This is
   * the ledger seam: fireSchedule has to link the run to the task while the
   * launch can still fail, or a crash in between leaves a run nothing can be
   * attributed to. Returning the task and letting the caller link afterwards
   * loses exactly that window.
   */
  onTaskCreated?: (taskId: string) => void;
}

/**
 * `task` is present on a FAILURE too whenever the row was already minted — the
 * launch, not the creation, is what fell over. It's a real, retryable task
 * rather than a leak, and callers that report the failure should be able to
 * point at it.
 */
export type DispatchResult =
  | { ok: true; task: Task }
  | { ok: false; error: string; task?: Task };

export async function dispatchPromptTask(input: DispatchInput): Promise<DispatchResult> {
  // ---- preflight: fail with something actionable rather than minting a task
  // that cannot possibly work.
  const project = getProject(input.project_id);
  if (!project) return { ok: false, error: "the project this belongs to no longer exists" };
  if (!project.repo_path.trim()) {
    return { ok: false, error: `"${project.name}" has no working directory set, so a session cannot start` };
  }
  // Checked for THIS agent — never allowed to fall back to another, which would
  // silently run the work on the wrong login.
  if (!isAgentConnected(input.agent)) {
    return { ok: false, error: `${input.agent} is not connected — reconnect it and this will work` };
  }
  // An unknown slash command does not fail at run time — it returns "Unknown
  // command: /x" as a SUCCESS — so a dispatch would report green having done
  // nothing. Best-effort: `unchecked` (no registry reachable) proceeds.
  const check = await validatePrompt(input.prompt, project, input.agent);
  if (!check.ok) {
    const hint = check.suggestions?.length ? ` Did you mean ${check.suggestions.map((c) => `/${c}`).join(", ")}?` : "";
    return { ok: false, error: `${check.error}${hint}` };
  }

  let task: Task | undefined;
  try {
    fs.mkdirSync(project.repo_path, { recursive: true });
    task = createTask({
      project_id: project.id,
      title: input.title,
      description: input.description,
      priority: input.priority,
      agent: input.agent,
      send_context: input.send_context,
      permission_mode: input.permission_mode,
      schedule_id: input.schedule_id ?? null,
      runbook_id: input.runbook_id ?? null,
    });
    input.onTaskCreated?.(task.id);

    const controller = claimTurn(task.id);
    if (!controller) return { ok: false, error: "the task's turn slot was already taken", task };
    const created = task;
    let launched = false;
    try {
      // The same lock the merge/sync routes hold: never launch a turn into a
      // worktree mid-rewrite.
      await withTaskLock(created.id, async () => {
        let fresh = { ...created };
        // ensureWorktree returning null (non-git/empty repo) is a legitimate,
        // silent fallback to repo_path. THROWING is different — a stale
        // index.lock from a crashed process, a disk-full git op, a detached
        // HEAD — and swallowing it here would launch straight into the user's
        // real checkout instead of an isolated worktree. So it isn't caught:
        // it escapes to this function's own catch below, which already turns
        // any setup failure into a DispatchResult carrying the minted task.
        // That's the mechanism both callers already use for every other
        // dispatch failure — fireSchedule settles the run "failed" with this
        // same message, the runbook route turns it into a visible 400 — so
        // nothing new is needed here, just not swallowing it first.
        const wt = await ensureWorktree(project.repo_path, fresh.id, project.branch);
        if (wt) {
          fresh = { ...fresh, worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha };
          updateTask(fresh.id, { worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha });
        }
        const userMsg = addMessage(fresh.id, fresh.generation, "user", input.prompt);
        updateTask(fresh.id, { running: 1, awaiting_input: 0 });
        publish(fresh.id, {
          type: "user", content: userMsg.content, msgId: userMsg.id,
          generation: fresh.generation, ts: userMsg.created_at,
        });
        startTurn(fresh, project, input.prompt, input.note, controller, input.runContext, AUTO_START_HOOKS);
        launched = true;
      });
    } finally {
      // Every non-launch exit must free the claim, or the task reads "running"
      // forever and every future message queues into the void.
      if (!launched) unregisterTurn(created.id, controller);
    }
    return launched ? { ok: true, task: created } : { ok: false, error: "the turn could not be launched", task: created };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A failure that already minted a task has to say why on THAT TASK, not
    // only in the DispatchResult. A schedule's failure lands in the run ledger
    // and a runbook's in an HTTP response, and neither is where anyone looks
    // the next morning: what they open is a task sitting there with an empty
    // transcript. publishTurnError is the same classified line every other
    // launch failure writes, so a worktree that couldn't be prepared arrives
    // with its "Repair worktree" button attached (issue #44) — and one click
    // from there is a launch, since the task is unstarted.
    if (task) publishTurnError(task.id, task.generation, message);
    return { ok: false, error: message, task };
  }
}
