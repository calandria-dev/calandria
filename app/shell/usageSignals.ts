// The Usage Center's rules: pace, projection, the five signals, their
// precedence, and the window the chip's ring tracks. Pure and DOM-free so
// tests/usageSignals.test.ts can pin every threshold with a fixed `now`.
//
// Signal rules (fixed by the design brief, docs/INSIGHTS.md "Usage Center"):
//   1 At limit          status rejected, or a window at 100%        every agent
//   2 On pace to cap    a weekly window projects >= 100% at reset,
//                       more than one day elapsed, still under 100% every agent
//   3 Near limit        a window at 80% or more (95% = limit tone)  every agent
//   4 Session underused session resets within 60m, >= 50% unused   primary only
//   5 Week underused    any week resets within 36h, >= 30% unused   primary only
// Precedence: lower number, then primary before occasional, then soonest reset.

import { GATEWAY_PLAN_ID, type PlanUsageSnapshot, type PlanUsageWindow } from "@/lib/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export const NEAR_PCT = 80;
export const LIMIT_PCT = 95;
const SESSION_UNDER_WITHIN = 60 * MIN;
const SESSION_UNDER_UNUSED = 50;
const WEEK_UNDER_WITHIN = 36 * HOUR;
const WEEK_UNDER_UNUSED = 30;
const PACE_GRACE = DAY;
// A projection from the first few percent of a window is noise ("2000% at
// reset" ten minutes in), so the end marker waits for this much elapsed time.
const PROJECTION_MIN_ELAPSED = 0.05;

export type Tone = "" | "warn" | "limit" | "opportunity";
export type SignalKind = "limit" | "pace" | "near" | "session_under" | "week_under";
const RANK: Record<SignalKind, number> = { limit: 1, pace: 2, near: 3, session_under: 4, week_under: 5 };

/** One agent as the Usage Center sees it: its snapshot plus display name. */
export interface UsageAgent {
  id: string;
  name: string;
  snap: PlanUsageSnapshot;
}

export interface UsageSignal {
  kind: SignalKind;
  rank: number;
  agentId: string;
  primary: boolean;
  window: PlanUsageWindow | null;
  tone: Exclude<Tone, "">;
  /** The instant this signal is about (the reset, or the projected cap). */
  at: number | null;
  /** Chip text, split so the agent name truncates before the message. */
  who: string;
  what: string;
  /** The popover note. */
  note: string;
  /** The full state in words, for the chip's accessible name. */
  spoken: string;
}

// ---------------------------------------------------------------- windows

// Which of the two windows every metered plan has each Claude key is, for
// snapshots written before drivers declared `kind`.
const SESSION_IDS = ["five_hour", "primary"];
const WEEK_IDS = ["seven_day", "secondary"];

/** The session and week windows a plan headlines, by kind, then by legacy id. */
export function headlineWindows(windows: PlanUsageWindow[]): { session?: PlanUsageWindow; week?: PlanUsageWindow } {
  const session = windows.find((w) => w.kind === "session") ?? windows.find((w) => w.kind == null && SESSION_IDS.includes(w.id));
  const week = windows.find((w) => w.kind === "week") ?? windows.find((w) => w.kind == null && WEEK_IDS.includes(w.id));
  return { session, week };
}

/**
 * A window's length in ms, or null when nothing says. Kinds give 5h and 7d;
 * Claude's per-model weeks are `seven_day_*`; a Codex window of an unusual
 * length states it in its label ("Current session (2h)"). The gateway budget
 * has no length and so no pace.
 */
export function windowLengthMs(w: PlanUsageWindow): number | null {
  if (w.kind === "gateway_budget") return null;
  const span = /\((\d+)([mhd])\)\s*$/.exec(w.label);
  if (span) return Number(span[1]) * (span[2] === "m" ? MIN : span[2] === "h" ? HOUR : DAY);
  if (w.kind === "session" || SESSION_IDS.includes(w.id)) return 5 * HOUR;
  if (w.kind === "week" || WEEK_IDS.includes(w.id) || w.id.startsWith("seven_day")) return WEEK;
  return null;
}

const isWeekly = (w: PlanUsageWindow) => windowLengthMs(w) === WEEK;
const isSessionWindow = (w: PlanUsageWindow) => {
  if (w.kind === "session") return true;
  if (w.kind != null) return false;
  const len = windowLengthMs(w);
  return len != null && len < DAY;
};

