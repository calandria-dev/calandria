/**
 * Session-scoped cron wakeups (ScheduleWakeup / CronCreate / /loop) as the
 * linger state machine in claude/driver.ts sees them — pure, SDK-free math
 * over the Stop hook's `session_crons` payload.
 *
 * Measured against claude CLI 2.1.240 / SDK 0.3.159 (the spike record is in
 * this feature's commit message):
 *
 * - A cron fires only while the CLI process is alive. Closing the held-open
 *   prompt iterable exits the CLI within ~300ms with no grace and no
 *   notification, and the wake is simply gone — the same broken promise
 *   linger-until-quiet fixed for run_in_background, in the class it excluded.
 * - With the input held open the cron DOES fire, and the wake arrives as a
 *   second `init` system message (same session id) followed by a fresh
 *   assistant turn. There is NO user message on the wire (the prompt is
 *   submitted internally) and NO task_notification — the init is the only
 *   signal, so cron wakes need their own accounting beside the notification
 *   path background tasks use.
 * - A one-shot wakeup's cron field encodes ONLY its wall-clock minute —
 *   "58 11 * * *" for 11:58 — in the CLI process's LOCAL time zone (the
 *   server shares it: the CLI is our child), at minute granularity
 *   (ScheduleWakeup's delaySeconds rounds up to the next minute boundary; the
 *   tool result says so). Day/month are wildcards, so "when does it fire" is
 *   "the next occurrence of HH:MM", at most 24h out.
 * - After a one-shot fires, the wake turn's Stop hook reports `session_crons:
 *   []`. A recurring cron survives its wakes: every Stop hook reports it
 *   again, so a lingering driver re-enters the linger after each wake turn.
 */

export type SessionCron = {
  id: string;
  /** Cron expression; one-shots encode their single fire time here. */
  schedule: string;
  recurring: boolean;
  /** The prompt the CLI submits when it fires (capped at 1000 chars by the SDK). */
  prompt: string;
};

export type PlannedCron = SessionCron & {
  /** Next fire time (ms epoch, local-time cron math); null when the expression didn't parse. */
  fireAt: number | null;
};

export type CronPlan = {
  /** Crons the driver will hold the session open for. */
  linger: PlannedCron[];
  /** Crons that will NOT be waited for — they die when the session closes. */
  cancelled: PlannedCron[];
};

type Field = Set<number>;
type CronSpec = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field; domStar: boolean; dowStar: boolean };

