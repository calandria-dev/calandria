// Pure Work Center view model: turns a contract work-center/1 snapshot into the
// groups, rows and count strings the UI draws (design release
// work-center-design-release/1, sections 2 to 4). No React and no browser
// globals, so it unit-tests directly.

import type { Attention, Count, Lifecycle, Outcome, Snapshot, Summary, WaitingReason, WorkRow } from "@/lib/workCenter/types";

type Kind = Attention["kind"];

// Chips on a row follow this fixed order; inline actions belong to the first live item.
export const KIND_ORDER: Kind[] = ["permission", "question", "review", "turn_failure", "base_rewrite", "ci", "settings_proposal", "agent_edit"];

export const KINDS: Record<Kind, { label: string; verb: string; role: "decide" | "fail" | "review" }> = {
  permission: { label: "Permission", verb: "Decide", role: "decide" },
  question: { label: "Question", verb: "Answer", role: "decide" },
  review: { label: "Review", verb: "Decide review", role: "review" },
  turn_failure: { label: "Turn failed", verb: "Recover", role: "fail" },
  base_rewrite: { label: "Base rewritten", verb: "Repair base", role: "fail" },
  ci: { label: "CI failing", verb: "Open checks", role: "fail" },
  settings_proposal: { label: "Settings proposal", verb: "Decide", role: "decide" },
  agent_edit: { label: "Agent edit", verb: "Acknowledge", role: "decide" },
};

export const LIFE_LABEL: Record<Lifecycle, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  on_hold: "On hold",
  done: "Done",
  cancelled: "Cancelled",
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  ok: "Turn finished",
  failed: "Turn failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
  unknown: "Unknown result",
};

// ---------- counts ----------

export type CountView = {
  /** What to draw: the number, `known+`, or the dash. */
  txt: string;
  /** loading = no snapshot yet; unknown = a snapshot count with value null; zero = a real zero. */
  kind: "loading" | "unknown" | "zero" | "value";
  n: number | null;
  title: string;
};

export function countView(c: Count | null | undefined): CountView {
  if (!c) return { txt: "\u2014", kind: "loading", n: null, title: "not loaded" };
  if (c.value === null) return { txt: `${c.known}+`, kind: "unknown", n: null, title: `${c.known} known · total unknown` };
  return { txt: String(c.value), kind: c.value === 0 ? "zero" : "value", n: c.value, title: "" };
}

export type Headline = {
  working: CountView;
  need: CountView;
  /** The `/ M` item figure: only when both counts are exact and they differ. */
  items: string | null;
};

export function headline(summary: Summary | null | undefined): Headline {
  const working = countView(summary?.workingTaskCount);
  const need = countView(summary?.visibleNeedsYouTaskCount);
  const itemCount = summary?.visibleAttentionItemCount;
  const items =
    need.n !== null && itemCount && itemCount.value !== null && itemCount.value !== need.n ? String(itemCount.value) : null;
  return { working, need, items };
}

// ---------- rows ----------

export function isRowSnoozed(r: WorkRow, now: number): boolean {
  return r.snoozedUntil !== null && r.snoozedUntil > now;
}

const kindRank = (k: Kind) => KIND_ORDER.indexOf(k);

/** A row's live attention items in chip order. Snoozed or locally cleared items are left out. */
export function liveItems(r: WorkRow, now: number, cleared?: ReadonlySet<string>): Attention[] {
  return r.attention
    .filter((a) => (a.snoozedUntil === null || a.snoozedUntil <= now) && !cleared?.has(a.id))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.firstOccurredAt - b.firstOccurredAt);
}

export type Groups = { need: WorkRow[]; work: WorkRow[]; wait: WorkRow[] };

/** The list's sections in render order: running tasks first, then decisions, then the rest. */
export type GroupKey = "work" | "need" | "wait" | "rec";
export const GROUP_ORDER: GroupKey[] = ["work", "need", "wait", "rec"];