export interface Pace {
  /** 0..1 of the window gone. */
  elapsed: number;
  /** The utilization an even spread would show now, 0..100. */
  pace: number;
  /** Utilization at reset at the current rate, or null while too early to say. */
  projected: number | null;
  /** When the current rate reaches 100%, or null if it never does before reset. */
  capAt: number | null;
}

/** Linear pace for a window with a known length and a reset still ahead. */
export function paceOf(w: PlanUsageWindow, now: number): Pace | null {
  const len = windowLengthMs(w);
  if (len == null || w.resetsAt == null || w.resetsAt <= now) return null;
  const elapsed = Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / len));
  const pace = elapsed * 100;
  if (elapsed < PROJECTION_MIN_ELAPSED || w.utilization <= 0 || w.utilization >= 100) return { elapsed, pace, projected: null, capAt: null };
  const projected = w.utilization / elapsed;
  const start = w.resetsAt - len;
  const capAt = projected >= 100 && w.utilization < 100 ? start + (len * elapsed * 100) / w.utilization : null;
  return { elapsed, pace, projected, capAt };
}

export function toneFor(pct: number, rejected = false): "" | "warn" | "limit" {
  if (rejected || pct >= LIMIT_PCT) return "limit";
  if (pct >= NEAR_PCT) return "warn";
  return "";
}

export function isPrimary(a: UsageAgent): boolean {
  return a.id !== GATEWAY_PLAN_ID && a.snap.role?.value === "primary";
}

// ---------------------------------------------------------------- formatting

/** Time left, compact ("18m", "3h05m", "2d4h"). Null once past or unknown. */
export function fmtRemaining(at: number | null, now: number = Date.now()): string | null {
  if (at == null) return null;
  const mins = Math.ceil((at - now) / MIN);
  if (mins <= 0) return null;
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ""}`;
  const m = mins % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
}

/** Time left in words, for accessible names ("40 minutes", "3 hours 5 minutes"). */
export function spokenRemaining(at: number | null, now: number = Date.now()): string | null {
  if (at == null) return null;
  const mins = Math.ceil((at - now) / MIN);
  if (mins <= 0) return null;
  const plural = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`;
  if (mins < 60) return plural(mins, "minute");
  const h = Math.floor(mins / 60);
  if (h >= 48) return plural(Math.round(h / 24), "day");
  return mins % 60 ? `${plural(h, "hour")} ${plural(mins % 60, "minute")}` : plural(h, "hour");
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const weekday = (at: number) => new Date(at).toLocaleDateString([], { weekday: "short" });

/** "14:05" today, "Wed 09:00" otherwise. */
export function fmtWhen(at: number, now: number = Date.now()): string {
  return sameDay(at, now) ? clock(at) : `${weekday(at)} ${clock(at)}`;
}

/** The shortest name for a moment: a clock today, a weekday otherwise. */
function fmtDay(at: number, now: number): string {
  return sameDay(at, now) ? clock(at) : weekday(at);
}

function fmtSpan(ms: number): string {
  const h = Math.round(ms / HOUR);
  if (h >= 36) {
    const d = Math.round(ms / DAY);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  return `${Math.max(1, h)} hour${h === 1 ? "" : "s"}`;
}

/** "Current week (Opus)" → "(Opus)", used to tell a plan's weeks apart. */
function qualifier(w: PlanUsageWindow): string {
  const m = /\(([^)]+)\)\s*$/.exec(w.label);
  if (!m || /^\d+[mhd]$/.test(m[1]) || m[1] === "all models") return "";
  return m[1];
}

/** The window as a noun: "session", "week", "Opus week", "budget". */
function windowNoun(w: PlanUsageWindow | null): string {
  if (!w) return "usage";
  if (w.kind === "gateway_budget") return "budget";
  const q = qualifier(w);
  const base = isSessionWindow(w) ? "session" : isWeekly(w) ? "week" : w.label.toLowerCase();
  return q ? `${q} ${base}` : base;
}

/** The window as chip shorthand: "5h", "2h", "wk", "budget". */
function windowShort(w: PlanUsageWindow): string {
  if (w.kind === "gateway_budget") return "budget";
  if (isSessionWindow(w)) {
    const len = windowLengthMs(w);
    return len ? `${Math.round(len / HOUR) || 1}h` : "session";
  }
  if (isWeekly(w)) return "wk";
  return w.label;
}

