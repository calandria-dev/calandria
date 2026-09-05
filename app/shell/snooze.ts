/**
 * Snoozing: park a task out of sight until a deadline, then hand it back.
 *
 * The entire feature is ONE stored number, `tasks.snoozed_until` (a ms epoch),
 * with no second field for a previous category. `status` is never touched by a
 * snooze, so "it goes back to the category it came from" needs no remembered
 * previous category and no restore step that could fail: the task never left
 * its status group, it was only drawn somewhere else while the deadline stood.
 *
 *   snoozed  ⟺  snoozed_until >  now      → shown in the Snoozed category
 *   woke     ⟺  0 < snoozed_until <= now  → back in its own, wearing the chip
 *   0        ⟺  never snoozed / chip seen and cleared
 *
 * A consequence worth spelling out: waking requires no server-side sweep, no
 * ticker and no write. A deadline in the past simply stops matching, so a task
 * snoozed while the app was shut down is already awake when it comes back up.
 * There is no missed-wake case to recover from. The only thing the client owes
 * the user is a re-render at the deadline, which is what `nextWake` arms.
 */

// The client rows this module reads: any task-shaped object with the column.
// Structurally typed rather than importing TaskRow so the helpers can be tested
// (and reused for a server row) without dragging the whole shape along.
export interface Snoozable {
  snoozed_until: number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Parked right now: draws in the Snoozed category, not its status group. */
export const isSnoozed = (t: Snoozable, now: number = Date.now()): boolean =>
  t.snoozed_until > now;

/**
 * Snoozed at some point, and back now: the "was snoozed" indicator. Due
 * exactly on `now` counts as woken, not still asleep, so a deadline that lands
 * on a render tick moves the card instead of leaving it in limbo (the two
 * predicates are exhaustive and mutually exclusive by construction).
 */
export const wasSnoozed = (t: Snoozable, now: number = Date.now()): boolean =>
  t.snoozed_until > 0 && t.snoozed_until <= now;

// ---------- picking a deadline ----------

export type SnoozeUnit = "minutes" | "hours" | "days" | "weeks";
const UNIT_MS: Record<SnoozeUnit, number> = { minutes: MINUTE, hours: HOUR, days: DAY, weeks: 7 * DAY };

/** "in 2 hours" → the instant that lands on. */
export const relativeUntil = (now: number, amount: number, unit: SnoozeUnit): number =>
  now + amount * UNIT_MS[unit];

export interface SnoozePreset {
  key: string;
  label: string;
  until: number;
}

/**
 * The one-click deadlines. Two relative ("1 hour", "3 hours") and three
 * wall-clock ones, computed in LOCAL time because "tomorrow" means the user's
 * tomorrow, not UTC's.
 *
 * Any preset already behind us is dropped instead of being offered and
 * clamped: "This evening" at 8pm would otherwise be a snooze that ends before
 * it begins, which reads as the button being broken. The minute of headroom
 * keeps a preset from appearing at the instant it stops being useful.
 */
export function snoozePresets(now: number): SnoozePreset[] {
  const clock = (addDays: number, hour: number): number => {
    const d = new Date(now);
    d.setDate(d.getDate() + addDays);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  };
  // The Monday strictly after today: on a Monday that's a full week out, not
  // this morning, which would be a no-op the user reads as a failure.
  const daysToMonday = ((8 - new Date(now).getDay()) % 7) || 7;
  return [
    { key: "1h", label: "1 hour", until: now + HOUR },
    { key: "3h", label: "3 hours", until: now + 3 * HOUR },
    { key: "evening", label: "This evening", until: clock(0, 18) },
    { key: "tomorrow", label: "Tomorrow", until: clock(1, 9) },
    { key: "week", label: "Next week", until: clock(daysToMonday, 9) },
  ].filter((p) => p.until > now + MINUTE);
}

// ---------- saying when it comes back ----------

const timeOf = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Whole local days between two instants: midnight to midnight, so 11pm to 1am
// is one day apart, not the two hours a raw subtraction would report.
function daysApart(from: number, to: number): number {
  const midnight = (ts: number) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  return Math.round((midnight(to) - midnight(from)) / DAY);
}

/**
 * When the card comes back, phrased the way the distance makes useful: a
 * countdown while it's near, a clock time once "in 9h" would make the reader do
 * the arithmetic, then the weekday, then the date once the weekday repeats.
 */
export function wakeLabel(until: number, now: number = Date.now()): string {
  const diff = until - now;
  if (diff <= 0) return "now";
  if (diff < MINUTE) return "in under a minute";
  const mins = Math.round(diff / MINUTE);
  if (mins < 60) return `in ${mins}m`;
  const days = daysApart(now, until);
  if (days === 0) return `at ${timeOf(until)}`;
  if (days === 1) return `tomorrow at ${timeOf(until)}`;
  if (days < 7) return `${new Date(until).toLocaleDateString([], { weekday: "short" })} at ${timeOf(until)}`;
  return `${new Date(until).toLocaleDateString([], { month: "short", day: "numeric" })} at ${timeOf(until)}`;
}

/**
 * The soonest deadline still ahead across a list, or null when nothing is
 * waiting. One timer set to this instant is all the whole board needs to
 * redraw itself on time: polling every task on an interval would compute the
 * same answer continuously instead of once.
 */
export function nextWake(rows: Snoozable[], now: number = Date.now()): number | null {
  let soonest: number | null = null;
  for (const r of rows) {
    if (r.snoozed_until > now && (soonest === null || r.snoozed_until < soonest)) soonest = r.snoozed_until;
  }
  return soonest;
}
