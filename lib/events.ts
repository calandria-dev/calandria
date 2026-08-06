// In-process pub/sub for live task turn events.
//
// The detached turn runner (lib/runner.ts) publishes every event it persists;
// any number of GET /messages SSE streams subscribe by task id and relay them
// to connected clients. Single Node process, so an in-memory map is enough —
// kept on globalThis so it survives dev HMR module reloads (same pattern as
// lib/abort.ts / lib/asks.ts).

import type { AgentAuthEvent, GlobalTaskEvent, TaskStreamEvent } from "./types";

// Lifecycle facts published by mutation ROUTES rather than the runner — a
// manual status PATCH or /clear settling the task row (task_updated), or a
// task hard-delete (task_deleted). Without them those mutations are silent on
// the bus, so every other tab's "needs you" badges keep counting a task the
// server already settled (or deleted). They're not transcript detail, so they
// go to GLOBAL listeners only (publishGlobal) — per-task /messages streams
// never see them. task_deleted carries its project id + freshly recomputed
// awaiting count itself: by the time a listener sees it the row is gone, so
// the usual re-read-the-task enrichment (GET /api/events) is impossible.
export type TaskMutationEvent =
  | { type: "task_updated" }
  | { type: "task_deleted"; projectId: string; awaiting_count: number };

/** Everything a global listener can see: turn events plus route mutations. */
export type BusEvent = TaskStreamEvent | TaskMutationEvent;

// What GET /api/events sends over the wire: lib/types' GlobalEvent members,
// the task payload widened with the "task_updated" boundary, and the row-less
// deletion event. Defined here — beside the bus events that produce them —
// rather than in lib/types.ts.
export type GlobalTaskWireEvent = Omit<GlobalTaskEvent, "event"> & {
  event: GlobalTaskEvent["event"] | "task_updated";
};
export type TaskDeletedWireEvent = {
  type: "task_deleted";
  taskId: string;
  projectId: string;
  /** The project's awaiting count recomputed AFTER the row was deleted. */
  awaiting_count: number;
};
export type GlobalWireEvent = GlobalTaskWireEvent | TaskDeletedWireEvent | AgentAuthEvent;

type Listener = (ev: TaskStreamEvent) => void;
type GlobalListener = (taskId: string, ev: BusEvent) => void;

declare global {
  // eslint-disable-next-line no-var
  var __orchEvents: Map<string, Set<Listener>> | undefined;
  // eslint-disable-next-line no-var
  var __orchEventsGlobal: Set<GlobalListener> | undefined;
}

function registry(): Map<string, Set<Listener>> {
  if (!global.__orchEvents) global.__orchEvents = new Map();
  return global.__orchEvents;
}

function globalRegistry(): Set<GlobalListener> {
  if (!global.__orchEventsGlobal) global.__orchEventsGlobal = new Set();
  return global.__orchEventsGlobal;
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
 */
export function subscribeGlobal(fn: GlobalListener): () => void {
  const set = globalRegistry();
  set.add(fn);
  return () => {
    set.delete(fn);
  };
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