const pct = (n: number) => Math.floor(n);
const possessive = (name: string) => `${name}'${name.endsWith("s") ? "" : "s"}`;

// ---------------------------------------------------------------- signals

/** Every signal one agent raises, most severe first, at most one per kind. */
export function agentSignals(a: UsageAgent, now: number, named: boolean): UsageSignal[] {
  const { snap } = a;
  if (!snap.available) return [];
  const primary = isPrimary(a);
  const who = named ? a.name : "";
  const out: UsageSignal[] = [];
  const make = (s: Omit<UsageSignal, "rank" | "agentId" | "primary" | "who">): UsageSignal =>
    ({ ...s, rank: RANK[s.kind], agentId: a.id, primary, who });

  // 1. At limit. A rejection whose reset has already passed is stale telemetry.
  const rejected = snap.status === "rejected" && !(snap.statusResetsAt != null && snap.statusResetsAt <= now);
  const spentWindow = snap.windows.find((w) => w.utilization >= 100);
  const limitWindow = rejected ? (snap.windows.find((w) => w.id === snap.statusWindow) ?? spentWindow ?? null) : (spentWindow ?? null);
  if (rejected || spentWindow) {
    const at = (rejected ? snap.statusResetsAt : null) ?? limitWindow?.resetsAt ?? null;
    const left = fmtRemaining(at, now);
    const noun = windowNoun(limitWindow);
    out.push(make({
      kind: "limit", tone: "limit", window: limitWindow, at,
      what: `limit${left ? ` · ${left}` : ""}`,
      note: `${possessive(a.name)} ${noun} limit is reached. Turns resume ${at != null ? `at ${fmtWhen(at, now)}` : "when the limit resets"}.`,
      spoken: `${a.name} ${noun} limit reached${at != null ? `, turns resume in ${spokenRemaining(at, now)}` : ""}.`,
    }));
  }

  // 2. On pace to cap: the weekly window that caps soonest.
  let pace: { w: PlanUsageWindow; capAt: number } | null = null;
  for (const w of snap.windows) {
    if (!isWeekly(w) || w.utilization >= 100) continue;
    const p = paceOf(w, now);
    if (!p || p.capAt == null || p.elapsed * WEEK <= PACE_GRACE) continue;
    if (!pace || p.capAt < pace.capAt) pace = { w, capAt: p.capAt };
  }
  if (pace) {
    const before = (pace.w.resetsAt as number) - pace.capAt;
    const noun = windowNoun(pace.w);
    out.push(make({
      kind: "pace", tone: "warn", window: pace.w, at: pace.capAt,
      what: `wk → cap ${fmtDay(pace.capAt, now)}`,
      note: `At this pace the ${noun} reaches its limit ${fmtWhen(pace.capAt, now)}, ${fmtSpan(before)} before reset.`,
      spoken: `${a.name} ${noun} is on pace to reach its limit ${fmtWhen(pace.capAt, now)}, ${fmtSpan(before)} before reset.`,
    }));
  }

  // 3. Near limit: the fullest window under 100%.
  const near = snap.windows
    .filter((w) => w.utilization >= NEAR_PCT && w.utilization < 100 && w !== limitWindow)
    .sort((x, y) => y.utilization - x.utilization)[0];
  if (near) {
    const left = fmtRemaining(near.resetsAt, now);
    const noun = windowNoun(near);
    out.push(make({
      kind: "near", tone: near.utilization >= LIMIT_PCT ? "limit" : "warn", window: near, at: near.resetsAt,
      what: `${windowShort(near)} ${pct(near.utilization)}%${left ? ` · ${left}` : ""}`,
      note: `${pct(near.utilization)}% of the ${noun} used.${left ? ` Resets in ${left}.` : ""}`,
      spoken: `${a.name} ${noun} ${pct(near.utilization)}% used${left ? `, resets in ${spokenRemaining(near.resetsAt, now)}` : ""}.`,
    }));
  }

  // 4 and 5 are about capacity expiring unused, so only on the plan relied on.
  // Session underuse reads the headline session; week underuse reads every
  // weekly window (per-model weeks included) and reports the soonest reset,
  // a tie going to the all-models window.
  if (primary) {
    const { session, week: headWeek } = headlineWindows(snap.windows);
    if (session?.resetsAt != null && session.resetsAt > now && session.resetsAt - now <= SESSION_UNDER_WITHIN && 100 - session.utilization >= SESSION_UNDER_UNUSED) {
      const unused = pct(100 - session.utilization);
      const left = fmtRemaining(session.resetsAt, now);
      out.push(make({
        kind: "session_under", tone: "opportunity", window: session, at: session.resetsAt,
        what: `${unused}% left · ${left}`,
        note: `${unused}% of the session unused. Resets in ${left}.`,
        spoken: `${a.name} session ${unused}% unused, resets in ${spokenRemaining(session.resetsAt, now)}.`,
      }));
    }
    const week = snap.windows
      .filter((w) => isWeekly(w) && w.resetsAt != null && w.resetsAt > now && w.resetsAt - now <= WEEK_UNDER_WITHIN && 100 - w.utilization >= WEEK_UNDER_UNUSED)
      .sort((x, y) => (x.resetsAt as number) - (y.resetsAt as number) || (x === headWeek ? -1 : y === headWeek ? 1 : 0))[0];
    if (week?.resetsAt != null) {
      const unused = pct(100 - week.utilization);
      const noun = windowNoun(week);
      out.push(make({
        kind: "week_under", tone: "opportunity", window: week, at: week.resetsAt,
        what: `wk ${unused}% left · ${fmtDay(week.resetsAt, now)}`,
        note: `${unused}% of the ${noun} unused. Resets ${fmtWhen(week.resetsAt, now)}.`,
        spoken: `${a.name} ${noun} ${unused}% unused, resets ${fmtWhen(week.resetsAt, now)}.`,
      }));
    }
  }
  return out;
}