/** localStorage key holding one section's collapsed flag. Instance-wide, since the list spans every project. */
export const groupCollapsedKey = (g: GroupKey) => `calandria_wc_${g}_collapsed`;

/**
 * A task appears once: needs-you wins over working, working over waiting.
 * Needs-you rows sort by their oldest unresolved item, the others by last
 * activity, newest first. A row the server listed that fits no group still
 * shows under Waiting, so an in-progress task with nothing live stays discoverable.
 */
export function groupRows(rows: WorkRow[], now: number, cleared?: ReadonlySet<string>, hidden?: ReadonlySet<string>): Groups {
  const g: Groups = { need: [], work: [], wait: [] };
  for (const r of rows) {
    if (isRowSnoozed(r, now) || hidden?.has(r.taskId)) continue;
    if (liveItems(r, now, cleared).length) g.need.push(r);
    else if (r.execution.isWorking) g.work.push(r);
    else g.wait.push(r);
  }
  const oldest = (r: WorkRow) => Math.min(...liveItems(r, now, cleared).map((a) => a.firstOccurredAt));
  const last = (r: WorkRow) => r.execution.lastActivityAt ?? 0;
  g.need.sort((a, b) => oldest(a) - oldest(b));
  g.work.sort((a, b) => last(b) - last(a));
  g.wait.sort((a, b) => last(b) - last(a));
  return g;
}

