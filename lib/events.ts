// In-process pub/sub for live task turn events.
//
// The detached turn runner (lib/runner.ts) publishes every event it persists;
// any number of GET /messages SSE streams subscribe by task id and relay them
// to connected clients. Single Node process, so an in-memory map is enough —
// kept on globalThis so it survives dev HMR module reloads (same pattern as
// lib/abort.ts / lib/asks.ts).

import type { AgentAuthEvent, GlobalTaskEvent, TaskStreamEvent } from "./types";
import type { NotificationPayload } from "./notifications/types";

// Lifecycle facts published by mutation ROUTES rather than the runner — a
// manual status PATCH or /clear settling the task row (task_updated), a task
// hard-delete (task_deleted), or a task re-parented to another project
// (task_moved). Without them those mutations are silent on the bus, so every
// other tab's "needs you" badges keep counting a task the server already
// settled (or deleted). They're not transcript detail, so they go to GLOBAL
// listeners only (publishGlobal) — per-task /messages streams never see them.
// task_deleted carries its project id + freshly recomputed awaiting count
// itself: by the time a listener sees it the row is gone, so the usual
// re-read-the-task enrichment (GET /api/events) is impossible. tasks_moved
// carries BOTH ends because the rows only remember where they landed, and the
// trays they left have to lose them. It is plural even for one task: moving a
// selection is one event, so eleven misfiled tasks cost every other tab one
// re-sync instead of eleven, and there's one shape to handle either way.
// task_edited is the wider cousin of task_updated: the row's user-visible
// fields (title, description, priority, dependency edges, …) changed, not just
// the status/awaiting pair the coarse wire payload carries. Listeners can't
// patch what isn't on the wire, so it tells them to refetch the row instead.
// Both writers publish it — the user editing a task (PATCH /api/tasks/[id]) and
// the `update_task` agent tool (lib/agentTools.ts updateTaskForAgent, which may
// be announcing a row other than the calling task's) — and it
// SUPERSEDES task_updated when one write is both (a refetch settles the status
// too, so the pair would be a duplicate).
// runbooks_changed is task_edited's project-keyed cousin: a project's saved
// runbooks were created, edited, copied into or deleted from. No task row is
// involved AT ALL — not even an arbitrary one to key the bus by, so its
// publishers pass "" — and the card refetches wholesale, so like task_deleted
// it carries its own project id, BYPASSES the relay's re-read-the-task
// enrichment, and says only "go again".
// notification is the odd one out and knows it: not a fact about a row that
// listeners should re-read, but a message COMPOSED for a human — the payload is
// already final by the time it is published (lib/notifications/notify.ts), and
// its taskId is empty on a test send. Like runbooks_changed it therefore
// bypasses the relay's re-read-the-task enrichment entirely.
export type TaskMutationEvent =
  | { type: "task_updated" }
  | { type: "task_edited" }
  | { type: "task_deleted"; projectId: string; awaiting_count: number }
  | { type: "tasks_moved"; taskIds: string[]; fromProjectIds: string[]; toProjectId: string }
  | { type: "runbooks_changed"; projectId: string }
  | { type: "tags_changed"; projectId: string }
  | { type: "notification"; payload: NotificationPayload };

/** Everything a global listener can see: turn events plus route mutations. */
export type BusEvent = TaskStreamEvent | TaskMutationEvent;

// What GET /api/events sends over the wire: lib/types' GlobalEvent members,
// the task payload widened with the "task_updated" boundary, and the row-less
// deletion event. Defined here — beside the bus events that produce them —
// rather than in lib/types.ts.
export type GlobalTaskWireEvent = Omit<GlobalTaskEvent, "event"> & {
  event: GlobalTaskEvent["event"] | "task_updated" | "task_edited";
};
export type TaskDeletedWireEvent = {
  type: "task_deleted";
  taskId: string;
  projectId: string;
  /** The project's awaiting count recomputed AFTER the row was deleted. */
  awaiting_count: number;
};
// Tasks changed projects. Deliberately count-free, unlike task_deleted: a move
// also changes both projects' task_count, which no event carries, so clients
// refetch the project list once — cheap for a rare, hand-driven mutation.
// `fromProjectIds` is the DISTINCT set of trays that lost rows (a selection can
// span projects), not one entry per moved task — nothing needs the pairing.
export type TasksMovedWireEvent = {
  type: "tasks_moved";
  taskIds: string[];
  fromProjectIds: string[];
  toProjectId: string;
};
/**
 * A project's saved runbooks changed. Deliberately payload-free beyond the
 * project — it says "refetch the card", exactly like task_edited says "refetch
 * the row".
 */
export type RunbooksChangedWireEvent = {
  type: "runbooks_changed";
  projectId: string;
};
/**
 * A project's tags changed — created, renamed, recolored, described, deleted,
 * or applied to a selection of tasks. Modelled on runbooks_changed exactly: no
 * task row is involved, the publishers key the bus with "", and the client
 * refetches the project. Membership changes ride this too rather than N
 * task_edited events, because a tag write is the one edit whose blast radius is
 * the whole chip bar (every count moves) as well as the rows.
 */