/** Precedence: rank, then primary, then the soonest instant. */
export function compareSignals(x: UsageSignal, y: UsageSignal): number {
  if (x.rank !== y.rank) return x.rank - y.rank;
  if (x.primary !== y.primary) return x.primary ? -1 : 1;
  return (x.at ?? Infinity) - (y.at ?? Infinity);
}

// ---------------------------------------------------------------- the chip

export interface UsageSummary {
  /** Every signal across agents, in precedence order. */
  signals: UsageSignal[];
  /** The window the ring tracks and its tone. */
  ring: { agentId: string; window: PlanUsageWindow; tone: Tone } | null;
  /** Any agent's last refresh failed. */
  stale: boolean;
  /** The readable agents whose last refresh failed. */
  staleAgents: UsageAgent[];
  /** Every readable agent is stale. */
  allStale: boolean;
  /** The oldest successful read among the stale agents, or null. */
  staleSince: number | null;
  /** Every listed agent is unreadable. */
  unavailable: boolean;
  /** The accessible name. */
  spoken: string;
  /** Agents in popover order: signalled first by precedence, then primary, then the rest. */
  order: UsageAgent[];
}

/**
 * The calm ring: the busiest primary agent's session window, else the busiest
 * session window anywhere, else the fullest window of any kind.
 */
export function calmRing(agents: UsageAgent[]): { agentId: string; window: PlanUsageWindow } | null {
  const live = agents.filter((a) => a.snap.available && a.snap.windows.length > 0);
  const sessions = (list: UsageAgent[]) =>
    list.flatMap((a) => {
      const s = headlineWindows(a.snap.windows).session;
      return s ? [{ agentId: a.id, window: s }] : [];
    });
  const busiest = <T extends { window: PlanUsageWindow }>(xs: T[]) =>
    xs.reduce<T | null>((best, x) => (!best || x.window.utilization > best.window.utilization ? x : best), null);
  return (
    busiest(sessions(live.filter(isPrimary))) ??
    busiest(sessions(live)) ??
    busiest(live.flatMap((a) => a.snap.windows.map((window) => ({ agentId: a.id, window }))))
  );
}

