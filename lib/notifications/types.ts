// The shape of a notification, shared by the server that composes it and the
// browser channel that renders it. Has no logic and no imports, so a client
// component can `import type` it without pulling in the DB.

export type NotificationKind =
  | "awaiting_input"
  | "turn_failed"
  | "schedule_failed"
  /** Settings' "Send test notification"; belongs to no task. */
  | "test";

export interface NotificationPayload {
  /**
   * Stable per (kind, task), not unique per send. Also the browser
   * Notification `tag`, so a second notification about the same task
   * replaces the first, keeping toasts from stacking up on a screen the
   * user isn't looking at.
   */
  id: string;
  kind: NotificationKind;
  /** Empty on a test notification, which belongs to no task. */
  taskId: string;
  /** Empty when the notification names no project. */
  projectId: string;
  /** The fact, e.g. "Waiting for input". Composed server-side so every
   *  channel renders it identically. */
  title: string;
  /** The detail: task title, project name, and the error when there is one. */
  body: string;
  ts: number;
}
