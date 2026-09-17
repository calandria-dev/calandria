/**
 * Queued starts on the client: the one stored fact is `tasks.start_at` (a ms
 * epoch, 0 = not queued; see lib/deferredStart.ts for the sweep that applies
 * it). These are the two derivations every surface that mentions one needs.
 */

/** Queued and not yet consumed: draw the "starts/resumes at" chip. */
export const isQueuedStart = (t: { start_at: number }): boolean => t.start_at > 0;

/**
 * A reset time as a clock reading for a button label: "4:49 PM" today, with
 * the weekday when it isn't ("Tue 4:49 PM"). The chips use snooze.ts's
 * wakeLabel ("in 19m", "tomorrow at …"); a button that says "Start at reset"
 * needs the instant, not the distance.
 */
export function resetClock(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
