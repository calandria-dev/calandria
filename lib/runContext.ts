// Why a turn is running, and whether anyone can answer it.
//
// The permission gate (lib/permissions.ts) has always inferred "is a human
// around?" from watcherCount() — presence, not intent. That is a decent
// heuristic for a turn the user launched, and the wrong question entirely for a
// scheduled one: a tab open on a second monitor at 08:30 would let a card park
// for the full attended cap on a turn nobody asked for and nobody is reading.
//
// So a scheduled turn says so explicitly. The runner owns the entry's lifetime
// (registered as the turn starts, cleared in its finally), keyed by task id —
// the same globalThis-on-a-single-process pattern as lib/abort.ts and
// lib/asks.ts. Deliberately a named shape rather than a bare boolean so the
// planned RunContext work (task S6asJLbDQpfWp_u3pDpEC) can widen it in place.
//
// No DB, no SDK — pinned by tests/importGraph.test.ts.

export type RunOrigin = "user" | "dependency" | "schedule";

export interface RunContext {
  origin: RunOrigin;
  /**
   * "deny" = settle any permission OR ask request at once instead of parking.
   *
   * Both halves are honored: lib/permissions.ts's waitForPermission() for the
   * canUseTool gate, and the AskUserQuestion paths — the Claude driver's
   * PreToolUse hook and the MCP bridge's ask_user (lib/agentTools.ts). An ask
   * is the more dangerous of the two under a schedule, because it fires in
   * EVERY permission mode (bypassPermissions short-circuits the gate but not
   * the hook), and parking one holds the turn slot open indefinitely — which
   * turns every future occurrence of that schedule into `skipped_overlap`.
   */
  interactionPolicy: "interactive" | "deny";
  /** The schedule_runs row this turn belongs to, so the runner can settle it. */
  scheduleRunId?: string;
  /**
   * How many requests this turn auto-denied for want of a human. The permission
   * gate reports its own through a `permission_decided` event, but the ask_user
   * bridge has no event stream of its own, so it records here and the runner
   * folds this in when it settles the run. A denied interaction means the turn
   * stopped short of the job, and the run must not read as a success.
   */
  deniedInteractions?: number;
}

/** What a scheduled firing runs under. */
export const SCHEDULED_RUN_CONTEXT: RunContext = { origin: "schedule", interactionPolicy: "deny" };

declare global {
  // eslint-disable-next-line no-var
  var __calandriaRunContexts: Map<string, RunContext> | undefined;
}

const contexts = (): Map<string, RunContext> => (global.__calandriaRunContexts ??= new Map());

export function setRunContext(taskId: string, ctx: RunContext): void {
  contexts().set(taskId, ctx);
}

/**
 * Drop the entry, but only if `ctx` is still the live one. A turn that settles
 * late must not wipe the context of the turn that replaced it (the same
 * identity check unregisterTurn() makes in lib/abort.ts). Omit `ctx` to clear
 * unconditionally.
 */
export function clearRunContext(taskId: string, ctx?: RunContext): void {
  if (ctx && contexts().get(taskId) !== ctx) return;
  contexts().delete(taskId);
}

export const getRunContext = (taskId: string): RunContext | undefined => contexts().get(taskId);

/** True when this turn must never park on a human. */
export const interactionDenied = (taskId: string): boolean =>
  contexts().get(taskId)?.interactionPolicy === "deny";

/**
 * Record that something was auto-denied because nobody is watching. A no-op for
 * an ordinary turn (no context registered), so callers need no second check.
 * The runner reads the count when it settles the schedule run.
 */
export function recordUnattendedDenial(taskId: string): void {
  const ctx = contexts().get(taskId);
  if (ctx) ctx.deniedInteractions = (ctx.deniedInteractions ?? 0) + 1;
}

/**
 * What the model is told when its question can't be asked. Written FOR the
 * model: it has to stop and summarize rather than guess an answer or retry the
 * same question in a loop for the rest of the turn.
 */
export const UNATTENDED_ASK_DENIAL =
  "This is a scheduled run: nobody is watching it, so the question cannot be answered and was " +
  "declined automatically. Do not ask again. Continue with whatever you can do without an answer, " +
  "using the most conservative reasonable assumption, and if that leaves the task blocked, stop and " +
  "state exactly what you needed to know — the user will pick it up when they return.";

/** The same fact, written for the human reading the transcript afterwards. */
export const UNATTENDED_ASK_NOTE =
  "Nobody is watching this scheduled run, so the question was declined automatically and the agent " +
  "was told to carry on without an answer.";
