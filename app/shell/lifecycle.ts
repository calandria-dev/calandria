// Page-lifecycle diagnostics and the decisions the shell makes on them.
//
// The installed iOS app sometimes comes back from the background painted but
// dead: nothing tappable until a force-quit. Nothing in the page can recover a
// WebContent process whose JavaScript never resumes, so the first job is to
// tell that case apart from one where JavaScript is running and something in
// the page is wrong. This module is the pure half: a bounded log of lifecycle
// events (no task content, only kinds, timestamps and numbers), the heartbeat
// arithmetic that shows whether timers were suspended, and the two decisions
// that ride on it. useLifecycleDiagnostics.ts attaches the listeners;
// Diagnostics.tsx shows the log. Pinned by tests/lifecycle.test.ts.

export type LifecycleKind =
  | "boot"           // this page started (a fresh load, or iOS relaunched it)
  | "visible"        // visibilitychange -> visible
  | "hidden"         // visibilitychange -> hidden
  | "pageshow"       // pageshow (persisted = restored from the back/forward cache)
  | "pagehide"
  | "focus"
  | "blur"
  | "online"
  | "offline"
  | "freeze"         // Page Lifecycle API (Chromium only)
  | "resume"
  | "heartbeat_gap"  // the 5s ticker fired late: timers were suspended or throttled
  | "resume_reload"; // the shell decided to reload itself on resume

export interface LifecycleEvent {
  /** Wall-clock ms. */
  t: number;
  kind: LifecycleKind;
  /** heartbeat_gap: wall-clock ms since the previous tick. */
  gapMs?: number;
  /** heartbeat_gap: performance.now() ms since the previous tick. */
  monoMs?: number;
  /** JS heap in MB where the browser reports it (Chromium's performance.memory). */
  heapMB?: number;
  online?: boolean;
  /** pageshow only: restored from the back/forward cache. */
  persisted?: boolean;
  /** boot only. */
  standalone?: boolean;
  ios?: boolean;
  /** boot only, the user agent, truncated. */
  ua?: string;
  /** resume_reload: how long the page had been hidden. */
  hiddenMs?: number;
}

export const LIFECYCLE_LOG_LIMIT = 80;
export const LIFECYCLE_LS = "calandria_lifecycle_v1";
// The name of the window event the hook dispatches after every write, so a
// Diagnostics panel already open re-reads without polling.
export const LIFECYCLE_CHANGED = "calandria:lifecycle";

export const HEARTBEAT_MS = 5_000;

// Appends one event and keeps only the newest `limit`.
export function pushLifecycleEvent(log: readonly LifecycleEvent[], ev: LifecycleEvent, limit = LIFECYCLE_LOG_LIMIT): LifecycleEvent[] {
  const next = [...log, ev];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function parseLifecycleLog(raw: string | null): LifecycleEvent[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is LifecycleEvent => !!e && typeof e === "object" && typeof (e as LifecycleEvent).t === "number" && typeof (e as LifecycleEvent).kind === "string");
  } catch {
    return [];
  }
}

// A tick that landed more than one whole interval late. Both clocks travel:
// the wall clock always advances across a suspension, while performance.now()
// may not, so a wall gap with a small monotonic delta says the page was
// suspended (iOS backgrounding) and one where both agree says it was merely
// throttled. Returns null for a tick that arrived on time.
export function heartbeatGap(prevWall: number, nowWall: number, prevMono: number, nowMono: number, interval = HEARTBEAT_MS): { gapMs: number; monoMs: number } | null {
  const gapMs = nowWall - prevWall;
  if (gapMs < interval * 2) return null;
  return { gapMs, monoMs: Math.max(0, Math.round(nowMono - prevMono)) };
}

// Whether the page runs as an installed app rather than in a browser tab.
// Safari exposes navigator.standalone; everything else answers the display-mode
// media query.
export function isStandaloneDisplay(nav: { standalone?: boolean }, matches: (q: string) => boolean): boolean {
  if (nav.standalone === true) return true;
  return matches("(display-mode: standalone)") || matches("(display-mode: fullscreen)");
}

// iPhone or iPad, including iPadOS reporting itself as a Mac with a touch screen.
export function isIOS(ua: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/.test(ua) && maxTouchPoints > 1;
}

// The one recovery the page can attempt: reload itself when the installed iOS
// app comes back after a long enough background. It only helps when JavaScript
// runs again on resume (this decision can't run otherwise), so it is off by
// default and a per-device choice in Settings -> Diagnostics. Limited to the
// installed app on iOS because that is where the report is from and a reload
// in a desktop tab would throw away scroll position for nothing.
export function shouldReloadOnResume(p: {
  thresholdMinutes: number;
  standalone: boolean;
  ios: boolean;
  hiddenSinceMs: number | null;
  nowMs: number;
}): boolean {
  if (!(p.thresholdMinutes > 0)) return false;
  if (!p.standalone || !p.ios) return false;
  if (p.hiddenSinceMs === null) return false;
  return p.nowMs - p.hiddenSinceMs >= p.thresholdMinutes * 60_000;
}

// Whether the phone's terminal sheet should tear its shell down. A hidden
// sheet keeps an xterm buffer, observers and a WebSocket alive for a shell
// nobody is looking at, and iOS drops the socket during a background anyway,
// so what survives is a dead buffer. A sheet the user is looking at is left
// alone: they may be reading output, and Enter respawns a dropped shell.
// The desktop drawer never suspends; a laptop tab keeps a dev server running
// across hours in the background on purpose.
export function terminalShouldSuspend(p: { mobile: boolean; sheetVisible: boolean; pageHidden: boolean }): boolean {
  return p.mobile && p.pageHidden && !p.sheetVisible;
}

// One line per event, oldest first, for the Copy button. Times are ISO so a
// report pasted into an issue reads without the reader's timezone.
export function formatLifecycleLog(log: readonly LifecycleEvent[]): string {
  return log.map((e) => {
    const parts = [new Date(e.t).toISOString(), e.kind];
    if (e.gapMs !== undefined) parts.push(`gap=${e.gapMs}ms`);
    if (e.monoMs !== undefined) parts.push(`mono=${e.monoMs}ms`);
    if (e.hiddenMs !== undefined) parts.push(`hidden=${e.hiddenMs}ms`);
    if (e.heapMB !== undefined) parts.push(`heap=${e.heapMB}MB`);
    if (e.online !== undefined) parts.push(`online=${e.online}`);
    if (e.persisted !== undefined) parts.push(`persisted=${e.persisted}`);
    if (e.standalone !== undefined) parts.push(`standalone=${e.standalone}`);
    if (e.ios !== undefined) parts.push(`ios=${e.ios}`);
    if (e.ua) parts.push(`ua="${e.ua}"`);
    return parts.join(" ");
  }).join("\n");
}