function parseField(raw: string, lo: number, hi: number): Field | null {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const step = m[3] ? Number(m[3]) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let start: number, end: number;
    if (m[1] === "*") {
      start = lo;
      end = hi;
    } else {
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : m[3] ? hi : start;
    }
    if (start < lo || end > hi || start > end) return null;
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/** Five-field Vixie cron (numeric only — names never appear in the CLI's payload). */
export function parseCron(schedule: string): CronSpec | null {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dow = parseField(fields[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) dow.add(0); // both spellings of Sunday
  return { minute, hour, dom, month, dow, domStar: fields[2] === "*", dowStar: fields[4] === "*" };
}

/**
 * The next minute boundary at or after `now` (ms epoch) that matches the
 * expression, in the process's local time — which is the CLI's, since it is
 * our child. Vixie's day rule: when BOTH day-of-month and day-of-week are
 * restricted, a day matches if EITHER does. Null if the expression doesn't
 * parse or nothing matches within 400 days (an impossible date such as
 * "0 0 31 2 *").
 */
export function nextCronFire(schedule: string, now: number = Date.now()): number | null {
  const spec = parseCron(schedule);
  if (!spec) return null;
  // Start at the current minute if we're exactly on it, else the next one.
  const startMs = Math.ceil(now / 60_000) * 60_000;
  const start = new Date(startMs);
  const dayMatches = (d: Date) => {
    if (!spec.month.has(d.getMonth() + 1)) return false;
    const domOk = spec.dom.has(d.getDate());
    const dowOk = spec.dow.has(d.getDay());
    if (spec.domStar && spec.dowStar) return true;
    if (spec.domStar) return dowOk;
    if (spec.dowStar) return domOk;
    return domOk || dowOk;
  };
  for (let offset = 0; offset < 400; offset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    if (!dayMatches(day)) continue;
    const first = offset === 0;
    for (let h = first ? start.getHours() : 0; h < 24; h++) {
      if (!spec.hour.has(h)) continue;
      for (let m = first && h === start.getHours() ? start.getMinutes() : 0; m < 60; m++) {
        if (!spec.minute.has(m)) continue;
        return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
      }
    }
  }
  return null;
}

/**
 * Which pending crons the linger will honor. `deadline` is the linger phase's
 * absolute cut-off (ms epoch) on a bounded instance, or null when the linger is
 * unbounded (the default — see BACKGROUND_LINGER_MS).
 *
 * Policy, stated so it's a visible decision rather than an accident:
 * - Linger disabled → nothing is honored; every cron is reported cancelled.
 * - Unbounded → EVERYTHING lingers, recurring crons included. A /loop's whole
 *   contract is "keep waking me until I'm stopped", and under no deadline the
 *   session stays open exactly that long — visibly ("wakes on schedule …" on
 *   the row, with its age), so it's the user's to Stop, the same call the
 *   unbounded default already makes for a backgrounded dev server. An
 *   expression the parser can't read still lingers here: the CLI accepted it
 *   and will fire it; only its label is unknown.
 * - Bounded → only a cron whose next fire fits inside the window lingers; a
 *   recurring cron that fits lingers for its next fire and is then cut by the
 *   deadline like any other work. An unparsable expression can't be shown to
 *   fit, so it's cancelled (and named) rather than gambled on.
 */
export function planSessionCrons(
  crons: SessionCron[],
  opts: { now: number; enabled: boolean; deadline: number | null },
): CronPlan {
  const plan: CronPlan = { linger: [], cancelled: [] };
  for (const c of crons) {
    const planned: PlannedCron = { ...c, fireAt: nextCronFire(c.schedule, opts.now) };
    const honored = opts.enabled && (opts.deadline === null || (planned.fireAt !== null && planned.fireAt <= opts.deadline));
    (honored ? plan.linger : plan.cancelled).push(planned);
  }
  return plan;
}

/**
 * Among the crons the driver was lingering on, the one a bare wake `init` most
 * plausibly came from: the earliest fire time that has already passed (within
 * a minute's slack for clock skew), else the earliest overall. Null when none.
 */
export function cronThatWoke(crons: PlannedCron[], now: number = Date.now()): PlannedCron | null {
  if (!crons.length) return null;
  const sorted = [...crons].sort((a, b) => (a.fireAt ?? Infinity) - (b.fireAt ?? Infinity));
  const due = sorted.filter((c) => c.fireAt !== null && c.fireAt <= now + 60_000);
  return due.length ? due[due.length - 1] : sorted[0];
}

/** "12:00" today, "Tue 09:00" within a week, else "Sep 3 09:00" — server-local time, like the CLI's own tool result. */
export function wakeTimeLabel(fireAt: number | null, now: number = Date.now()): string {
  if (fireAt === null) return "an unparsed schedule";
  const d = new Date(fireAt);
  const n = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return time;
  if (fireAt - now < 7 * 86_400_000) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** One cron, for a notice: `at 12:00 — "prompt…"` / `on \`* * * * *\` (next 12:00) — "prompt…"`. */
export function describeCron(c: PlannedCron, now: number = Date.now(), promptChars = 160): string {
  const when = c.recurring ? `on \`${c.schedule}\` (next ${wakeTimeLabel(c.fireAt, now)})` : `at ${wakeTimeLabel(c.fireAt, now)}`;
  const prompt = c.prompt.length > promptChars ? c.prompt.slice(0, promptChars) + "…" : c.prompt;
  return `${when} — "${prompt}"`;
}

/**
 * The activity-line phrase for a linger, persisted on the task row
 * (tasks.background_note) and shown beside "live" on the task list, the board
 * and the chat: what the held-open session is waiting on.
 */
export function lingerNote(backgroundTaskCount: number, crons: PlannedCron[], now: number = Date.now()): string {
  const parts: string[] = [];
  if (backgroundTaskCount > 0) parts.push("working in background");
  if (crons.length) {
    const sorted = [...crons].sort((a, b) => (a.fireAt ?? Infinity) - (b.fireAt ?? Infinity));
    const next = sorted[0];
    const more = sorted.length > 1 ? ` (+${sorted.length - 1} more)` : "";
    parts.push(
      next.recurring
        ? `wakes on \`${next.schedule}\`, next ${wakeTimeLabel(next.fireAt, now)}${more}`
        : `waiting to wake at ${wakeTimeLabel(next.fireAt, now)}${more}`,
    );
  }
  return parts.join(" · ");
}

/**
 * The honesty notice: appended to the transcript when a session closes with
 * crons its Stop hook reported that will never fire, so neither the user nor
 * the model's next turn sits waiting on a wake that died with the process.
 * Mirror of the linger-expiry notice for background tasks.
 */
export function cancelledCronsNotice(crons: PlannedCron[], reason: string, now: number = Date.now()): string {
  const plural = crons.length > 1;
  return (
    `⏰ Scheduled wakeup${plural ? "s" : ""} cancelled — ${reason}: ` +
    crons.map((c) => describeCron(c, now)).join("; ") +
    `. ${plural ? "They" : "It"} will not fire; nothing re-invokes this session on ${plural ? "their" : "its"} own.`
  );
}
