// Detached server-side turn runner.
//
// A Claude turn used to live inside the POST /messages SSE handler, so a page
// reload or dropped connection aborted it. Now POST just calls startTurn() and
// returns: the turn runs here, owned by the server process, persisting every
// event to SQLite and fanning it out over lib/events.ts. Any number of GET
// /messages streams (including zero) can watch; disconnects never touch the
// turn. Stopping is only ever explicit, via lib/abort.ts (/abort route).

import fs from "node:fs";
import { updateTask, addMessage, updateMessage, getMessage, recordSession, endSession, addUsage, getTask, getProject, addPendingMessage, popPendingMessage, listPendingMessages, deletePendingMessage, clearPendingMessages, getSetting, setSetting } from "@/lib/store";
import { isSuggestTaskTool } from "@/lib/suggestionCard";
import { taskProvider } from "@/lib/agentEnv";
import { getDriver } from "@/lib/agents/registry";
import { claimTurn, handoffTurn, hasTurn, ownsTurn, unregisterTurn, abortTurn, activeTurnIds } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { publish, subscribeGlobal, publishGlobal } from "@/lib/events";
import { forgetTurnActivity, markTurnActivity } from "@/lib/turnActivity";
import { PERMISSION_PROMPT_TIMEOUT_MS, PERMISSION_UNATTENDED_MS, SHUTDOWN_GRACE_MS } from "@/lib/config";
import { worktreeSyncStatus, fastForwardWorktree, ensureWorktree } from "@/lib/git";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { recordBaseCut } from "@/lib/baseDrift";
import { isPromptTooLong, CONTEXT_OVERFLOW_NOTICE } from "@/lib/promptLimits";
import { isAuthFailure, AUTH_EXPIRED_NOTICE } from "@/lib/authFailure";
import { isApprovalBlocked, APPROVAL_BLOCKED_NOTICE } from "@/lib/approvalFailure";
import { isUsageLimit, USAGE_LIMIT_NOTICE } from "@/lib/usageLimit";
import { worktreePrepNotice } from "@/lib/worktreeFailure";
import { markAgentAuthBroken, clearAgentAuthBroken } from "@/lib/agents/connections";
import { DENIED_INTERRUPTED, DENIED_TIMED_OUT, parseDecision, waitForPermission } from "@/lib/permissions";
import {
  acceptSettingsChanges,
  checkSettingsDrift,
  settingsBlockedError,
  settingsDriftNotice,
  settingsDriftRequest,
  SETTINGS_DENIED_UNATTENDED,
} from "@/lib/settingsDrift";
import { worktreeRelative } from "@/lib/collab";
import { clearRunContext, setRunContext, type RunContext } from "@/lib/runContext";
import { sendTurnInput } from "@/lib/turnInput";
import { settleRun } from "@/lib/schedule/store";
import type { TurnHooks } from "@/lib/agents/types";
import type { Task, Project, PermissionOutcome, ToolData, LedgerUsage } from "@/lib/types";
import { createLogger } from "@/lib/log.mjs";
import { countTurnFinished, countTurnStarted } from "@/lib/metrics";

// Every line this module prints. The bracket tag it used to hand console
// becomes the logger's component, so `CALANDRIA_LOG_FORMAT=json` turns the
// whole file into parseable output without touching a call site (lib/log.mjs).
const log = createLogger("runner");

// What a scheduled run says for itself when it stopped because there was
// nobody to approve something. Named, because the docs promise the user that a
// schedule on any mode but its agent's never-asks one "can stop early with the
// job half done" — this is that sentence arriving on the run it happened to,
// instead of a green "ran". Phrased without naming a mode: this text is
// agent-agnostic while the mode labels are provider-native (Claude's
// "bypassPermissions", Codex's "workspace-write"), so any one name would be
// wrong for somebody's schedule.
export const SCHEDULE_UNATTENDED_DETAIL =
  "the agent needed approval and nobody was watching, so it was declined automatically. " +
  "The run may have stopped with the job half done. Use the agent's never-asks permission mode, or start this one by hand.";

/**
 * Kick off one user turn in the background. Returns immediately; the caller
 * must have already persisted the user message and set running=1. `syncNote`
 * (the silent worktree fast-forward notice, if any) is persisted + published
 * first so it reads in order at the top of the turn.
 *
 * `hooks` is what this turn's tool calls are allowed to set off outside the
 * turn — today only "a task went terminal, sweep its auto-start dependents".
 * It is passed IN rather than resolved here because the sweep lives in
 * lib/autoStart.ts, which launches through this module: importing it back
 * would rebuild the cycle that once broke every auto-start in production, and
 * would drag the agent SDKs into autoStart's sync route-entry importers along
 * the way (issue #40 — see TurnHooks in lib/agents/types.ts and the
 * DYNAMIC_ONLY note in tests/importGraph.test.ts). Every launch path passes
 * AUTO_START_HOOKS; omitting it doesn't break the turn, it just leaves the
 * dependents of anything the agent marks done sitting unstarted.
 */