export function ago(now: number, t: number | null): string {
  if (t === null) return "";
  const m = Math.round((now - t) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The waiting reasons of a row as sentences; `detail_unavailable` is flagged so it can be set apart. */
export function waitingText(r: WorkRow): { reason: WaitingReason; text: string }[] {
  const ex = r.execution;
  return ex.waitingReasons.map((reason) => {
    switch (reason) {
      case "input": return { reason, text: "Parked on your decision" };
      case "wakeup": {
        const at = ex.wakeups.length ? Math.min(...ex.wakeups.map((w) => w.at)) : null;
        return { reason, text: at === null ? "Sleeps until a wakeup" : `Sleeps until ${clock(at)}` };
      }
      case "queued": {
        const q = ex.queuedStart;
        if (q) {
          const when = q.at ? clock(q.at) : null;
          const why = q.reason === "usage_reset" ? `usage limit resets${when ? ` ${when}` : ""}` : q.reason === "capacity" ? "waiting for capacity" : when ? `starts ${when}` : "scheduled";
          return { reason, text: `Queued · ${why}` };
        }
        const n = ex.queuedFollowupCount;
        return { reason, text: `Queued · ${n} follow-up${n === 1 ? "" : "s"}` };
      }
      case "dependency": {
        const n = ex.blockerTaskIds.length;
        return { reason, text: n ? `Blocked by ${n} task${n === 1 ? "" : "s"}` : "Blocked by a dependency" };
      }
      case "on_hold": return { reason, text: "On hold" };
      case "no_live_turn": return { reason, text: "Nothing running" };
      case "external": return { reason, text: `Waiting on ${ex.externalWait?.kind === "capacity" ? "capacity" : "the provider"}` };
      case "detail_unavailable": return { reason, text: "Background detail unavailable" };
      case "review_required": return { reason, text: "Required review unsatisfied" };
    }
  });
}

/** Lifecycle label: only when the task is not in progress; `odd` when it contradicts live work or a decision. */
export function lifecycleLabel(r: WorkRow, liveCount: number): { text: string; odd: boolean } | null {
  if (r.lifecycle === "in_progress") return null;
  const terminal = r.lifecycle === "done" || r.lifecycle === "cancelled";
  const odd = (terminal && (liveCount > 0 || r.execution.isWorking)) || (r.lifecycle === "on_hold" && liveCount > 0);
  return { text: LIFE_LABEL[r.lifecycle], odd };
}

/** The `#41` a CI item names, shown as a chip suffix. */
export function chipMeta(a: Attention): string {
  return a.kind === "ci" ? (a.title.match(/#\d+/)?.[0] ?? "") : "";
}

export const isStaleItem = (a: Attention) => a.freshness.state !== "fresh";

// ---------- inline actions ----------

export type InlineAction = "allow" | "deny" | "ack" | "open" | "accept" | "waive";

/**
 * What the review route says about a review item's request, read before its
 * inline buttons are offered. `matches` is false when the request moved past
 * the revision and version the item names, so nothing may be decided from it.
 */
export type ReviewFacts = { revision: number; required: boolean; canAccept: boolean; canWaive: boolean; matches: boolean };

/** A review item a person can decide from the row: a pending request, not a failed effect to recover. */
export const isDecidableReview = (a: Attention | undefined) => a?.kind === "review" && a.action === "decide_review";

/**
 * Which inline buttons the first live item gets on desktop (release section 4). Snooze is always added by the row.
 * A review gets Accept and Waive only once its facts are read and still match the item; Request changes navigates.
 */
export function inlineActionsFor(a: Attention | undefined, facts?: ReviewFacts | null): InlineAction[] {
  if (!a) return [];
  if (a.kind === "permission" && a.inlineDecision === "allow_once_or_deny") return ["allow", "deny"];
  if (a.kind === "agent_edit") return ["ack", "open"];
  if (isDecidableReview(a) && facts?.matches) {
    const out: InlineAction[] = [];
    if (facts.canAccept) out.push("accept");
    if (facts.required && facts.canWaive) out.push("waive");
    return out.length ? out : ["open"];
  }
  return ["open"];
}

/** Phone action sheet entries for an item, ahead of Snooze. A review offers Accept (release section 4). */
export function sheetActionsFor(a: Attention | undefined, facts?: ReviewFacts | null): InlineAction[] {
  if (a?.kind === "agent_edit") return ["open", "ack"];
  if (isDecidableReview(a) && facts?.matches && facts.canAccept) return ["open", "accept"];
  return ["open"];
}

// ---------- action text (maps from the design: MSG, FAIL, IND) ----------

export type ActionKey = "ack" | "allow" | "deny" | "snz";

export const ACTION_PENDING: Record<ActionKey, string> = {
  ack: "Acknowledging…",
  allow: "Sending decision…",
  deny: "Sending decision…",
  snz: "Snoozing…",
};
export const ACTION_OK: Record<ActionKey, [string, string]> = {
  ack: ["Acknowledged.", "Row clears on next refresh."],
  allow: ["Allowed once.", "The turn resumes; scope unchanged."],
  deny: ["Denied.", "The agent is told and the turn continues."],
  snz: ["Snoozed.", "Hidden until then."],
};
export const ACTION_FAIL: Record<ActionKey, string> = {
  ack: "Couldn't acknowledge",
  allow: "Decision not delivered",
  deny: "Decision not delivered",
  snz: "Snooze not saved",
};
export const ACTION_IND: Record<ActionKey, string> = {
  ack: "The acknowledge call timed out after the request was sent. It may or may not have applied.",
  allow: "The reply was lost. The agent may already be running the command.",
  deny: "The reply was lost. The denial may or may not have reached the agent.",
  snz: "Snooze may have been saved.",
};

/** A FAIL message always carries the real HTTP status in parentheses. */
export function failText(key: ActionKey, status: number): string {
  return `${ACTION_FAIL[key]} (${status}).`;
}

// ---------- snapshot freshness ----------

export type Connection = {
  /** No snapshot has arrived yet. */
  loading: boolean;
  /** The last fetch failed; the snapshot shown is the last good one. */
  error: string | null;
  /** The live feed is down. */
  disconnected: boolean;
};

/** Stale means the numbers shown may be old: a failed fetch or a dropped feed with data on screen. */
export const isStale = (c: Connection, snap: Snapshot | null): boolean => !!snap && (!!c.error || c.disconnected);

/** True when the snapshot lists a coverage hole, so the totals are partial. */
export const partialSources = (snap: Snapshot | null): string[] =>
  snap ? snap.coverage.filter((c) => c.state === "unavailable" || c.state === "partial").map((c) => c.source) : [];