export type TagsChangedWireEvent = {
  type: "tags_changed";
  projectId: string;
};
/** A composed, ready-to-render notification. See lib/notifications/. */
export type NotificationWireEvent = { type: "notification"; payload: NotificationPayload };
export type GlobalWireEvent =
  | GlobalTaskWireEvent
  | TaskDeletedWireEvent
  | TasksMovedWireEvent
  | RunbooksChangedWireEvent
  | TagsChangedWireEvent
  | NotificationWireEvent
  | AgentAuthEvent;

type Listener = (ev: TaskStreamEvent) => void;
type GlobalListener = (taskId: string, ev: BusEvent) => void;

declare global {
  // eslint-disable-next-line no-var
  var __calandriaEvents: Map<string, Set<Listener>> | undefined;
  // eslint-disable-next-line no-var
  var __calandriaEventsGlobal: Set<GlobalListener> | undefined;
  // eslint-disable-next-line no-var
  var __calandriaEventsGlobalInternal: Set<GlobalListener> | undefined;
}

function registry(): Map<string, Set<Listener>> {
  if (!global.__calandriaEvents) global.__calandriaEvents = new Map();
  return global.__calandriaEvents;
}

function globalRegistry(): Set<GlobalListener> {
  if (!global.__calandriaEventsGlobal) global.__calandriaEventsGlobal = new Set();
  return global.__calandriaEventsGlobal;
}

// A MARKER subset of globalRegistry(), not a second delivery list: fan-out still
// walks one set in one order, and this only records which of those listeners are
// server-side consumers rather than client streams. See watcherCount().
function internalRegistry(): Set<GlobalListener> {
  if (!global.__calandriaEventsGlobalInternal) global.__calandriaEventsGlobalInternal = new Set();
  return global.__calandriaEventsGlobalInternal;
}

/** Options for subscribeGlobal. */
export interface SubscribeGlobalOptions {
  /**
   * This subscriber is part of the SERVER, not a connected client — the
   * notification dispatcher, and whatever else later reads the bus in-process.
   * It lives for the process's lifetime, so counting it as a watcher would
   * permanently defeat the presence heuristic below.
   */
  internal?: boolean;
}

/** Subscribe to a task's live events. Returns an unsubscribe function. */
export function subscribe(taskId: string, fn: Listener): () => void {
  const reg = registry();
  let set = reg.get(taskId);
  if (!set) {
    set = new Set();
    reg.set(taskId, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) reg.delete(taskId);
  };
}

/**
 * Subscribe to EVERY task's events (the wildcard channel behind the global
 * GET /api/events lifecycle stream). Listeners get the task id alongside each
 * event, since the per-task keying is lost. Returns an unsubscribe function.
 *
 * Pass `{ internal: true }` for a subscriber that is part of the server rather
 * than a connected client, so it stays out of watcherCount().
 */
export function subscribeGlobal(fn: GlobalListener, opts?: SubscribeGlobalOptions): () => void {
  const set = globalRegistry();
  set.add(fn);
  if (opts?.internal) internalRegistry().add(fn);
  return () => {
    set.delete(fn);
    internalRegistry().delete(fn);
  };
}

/**
 * How many CLIENTS are watching the app right now — one global listener per
 * open GET /api/events stream, i.e. roughly one per browser tab. Zero means
 * nobody can SEE anything the server surfaces, let alone answer it, which is
 * how the permission gate tells an unattended turn (an auto-started task at
 * 3am) from one a human is sitting in front of. See lib/permissions.ts.
 *
 * Subscribers marked `internal` are deliberately EXCLUDED, because that gate is
 * the whole reason this number exists. A server-side bus consumer (the
 * notification dispatcher) subscribes once and never unsubscribes, so counting
 * it would pin this above zero for the life of the process — and an
 * auto-started task hitting a permission card at 3am with every tab shut would
 * park for the attended cap (hours) instead of auto-denying in seconds, holding
 * the task `running` and the container awake with it. Presence means a human,
 * not a listener.
 */
export function watcherCount(): number {
  // Clamped because the wrong answer here is unsafe in one direction only:
  // under-counting merely auto-denies an unattended-looking turn, while a
  // negative read would be indistinguishable from zero anyway.
  return Math.max(0, globalRegistry().size - internalRegistry().size);
}

/** Fan an event out to every subscriber of this task. Safe with zero listeners. */
export function publish(taskId: string, ev: TaskStreamEvent): void {
  const set = registry().get(taskId);
  if (set) {
    for (const fn of set) {
      try {
        fn(ev);
      } catch {
        // One dead subscriber (e.g. a stream torn down mid-enqueue) must never
        // break delivery to the others or the turn itself.
      }
    }
  }
  for (const fn of globalRegistry()) {
    try {
      fn(taskId, ev);
    } catch {
      // same rule as above
    }
  }
}

/**
 * Fan a route-published mutation fact out to GLOBAL listeners only. Mutation
 * events aren't transcript detail, so per-task /messages viewers never see
 * them — the global /api/events stream is their sole consumer.
 */
export function publishGlobal(taskId: string, ev: TaskMutationEvent): void {
  for (const fn of globalRegistry()) {
    try {
      fn(taskId, ev);
    } catch {
      // same rule as publish()
    }
  }
}