export function startTurn(
  task: Task,
  project: Project,
  userText: string,
  syncNote: string,
  controller?: AbortController,
  runContext?: RunContext,
  hooks?: TurnHooks
): void {
  // Lets the Stop button abort this turn. Registered by task id so the
  // separate /abort route can find and trip it — and so hasTurn() can report
  // turn liveness to the POST guard and the GET stream's snapshot. Callers
  // that already hold the task's claim (the POST route, the queue drainer's
  // handoff) pass their controller through; anyone else claims here, and the
  // claim is atomic (a synchronous check+register), so two concurrent launches
  // can never both start a turn on the same session.
  const abortController = controller ?? claimTurn(task.id);
  if (!abortController) {
    // Defense-in-depth: the slot is occupied by a live turn. Callers are
    // supposed to claim before launching (so this shouldn't be reachable) —
    // park the message as a queued follow-up rather than double-running the
    // session with a turn the Stop button couldn't reach.
    log.error("startTurn raced a live turn; queueing the message instead", { task: task.id });
    const pm = addPendingMessage(task.id, task.generation, userText);
    publish(task.id, { type: "queued", msgId: pm.id, content: userText, generation: task.generation, ts: pm.created_at });
    return;
  }
  // Declare WHY this turn is running for its whole life. The permission gate
  // reads this instead of guessing from open tabs, and the finally below uses
  // it to settle the schedule run. Registered here rather than inside run() so
  // it is in place before the first tool call can possibly arrive.
  if (runContext) setRunContext(task.id, runContext);
  // A turn is what a queued start (tasks.start_at, lib/deferredStart.ts) was
  // waiting to produce, so ANY launch consumes the deadline — the sweep's own,
  // a Start-session click, a follow-up sent by hand. Left set, a task the user
  // resumed before the reset would be resumed AGAIN when it passed, with a
  // "continue" the session didn't need. Announced as an edit because the
  // coarse turn events don't carry the field, and the hero/card chips read it.
  if (task.start_at) {
    updateTask(task.id, { start_at: 0 });
    task.start_at = 0;
    publishGlobal(task.id, { type: "task_edited" });
  }
  // Detached: nobody awaits this. `run()` guards its own body (try/catch/finally)
  // and unregisterTurn runs in that finally, but a throw from the finally itself
  // (e.g. the task row was deleted mid-turn, so updateTask/endSession hit a
  // FOREIGN KEY error) would surface here as an unhandled rejection and, under
  // Node's default policy, crash the entire server — taking down every other
  // tenant's turn. Swallow-and-log so one deleted task can never do that.
  run(task, project, userText, syncNote, abortController, runContext, hooks).catch((err) => {
    log.error("turn crashed after its finally settled", { task: task.id, err });
    // Best-effort settle so even this last-resort path can't wedge the task in
    // a running-forever state. unregisterTurn is identity-checked, so a newer
    // turn's registration is never wiped; if one IS registered (a queued
    // follow-up already took over), leave its state alone.
    try {
      unregisterTurn(task.id, abortController);
      if (!hasTurn(task.id)) {
        const current = getTask(task.id);
        if (current && current.generation === task.generation && current.running) {
          updateTask(task.id, { running: 0, background_pending: 0, background_note: "" });
        }
        publish(task.id, { type: "turn_end" });
      }
    } catch (settleErr) {
      log.error("could not settle task after crash", { task: task.id, err: settleErr });
    }
    // A crash here means run()'s own finally never reached ITS settle block, so
    // a scheduled run would otherwise leak two ways: the schedule_runs row stuck
    // at claimed/running forever, and — worse — the stale RunContext entry left
    // keyed on this task id, which a later ORDINARY turn on the same task would
    // silently inherit via interactionDenied() (lib/runContext.ts) and have its
    // own permission prompts auto-deny with no visible explanation. Settle both
    // here, best-effort: this catch is the last line of defence for a detached
    // promise, so nothing inside it may itself throw out.
    if (runContext) {
      try {
        if (runContext.scheduleRunId) {
          const detail = `runner crashed before settling: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
          settleRun(runContext.scheduleRunId, "failed", detail);
        }
      } catch (scheduleErr) {
        log.error("could not settle schedule run after crash", { task: task.id, run: runContext.scheduleRunId, err: scheduleErr });
      }
      try {
        clearRunContext(task.id, runContext);
      } catch (contextErr) {
        log.error("could not clear run context after crash", { task: task.id, err: contextErr });
      }
    }
  });
}

/**
 * Send a message straight into a turn that is LINGERING — the state where the
 * model's output is done but the driver is holding the agent session open so
 * run_in_background work survives, or a scheduled wakeup can still fire
 * (lib/agents/claude/driver.ts). Returns true if the live turn took it.
 *
 * Without this the message parks in `pending_messages` and waits for the linger
 * to end, which by default is not bounded at all (BACKGROUND_LINGER_MS = 0): a
 * user watching a `sleep 600` or a `/loop` would be told "queued" and then hear
 * nothing for ten minutes, while the session that could answer them sits idle
 * with an open input. Nothing is in flight during a linger, so the message
 * simply opens the next turn — the same thing the queue drain would eventually
 * do, minus the wait.
 *
 * Only the driver can say whether its session can take a message (mid-thought
 * it cannot; that is what the queue is for), so the offer goes through
 * lib/turnInput.ts and a `false` means "queue it instead". Everything after the
 * handoff is the ordinary user-message path — persisted to the transcript,
 * published as a `user` event — so a reload, another tab, and the global
 * lifecycle stream all see exactly what they see for a message that started a
 * turn the normal way. The whole body is synchronous (better-sqlite3, in-memory
 * pub/sub, a synchronous push into the driver's channel), so nothing can
 * interleave between the CLI accepting the message and the transcript recording
 * it.
 */
export function sendToLingeringTurn(taskId: string, text: string): boolean {
  // Re-read: the caller's snapshot predates its own `await req.json()`, and a
  // /clear could have bumped the generation since. A message persisted under a
  // stale generation renders in the wrong session's transcript.
  const task = getTask(taskId);
  if (!task) return false;
  // Anything already parked was promised the session FIRST (it was typed
  // earlier and renders above this one as a queued bubble). Jumping it would
  // deliver the user's own two messages out of the order they wrote them, so
  // this one parks behind it — and the queue empties on its own, because
  // entering a linger drains the oldest parked message into the same open
  // session (see the background_pending branch in run()).
  if (listPendingMessages(taskId).length > 0) return false;
  if (!sendTurnInput(taskId, text)) return false;
  recordSentMessage(taskId, task.generation, text);
  return true;
}

/** Persist + publish a message the live turn just accepted, as the ordinary
 *  user message it is. Shared by both ways one gets in: the user sending during
 *  a linger, and the linger-entry drain of an already-parked follow-up. */
function recordSentMessage(taskId: string, gen: number, text: string): void {
  // The linger is over the instant the CLI takes the message: a real model turn
  // is starting, so "working in background" would be a lie on every surface
  // that reads the row (the activity line, the status dot, the global stream's
  // re-read). Persisted BEFORE the publish, like every other state that stream
  // re-reads. `running` deliberately stays 1 — it never dropped; this turn is
  // the same turn, continuing.
  updateTask(taskId, { background_pending: 0, background_note: "" });
  try {
    const m = addMessage(taskId, gen, "user", text);
    publish(taskId, { type: "user", content: m.content, msgId: m.id, generation: gen, ts: m.created_at });
  } catch (err) {
    // The row went away between the two synchronous steps above (a delete
    // racing this send) — the CLI has the message and the task doesn't exist to
    // show it. Nothing left to do but say so; the turn dies with the task.
    log.error("sent a message into the live turn but could not persist it", { task: taskId, err });
  }
}

/**
 * Begin a *resume* (non-initial) turn for a task: make sure the task has a
 * worktree, silently catch a fast-forward-able one up to the base branch,
 * persist + echo the user message, flip running on, and hand off to the
 * detached runner. Shared by the POST /messages resume path and the queue
 * drainer (a dequeued follow-up is always a resume turn). Mirrors the prep the
 * POST route does inline for the very first turn; the initial turn stays in the
 * route since it also persists the generic opening prompt.
 */
export async function startResumeTurn(task: Task, project: Project, userText: string, controller?: AbortController, hooks?: TurnHooks): Promise<void> {
  const id = task.id;
  const gen = task.generation;
  // Claim the task's turn slot BEFORE the awaits below. The claim is atomic
  // (synchronous check+register), so a concurrent launch can't interleave in
  // the sync-status window and start a second turn on the same session.
  // Callers that already claimed (the POST route, the drain handoff) pass
  // their controller through; if the slot turns out to be occupied, park the
  // message as a queued follow-up — same outcome as the POST route's guard.
  const abortController = controller ?? claimTurn(id);
  if (!abortController) {
    const pm = addPendingMessage(id, gen, userText);
    publish(id, { type: "queued", msgId: pm.id, content: userText, generation: gen, ts: pm.created_at });
    return;
  }
  try {
    // Isolation is this function's job, not its callers'. Both launch paths that
    // create a worktree (POST /messages, lib/autoStart.ts) run the same self-heal
    // before their FIRST turn, but a turn can also reach the runner through the
    // queue drainer in run()'s finally — which only pops a message and calls
    // here. If task.worktree_path were empty by then, the driver would fall back
    // to project.repo_path and the agent would edit the user's actual checkout
    // instead of an isolated worktree. Today the callers happen to make that
    // unreachable (every drain follows a turn one of them launched); this makes
    // it an invariant of the code rather than of three call sites agreeing.
    // Same contract as those paths: ensureWorktree reattaches to a surviving
    // branch so pruned work comes back, and non-git/empty repos legitimately
    // yield null and fall back to repo_path. Mutating `task` so the sync check
    // below and the runner see the new cwd. Runs before the catch-up on
    // purpose — that reads worktree_path.
    // A project with no working directory set is skipped rather than isolated:
    // both launch paths refuse that project outright, and ensureWorktree("")
    // would be asking git to init a repo in an unknown place.
    // ensureWorktree returning null (non-git/empty repo) is the legitimate
    // fallback described above, handled by the `if (wt)` guard. THROWING is
    // different — a stale index.lock from a crashed process, a disk-full git
    // op, a detached HEAD. The riskiest caller of this self-heal is the queue
    // drain in run()'s finally below: a turn nobody is watching at the instant
    // it fails. Swallowing the throw there would launch straight into
    // task.worktree_path || project.repo_path — the user's real checkout,
    // under whatever permission mode the task already carries — with no
    // event, no transcript line, no banner. So it isn't caught here: it
    // escapes to this function's own catch just below, which unregisters the
    // claim and rethrows. The queue drainer's `.catch` on this same call
    // already turns that rejection into a transcript line via
    // publishTurnError, a settled `running: 0`, and a `turn_end` — the exact
    // visible-failure path this file uses for every other kind of launch
    // failure, so nothing new is needed here, just not swallowing it first.
    // (The other caller, the POST route, ensures the worktree itself before
    // ever reaching this function, so this branch is its safety net, not its
    // primary path.)
    if (project.repo_path.trim() && (!task.worktree_path || !fs.existsSync(task.worktree_path))) {
      const requestedBase = resolveBaseBranch(task, project);
      const wt = await ensureWorktree(project.repo_path, id, requestedBase);
      if (wt) {
        task.worktree_path = wt.path;
        task.work_branch = wt.branch;
        task.base_sha = wt.baseSha;
        // Pin the base at the cut (lib/baseBranch.ts). This path is the self-heal
        // rather than a first launch, but a cut is a cut: base_sha now comes from
        // that branch, so the task owns the answer from here on. Skipped when
        // ensureWorktree fell back to HEAD (baseBranch "") — pinning a branch the
        // worktree wasn't actually cut from would be a lie the merge would honor.
        if (wt.baseBranch) task.base_branch = wt.baseBranch;
        updateTask(id, {
          worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha,
          ...(wt.baseBranch ? { base_branch: wt.baseBranch } : {}),
        });
        // Record what the cut actually got, for the opening turn's context to state:
        // a base branch behind the project default, or one that no longer exists,
        // is otherwise invisible to the session until its PR reads as a revert
        // (lib/baseDrift.ts).
        await recordBaseCut({
          taskId: id,
          repoPath: project.repo_path,
          requestedBase,
          cutBase: wt.baseBranch,
          projectDefault: project.branch,
        });
      }
    }
    // Catch the worktree up to base when it's a clean, zero-conflict fast-forward
    // (no divergent commits, clean tree) so follow-up work isn't built on stale
    // code. Anything riskier is left to the user-driven Sync/Fix banner. A git
    // hiccup must never block the turn — just skip the catch-up.
    let syncNote = "";
    if (task.worktree_path && task.work_branch) {
      // The task's own base, not the project's: a task on feature/auth catches
      // up to feature/auth, which is the entire point of the feature.
      const base = resolveBaseBranch(task, project);
      try {
        const s = await worktreeSyncStatus({
          repoPath: project.repo_path,
          worktreePath: task.worktree_path,
          workBranch: task.work_branch,
          baseBranch: base,
        });
        if (s.canFastForward && s.behind > 0 && (await fastForwardWorktree(task.worktree_path, base))) {
          if (s.baseTip) {
            task.base_sha = s.baseTip;
            updateTask(id, { base_sha: s.baseTip });
          }
          syncNote = `✓ Caught up to ${base} (was ${s.behind} behind).`;
        }
      } catch {
        // skip the catch-up
      }
    }
    const userMsg = addMessage(id, gen, "user", userText);
    updateTask(id, { running: 1, suggested: 0, awaiting_input: 0, background_pending: 0, background_note: "" });
    publish(id, { type: "user", content: userMsg.content, msgId: userMsg.id, generation: gen, ts: userMsg.created_at });
    startTurn(task, project, userText, syncNote, abortController, undefined, hooks);
  } catch (err) {
    // The turn never launched (e.g. the task row vanished mid-await) — release
    // the claim, or the task would read "running" forever and every future
    // message would queue into the void. Identity-guarded, so if the runner
    // did take ownership this is a no-op.
    unregisterTurn(id, abortController);
    throw err;
  }
}

/**
 * Graceful-shutdown drain: abort every turn this process is currently
 * running — the same `abortTurn` a Stop-button press calls — and wait (up to
 * `timeoutMs`) for each one's `run()` finally to actually settle (persisting
 * DENIED_INTERRUPTED on any open permission card, flipping running/
 * awaiting_input, publishing turn_end), rather than a bare process.exit(0)
 * cutting a mid-write turn off with nothing durable recorded. Called by
 * POST /api/instance/drain, which server.js's SIGTERM/SIGINT handler pings
 * before it exits — see that route for why this can't be reached by a direct
 * import from the plain-Node entrypoint.
 *
 * abortTurn() deletes a task's registry entry synchronously, so hasTurn()
 * alone can't tell us when the unwind is DONE — only that it's no longer
 * abortable. turn_end is the actual completion signal (run()'s finally
 * publishes it in every code path that doesn't hand off to a successor turn,
 * and nothing should be claiming a fresh turn while the process is shutting
 * down), so this subscribes to it globally before issuing any abort — a
 * turn whose driver iterator is already at an await-free point could
 * otherwise unwind and publish inside the same synchronous abort() call,
 * before a subscription registered afterward existed to see it.
 *
 * Bounded because a driver stuck on an uninterruptible syscall must never
 * turn a `docker stop` into a hang for the container runtime to SIGKILL
 * anyway; a turn still unwinding at the deadline is left to finish on its
 * own (its finally still runs — this just stops waiting for it) or to be cut
 * off by the process exit that follows.
 */
export async function drainActiveTurns(timeoutMs: number = SHUTDOWN_GRACE_MS): Promise<{ total: number; settled: number }> {
  const ids = activeTurnIds();
  if (ids.length === 0) return { total: 0, settled: 0 };
  const pending = new Set(ids);
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const unsubscribe = subscribeGlobal(
    (taskId, ev) => {
      if (ev.type !== "turn_end" || !pending.has(taskId)) return;
      pending.delete(taskId);
      if (pending.size === 0) resolveDone();
    },
    { internal: true }
  );
  for (const id of ids) abortTurn(id);
  const timedOut = await Promise.race([
    done.then(() => false),
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(true), timeoutMs);
      t.unref?.();
    }),
  ]);
  unsubscribe();
  if (timedOut && pending.size > 0) {
    log.warn("shutdown drain timed out with turns still unwinding", {
      unwinding: pending.size,
      turns: ids.length,
      tasks: [...pending].join(","),
    });
  }
  return { total: ids.length, settled: ids.length - pending.size };
}

/**
 * Persist + publish a failed-turn line, appending a recovery hint when the
 * failure is one we know how to fix:
 *   - the API's context-overflow rejection ("prompt is too long") →
 *     CONTEXT_OVERFLOW_NOTICE, which the UI turns into a one-click "Start fresh
 *     context" (/clear) button;
 *   - a dead agent login (expired OAuth session, revoked/invalid key) →
 *     AUTH_EXPIRED_NOTICE, which becomes a "Reconnect <agent>" button;
 *   - a spent usage limit (Claude's 5-hour/weekly subscription cap, an API 429)
 *     → USAGE_LIMIT_NOTICE, informational — the recovery is waiting for the
 *     reset, so there is no button;
 *   - an approval-policy block (enterprise-managed Codex downgraded our
 *     "never" to an approval-requiring policy that exec mode can't service) →
 *     APPROVAL_BLOCKED_NOTICE, which becomes a "Retry" button — the Codex
 *     driver has already self-healed to "on-request" for the next turn;
 *   - a worktree that could not be prepared (a crashed git's stale index.lock, a
 *     registration pointing at a directory that's gone, a full disk, a detached
 *     HEAD) → the classified hint from lib/worktreeFailure.ts, plus, for the two
 *     kinds a repair pass can fix, WORKTREE_REPAIR_NOTICE — a "Repair worktree"
 *     button. This is the path an UNATTENDED launch failure takes (the queue
 *     drain below, lib/autoStart.ts, lib/dispatch.ts), so a scheduled run that
 *     fails the same way every morning now says what to do about it.
 * Either way the raw provider text stays visible above the hint, so token counts
 * and the actual wording remain legible. The persisted message is the durable
 * channel — it survives SSE reconnects because the snapshot replays from SQLite.
 */
export function publishTurnError(id: string, gen: number, errText: string): void {
  const notice = isPromptTooLong(errText)
    ? CONTEXT_OVERFLOW_NOTICE
    : isAuthFailure(errText)
      ? AUTH_EXPIRED_NOTICE
      : isUsageLimit(errText)
        ? USAGE_LIMIT_NOTICE
        : isApprovalBlocked(errText)
          ? APPROVAL_BLOCKED_NOTICE
          : worktreePrepNotice(errText);
  const content = notice ? `⚠ ${errText}\n\n${notice}` : `⚠ ${errText}`;
  // The persist can itself throw — most importantly when the task row is gone
  // (project/task deleted mid-turn): addMessage then hits a FOREIGN KEY error.
  // This function is the *error* path, so a throw here escapes the runner's
  // catch block and, unhandled on the detached `run()`, would crash the whole
  // server. Degrade gracefully: if we can't persist, still fan out to any live
  // viewer with a best-effort id, and never rethrow.
  let msgId: string | undefined;
  let ts: number | undefined;
  try {
    const m = addMessage(id, gen, "system", content);
    msgId = m.id;
    ts = m.created_at;
  } catch (err) {
    log.error("could not persist turn error (row gone?)", { task: id, err });
  }
  try {
    publish(id, { type: "error", content, msgId, generation: gen, ts });
  } catch {
    // in-memory pub/sub; ignore
  }
}

async function run(task: Task, project: Project, userText: string, syncNote: string, abortController: AbortController, runContext?: RunContext, hooks?: TurnHooks): Promise<void> {
  const id = task.id;
  const gen = task.generation;
  let sessionId: string | null = task.session_id;
  let opened = false;
  // tool_use_id -> { dbId, data } so a later tool_result can be merged in.
  const toolMsgs: Record<string, { dbId: string; data: ToolData }> = {};
  // suggest_task tool_use ids whose `suggested` event hasn't arrived yet, oldest
  // first. The tool row is created when the call streams; the id of the task it
  // filed is only known when the tool reports back, so the two are matched in
  // order — a planning turn issues its whole batch in one assistant message,
  // and each call is entitled to exactly one card.
  const pendingSuggestCalls: string[] = [];
  // Everything currently parked on the user — AskUserQuestion cards and
  // permission prompts alike. One assistant message can park several at once,
  // and awaiting_input must stay up until the last one is settled.
  const openAsks = new Set<string>();
  let turnError: string | null = null;
  // Set when this turn died on authentication rather than on the work: the
  // agent's login is dead instance-wide, so the queue must be parked (every
  // follow-up would fail identically) and the whole app told, not just this task.
  let authFailure: string | null = null;
  // Set when this turn died on a spent usage limit (Claude's 5-hour/weekly
  // subscription cap, an API 429): the quota is dead until it resets, so the
  // queue must be parked for the same reason — every follow-up would drain
  // straight into the same limit. Classified after authFailure (a dead login
  // never doubles as a spent quota).
  let usageLimitFailure: string | null = null;
  // Set when a tool-permission prompt auto-denied because NOBODY was watching
  // (lib/permissions.ts). Like a dead login, the problem isn't the work — it's
  // that there was no one to approve it, and draining the queue now would run
  // every follow-up into the same wall.
  let unattendedDeny = false;
  // Set when the pre-turn settings gate refused (issue #43): the task's own
  // .claude/settings.json changed since it last ran and the change wasn't
  // approved, so this turn never reached the agent. The queue is parked for the
  // same reason as the two above — every follow-up would raise the identical
  // card — and the task is left flagged, because the way out is a person
  // reading a diff.
  let settingsBlocked = false;
  const startedAt = Date.now();
  // What this turn spent, accumulated from the same `usage` events that write
  // task_usage, so the lifecycle line in the finally can report tokens without
  // re-reading the DB it just wrote. A turn can report usage more than once
  // (each SDK result message carries its own), hence a running sum rather than
  // a last-wins snapshot.
  const spent = { cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  // Of the usage reports folded into `spent`, how many carried no price at all
  // (a custom base URL — see the usage branch below). `spent.cost_usd` is the
  // sum over the others, so this is what stops the lifecycle line logging a
  // confident "cost_usd: 0" for a turn that may well have cost real money.
  let unpricedTurns = 0;
  // Start the idle clock (lib/turnActivity.ts) at the launch rather than at the
  // first event: a turn that hangs before the session ever opens is exactly the
  // kind of silence worth reporting, and with no baseline it would never be.
  markTurnActivity(id);

  // Turn lifecycle, line 1 of 2 (issue #16). The runner used to log failures
  // and nothing else, so a healthy instance said nothing at all about the work
  // it was doing — no start, no duration, no spend, and the only record of a
  // turn having happened was a row in SQLite. Emitted from here rather than
  // from the POST route because this is where every launch path converges: a
  // first turn, a resume, a drained follow-up, a schedule firing, an
  // auto-started dependent.
  //
  // The /metrics counter (issue #16 item 3) is incremented from the same two
  // places as the two lines, deliberately: an instance whose graph and whose
  // logs disagree about how many turns ran tells two stories and gives whoever
  // is reading no way to tell which one is lying.
  countTurnStarted();
  log.info("turn start", {
    task: id,
    project: project.id,
    agent: task.agent,
    generation: gen,
    origin: runContext?.origin ?? "user",
    resume: Boolean(sessionId),
  });

  // Persist + publish a failed turn's transcript line (with a recovery hint when
  // we know the fix), and — for a dead login — raise the instance-wide flag every
  // tab reads, published once per outage so a fleet of failing tasks can't spam
  // the banner. Returns true when the failure was an authentication failure, so
  // the caller records it for the queue decision below.
  const failTurn = (text: string): boolean => {
    publishTurnError(id, gen, text);
    if (!isAuthFailure(text)) return false;
    if (markAgentAuthBroken(task.agent, text, Date.now())) {
      publish(id, { type: "agent_auth", agent: task.agent, broken: true, reason: text });
    }
    return true;
  };
  try {
    // The setup below runs INSIDE the try on purpose: a throw here (SQLite I/O
    // error, disk full) must still hit the finally, or the turn never
    // unregisters and running never settles — the task would show "running"
    // forever and its queued follow-ups would never drain.
    //
    // Funnel: the first-ever turn on this instance (tutorial included — `seeded`
    // tells them apart). The settings flag makes it exactly-once across restarts.
    if (!getSetting("first_task_started")) {
      setSetting("first_task_started", String(startedAt));
    }

    if (syncNote) {
      const m = addMessage(id, gen, "system", syncNote);
      publish(id, { type: "notice", content: syncNote, msgId: m.id, generation: gen, ts: m.created_at });
    }

    const driver = getDriver(task.agent);
    // The pre-turn settings gate (issue #43). The agent has not started yet,
    // and whatever `.claude/settings.json` says at this instant is what its
    // hooks, permission-allow rules and env are for the whole turn — loaded
    // from disk before canUseTool exists to have an opinion. That file lives in
    // the worktree, so the previous turn could have written it, and the
    // fast-forward a few lines above could have brought it in from base.
    //
    // So: hash what the driver says it will load, and if it moved since the
    // version this task last ran under, park HERE. Deliberately the same
    // machinery as a tool prompt — same PermissionRequest, same ask registry,
    // same POST /answer route, same transcript row — because the answer means
    // the same thing and a second answering path is a second thing to get
    // wrong. The notice goes first so the transcript reads as a statement
    // followed by a question, and so the fact survives even if the card is
    // never answered.
    const watched = driver.watchedSettingsFiles ?? [];
    const settingsRoot = task.worktree_path || project.repo_path;
    const changes = watched.length && settingsRoot ? checkSettingsDrift(id, settingsRoot, watched) : [];
    if (changes.length) {
      const notice = settingsDriftNotice(changes);
      const nm = addMessage(id, gen, "system", notice);
      publish(id, { type: "notice", content: notice, msgId: nm.id, generation: gen, ts: nm.created_at });

      const request = settingsDriftRequest(
        `settings:${gen}:${startedAt}`,
        id,
        changes,
        PERMISSION_PROMPT_TIMEOUT_MS,
        PERMISSION_UNATTENDED_MS
      );
      const data: ToolData = { title: request.title, permission: { request } };
      const cm = addMessage(id, gen, "tool", JSON.stringify(data));
      toolMsgs[request.id] = { dbId: cm.id, data };
      openAsks.add(request.id);
      updateTask(id, { awaiting_input: 1 });
      publish(id, { type: "permission", request, msgId: cm.id, generation: gen, ts: cm.created_at });

      // The same settle the driver's permission_decided branch performs, done
      // here because this card was never on the driver's stream: nothing has
      // asked the agent for anything yet.
      const settle = (outcome: PermissionOutcome) => {
        data.permission = { request, outcome };
        updateMessage(cm.id, JSON.stringify(data));
        openAsks.delete(request.id);
        if (openAsks.size === 0) updateTask(id, { awaiting_input: 0 });
        publish(id, { type: "permission_decided", id: request.id, outcome, msgId: cm.id, generation: gen });
      };

      const waited = await waitForPermission({
        taskId: id,
        id: request.id,
        signal: abortController.signal,
        attendedMs: PERMISSION_PROMPT_TIMEOUT_MS,
        unattendedMs: PERMISSION_UNATTENDED_MS,
      });
      if ("aborted" in waited) {
        // Stopped while the card was open. Not a failure and not a refusal —
        // the finally below settles it as a stopped turn, and the baseline is
        // left alone so the next turn asks again.
        settle({ decision: "deny", auto: true, reason: "interrupted", note: DENIED_INTERRUPTED });
        return;
      }
      if ("expired" in waited) {
        // Nobody answered: a declared-unattended (scheduled) run settles
        // instantly, an unwatched one after the short grace. Adopting new agent
        // settings is not something an absent human can be taken to have
        // agreed to, so both refuse — and the schedule run settles `failed` off
        // the turnError below rather than reporting a quiet green "ran".
        const unattended = waited.expired === "unattended";
        settle({
          decision: "deny",
          auto: true,
          reason: waited.expired,
          note: unattended ? SETTINGS_DENIED_UNATTENDED : DENIED_TIMED_OUT,
        });
        settingsBlocked = true;
        turnError = settingsBlockedError(changes, unattended ? "unattended" : "timeout");
        publishTurnError(id, gen, turnError);
        return;
      }
      const { decision, note } = parseDecision(waited.answers);
      if (decision === "deny") {
        settle({ decision, note: note || undefined });
        settingsBlocked = true;
        turnError = settingsBlockedError(changes, "declined");
        publishTurnError(id, gen, turnError);
        return;
      }
      // Approved. The new version becomes what this task runs under, so the
      // next turn is silent until it changes again — an "always allow" would
      // have been a standing grant to whatever the file says NEXT, which is
      // the thing being gated, so there is no such offer on the card.
      acceptSettingsChanges(id, changes);
      // Recorded as allow_once whatever the client sent: with no scope offer on
      // the card, an "allow_always" answer has nothing to remember, and the
      // settled view would claim a rule that doesn't exist.
      settle({ decision: "allow_once" });
    }
    // Orphan-on-crash investigation (issue #14 item 2): both agent SDKs spawn
    // the claude/codex CLI as a plain (non-detached) child tied to THIS
    // abortController, not to server lifecycle. Verified against the
    // installed SDKs: @openai/codex-sdk passes `signal: <this controller's
    // signal>` straight to node's `child_process.spawn`, which Node kills on
    // abort natively; @anthropic-ai/claude-agent-sdk's transport schedules its
    // own SIGTERM-then-SIGKILL escalation off the same abortController, AND
    // separately registers a process-wide `exit` hook that SIGTERMs every
    // live session's child on ANY clean process exit (so even a bare
    // process.exit(0) already reaped Claude children before this file added
    // draining). So `drainActiveTurns()` aborting every live turn on
    // SIGTERM/SIGINT — the fix for item 1 above — already kills every live
    // agent child for a graceful shutdown; no separate pid-tracking/reap
    // machinery was added for that path. The one case nothing here covers is
    // a HARD kill of the server (SIGKILL/OOM/power loss): no code runs, so a
    // live child can outlive it. A lib/services.ts-style pid-column-plus-
    // boot-reap fix isn't available for that gap — unlike the services
    // supervisor, which spawns its own children and holds their `pid`,
    // neither agent SDK exposes the underlying child process (or its pid)
    // through any public/documented API, so persisting one would mean reading
    // private, minified SDK internals liable to break on every version bump.
    for await (const ev of driver.runTurn(task, project, userText, abortController, hooks)) {
      // This turn is producing something, whatever it is. One Map write, before
      // the branch ladder, so nothing added below can forget to do it — and it
      // is what makes the gaps BETWEEN these events the signal the idle mark is
      // derived from (lib/turnActivity.ts).
      markTurnActivity(id);
      // Persist first, then publish enriched with the DB message id — so a
      // snapshot taken at any instant plus the live tail never loses an event,
      // and clients can upsert by id instead of appending duplicates.
      if (ev.type === "session") {
        sessionId = ev.sessionId;
        opened = true;
        // Session is live — now it's officially started / in progress. And
        // whatever an earlier unattended run left unread is superseded: a turn
        // is underway again, so the row belongs under "In progress" rather
        // than in the ran-clean pile. Cleared HERE rather than at each launch
        // site because every turn passes through this one point, however it
        // was started (a message, a resume, the deferred-start sweep, the next
        // firing of the same schedule).
        updateTask(id, { started: 1, status: "in_progress", unread_run_at: 0 });
        // Persist this generation's agent session id for the project view.
        recordSession({ project_id: project.id, task_id: id, generation: gen, claude_session_id: sessionId });
        publish(id, ev);
      } else if (ev.type === "model") {
        // Persist the model the SDK actually ran so the badge survives reloads.
        updateTask(id, { resolved_model: ev.model });
        publish(id, ev);
      } else if (ev.type === "assistant") {
        const m = addMessage(id, gen, "assistant", ev.content);
        publish(id, { ...ev, msgId: m.id, generation: gen, ts: m.created_at });
      } else if (ev.type === "tool") {
        // A file the call wrote is stored worktree-RELATIVE, and only when it
        // is inside the worktree: that's the form the file route takes, and a
        // path it would refuse must not grow a Collaborate button.
        const file = ev.file ? worktreeRelative(task.worktree_path, ev.file) ?? undefined : undefined;
        const data: ToolData = { title: ev.title, name: ev.name, detail: ev.detail, peek: ev.peek, diff: ev.diff, file };
        const m = addMessage(id, gen, "tool", JSON.stringify(data));
        toolMsgs[ev.id] = { dbId: m.id, data };
        // A suggest_task call gets a card settled onto it the moment the tool
        // reports what it filed (below) — queue the row so a parallel batch of
        // suggestions lands one card each, in the order the calls were made.
        if (isSuggestTaskTool(ev.name)) pendingSuggestCalls.push(ev.id);
        publish(id, { ...ev, file, msgId: m.id, generation: gen, ts: m.created_at });
      } else if (ev.type === "tool_result") {
        const t = toolMsgs[ev.id];
        if (t) {
          // A suggest_task row can have been given its card OUT OF BAND while
          // the call was in flight — the stdio bridge's endpoint writes
          // straight to the message row, since a Codex session's MCP client
          // never touches this event stream. Our in-memory copy predates that
          // write, so re-read it before stamping the result over the top;
          // otherwise the card the bridge just attached disappears one event
          // later. Narrowed to suggest_task rows so an ordinary tool_result
          // still costs no read.
          if (isSuggestTaskTool(t.data.name) && !t.data.suggestion) {
            try {
              const fresh = JSON.parse(getMessage(t.dbId)?.content ?? "{}") as ToolData;
              if (fresh.suggestion) t.data.suggestion = fresh.suggestion;
            } catch { /* keep what we have */ }
          }
          t.data.result = ev.content;
          t.data.isError = ev.isError;
          if (ev.peek) t.data.peek = ev.peek;
          updateMessage(t.dbId, JSON.stringify(t.data));
          publish(id, { ...ev, msgId: t.dbId, generation: gen });
        }
      } else if (ev.type === "ask") {
        // Persist the question (with its id) so a page reload can re-render
        // the picker and still answer the correct tool_use.
        const data: ToolData = { title: "Question for you", ask: { id: ev.id, questions: ev.questions } };
        const m = addMessage(id, gen, "tool", JSON.stringify(data));
        toolMsgs[ev.id] = { dbId: m.id, data };
        openAsks.add(ev.id);
        // The turn is still live but parked on the user — flag it so the task
        // list / project badges surface "Needs your input" right now, not only
        // once the turn fully ends. Persisted BEFORE publishing so reloads and
        // the global /api/events stream (which re-reads the row per event) agree.
        updateTask(id, { awaiting_input: 1 });
        publish(id, { ...ev, msgId: m.id, generation: gen, ts: m.created_at });
      } else if (ev.type === "ask_answered") {
        const t = toolMsgs[ev.id];
        if (t) {
          t.data.ask = { id: t.data.ask?.id ?? ev.id, questions: t.data.ask?.questions ?? [], answers: ev.answers };
          updateMessage(t.dbId, JSON.stringify(t.data));
          // Answered — but only drop the flag once every parked ask is settled;
          // Claude resumes work in the same turn once none are waiting. (A
          // later turn-end re-flags it via the finally block.)
          openAsks.delete(ev.id);
          if (openAsks.size === 0) updateTask(id, { awaiting_input: 0 });
          publish(id, { ...ev, msgId: t.dbId, generation: gen });
        }
      } else if (ev.type === "permission") {
        // A tool call parked on the user's approval (the canUseTool gate under
        // acceptEdits / plan). Same deal as an ask: persist the
        // request with its id so a reload re-renders an answerable card, and
        // flag the task now — the turn is live but blocked on a human.
        const data: ToolData = { title: "Permission needed", permission: { request: ev.request } };
        const m = addMessage(id, gen, "tool", JSON.stringify(data));
        toolMsgs[ev.request.id] = { dbId: m.id, data };
        openAsks.add(ev.request.id);
        updateTask(id, { awaiting_input: 1 });
        publish(id, { ...ev, msgId: m.id, generation: gen, ts: m.created_at });
      } else if (ev.type === "permission_decided") {
        const t = toolMsgs[ev.id];
        if (t && t.data.permission) {
          t.data.permission = { request: t.data.permission.request, outcome: ev.outcome };
          updateMessage(t.dbId, JSON.stringify(t.data));
          // Shares openAsks with the question cards on purpose: the flag drops
          // only once NOTHING is waiting on the user, whichever kind it was.
          openAsks.delete(ev.id);
          if (openAsks.size === 0) updateTask(id, { awaiting_input: 0 });
          if (ev.outcome.reason === "unattended") unattendedDeny = true;
          publish(id, { ...ev, msgId: t.dbId, generation: gen });
        }
      } else if (ev.type === "permission_denied") {
        // The CLI refused this call itself, before canUseTool was consulted.
        // Nothing was ever parked on the user, so openAsks / awaiting_input are
        // deliberately untouched — this is a card that arrives already settled.
        //
        // It settles onto the tool message the call already created, reusing
        // what describeToolUse derived for it: the card's job is to show the
        // input the user never got to judge, and it belongs WITH the call
        // rather than beside it.
        const outcome: PermissionOutcome = {
          decision: "deny",
          auto: true,
          reason: "blocked",
          blockedBy: ev.reasonType,
          note: ev.reason,
        };
        const t = toolMsgs[ev.id];
        if (t) {
          t.data.permission = {
            request: { id: ev.id, tool: ev.tool, title: t.data.title, detail: t.data.detail ?? "", diff: t.data.diff, expiresAt: 0 },
            outcome,
          };
          updateMessage(t.dbId, JSON.stringify(t.data));
          publish(id, { ...ev, msgId: t.dbId, generation: gen });
        } else {
          // No tool message to settle onto: the refused call happened inside a
          // subagent (the SDK's agent_id), whose tool_use blocks never surface
          // on this stream. Give it its own card so the refusal is still seen —
          // without the input, which we genuinely don't have.
          const request = {
            id: ev.id,
            tool: ev.tool,
            title: ev.agentId ? `${ev.tool} (in a subagent)` : ev.tool,
            detail: "",
            expiresAt: 0,
          };
          const data: ToolData = { title: request.title, permission: { request, outcome } };
          const m = addMessage(id, gen, "tool", JSON.stringify(data));
          toolMsgs[ev.id] = { dbId: m.id, data };
          publish(id, { ...ev, msgId: m.id, generation: gen, ts: m.created_at });
        }
      } else if (ev.type === "background_pending") {
        // The model's turn ended but its run_in_background work is still
        // going — or a scheduled wakeup is pending — and the driver is holding
        // the session open for it (optionally bounded — see
        // BACKGROUND_LINGER_MS). The turn is NOT over: running stays 1, the
        // slot stays claimed (so Stop, the SIGTERM drain, and message queueing
        // all keep working), and awaiting_input stays 0 — nothing here needs
        // the user, so this state is excluded from the "N need you" pill by
        // construction. The flag is what lets the UI say "working in
        // background" instead of a generic live spinner, and the note is what
        // it's waiting on ("waiting to wake at 12:00") — persisted on the row
        // because every surface that shows it re-reads the row rather than
        // holding the event. Persisted before publishing, like every state the
        // global stream re-reads.
        updateTask(id, { background_pending: 1, background_note: ev.note });
        publish(id, ev);
        // The composer told the user a follow-up parked mid-turn would be
        // "sent at turn end" — and the model's turn HAS ended: a
        // linger is the session holding its input open for work nobody is
        // waiting on. So hand the oldest parked message to it now rather than
        // leaving it until the linger closes, which by default has no deadline
        // at all. One per linger entry, exactly as the end-of-turn drain pops
        // one: if the work is still running when that turn ends, this fires
        // again on the next entry and the queue empties in order.
        //
        // Deliberately NOT startResumeTurn's path: no worktree fast-forward,
        // because the session is already open in that checkout and rewriting
        // files under a running agent is the one thing the sync is careful
        // never to do. Generation-guarded like every other write in this loop.
        const parked = listPendingMessages(id)[0];
        if (parked && parked.generation === gen && sendTurnInput(id, parked.content)) {
          deletePendingMessage(parked.id, id);
          // Drop its queued bubble — recordSentMessage re-echoes it as the
          // ordinary user message it has now become.
          publish(id, { type: "dequeued", msgId: parked.id });
          recordSentMessage(id, gen, parked.content);
        }
      } else if (ev.type === "background_resumed") {
        // A lingered-on task settled and its notification woke the model — a
        // continuation turn is about to stream with no user message behind it.
        // Persist the CLI's own summary as the system line that explains the
        // unprompted output; without it the transcript shows the model talking
        // to nobody.
        updateTask(id, { background_pending: 0, background_note: "" });
        const note = `⏵ ${ev.summary || `Background task ${ev.status}`}`;
        const m = addMessage(id, gen, "system", note);
        publish(id, { ...ev, msgId: m.id, generation: gen, ts: m.created_at });
      } else if (ev.type === "suggested") {
        // The suggestion is already committed; what happens here is only about
        // where the user SEES it. It settles onto the suggest_task tool row the
        // call created — the same move an already-decided permission card makes
        // above — so the proposal is reviewable in the session that made it
        // instead of only in a tray the user has to go and find.
        //
        // Nothing but the two ids is persisted: the card re-reads the task on
        // every render, so a transcript reloaded next week shows what the row
        // is NOW (started, accepted, withdrawn, deleted) rather than the offer
        // that was true the moment the tool ran. A driver that reports no task
        // id, or a suggestion with no call to settle onto (the mock's directive
        // path before it grew a tool row), falls through to a bare publish —
        // the tray still refreshes, exactly as it did before.
        // Only a report that names its task consumes a queued call: a driver
        // that omits the id has no card to place, and popping the queue for it
        // would offset every later suggestion onto the wrong row.
        const callId = ev.taskId ? pendingSuggestCalls.shift() : undefined;
        const t = callId ? toolMsgs[callId] : undefined;
        if (ev.taskId && t) {
          t.data.suggestion = { taskId: ev.taskId, projectId: ev.projectId };
          updateMessage(t.dbId, JSON.stringify(t.data));
          publish(id, { ...ev, msgId: t.dbId, generation: gen });
        } else {
          publish(id, ev);
        }
      } else if (ev.type === "usage") {
        // A turn against an overridden endpoint (lib/agentEnv.ts) is not
        // Anthropic or OpenAI spend, whatever the driver's own figure says:
        // Claude Code prices whatever model id it was TOLD, and the Codex
        // estimate prices an unknown id at the CLI-default family. But "not
        // vendor spend" splits in two, and folding the halves together is what
        // this decides once, HERE, before the ledger, the running total and the
        // live chip all read it:
        //
        //  - a LOCAL model server (Ollama, LM Studio, anything on this machine
        //    or this network) genuinely bills nothing, so 0 is a measurement;
        //  - a CUSTOM base URL is free text plus an optional token, as likely to
        //    be OpenRouter, Together, Fireworks or a Bedrock proxy as anything
        //    free. Writing 0 there under-reports a real bill and writing the
        //    driver's figure over-reports a catalog that isn't the one being
        //    charged. So it is recorded as UNKNOWN (null) and left out of every
        //    total, rather than either lie.
        //
        // The kind comes from `taskProvider`, the same call the session header's
        // provider badge renders from, so the ledger and the badge cannot
        // disagree about which endpoint a turn ran against. Tokens are kept
        // whichever way it lands: an unpriced turn still filled a context window.
        const provider = taskProvider(project, task);
        const cost = provider.pricing === "vendor" ? ev.usage.cost_usd : provider.pricing === "free" ? 0 : null;
        const usage: LedgerUsage = { ...ev.usage, cost_usd: cost };
        addUsage({ project_id: project.id, task_id: id, generation: gen, agent: task.agent, provider: provider.host, usage });
        for (const k of Object.keys(spent) as (keyof typeof spent)[]) spent[k] += usage[k] ?? 0;
        if (cost === null) unpricedTurns++;
        // The wire event stays TurnUsage-shaped, and the client ADDS it to the
        // task's running total, so an unpriced turn contributes 0 there for the
        // same reason SUM() skips its NULL — with `unpriced` alongside so the
        // client bumps the row's unpriced_turns and marks the total as a floor
        // straight away, rather than showing a stalled figure until refetch.
        publish(id, { ...ev, usage: { ...ev.usage, cost_usd: cost ?? 0 }, unpriced: cost === null });
      } else if (ev.type === "context") {
        // Measured occupancy, persisted as it arrives (not at turn end) so a
        // Stop or a crash mid-turn doesn't lose what the window actually
        // holds. Generation-guarded like the settle in finally: a /clear that
        // raced this turn has reset the row for a fresh window, and a late
        // report from the old session must not land on it.
        const current = getTask(id);
        if (current && current.generation === gen) updateTask(id, { context_measured: ev.tokens });
        publish(id, ev);
      } else if (ev.type === "error") {
        // A soft error emitted mid-stream (e.g. "Run ended: …"). Marks the turn
        // failed and publishes the persisted form, so live viewers
        // and snapshot replays render the identical line (with a recovery hint
        // on context overflow / a dead login).
        turnError = ev.content;
        if (failTurn(ev.content)) authFailure = ev.content;
        else if (isUsageLimit(ev.content)) usageLimitFailure = ev.content;
      } else if (ev.type === "notice") {
        // A quiet system note emitted mid-turn (e.g. expose_service confirming a
        // live URL). Persist it so a reload still shows the line, like syncNote.
        const m = addMessage(id, gen, "system", ev.content);
        publish(id, { ...ev, msgId: m.id, generation: gen, ts: m.created_at });
      } else if (ev.type === "done") {
        sessionId = ev.sessionId;
        publish(id, ev);
      } else {
        publish(id, ev);
      }
    }
  } catch (err) {
    // Persisted (not just streamed): with no request attached, nobody may be
    // listening when this fires — the transcript must carry it.
    turnError = err instanceof Error ? err.message : String(err);
    if (failTurn(turnError)) authFailure = turnError;
    else if (isUsageLimit(turnError)) usageLimitFailure = turnError;
  } finally {
    // NOTE: this whole block is synchronous (better-sqlite3, in-memory pub/sub),
    // so nothing can interleave with it — the registry slot is either handed off
    // or released below, never left in a half-state a POST could race.
    //
    // A Stop deletes our registry entry immediately (hasTurn goes false), so a
    // new POST can claim the slot and start a successor turn while this one is
    // still unwinding. When that has happened, the successor owns the task row,
    // the pending queue, and turn_end — settling any of them here would clobber
    // a live turn's state (running flipped off, its queued follow-ups eaten).
    const superseded = hasTurn(id) && !ownsTurn(id, abortController);
    // Any permission card still open never got a decision — the turn died
    // (Stop, a crash, a driver error) with the gate parked. Settle it here or
    // it renders as answerable forever, and answering it would resolve nothing.
    // Best-effort: this is the finally, and the task row may already be gone.
    for (const openId of openAsks) {
      const t = toolMsgs[openId];
      if (!t?.data.permission || t.data.permission.outcome) continue;
      const outcome = { decision: "deny" as const, auto: true, reason: "interrupted" as const, note: DENIED_INTERRUPTED };
      t.data.permission = { request: t.data.permission.request, outcome };
      try {
        updateMessage(t.dbId, JSON.stringify(t.data));
        publish(id, { type: "permission_decided", id: openId, outcome, msgId: t.dbId, generation: gen });
      } catch (err) {
        log.error("could not settle open permission card", { task: id, err });
      }
    }
    // A Stop isn't a failure (Claude swallows the abort), so it reports as a
    // completed-but-stopped turn.
    const stopped = abortController.signal.aborted;
    // Guard against a generation boundary crossed mid-turn (a /clear while this
    // turn was live). /clear ends this generation and resets the task row —
    // session_id=null, started=0, running=0 — for a fresh context. If we then
    // wrote our sessionId back here we'd RESURRECT the session /clear just
    // nulled and re-arm running/awaiting_input, silently defeating /clear and
    // double-injecting the old context on the next send. So only settle the
    // task row when it's still on the generation this turn actually ran in.
    const current = getTask(id);
    const generationAdvanced = !current || current.generation !== gen;
    // If the session never opened, keep the task retryable (started stays 0).
    // A turn that actually ran and ended mid-task — whether it finished on its
    // own or was Stopped — is now waiting on the user, so flag awaiting_input
    // (cleared on the next send / done) leaving it cleanly resumable.
    //
    // A scheduled turn that finished cleanly is NOT waiting on anybody: nobody
    // asked for it, and awaiting_input feeds the shared NEEDS_YOU predicate
    // behind the "N need you" pill. Left at 1 it would park a permanent,
    // unanswerable item there every single morning, which is how a user learns
    // to ignore the pill. Success is quiet; a scheduled turn that FAILED still
    // raises its hand exactly like any other.
    // An interaction auto-denied by a path that doesn't emit a permission event
    // — the Codex ask_user bridge (lib/agentTools.ts), which records it on the
    // context instead. Folded in here, before anything below reads the flag, so
    // "the turn was cut short because nobody was there" has exactly one meaning
    // regardless of which agent hit it.
    if (runContext?.deniedInteractions) unattendedDeny = true;
    // Success is quiet — but only actual success. A turn whose tool calls (or
    // questions) were auto-denied because nobody is watching did NOT do the job
    // it was scheduled for; it stopped partway with the work half done. Reported
    // as a quiet green "ran", that is precisely the silent skip this feature
    // exists to make impossible, so it raises its hand like any other failure.
    const scheduledOk = runContext?.origin === "schedule" && !turnError && !stopped && !unattendedDeny;

    // Turn lifecycle, line 2 of 2 (issue #16): what happened, how long it took,
    // what it cost. The outcome ladder is deliberately the SAME one the
    // schedule-run settle below uses — a run recorded `failed` in the ledger
    // and logged `ok` would be worse than no line at all — with `interrupted`
    // meaning the agent session never opened, so the turn produced nothing.
    // Tokens come from the accumulator, not a task_usage read: an agent that
    // reported no usage (a driver that doesn't, a turn that died before its
    // result message) logs zeros, which is the truth about THIS turn rather
    // than the task's running total.
    const outcome = stopped ? "stopped" : turnError || unattendedDeny ? "failed" : opened ? "ok" : "interrupted";
    // The counter takes the SAME word: TurnOutcome is that ladder as a type, so
    // a fifth outcome added here has to be given a series too rather than
    // quietly landing in no bucket at all.
    countTurnFinished(outcome);
    log[outcome === "failed" ? "error" : outcome === "interrupted" ? "warn" : "info"](`turn ${outcome}`, {
      task: id,
      project: project.id,
      agent: task.agent,
      generation: gen,
      origin: runContext?.origin ?? "user",
      ms: Date.now() - startedAt,
      tokens_in: spent.input_tokens,
      tokens_out: spent.output_tokens,
      cache_read: spent.cache_read_tokens,
      cache_write: spent.cache_creation_tokens,
      tokens_total: spent.input_tokens + spent.output_tokens + spent.cache_read_tokens + spent.cache_creation_tokens,
      // Omitted entirely when every usage report this turn was unpriced: a
      // logged 0 would be read as a measurement, and there isn't one.
      cost_usd: unpricedTurns && !spent.cost_usd ? undefined : Math.round(spent.cost_usd * 10000) / 10000,
      unpriced_turns: unpricedTurns || undefined,
      // Only when they say something: `superseded` means a Stop released this
      // turn's slot and a successor claimed it, so this line describes a turn
      // that settled nothing; `error` is the whole reason the line is at error
      // level.
      superseded: superseded || undefined,
      error: turnError ? String(turnError).slice(0, 300) : undefined,
    });
    if (!generationAdvanced && !superseded) {
      // background_pending settles with running: however the linger ended (all
      // work done, expiry, Stop), the session that owned the work is gone.
      //
      // A clean scheduled run rests on `unread_run_at` — the mark that says
      // "this ran, on its own, and nobody has looked at it yet". Quiet like
      // awaiting_input isn't (it's outside the NEEDS_YOU predicate, so the "N
      // need you" pill never gains a daily item nobody can answer), but still a
      // state with a way OUT of it: the board draws these in their own group
      // and acknowledging one is an ordinary status write. Without it the task
      // sat at running=0 / awaiting_input=0 / status=in_progress, which is
      // indistinguishable from live work and which nothing ever moved, so every
      // firing left one more permanent "In progress" row behind (issue #28).
      // A turn the settings gate refused never opened a session, so the clause
      // below would leave it flagged for nothing — and it is precisely the case
      // that needs a person: the way out is reading a diff and deciding, which
      // is what the "N need you" pill is for. Including the scheduled case,
      // where the alternative is a run that refused itself at 08:30 and said so
      // only in a ledger nobody opens.
      updateTask(id, {
        running: 0, background_pending: 0, background_note: "", session_id: sessionId,
        awaiting_input: (opened && !scheduledOk) || settingsBlocked ? 1 : 0,
        // Only a run that actually opened a session produced anything to read.
        ...(scheduledOk && opened ? { unread_run_at: Date.now() } : {}),
      });
    }

    // Settle the schedule run from HERE, because this is the only place that
    // knows the outcome: whether a session opened, whether it errored, whether
    // it was stopped. Polling task.running from outside cannot reconstruct it.
    if (runContext?.scheduleRunId) {
      const status = stopped
        ? "stopped"
        : turnError || unattendedDeny
          ? "failed"
          : opened ? "succeeded" : "interrupted";
      const detail = turnError && !stopped
        ? String(turnError).slice(0, 500)
        : unattendedDeny && !stopped
          ? SCHEDULE_UNATTENDED_DETAIL
          : !opened ? "the agent session never opened" : "";
      try {
        settleRun(runContext.scheduleRunId, status, detail);
      } catch (err) {
        log.error("could not settle schedule run", { task: id, run: runContext.scheduleRunId, err });
      }
    }
    if (runContext) clearRunContext(id, runContext);
    // Keyed by (task_id, generation), so this settles THIS generation's session
    // row and never touches the fresh generation — safe to run either way.
    if (opened) endSession(id, gen);

    // A turn that actually ran is the strongest possible proof the agent's login
    // works — stronger than `claude auth status`, since it exercised the same
    // path a real turn takes. So clear any broken-connection flag left by an
    // earlier failure and tell every tab, which is how the banner comes down
    // after the user reconnects in a different window (or the credential
    // refreshed itself). Publishes only when the flag was actually set.
    if (!turnError && opened && clearAgentAuthBroken(task.agent)) {
      publish(id, { type: "agent_auth", agent: task.agent, broken: false, reason: null });
    }

    // A Stop — or a /clear that advanced the generation out from under us —
    // discards the parked queue: those follow-ups were lined up behind the train
    // of thought the user just interrupted (or the context they just cleared),
    // so running them now would be surprising and would leak old-generation
    // work into the new one. Otherwise dequeue the oldest follow-up and run it
    // as the next turn, continuing the session without a gap.
    let continued = false;
    if (superseded) {
      // The successor turn owns the queue and will emit its own turn_end; our
      // own registry entry is long gone (the Stop deleted it), so there is
      // nothing left to release either.
      continued = true;
    } else if (abortController.signal.aborted || generationAdvanced) {
      for (const p of clearPendingMessages(id)) publish(id, { type: "dequeued", msgId: p.id });
    } else if (authFailure || usageLimitFailure || unattendedDeny || settingsBlocked) {
      // The login (or the quota, or the absent human, or an unapproved settings
      // change) is what failed — not the work: draining now would run each
      // follow-up straight into the same authentication error / spent limit /
      // unanswerable permission prompt / identical settings card, emptying the
      // queue and stacking identical walls of red for messages that never
      // actually ran. Leave them parked (they're rows in pending_messages, so
      // they survive a reload and still render as queued bubbles) and say so
      // once. They drain normally at the end of the next turn, after a
      // reconnect / once the limit resets / once you're back.
      const parked = listPendingMessages(id).length;
      if (parked) {
        const when = authFailure
          ? "once you reconnect"
          : usageLimitFailure
            ? "once the limit resets"
            : settingsBlocked
              ? "once you've approved the settings change"
              : "when you send the next message";
        const note = `ℹ ${parked} queued message${parked === 1 ? "" : "s"} kept in the queue: ${parked === 1 ? "it runs" : "they run"} ${when}.`;
        // Best-effort: the task row can be gone by now (deleted mid-turn), and a
        // FOREIGN KEY throw here would escape the detached run()'s finally.
        try {
          const m = addMessage(id, gen, "system", note);
          publish(id, { type: "notice", content: note, msgId: m.id, generation: gen, ts: m.created_at });
        } catch (err) {
          log.error("could not persist parked-queue notice (row gone?)", { task: id, err });
        }
      }
    } else {
      // Hand the occupancy slot to the follow-up FIRST — an atomic swap of our
      // controller for a fresh one — so hasTurn never reads false between this
      // turn and the next. (It used to: unregister-then-launch left a window
      // where a POST could start a parallel turn against the same session.)
      const nextController = handoffTurn(id, abortController);
      if (nextController) {
        const next = popPendingMessage(id);
        const fresh = next ? getTask(id) : undefined;
        // Re-read the project at dequeue time, not the snapshot captured at the
        // START of the turn we're finishing. The base branch, repo_path, or
        // context may have changed while this turn ran; the dequeued follow-up
        // fast-forwards against its resolved base branch / repo_path and seeds its system
        // prompt from project.context, so a stale snapshot would sync it to the
        // wrong base and run it with outdated context.
        const freshProject = fresh ? getProject(fresh.project_id) : undefined;
        if (next && fresh && freshProject) {
          // Drop its "queued" bubble — startResumeTurn re-echoes it as a normal
          // user message. running stays on across the handoff, so we deliberately
          // do NOT publish turn_end here; the next turn's own finally will.
          publish(id, { type: "dequeued", msgId: next.id });
          continued = true;
          // The follow-up writes into the same worktree the merge/sync routes
          // rewrite with multi-second git ops, so launch under the same
          // per-task lock those routes hold — and re-check the world once we
          // have it, because the wait can be long. The handoff slot above
          // stays claimed the whole time, so no POST can start a parallel
          // turn while we queue for the lock.
          void withTaskLock(id, async () => {
            const cur = getTask(id);
            // Task deleted or /clear'd while we waited — a cleared generation
            // discards its queue, and this popped message belongs to the old
            // one. (Their abortTurn already released the handoff slot; the
            // unregister is a defensive no-op then.)
            if (!cur || cur.generation !== gen) {
              unregisterTurn(id, nextController);
              return;
            }
            // Re-read the project too: it was already refreshed at dequeue time
            // (see freshProject above), but the lock wait can be long — a merge
            // may have run, or the project may have been deleted, in between.
            const curProject = getProject(cur.project_id);
            if (!curProject) {
              unregisterTurn(id, nextController);
              publishTurnError(id, gen, "Project was deleted; queued follow-up cancelled.");
              publish(id, { type: "turn_end" });
              return;
            }
            if (!ownsTurn(id, nextController)) {
              // A Stop landed while we waited on the lock: it tripped and
              // released the handoff slot (and a successor turn may have
              // claimed it since). Stop discards queued follow-ups, so drop
              // this one — it was parked before the press. With no successor,
              // settle the UI with the turn_end the handoff had deferred; a
              // live successor emits its own.
              if (!hasTurn(id)) publish(id, { type: "turn_end" });
              return;
            }
            // Same hooks the turn we're finishing ran under: a drained
            // follow-up is the same session continuing, so its tool calls must
            // reach the same launcher (nobody re-supplies them from outside).
            await startResumeTurn(cur, curProject, next.content, nextController, hooks);
          }).catch((err) => {
            // Failsafe: if launching the queued turn fails, release its slot,
            // surface the error, and settle the task so it doesn't hang in a
            // running-but-dead state.
            unregisterTurn(id, nextController);
            // publishTurnError persists + publishes without ever rethrowing — a
            // plain addMessage here could hit a FOREIGN KEY error (task deleted
            // while we waited on the lock) and, thrown from inside this .catch,
            // become an unhandled rejection that crashes the server.
            publishTurnError(id, gen, err instanceof Error ? err.message : String(err));
            updateTask(id, { running: 0, background_pending: 0, background_note: "", awaiting_input: opened ? 1 : 0 });
            publish(id, { type: "turn_end" });
          });
        } else {
          if (next && fresh && !freshProject) {
            // Project was deleted mid-turn: with no base branch / repo_path /
            // context left, the follow-up can't be safely synced or run. Drop
            // its "queued" bubble, surface the cancellation, and fall through
            // to the turn_end below (continued stays false) leaving the task
            // settled.
            publish(id, { type: "dequeued", msgId: next.id });
            publishTurnError(id, gen, "Project was deleted; queued follow-up cancelled.");
          }
          // Nothing queued, or the task/project row is gone — free the slot we
          // just claimed for the handoff.
          unregisterTurn(id, nextController);
        }
      }
    }
    if (!continued) {
      // Release occupancy only now, at the very end of this synchronous block —
      // a no-op if a Stop already deleted the entry or a handoff replaced it.
      unregisterTurn(id, abortController);
      // The idle clock only describes a LIVE turn, so it retires with the slot.
      // Deliberately not on the handoff/superseded paths: the successor turn is
      // the same session continuing, and it re-stamps on entry anyway.
      forgetTurnActivity(id);
      // Emitted after the task row settles, so a client refreshing on turn_end
      // reads the final running/awaiting_input state. Skipped when a queued
      // follow-up or a successor turn is taking over — that turn will emit its
      // own turn_end.
      publish(id, { type: "turn_end" });
    }
  }
}
