// The shape of a notification, shared by the server that composes it and the
// browser channel that renders it. Deliberately logic-free and import-free so
// a client component can `import type` it without dragging the DB in.
//
// See docs/superpowers/specs/2026-08-21-notifications-design.md.

export type NotificationKind =
  | "awaiting_input"
  | "turn_failed"
  | "schedule_failed"
  /** Settings' "Send test notification" — belongs to no task. */
  | "test";

export interface NotificationPayload {
  /**
   * Stable per (kind, task) — NOT unique per send. It is also the browser
   * Notification `tag`, so a second notification about the same task REPLACES
   * the first instead of stacking a second toast on a screen the user isn't
   * looking at.
   */
  id: string;
  kind: NotificationKind;
  /** Empty on a test notification, which belongs to no task. */
  taskId: string;
  /** Empty when the notification names no project. */
  projectId: string;
  /** The fact, e.g. "Waiting for input". Composed server-side so a second
   *  channel renders identically rather than inventing its own wording. */
  title: string;
  /** The detail: task title, project name, and the error when there is one. */
  body: string;
  ts: number;
}