export function summarizeUsage(agents: UsageAgent[], now: number = Date.now()): UsageSummary {
  const named = agents.length > 1;
  const perAgent = new Map(agents.map((a) => [a.id, agentSignals(a, now, named).sort(compareSignals)] as const));
  const signals = [...perAgent.values()].flat().sort(compareSignals);
  const live = agents.filter((a) => a.snap.available);
  const staleAgents = live.filter((a) => a.snap.stale);
  const stale = staleAgents.length > 0;
  const allStale = stale && staleAgents.length === live.length;
  const reads = staleAgents.map((a) => a.snap.fetchedAt).filter((t): t is number => t != null);
  const staleSince = reads.length ? Math.min(...reads) : null;
  const unavailable = agents.length > 0 && agents.every((a) => !a.snap.available);

  const top = signals[0];
  const calm = calmRing(agents);
  const ring = top?.window
    ? { agentId: top.agentId, window: top.window, tone: top.tone }
    : calm
      ? { ...calm, tone: "" as Tone }
      : null;

  const order = [...agents].sort((x, y) => {
    const sx = perAgent.get(x.id)?.[0];
    const sy = perAgent.get(y.id)?.[0];
    if (sx && sy) return compareSignals(sx, sy);
    if (sx || sy) return sx ? -1 : 1;
    if (isPrimary(x) !== isPrimary(y)) return isPrimary(x) ? -1 : 1;
    if (x.snap.available !== y.snap.available) return x.snap.available ? -1 : 1;
    return 0;
  });

  let spoken: string;
  if (unavailable) spoken = "Usage: unavailable.";
  else if (top) spoken = `Usage: ${top.spoken}`;
  else if (ring) {
    const a = agents.find((x) => x.id === ring.agentId);
    const left = spokenRemaining(ring.window.resetsAt, now);
    spoken = `Usage: ${a?.name ?? ""} ${windowNoun(ring.window)} ${pct(ring.window.utilization)}% used${left ? `, resets in ${left}` : ""}. No notices.`;
  } else spoken = "Usage: no windows reported.";
  if (signals.length > 1) spoken += ` ${signals.length - 1} more notice${signals.length === 2 ? "" : "s"}.`;
  if (stale) {
    const since = staleSince != null ? spokenAgo(staleSince, now) : null;
    spoken += ` Data is stale (${allStale ? "every agent" : staleAgents.map((a) => a.name).join(", ")}${since ? `, last read ${since} ago` : ""}).`;
  }
  const down = agents.filter((a) => !a.snap.available);
  if (!unavailable && down.length) spoken += ` ${down.map((a) => a.name).join(", ")} unavailable.`;
  return { signals, ring, stale, staleAgents, allStale, staleSince, unavailable, spoken, order };
}

// ---------------------------------------------------------------- truncation

/** One chip text candidate: the agent name (bold, may be empty) and the message. */
export interface ChipStep { who: string; what: string }

const dropReset = (what: string) => what.replace(/ · [^·]+$/, "");

/**
 * The chip's truncation ladder for a signal, widest first: full text, without
 * the reset suffix, without the agent name, without both. The chip shows the
 * first step that fits and falls back to the ring alone; it never cuts a word.
 */
export function chipLadder(s: UsageSignal): ChipStep[] {
  const bare = dropReset(s.what);
  const steps: ChipStep[] = [{ who: s.who, what: s.what }, { who: s.who, what: bare }, { who: "", what: s.what }, { who: "", what: bare }];
  const seen = new Set<string>();
  return steps.filter((x) => {
    const key = `${x.who}\u0000${x.what}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The stale label's ladder: "stale 47m" (every agent) or "stale · 47m" (some), then "stale". */
export function staleLadder(since: number | null, allStale: boolean, now: number = Date.now()): ChipStep[] {
  const ago = since != null ? fmtAgo(since, now) : null;
  return ago ? [{ who: "", what: `stale${allStale ? "" : " ·"} ${ago}` }, { who: "", what: "stale" }] : [{ who: "", what: "stale" }];
}

/** Time since a past instant, compact ("47m", "3h", "2d"). */
export function fmtAgo(at: number, now: number = Date.now()): string {
  const mins = Math.max(1, Math.round((now - at) / MIN));
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function spokenAgo(at: number, now: number): string {
  const mins = Math.max(1, Math.round((now - at) / MIN));
  const plural = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`;
  if (mins < 60) return plural(mins, "minute");
  const h = Math.round(mins / 60);
  return h < 48 ? plural(h, "hour") : plural(Math.round(h / 24), "day");
}

/** The role row's plain-words reason ("Auto (primary, last week 78%)"). */
export function roleText(snap: PlanUsageSnapshot): string {
  const role = snap.role;
  if (!role) return "Occasional";
  const value = role.value;
  if (role.source === "pinned") return `Pinned ${value}`;
  if (role.lastWeekPeak != null) return `Auto (${value}, last week ${pct(role.lastWeekPeak)}%)`;
  const week = headlineWindows(snap.windows).week;
  return `Auto (${value}, no completed week yet${week ? `, this week ${pct(week.utilization)}%` : ""})`;
}
