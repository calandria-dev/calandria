/**
 * An idle live turn on the client: the one stored fact is `idle_since`, the
 * instant a running turn last produced anything, sent only once it has been
 * quiet long enough to be worth reporting (see lib/turnActivity.ts for the
 * server-side sweep and why the mark is never "needs you" and never a
 * deadline). These are the derivations every surface that mentions one needs.
 */

import { useEffect, useReducer } from "react";

/** Quiet long enough that the card should say so. */
export const isIdleTurn = (t: { idle_since?: number }, running: boolean): boolean =>
  running && (t.idle_since ?? 0) > 0;

/**
 * How long a turn has been quiet, as the tail of an activity line: "no activity
 * for 34m". Rounded to whole minutes, since this is a "go and look" cue, not a
 * measurement, and a seconds-precise figure would imply the server is watching
 * more closely than it is.
 */
export function idleFor(since: number, now: number = Date.now()): string {
  const m = Math.max(0, Math.floor((now - since) / 60_000));
  if (m < 60) return `no activity for ${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `no activity for ${h}h${rest ? ` ${rest}m` : ""}`;
}

/** The tooltip, spelled out once so every surface says the same thing. */
export const IDLE_TITLE =
  "The turn is still live but has produced nothing for a while — no output, no tool call. Often a wait on something that already finished. Nothing has been stopped: open it and decide, or press Stop.";

/**
 * Re-render on a one-minute heartbeat while `on`. The age of an idle turn
 * grows with the clock, not with anything the server pushes: a quiet turn
 * publishes exactly one event, when it goes quiet, so without this the label
 * would freeze at whatever it said the moment it appeared. Same reasoning as
 * the schedules card polling to age `lastTickAt` (./Schedules.tsx); the timer
 * exists only on the cards that are actually idle.
 */
export function useIdleClock(on: boolean): void {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [on]);
}
