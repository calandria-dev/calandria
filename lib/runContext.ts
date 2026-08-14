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
  /** "deny" = settle any permission/ask request at once instead of parking. */
  interactionPolicy: "interactive" | "deny";
  /** The schedule_runs row this turn belongs to, so the runner can settle it. */
  scheduleRunId?: string;
}

/** What a scheduled firing runs under. */
export const SCHEDULED_RUN_CONTEXT: RunContext = { origin: "schedule", interactionPolicy: "deny" };

declare global {
  // eslint-disable-next-line no-var
  var __orchRunContexts: Map<string, RunContext> | undefined;
}

const contexts = (): Map<string, RunContext> => (global.__orchRunContexts ??= new Map());

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
