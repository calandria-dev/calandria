// Pure formatting + derivation helpers shared across the shell modules.
import type { AskQuestion, AskAnswers } from "@/lib/types";
import { contextWindowFor } from "@/lib/contextWindow";
import type { Msg, TaskRow, AgentCapabilities, AgentInfo } from "./types";
import type { InternalUsageEstimate } from "./types";

// Compact token count: 1234 → "1.2k", 1_200_000 → "1.2M".
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}
// Human byte size: 1536 → "1.5 KB", 5_242_880 → "5.0 MB". Base-1024.
export function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${i === 0 ? v : v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
// Dollar cost: sub-cent shows "<$0.01"; otherwise 2–3 sig digits after the point.
export function fmtCost(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
}

/**
 * The dollar figure the usage chip prints, which is not always a dollar figure.
 * A task whose turns ALL ran against an endpoint nobody has priced has nothing
 * to show — "—" is the honest answer and "$0.00" is a claim we can't make — and
 * one with a MIX shows what the priced turns came to, with a "+" saying there
 * is more that isn't counted. `usageTooltip` spells out which.
 */
export function fmtCostTotal(costUsd: number, unpricedTurns: number): string {
  if (unpricedTurns <= 0) return fmtCost(costUsd);
  if (costUsd <= 0) return "—";
  return `${fmtCost(costUsd)}+`;
}

export function fmtJobCost(e: InternalUsageEstimate): string {
  const cost = e.cost_usd <= 0 ? "$0.00" : e.cost_usd < 0.01 ? "<$0.01" : `$${e.cost_usd.toFixed(2)}`;
  return `~${fmtTokens(e.tokens)} tokens (~${cost})`;
}

// ---------- the usage chip (tokens + cost, honestly) ----------

// A task's cumulative tokens split by what they actually represent. The raw
// `total_tokens` sums all four buckets, and in real sessions ~90%+ of it is
// prompt-cache READS — the same context re-sent on every turn and billed at ~10%
// of the input rate. Leading with that reads as "this task burned 3.8M tokens"
// when the model only ever processed ~250k of new material, which is what scares
// people off. So the chip leads with `fresh` (tokens seen for the first time:
// in/out plus cache WRITES, which are billed above input rate) and carries cache
// reads as secondary detail. Defensive ?? 0s: a task row can predate the fields.
export interface UsageSplit {
  total: number;      // every bucket summed, subagent sidechains included
  fresh: number;      // main-session in/out + cache writes: material processed anew
  inOut: number;      // prompt + completion tokens, uncached
  cacheWrite: number; // context written into the cache (billed ~1.25× input)
  cacheRead: number;  // context re-read from the cache (billed ~0.1× input)
  subagent: number;   // of `total`, tokens burned inside Task-tool sidechains
}
export function usageSplit(
  t: Pick<TaskRow, "total_tokens" | "cache_read_tokens" | "cache_creation_tokens"> & Partial<Pick<TaskRow, "subagent_tokens">>
): UsageSplit {
  // The four stored buckets are the MAIN SESSION's alone — the Claude result
  // message excludes sidechains from its token counts while folding them into
  // its cost, so `subagent_tokens` is additional rather than a slice of
  // `total_tokens`. Adding it here is what makes the tooltip's grand total
  // describe the same turn the dollar figure beside it does.
  const main = t.total_tokens ?? 0;
  const subagent = t.subagent_tokens ?? 0;
  const cacheRead = t.cache_read_tokens ?? 0;
  const cacheWrite = t.cache_creation_tokens ?? 0;
  return {
    total: main + subagent,
    subagent,
    cacheRead,
    cacheWrite,
    inOut: Math.max(0, main - cacheRead - cacheWrite),
    fresh: Math.max(0, main - cacheRead),
  };
}

/**
 * How to present an agent's dollar figure. Two independent questions:
 *
 * - Is the number a MEASUREMENT or an estimate? `costIsEstimated` answers that
 *   (Codex reports tokens only, so its figure is tokens × published prices).
 * - Is the number MONEY THE USER SPENDS? Only under api-key auth. On a Max/Pro
 *   (or ChatGPT) subscription the marginal cost of a turn is $0 — the SDK's
 *   `total_cost_usd` is what the same tokens would have cost through the API,
 *   and what's actually consumed is plan quota. Showing a bare "$4.20" there
 *   reads as a bill for something that was included.
 *
 * Either one makes the figure approximate-in-meaning, so both get an `~` plus a
 * tooltip clause saying which it is. An unknown account (bundle still loading,
 * agent not connected) keeps the plain billed presentation — we won't claim a
 * turn was covered by a plan we can't see.
 */
export interface CostDisplay {
  show: boolean;   // render a dollar figure at all
  approx: boolean; // prefix it with ~
  note: string;    // tooltip clause explaining what the figure means ("" = a plain billed charge)
}
export function costDisplay(agent: AgentInfo | undefined): CostDisplay {
  const caps = agent?.capabilities;
  const estimated = caps?.costIsEstimated === true;
  const show = caps?.reportsCostUsd !== false || estimated;
  const subscription = agent?.account?.method === "subscription";
  const plan = agent?.account?.plan;
  // "Max"/"Pro"/"ChatGPT Plus" → "your Max plan"; unknown/"API" → "your plan".
  const planName = plan && !/^api$/i.test(plan) ? `your ${plan} plan` : "your plan";
  const source = estimated ? "estimated from token counts × published API prices" : "API-price equivalent";
  const note = subscription
    ? `${source}: this ran on ${planName} login, so it draws on plan quota, not a bill`
    : estimated
      ? source
      : "";
  return { show, approx: subscription || estimated, note };
}

// The usage chip's tooltip: the full breakdown the compact chip can't fit, one
// fact per line. Exact counts here (the chip rounds) — this is the view someone
// opens precisely because the rounded number surprised them.
export function usageTooltip(split: UsageSplit, costUsd: number, cost: CostDisplay, unpricedTurns = 0): string {
  const n = (v: number) => v.toLocaleString();
  const lines = [
    `${n(split.fresh)} new tokens this task: ${n(split.inOut)} in/out · ${n(split.cacheWrite)} written to cache`,
  ];
  if (split.cacheRead > 0) {
    lines.push(`${n(split.cacheRead)} cache reads (context re-read on every model request: each tool call is one; billed at ~10% of the input rate)`);
  }
  // The grand total is worth stating whenever it exceeds the headline `fresh`
  // figure — either because context was re-read, or because work happened in a
  // sidechain. It has to precede the subagent line for "of those" to refer to
  // anything.
  if (split.cacheRead > 0 || split.subagent > 0) {
    lines.push(`${n(split.total)} tokens total`);
  }
  // Absent for Codex and the mock driver, which don't report the split: no
  // line rather than a "0 in subagents" that reads as a measured claim.
  if (split.subagent > 0) {
    lines.push(`${n(split.subagent)} of those in subagents (their own windows, not this session's context)`);
  }
  if (cost.show && costUsd > 0) {
    lines.push(`${cost.approx ? "~" : ""}${fmtCost(costUsd)}${cost.note ? ` ${cost.note}` : " billed"}`);
  }
  // Said whether or not `cost.show` is on: the reason a figure is missing is
  // more useful than the figure would have been.
  if (unpricedTurns > 0) {
    const turns = `${n(unpricedTurns)} turn${unpricedTurns === 1 ? "" : "s"}`;
    lines.push(costUsd > 0
      ? `${turns} ran against a custom endpoint with no price set — the figure above covers only the rest`
      : `${turns} ran against a custom endpoint with no price set, so there is no cost to show — unknown, not $0.00`);
  }
  return lines.join("\n");
}

// Context window: the input-side tokens of the latest turn ≈ how full that
// window currently is. The size comes from the agent's capability descriptor
// (capabilities.models[].contextWindow) — Codex windows differ from Claude's, so
// it can't be a static Claude-only table. The miss policy (widest for
// Default/null, narrowest for an id the catalog doesn't know) is
// lib/contextWindow.ts, shared with the server's modelContextWindow().
export { DEFAULT_CONTEXT_WINDOW } from "@/lib/contextWindow";
export function contextWindowOf(model: string | null | undefined, caps?: AgentCapabilities): number {
  return contextWindowFor(caps?.models ?? [], model);
}
export function contextPct(tokens: number, model: string | null | undefined, caps?: AgentCapabilities): number {
  return Math.round((tokens / contextWindowOf(model, caps)) * 1000) / 10;
}

// Friendly name for a resolved model id — the badge that answers "which model
// did this turn actually run on?". The VERSION is the point: family aliases move
// (today "opus" resolves to claude-opus-5, last month claude-opus-4-8), so a bare
// "Opus" badge tells you nothing. Parse family + version out of the id first
// ("claude-opus-5" -> "Opus 5", "claude-opus-4-8-20251101" -> "Opus 4.8") and
// keep the `[1m]` marker, since the 1M variant is a distinct run mode.
// Non-Claude ids (Codex's "gpt-5.1-codex-max") carry no such version shape —
// those fall through to the agent's capability labels, matched longest-first so
// a shorter value can't shadow a more specific one. Raw id is the last resort.
export function modelLabel(id: string | null, caps?: AgentCapabilities): string {
  if (!id) return "";
  const s = id.toLowerCase();
  const long = s.includes("[1m]") ? " (1M)" : "";
  const fam = ["fable", "opus", "sonnet", "haiku"].find((f) => s.includes(f));
  if (fam) {
    const cap = fam[0].toUpperCase() + fam.slice(1);
    const v = s.match(new RegExp(`${fam}-(\\d+)(?:-(\\d+))?`));
    // Deliberately NOT the capability label here: an id we can't read a version
    // out of shouldn't be badged with a version we're only guessing at.
    return v ? `${cap} ${v[1]}${v[2] ? `.${v[2]}` : ""}${long}` : `${cap}${long}`;
  }
  const hit = (caps?.models ?? [])
    .filter((o) => s.includes(o.value.toLowerCase()))
    .sort((a, b) => b.value.length - a.value.length)[0];
  return hit ? hit.label : id;
}

// Phrase AskUserQuestion answers as a reply, for the reload fallback where the
// turn is no longer parked and we resume the session with a normal message.
export function formatAnswersText(questions: AskQuestion[], answers: AskAnswers): string {
  const lines = questions.map((q, i) => {
    const picked = (answers[i] ?? []).filter((s) => s && s.trim());
    return `- ${q.header || q.question}: ${picked.length ? picked.join(", ") : "(no selection)"}`;
  });
  return `Answering your question${questions.length > 1 ? "s" : ""}:\n${lines.join("\n")}`;
}
// Absolute wall-clock stamp for a transcript message ("3:42 PM", locale-aware).
// Messages from an earlier day prefix the date, so a task resumed days later
// still reads right. Absolute on purpose: MessageView is memoized, so a
// relative "2m ago" would freeze at whatever it said when the row rendered.
export function clockTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
export function relTime(ts: number): string {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
// ---------- scheduler health ----------
//
// A schedule promises work at 08:30 with nobody logged in, so the ONE thing the
// card must never do is show a confident "next run tomorrow 08:30" when nothing
// is actually watching for it. Three ways that happens, in order of how much
// they lie:
//
//   1. the ticker was never started (CALANDRIA_SCHEDULER=off, a boot ping that never
//      landed) — nothing will ever fire;
//   2. the ticker is started but its sweeps have STOPPED COMING BACK. This is
//      the quiet one: tickSchedules() is single-flight, so one call that never
//      returns (a stalled agent CLI in the fire-time probe, a hung git op)
//      leaves `ticking` true forever and every schedule on the instance stops,
//      with no error anywhere because nothing threw. A stale lastTickAt is the
//      only symptom it has, which is exactly why it's served;
//   3. a sweep completed but one schedule inside it threw.
//
// Aged against the server's real tick interval rather than a guessed one. The
// multiplier is generous (a sweep that fires several schedules serially can
// legitimately outlast one interval) with a floor, so a fast dev tick can't
// produce a banner that flickers on and off.
const STALE_TICKS = 4;
const STALE_FLOOR_MS = 120_000;

export interface SchedulerHealthLike {
  started: boolean;
  startedAt: number;
  lastTickAt: number;
  lastError: string;
  tickMs: number;
}

/** The banner the Schedules card should show, or null when all is well. */
export function schedulerAlert(h: SchedulerHealthLike, now = Date.now()): string | null {
  if (!h.started) return "The scheduler is not running on this instance. Nothing will fire.";
  const staleAfter = Math.max(STALE_TICKS * (h.tickMs || 0), STALE_FLOOR_MS);
  // Before the first sweep returns there is no lastTickAt to age, so fall back
  // to when the ticker started — that covers the worst case of all, a very
  // first sweep that hung on boot.
  const since = h.lastTickAt || h.startedAt;
  if (since && now - since > staleAfter) {
    return `The scheduler hasn't completed a check since ${relTime(since)}. It looks stuck, so nothing is firing. Restarting the app clears it.`;
  }
  if (h.lastError) {
    return `A schedule failed on the last check: ${h.lastError}. The others still ran.`;
  }
  return null;
}

// How long a task has been waiting on the user, spelled out for the "need you"
// dropdown ("waiting for 3 hours"). Coarser and more verbose than relTime — this
// is the only subline a row gets, so it reads as prose rather than a chip.
export function waitedFor(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (s < 45) return "a few seconds";
  const m = Math.round(s / 60);
  if (m < 1) return "a minute";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}
export function duration(start: number, end: number | null): string {
  if (!end) return "active";
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// A task is "waiting on you" when its awaiting_input flag is set — Claude either
// ended its turn mid-task or is parked on an AskUserQuestion. The flag is the
// single source of truth (cleared the instant the next turn starts / a question
// is answered), so this holds even while the turn is technically still live and
// parked on the question — that's exactly the case the task list must surface.
export const isAwaiting = (t: TaskRow) =>
  t.status === "in_progress" && !!t.awaiting_input;

// A task whose open PR is red. The OTHER way a task needs a human, and the one
// nothing was parked for: the turn ended, the agent verified locally, and CI
// disagreed. `pr_state === "open"` matters — a merged or closed PR is never
// re-polled, so its last-seen "failing" could never clear itself — and the
// status screen keeps a held or cancelled task quiet, since somebody has
// already decided not to pursue it.
//
// Mirrors the server's PR_RED_ARM in lib/store.ts, which is what the pill
// counts for every OTHER project; the two must agree or the selected project's
// count would jump as you switch to it.
export const isPrRed = (t: TaskRow) =>
  t.pr_state === "open" && t.pr_checks === "failing" && (t.status === "in_progress" || t.status === "done");

// The union: what "N need you" means. Every attention surface (the pill count,
// the list's Needs-you group, the board's Needs-input column) partitions on
// THIS, not on isAwaiting — and every status group excludes it, or a done task
// with a red PR would be drawn twice.
export const needsYou = (t: TaskRow) => isAwaiting(t) || isPrRed(t);

// The red checks stored on the row, parsed. Defensive for the same reason the
// server's parseFailingChecks is: a column an older build never wrote must cost
// a chip its detail, not throw inside a task list.
export function prFailingChecks(t: Pick<TaskRow, "pr_failing">): { name: string; url: string; workflow: string }[] {
  if (!t.pr_failing) return [];
  try {
    const v = JSON.parse(t.pr_failing);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// A task whose last UNATTENDED run finished cleanly and which nobody has looked
// at yet — the resting state of a scheduled success (lib/runner.ts). It is
// deliberately not "needs you": nothing is waiting on an answer, so it stays
// out of the pill. But it isn't working either, and it isn't done — the output
// hasn't been read — so it gets a category of its own instead of resting in
// "In progress", where it was indistinguishable from live work and where
// nothing ever moved it (issue #28).
//
// `running` is part of the predicate, not a nicety: the coarse /api/events
// payload settles running before a client would ever refetch the row, so a
// task the mark still sits on because its NEXT turn is already streaming must
// read as working, not as finished.
export const isUnreadRun = (t: TaskRow) =>
  t.status === "in_progress" && t.unread_run_at > 0 && !t.running && !t.awaiting_input;

// A tray suggestion an agent has retracted (the withdraw_suggestion tool): still
// `suggested`, so it stays in the tray for the user to revive or dismiss, but
// cancelled — and therefore no longer proposing anything. Without this the tray
// draws it identically to a live suggestion, which is the whole reason the tool
// would be useless: a retraction nobody can see isn't one.
//
// Keyed on the STATE, not on withdrawn_reason: a suggestion cancelled any other
// way (the edit dialog) is just as dead and should read the same. The reason is
// what gets shown when there is one, not what qualifies a row.
export const isWithdrawn = (t: TaskRow) => !!t.suggested && t.status === "cancelled";

// Live suggestions first, withdrawn ones after — a stable partition, so within
// each half the tray keeps its manual order. Retractions are the tail of the
// tray rather than hidden: the user still has to decide whether to agree.
export const withdrawnLast = (a: TaskRow, b: TaskRow) => Number(isWithdrawn(a)) - Number(isWithdrawn(b));

// A terminal task will never finish anything again: it is done, or it was
// cancelled and won't be resumed. Mirrors `blocks()` in lib/autoStart.ts, which
// is what actually decides whether a dependent may start.
export const isTerminal = (t: { status: TaskRow["status"] }) => t.status === "done" || t.status === "cancelled";

// Case-insensitive, locale-aware A→Z. Picker lists are scanned by eye for a
// name the user already has in mind, so alphabetical beats any recency or
// filing order there — "Auth" shouldn't sort after "auth migration".
export const alphabetical = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

// The tasks a "Blocked by" picker may offer. Two kinds are left out, because
// offering them is offering an edge that means nothing yet: a TERMINAL task
// can't block anything by definition, and an unreviewed SUGGESTION isn't on the
// board — picking one would wait on work nobody has agreed to do.
//
// Both have the same exception, and it is the whole point of the exception: one
// ALREADY selected stays listed. An edge drawn while the blocker was live must
// survive it finishing, and an edge an agent drew onto a suggestion
// (`update_task`'s `blocked_by`, which never checks `suggested`) has to be
// visible somewhere — the picker is the only screen that can untick it, and a
// suggestion DOES block server-side (issue #46).
export const blockerCandidates = (candidates: TaskRow[], selected: string[]): TaskRow[] =>
  candidates
    .filter((c) => (!isTerminal(c) && !c.suggested) || selected.includes(c.id))
    .sort((a, b) => alphabetical(a.title, b.title));

// One rule for "does this dependency still gate a start", shared by the chip
// and by the two dialogs' Start gates. It mirrors `blocks()` in lib/autoStart.ts
// — the predicate that actually decides — on both of its edges:
//
//   - a terminal blocker doesn't block. It will never finish, so waiting on it
//     would deadlock the dependent forever.
//   - a ref that resolves to NOTHING doesn't block either. `blocks()` returns
//     false for a missing task, and the client disagreeing meant a deleted or
//     not-yet-loaded blocker disabled a Start the server would have allowed.
//
// A SUGGESTED blocker does block, agreeing with the server. It is drawn as one
// (`blockerCandidates` above lists it, `blockerTitles` names it as suggested)
// rather than silently ignored.
export const isBlocking = (b: TaskRow | undefined): b is TaskRow => !!b && !isTerminal(b);

// The titles of a task's unfinished blockers. A task with any of these is
// "blocked" and can't be started until they clear. A blocker still sitting in
// the Suggested tray is named as such: it blocks like any other, but it clears
// by being accepted, dismissed or unticked rather than by being worked, and the
// chip is where a user finds out that's what they're waiting on.
export const blockerTitles = (t: TaskRow, byId: Map<string, TaskRow>): string[] =>
  (t.depends_on ?? [])
    .map((id) => byId.get(id))
    .filter(isBlocking)
    .map((b) => (b.suggested ? `${b.title} (suggested)` : b.title));

// add/del/ctx class for a diff line's sign — shared by the peek and full views.
export const diffCls = (sign: "+" | "-" | " ") => (sign === "+" ? "add" : sign === "-" ? "del" : "ctx");

// group flat messages into per-generation sessions, pulling out the /clear summaries
export function buildSessions(messages: Msg[]) {
  const summaryByGen: Record<number, string> = {};
  for (const m of messages) if (m.role === "session_break") summaryByGen[m.generation] = m.content;
  // Queued follow-ups are excluded here — they haven't run yet, so SessionView
  // renders them in a pinned block below the live "thinking" indicator instead
  // of interleaved with the committed transcript.
  const committed = messages.filter((m) => m.role !== "queued");
  const gens = Array.from(new Set(committed.filter((m) => m.role !== "session_break").map((m) => m.generation))).sort((a, b) => a - b);
  return gens.map((n) => ({
    n,
    summaryBefore: summaryByGen[n - 1] ?? null,
    messages: committed.filter((m) => m.generation === n && m.role !== "session_break"),
  }));
}

// ---------- chat attachments (images + large text pastes) ----------
// An upload travels inside the message text as one marker line per file:
// "[Attached image: /abs/path.png]" for images, "[Attached file: /abs/path.ext]"
// for every other type (any file may be attached; a big text paste is also
// diverted here, see PASTE_ATTACH_THRESHOLD). The same string serves both
// sides — the agent gets an absolute path to a file staged outside the worktree
// and decides how to open it, and the transcript strips the marker back out to
// render an inline thumbnail (image) or a named file chip. The serving URL is
// derived from the path's uploads/<task>/<file> tail, so no extra columns or
// event fields are needed.
export const attachmentMarker = (absPath: string) => `[Attached image: ${absPath}]`;
export const fileAttachmentMarker = (absPath: string) => `[Attached file: ${absPath}]`;
const ATTACHMENT_RE = /^\[Attached (image|file): (.+)\]$/;

export interface MsgAttachment { path: string; url: string; kind: "image" | "file"; name: string }

// Split a user message into displayable text + attachment chips. Marker lines
// whose path doesn't end in uploads/<task>/<file> (hand-typed lookalikes) stay
// in the text untouched.
export function splitAttachments(content: string): { text: string; attachments: MsgAttachment[] } {
  if (!content.includes("[Attached image: ") && !content.includes("[Attached file: ")) {
    return { text: content, attachments: [] };
  }
  const attachments: MsgAttachment[] = [];
  const kept: string[] = [];
  for (const line of content.split("\n")) {
    const m = ATTACHMENT_RE.exec(line.trim());
    const parts = m ? m[2].split(/[\\/]/).filter(Boolean) : [];
    if (m && parts.length >= 3 && parts[parts.length - 3] === "uploads") {
      const [taskId, file] = parts.slice(-2);
      attachments.push({ path: m[2], url: `/api/tasks/${taskId}/uploads/${file}`, kind: m[1] === "image" ? "image" : "file", name: file });
    } else {
      kept.push(line);
    }
  }
  return { text: kept.join("\n").trim(), attachments };
}

// ---------- pull-request state ----------
// The wording for tasks.pr_state / pr_checks / pr_review, kept here rather than
// in the chip because the "needs you" surfaces and the merge button want the
// same words, and two copies would drift. Every helper takes the raw column
// value, so "" (never refreshed yet) is a case each one answers deliberately.

/** How a PR's state reads, and the tone it's drawn in. "" = not refreshed yet. */
export function prStateLabel(state: string): { label: string; tone: "open" | "merged" | "closed" | "unknown" } {
  switch (state) {
    case "open": return { label: "Open", tone: "open" };
    case "merged": return { label: "Merged", tone: "merged" };
    case "closed": return { label: "Closed", tone: "closed" };
    default: return { label: "Checking…", tone: "unknown" };
  }
}

/**
 * How the check rollup reads. "none" is deliberately NOT green: a repo with no
 * CI at all has proved nothing, so it gets no verdict rather than a tick.
 */
export function prChecksLabel(checks: string): { label: string; tone: "pass" | "fail" | "pending" } | null {
  switch (checks) {
    case "passing": return { label: "checks passing", tone: "pass" };
    case "failing": return { label: "checks failing", tone: "fail" };
    case "pending": return { label: "checks running", tone: "pending" };
    default: return null; // "none" (no CI) and "" (not refreshed yet) say nothing
  }
}

/** How gh's reviewDecision reads. "" means review isn't required on this repo. */
export function prReviewLabel(review: string): { label: string; tone: "pass" | "fail" | "pending" } | null {
  switch (review) {
    case "APPROVED": return { label: "approved", tone: "pass" };
    case "CHANGES_REQUESTED": return { label: "changes requested", tone: "fail" };
    case "REVIEW_REQUIRED": return { label: "review required", tone: "pending" };
    default: return null;
  }
}

/** The chip's tooltip: everything the columns know, spelled out in one line. */
export function prTooltip(
  task: Pick<TaskRow, "pr_url" | "pr_state" | "pr_checks" | "pr_review" | "pr_synced_at" | "pr_failing">
): string {
  const bits = [prStateLabel(task.pr_state).label];
  const checks = prChecksLabel(task.pr_checks);
  if (checks) bits.push(checks.label);
  else if (task.pr_checks === "none") bits.push("no checks configured");
  const review = prReviewLabel(task.pr_review);
  if (review) bits.push(review.label);
  const synced = task.pr_synced_at ? `checked ${relTime(task.pr_synced_at)}` : "not checked yet";
  // Name the red jobs in the hover too, not only in the chip: the chip has room
  // for one or two before it has to say "+3 more", and the tooltip has room for
  // all of them.
  const red = prFailingChecks(task);
  const named = red.length ? `\nfailing: ${red.map((c) => c.name).join(", ")}` : "";
  return `${task.pr_url}\n${bits.join(" · ")} · ${synced}${named}`;
}
