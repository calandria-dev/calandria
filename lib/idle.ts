// In-process activity registry. Kept on globalThis (same pattern as
// lib/abort.ts / lib/events.ts) because server.js — plain Node, but the SAME
// process as the Next route handlers — writes two of the fields directly: it
// counts live /pty websockets and stamps lastRequestAt on every HTTP request /
// WS upgrade. Keep the field names in sync with server.js.

export type Activity = {
  /** Process boot (ms epoch). */
  startedAt: number;
  /** Last HTTP request or WS upgrade. */
  lastRequestAt: number;
  /** Live proxied /pty terminal websockets (maintained by server.js). */
  openPty: number;
  /** Live transcript SSE streams (maintained by the messages route). */
  openSse: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __orchActivity: Activity | undefined;
}

export function activity(): Activity {
  if (!global.__orchActivity) {
    const now = Date.now();
    global.__orchActivity = { startedAt: now, lastRequestAt: now, openPty: 0, openSse: 0 };
  }
  return global.__orchActivity;
}

export function sseOpened(): void {
  activity().openSse++;
}

export function sseClosed(): void {
  const a = activity();
  a.openSse = Math.max(0, a.openSse - 1);
}
