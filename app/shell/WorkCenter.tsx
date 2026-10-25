"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { ReviewView } from "@/lib/reviews/types";
import type { Attention, WorkRow } from "@/lib/workCenter/types";
import { Icon } from "../icons";
import {
  DECISION_IND, DECISION_OK, DECISION_PENDING, decisionFailText, newIdempotencyKey, postReviewAction, type ReviewIntent,
} from "./reviewActions";
import { snoozePresets } from "./snooze";
import type { ProjectRow } from "./types";
import type { WorkCenterData } from "./useWorkCenter";
import {
  ACTION_IND, ACTION_OK, ACTION_PENDING, KINDS, OUTCOME_LABEL, ago, chipMeta, failText, groupRows, headline, inlineActionsFor,
  GROUP_ORDER, groupCollapsedKey, isDecidableReview, isStale, isStaleItem, lifecycleLabel, liveItems, partialSources, sheetActionsFor,
  waitingText, type ActionKey, type CountView, type GroupKey, type InlineAction, type ReviewFacts,
} from "./workCenterModel";

// The Work Center (design release work-center-design-release/1): the persistent
// two-count pill and the surface it opens. `pop` is the desktop and narrow-window
// popover, `phone` is the Work tab. Rows come from the server snapshot only; the
// client adds outcome strips for the action it just ran and nothing else.

// ---------- shared view state, owned by the Shell so Back can restore it ----------

export type WcViewState = {
  /** The selected row id: a task id, or `rec:<taskId>` for a recently-finished entry. */
  selected: string | null;
  scrollTop: number;
  /** Tasks whose destination no longer exists; drawn with the "resolved under you" strip. */
  resolved: Set<string>;
};
export const newWcViewState = (): WcViewState => ({ selected: null, scrollTop: 0, resolved: new Set() });

/** What the Shell needs to open a destination from a row. */
export type WcOpen = {
  projectId: string;
  taskId: string;
  sessionId: string | null;
  messageId: string | null;
  /** Set for a review item: the Review tab anchors this request and submission. */
  reviewRequestId?: string | null;
  submissionId?: string | null;
  surface: Attention["destination"]["surface"] | "transcript_end";
  rowId: string;
};

const projectOf = (projects: ProjectRow[], id: string) => projects.find((p) => p.id === id);

// ---------- small pieces ----------

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** The ripple runs for 30 seconds after the working count changes, then holds still. */
function useRippleActive(key: string): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    setOn(true);
    const t = setTimeout(() => setOn(false), 30_000);
    return () => clearTimeout(t);
  }, [key]);
  return on;
}

/**
 * Per-section collapsed flags, persisted in localStorage so the choice survives reloads. Every section starts open.
 * Read in the initializer, so the open-focus layout effect never lands on a row a collapsed section is about to hide.
 */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Partial<Record<GroupKey, boolean>>>(() => {
    const out: Partial<Record<GroupKey, boolean>> = {};
    if (typeof window === "undefined") return out;
    for (const g of GROUP_ORDER) {
      try { if (localStorage.getItem(groupCollapsedKey(g)) === "1") out[g] = true; } catch {}
    }
    return out;
  });
  const toggle = (g: GroupKey) => setCollapsed((c) => {
    const shut = !c[g];
    try { localStorage.setItem(groupCollapsedKey(g), shut ? "1" : "0"); } catch {}
    return { ...c, [g]: shut };
  });
  return { collapsed, toggle };
}

const Warn = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden><path d="M8 2l6.5 11.5H1.5L8 2z" /><path d="M8 6.5v3M8 11.5v.5" /></svg>
);
const Question = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden><circle cx={8} cy={8} r={6} /><path d="M6.2 6.3a1.9 1.9 0 013.7.5c0 1.2-1.9 1.4-1.9 2.6M8 11.6v.4" /></svg>
);

// ---------- the pill ----------

export function WorkCenterPill({ data, open, onClick, pillRef, tall }: {
  data: WorkCenterData; open: boolean; onClick: () => void; pillRef: RefObject<HTMLButtonElement | null>;
  /** Phone title bar: the taller touch target. */
  tall?: boolean;
}) {
  const h = headline(data.snap?.summary);
  const stale = isStale({ loading: data.loading, error: data.error, disconnected: data.disconnected }, data.snap);
  const rippling = useRippleActive(h.working.txt) && !stale && h.working.kind !== "unknown" && h.working.kind !== "loading";
  const hot = h.need.kind === "value" || h.need.kind === "unknown";
  const label = `Work Center: ${h.working.txt} working, ${h.need.txt} need you${h.need.kind === "unknown" ? " (total unknown)" : ""}${stale ? ", data stale" : ""}`;
  return (
    <button
      ref={pillRef}
      className={`wc-pill${tall ? " tall" : ""}${hot ? " hot" : ""}${stale ? " stale" : ""}${open ? " open" : ""}`}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={h.need.title || h.working.title || undefined}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <span className={`wc-pill-c run${h.working.kind === "unknown" || h.working.kind === "loading" ? " unk" : ""}`}>
        <span className={`wc-ico wc-ico-11 run${rippling ? "" : " still"}${h.working.kind === "unknown" || h.working.kind === "loading" ? " faded" : ""}`}>{Icon.working()}</span>
        <span className="wc-pill-n">{h.working.txt}</span>
      </span>
      <span className={`wc-pill-c need${h.need.kind === "unknown" || h.need.kind === "loading" ? " unk" : ""}${h.need.kind === "zero" ? " zero" : ""}`}>
        <span className={`wc-ico wc-ico-11 need${h.need.kind === "zero" ? " zero" : ""}${h.need.kind === "unknown" || h.need.kind === "loading" ? " faded" : ""}`}>{Icon.needsYou()}</span>
        <span className="wc-pill-n">{h.need.txt}</span>
      </span>
      {stale && <span className="wc-pill-st" title="Showing last good data">{Icon.clock()}</span>}
    </button>
  );
}

// ---------- snooze menu ----------

type SnoozeChoice = { key: string; label: string; until: number; hint: string };

/** The three entries of the design, resolved by the shared presets so the time math is the board's. */
export function snoozeChoices(now: number): SnoozeChoice[] {
  const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const byKey = new Map(snoozePresets(now).map((p) => [p.key, p]));
  const out: SnoozeChoice[] = [];
  const hour = byKey.get("1h");
  if (hour) out.push({ key: "1h", label: "1 hour", until: hour.until, hint: clock(hour.until) });
  const tomorrow = byKey.get("tomorrow");
  if (tomorrow) out.push({ key: "tomorrow", label: "Until tomorrow", until: tomorrow.until, hint: clock(tomorrow.until) });
  const week = byKey.get("week");
  if (week) out.push({ key: "week", label: "Until Monday", until: week.until, hint: `${new Date(week.until).toLocaleDateString([], { weekday: "short" })} ${clock(week.until)}` });
  return out;
}

function SnoozeMenu({ onPick, onClose }: { onPick: (c: SnoozeChoice) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const choices = useMemo(() => snoozeChoices(Date.now()), []);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, []);
  const onKey = (e: KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "Tab") { e.preventDefault(); items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus(); }
  };
  return (
    <div ref={ref} className="wc-menu" role="menu" aria-label="Snooze task" onKeyDown={onKey} onClick={(e) => e.stopPropagation()}>
      <div className="wc-menu-h">Snooze task</div>
      {choices.map((c) => (
        <button key={c.key} role="menuitem" onClick={() => onPick(c)}>{c.label}<span className="wc-menu-m">{c.hint}</span></button>
      ))}
      <div className="wc-menu-h warn">Hidden from Work Center until then.</div>
    </div>
  );
}

// ---------- outcome strip ----------

type RowOutcome = {
  /** `conflict`: a review decision the server refused because the review moved; Dismiss refetches. */
  type: "pending" | "ok" | "fail" | "ind" | "gone" | "conflict";
  msg: string;
  sub?: string;
  key?: ActionKey;
  /** Indeterminate only: the person ticked "May duplicate". */
  ack?: boolean;
  /** Fail only: a resend cannot change the outcome, so only Dismiss is offered. */
  noRetry?: boolean;
};

function OutcomeStrip({ o, onRetry, onDismiss, onAck }: { o: RowOutcome; onRetry: () => void; onDismiss: () => void; onAck: (v: boolean) => void }) {
  if (o.type === "pending") return <div className="wc-out ind" role="status"><span className="wc-spin" />{o.msg}</div>;
  if (o.type === "ok") return <div className="wc-out ok" role="status">{Icon.check()}<span>{o.msg}</span>{o.sub && <span className="wc-out-sub">{o.sub}</span>}</div>;
  if (o.type === "fail") {
    return (
      <div className="wc-out fail" role="status"><Warn /><span>{o.msg}</span>
        <span className="wc-out-a">{!o.noRetry && <button className="wc-act sm" onClick={onRetry}>Retry</button>}<button className="wc-act sm ghost" onClick={onDismiss}>Dismiss</button></span>
      </div>
    );
  }
  if (o.type === "ind") {
    return (
      <div className="wc-out ind" role="status"><Question /><span><b>Unknown result.</b> {o.msg}</span>
        <span className="wc-out-a">
          <label><input type="checkbox" checked={!!o.ack} onChange={(e) => onAck(e.target.checked)} /> May duplicate</label>
          <button className="wc-act sm" disabled={!o.ack} onClick={onRetry}>Retry</button>
          <button className="wc-act sm ghost" onClick={onDismiss}>Leave as is</button>
        </span>
      </div>
    );
  }
  if (o.type === "conflict") {
    return <div className="wc-out fail" role="status"><Warn /><span>{o.msg}</span><span className="wc-out-a"><button className="wc-act sm ghost" onClick={onDismiss}>Dismiss</button></span></div>;
  }
  return <div className="wc-out gone" role="status">{Icon.clock()}<span>{o.msg}</span><span className="wc-out-a"><button className="wc-act sm ghost" onClick={onDismiss}>OK</button></span></div>;
}

// ---------- waive popover ----------

function WaiveMenu({ rev, onWaive, onClose }: { rev: number; onWaive: (reason: string) => void; onClose: () => void }) {
  const [val, setVal] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div
      className="wc-menu wc-waive"
      role="dialog"
      aria-label={`Waive required review, rev ${rev}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
    >
      <div className="wc-menu-h">Waive required review · rev {rev}</div>
      <textarea ref={ref} className="wc-waive-text" placeholder="Reason (required)" aria-label="Reason for waiving" rows={3} value={val} onChange={(e) => setVal(e.target.value)} />
      <div className="wc-waive-fine">Waives this submission only. A resubmission restores the requirement. Nothing merges.</div>
      <div className="wc-waive-a">
        <button className="wc-act" onClick={onClose}>Cancel</button>
        <button className="wc-act pri" disabled={!val.trim()} onClick={() => onWaive(val.trim())}>Waive</button>
      </div>
    </div>
  );
}

/** Reads the request behind each decidable review item, once per item version and again whenever the snapshot sequence moves. */
function useReviewFacts(items: { taskId: string; item: Attention }[], sequence: number | null): Record<string, ReviewFacts | "gone"> {
  const [facts, setFacts] = useState<Record<string, ReviewFacts | "gone">>({});
  const asked = useRef(new Set<string>());
  const want = items.map(({ taskId, item }) => ({ taskId, item, key: `${item.id}:${item.sourceRevision}` }));
  const sig = `${sequence ?? ""}#${want.map((w) => w.key).join("|")}`;
  useEffect(() => {
    for (const { taskId, item, key } of want) {
      // A moved sequence may have dropped allowedActions, so the read is repeated per sequence.
      const askKey = `${key}@${sequence ?? ""}`;
      if (asked.current.has(askKey)) continue;
      asked.current.add(askKey);
      const rid = item.destination.reviewRequestId;
      if (!rid) continue;
      void fetch(`/api/tasks/${encodeURIComponent(taskId)}/reviews?request_id=${encodeURIComponent(rid)}&limit=1`, { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) { asked.current.delete(askKey); return; }
          const j = (await res.json()) as { requests?: ReviewView[] };
          const v = j.requests?.find((r) => r.id === rid);
          const f: ReviewFacts | "gone" = !v ? "gone" : {
            revision: v.currentSubmission.revision,
            required: v.required,
            canAccept: v.allowedActions.includes("accept"),
            canWaive: v.allowedActions.includes("waive"),
            // The exact artifact the item names: same submission, same version.
            matches: v.state === "pending" && v.currentSubmission.id === item.destination.submissionId && String(v.version) === item.sourceRevision,
          };
          setFacts((m) => ({ ...m, [key]: f }));
        })
        .catch(() => { asked.current.delete(askKey); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return facts;
}

// ---------- the surface ----------

export function WorkCenterSurface({ kind, data, projects, viewState, onOpen, onClose, onSnoozed }: {
  kind: "pop" | "phone";
  data: WorkCenterData;
  projects: ProjectRow[];
  viewState: RefObject<WcViewState>;
  onOpen: (target: WcOpen) => void;
  /** Esc or the close button. Absent on the phone tab. */
  onClose?: () => void;
  onSnoozed?: (until: number) => void;
}) {
  const phone = kind === "phone";
  const now = useNow();
  const snap = data.snap;
  const conn = { loading: data.loading, error: data.error, disconnected: data.disconnected };
  const stale = isStale(conn, snap);
  const h = headline(snap?.summary);

  const [outcomes, setOutcomes] = useState<Record<string, RowOutcome>>({});
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<{ taskId: string } | null>(null);
  const [waive, setWaive] = useState<{ taskId: string } | null>(null);
  const [sheet, setSheet] = useState<{ taskId: string; snooze: boolean } | null>(null);
  const [moreRecent, setMoreRecent] = useState(false);
  const { collapsed, toggle: toggleGroup } = useCollapsedGroups();
  const [selected, setSelected] = useState<string | null>(viewState.current.selected);
  const retryRef = useRef<Record<string, () => void>>({});
  const bodyRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const menuOpenerRef = useRef<HTMLElement | null>(null);
  const clearTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Items the server no longer lists are forgotten, so a later item with the same
  // id (it cannot happen, ids are opaque) or a stale hidden task cannot linger.
  useEffect(() => {
    if (!snap) return;
    const ids = new Set(snap.tasks.flatMap((t) => t.attention.map((a) => a.id)));
    const tasks = new Set(snap.tasks.map((t) => t.taskId));
    setCleared((c) => (c.size && [...c].some((x) => !ids.has(x)) ? new Set([...c].filter((x) => ids.has(x))) : c));
    setHidden((c) => (c.size && [...c].some((x) => !tasks.has(x)) ? new Set([...c].filter((x) => tasks.has(x))) : c));
  }, [snap]);
  useEffect(() => () => { for (const t of Object.values(clearTimers.current)) clearTimeout(t); }, []);

  // Tasks marked "resolved under you" by a destination that was gone.
  useEffect(() => {
    const res = viewState.current.resolved;
    if (!res.size) return;
    setOutcomes((o) => {
      const next = { ...o };
      for (const id of res) if (!next[id]) next[id] = { type: "gone", msg: "That request is no longer there. The list is refreshing." };
      return next;
    });
  }, [viewState, snap]);

  const groups = useMemo(() => (snap ? groupRows(snap.tasks, now, cleared, hidden) : null), [snap, now, cleared, hidden]);
  const recent = useMemo(() => (snap ? snap.recentlyFinished.rows.filter((r) => !hidden.has(r.taskId)) : []), [snap, hidden]);
  const partial = partialSources(snap);

  // Review items that lead their row: their request is read before Accept or Waive is offered.
  const leadReviews = useMemo(() => (groups?.need ?? []).flatMap((r) => {
    const first = liveItems(r, now, cleared)[0];
    return first && isDecidableReview(first) ? [{ taskId: r.taskId, item: first }] : [];
  }), [groups, now, cleared]);
  const facts = useReviewFacts(leadReviews, snap?.sequence ?? null);
  const factsFor = (item: Attention | undefined): ReviewFacts | null => {
    const f = item ? facts[`${item.id}:${item.sourceRevision}`] : undefined;
    return f && f !== "gone" ? f : null;
  };
  // A request that moved past what the item names (decided in another tab, resubmitted) refetches the list.
  const moved = Object.values(facts).some((f) => f === "gone" || !f.matches);
  useEffect(() => { if (moved) data.refresh(); }, [moved]); // eslint-disable-line react-hooks/exhaustive-deps
  const itemsAreKnown = h.need.kind === "unknown";

  // ----- focus on open: selected row, else first Needs-you row, else first row, else the heading -----
  const navEls = useCallback(
    () => [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-wc-nav]") ?? [])],
    []
  );
  const selectAndFocus = useCallback((el: HTMLElement | undefined) => {
    if (!el) return;
    setSelected(el.dataset.wcNav ?? null);
    viewState.current.selected = el.dataset.wcNav ?? null;
    el.focus();
  }, [viewState]);
  const focusedOnce = useRef(false);
  useLayoutEffect(() => {
    if (focusedOnce.current || !snap) return;
    focusedOnce.current = true;
    if (bodyRef.current && viewState.current.scrollTop) bodyRef.current.scrollTop = viewState.current.scrollTop;
    const els = navEls();
    const want = viewState.current.selected;
    const target =
      (want ? els.find((e) => e.dataset.wcNav === want) : undefined) ??
      els.find((e) => e.dataset.wcGroup === "need") ??
      els[0];
    if (phone) { if (target && want) { target.focus({ preventScroll: true }); } return; }
    if (target) { target.focus({ preventScroll: true }); setSelected(target.dataset.wcNav ?? null); }
    else headingRef.current?.focus();
  }, [snap, navEls, phone, viewState]);
  useEffect(() => {
    if (!snap && !phone) headingRef.current?.focus();
  }, [snap, phone]);

  // ----- actions -----
  const openTarget = useCallback((row: WorkRow, item: Attention | null) => {
    viewState.current.scrollTop = bodyRef.current?.scrollTop ?? 0;
    viewState.current.selected = row.taskId;
    onOpen({
      projectId: row.projectId,
      taskId: row.taskId,
      sessionId: item?.destination.sessionId ?? null,
      messageId: item?.destination.messageId ?? null,
      reviewRequestId: item?.destination.reviewRequestId ?? null,
      submissionId: item?.destination.submissionId ?? null,
      surface: item?.destination.surface ?? "transcript",
      rowId: row.taskId,
    });
  }, [onOpen, viewState]);

  const setOutcome = (taskId: string, o: RowOutcome | null) =>
    setOutcomes((prev) => {
      const next = { ...prev };
      if (o) next[taskId] = o; else delete next[taskId];
      return next;
    });

  const run = useCallback(async (row: WorkRow, item: Attention | null, key: ActionKey, send: () => Promise<Response>, after?: () => void) => {
    const taskId = row.taskId;
    const attempt = async () => {
      setOutcome(taskId, { type: "pending", msg: ACTION_PENDING[key], key });
      let res: Response;
      try {
        res = await send();
      } catch {
        // The request left and no answer came back: it may or may not have applied.
        setOutcome(taskId, { type: "ind", msg: ACTION_IND[key], key, ack: false });
        return;
      }
      let body: { resolved?: boolean; error?: { code?: string } } | null = null;
      try { body = await res.clone().json(); } catch { /* no body */ }
      if (res.ok && (!body || typeof body !== "object")) {
        // A 2xx with nothing to read cannot say whether the action applied.
        setOutcome(taskId, { type: "ind", msg: ACTION_IND[key], key, ack: false });
        data.refresh();
        return;
      }
      if (res.ok && body?.resolved !== false) {
        const [msg, sub] = ACTION_OK[key];
        if (item) setCleared((c) => new Set(c).add(item.id));
        after?.();
        setOutcome(taskId, { type: "ok", msg, sub, key });
        clearTimeout(clearTimers.current[taskId]);
        clearTimers.current[taskId] = setTimeout(() => setOutcome(taskId, null), 2500);
        data.refresh();
        return;
      }
      if (res.status === 409 || body?.resolved === false) {
        setOutcome(taskId, { type: "gone", msg: "That request was settled elsewhere or has expired. The list is refreshing.", key });
        data.refresh();
        return;
      }
      setOutcome(taskId, { type: "fail", msg: failText(key, res.status), key });
    };
    retryRef.current[taskId] = () => void attempt();
    await attempt();
  }, [data]);

  const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const decide = (row: WorkRow, item: Attention, decision: "allow_once" | "deny") => {
    const requestId = item.destination.requestId;
    if (!requestId) return;
    void run(row, item, decision === "allow_once" ? "allow" : "deny", () =>
      fetch(`/api/tasks/${row.taskId}/answer`, jsonInit("POST", {
        askId: requestId,
        answers: [[decision]],
        sessionId: item.destination.sessionId ?? undefined,
        messageId: item.destination.messageId ?? undefined,
        requestId,
      })));
  };
  const acknowledge = (row: WorkRow, item: Attention) =>
    void run(row, item, "ack", () => fetch(`/api/tasks/${row.taskId}/agent-edits`, jsonInit("POST", { action: "ack", edit_id: item.sourceRevision })));
  const snooze = (row: WorkRow, c: SnoozeChoice) => {
    setMenu(null);
    setSheet(null);
    void run(row, null, "snz", () => fetch(`/api/tasks/${row.taskId}`, jsonInit("PATCH", { snoozed_until: c.until })), () => {
      setHidden((s) => new Set(s).add(row.taskId));
      data.refetchAt(c.until);
      onSnoozed?.(c.until);
    });
  };

  // Review decisions: one idempotency key per click, reused by Retry, so a lost reply replays instead of repeating.
  const decideReview = (row: WorkRow, item: Attention, decision: "accept" | "waive", reason: string | null) => {
    const rid = item.destination.reviewRequestId;
    const sid = item.destination.submissionId;
    const version = Number(item.sourceRevision);
    if (!rid || !sid || !Number.isInteger(version)) return;
    setWaive(null);
    const intent: ReviewIntent = { decision, requestId: rid, submissionId: sid, expectedVersion: version, reason, idempotencyKey: newIdempotencyKey() };
    const taskId = row.taskId;
    const attempt = async () => {
      setOutcome(taskId, { type: "pending", msg: DECISION_PENDING[decision] });
      const res = await postReviewAction(taskId, intent);
      if (res.kind === "ok") {
        const [msg, sub] = DECISION_OK[decision];
        setCleared((c) => new Set(c).add(item.id));
        setOutcome(taskId, { type: "ok", msg, sub });
        clearTimeout(clearTimers.current[taskId]);
        clearTimers.current[taskId] = setTimeout(() => setOutcome(taskId, null), 2500);
        data.refresh();
      } else if (res.kind === "conflict") {
        const m = res.message;
        setOutcome(taskId, { type: "conflict", msg: `${m[0].toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? "" : "."}` });
      } else if (res.kind === "fail") {
        setOutcome(taskId, { type: "fail", msg: decisionFailText(decision, res.status, res.code), noRetry: !res.retryable });
      } else {
        setOutcome(taskId, { type: "ind", msg: DECISION_IND[decision], ack: false });
      }
    };
    retryRef.current[taskId] = () => void attempt();
    void attempt();
  };
  const closeWaive = () => {
    setWaive(null);
    const opener = menuOpenerRef.current;
    menuOpenerRef.current = null;
    requestAnimationFrame(() => opener?.focus());
  };

  const closeMenu = () => {
    setMenu(null);
    const opener = menuOpenerRef.current;
    menuOpenerRef.current = null;
    requestAnimationFrame(() => opener?.focus());
  };
  const openMenu = (taskId: string, opener: HTMLElement) => { menuOpenerRef.current = opener; setMenu({ taskId }); };

  const doInline = (row: WorkRow, item: Attention, a: InlineAction) => {
    if (a === "allow") decide(row, item, "allow_once");
    else if (a === "deny") decide(row, item, "deny");
    else if (a === "ack") acknowledge(row, item);
    else if (a === "accept") decideReview(row, item, "accept", null);
    else if (a !== "waive") openTarget(row, item);
  };

  // ----- keyboard -----
  const onKeyDown = (e: KeyboardEvent<Element>) => {
    if (e.key === "Escape") {
      if (sheet) { e.stopPropagation(); setSheet(null); return; }
      if (!phone) { e.preventDefault(); e.stopPropagation(); onClose?.(); }
      return;
    }
    if (menu || sheet || waive) return;
    const t = e.target as HTMLElement;
    const navEl = t.closest<HTMLElement>("[data-wc-nav]");
    if (!navEl) return;
    const onRow = t === navEl;
    const els = navEls();
    const i = els.indexOf(navEl);
    if (onRow) {
      if (e.key === "ArrowDown") { e.preventDefault(); selectAndFocus(els[Math.min(i + 1, els.length - 1)]); }
      else if (e.key === "ArrowUp") { e.preventDefault(); selectAndFocus(els[Math.max(i - 1, 0)]); }
      else if (e.key === "Home") { e.preventDefault(); selectAndFocus(els[0]); }
      else if (e.key === "End") { e.preventDefault(); selectAndFocus(els[els.length - 1]); }
      else if (e.key === "Enter") { e.preventDefault(); navEl.click(); }
      else if (e.key === "ArrowRight") {
        e.preventDefault();
        navEl.querySelector<HTMLElement>("button:not([disabled])")?.focus();
      } else if ((e.key === "s" || e.key === "S") && navEl.dataset.wcRow) {
        e.preventDefault();
        openMenu(navEl.dataset.wcRow, navEl);
      }
      return;
    }
    // Inside a row: ← and → walk chips, then actions, then Snooze.
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const inner = [...navEl.querySelectorAll<HTMLElement>("button:not([disabled])")];
      const j = inner.indexOf(t);
      e.preventDefault();
      if (e.key === "ArrowRight") inner[Math.min(j + 1, inner.length - 1)]?.focus();
      else if (j <= 0) navEl.focus(); else inner[j - 1]?.focus();
    }
  };

  // Keep Tab inside the popover (it sits over live columns).
  const onTrap = (e: KeyboardEvent<Element>) => {
    if (phone || e.key !== "Tab" || menu || sheet || waive) return;
    const focusable = [...((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='0'], input:not([disabled])"))];
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  // ----- render pieces -----
  const avatar = (row: WorkRow, small?: boolean) => {
    const p = projectOf(projects, row.projectId);
    return (
      <span className={`wc-av${small ? " sm" : ""}${phone ? " phone" : ""}`} style={{ background: p?.color }} aria-hidden>
        {(p?.icon || row.projectName[0] || "?").toUpperCase()}
        {!small && row.execution.isWorking && <span className="wc-av-run" title="Executing" />}
      </span>
    );
  };

  const renderRow = (row: WorkRow, grp: "need" | "work" | "wait") => {
    const items = liveItems(row, now, cleared);
    const first = items[0];
    const o = outcomes[row.taskId];
    const life = lifecycleLabel(row, items.length);
    const waits = waitingText(row);
    const bg = row.execution.background;
    const isSel = selected === row.taskId;
    const sub: React.ReactNode[] = [<span key="p">{row.projectName}</span>];
    for (const w of waits) sub.push(<span key={w.reason} className={`wc-why${w.reason === "detail_unavailable" ? " gap" : ""}`}>{w.text}</span>);
    if (bg.length) sub.push(<span key="bg" className="wc-bg"><i />{bg.length === 1 ? "1 background task" : `${bg.length} background tasks`}</span>);
    else if (row.execution.foreground === "executing" && !waits.length) sub.push(<span key="ex" className="wc-bg"><i />Turn executing</span>);
    sub.push(<span key="age" className="wc-age" title="Last activity">{row.execution.lastActivityAt ? `${ago(now, row.execution.lastActivityAt)} ago` : "no activity yet"}</span>);
    const joined = sub.flatMap((n, i) => (i ? [<span key={`s${i}`} className="wc-sep">·</span>, n] : [n]));
    const firstFacts = factsFor(first);
    const acts = phone || !first ? [] : inlineActionsFor(first, firstFacts);
    const aria = `${row.title}, ${row.projectName}${items.length ? `, ${items.length} item${items.length === 1 ? "" : "s"}` : ""}`;
    return (
      <div
        key={row.taskId}
        className={`wc-row ${phone ? "phone" : "pop"}${isSel ? " on" : ""}${o?.type === "pending" ? " busy" : ""}${o?.type === "gone" ? " ghost" : ""}`}
        role="option"
        aria-selected={isSel}
        aria-label={aria}
        tabIndex={isSel || (!selected && grp === "need" && row === (groups?.need[0] ?? null)) ? 0 : -1}
        data-wc-nav={row.taskId}
        data-wc-row={row.taskId}
        data-wc-group={grp}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, label, input, .wc-menu")) return;
          setSelected(row.taskId);
          openTarget(row, first ?? null);
        }}
        onFocus={(e) => { if (e.target === e.currentTarget) { setSelected(row.taskId); viewState.current.selected = row.taskId; } }}
      >
        {avatar(row)}
        <div className="wc-main">
          <div className="wc-t"><span title={row.title}>{row.title}</span>{life && <span className={`wc-life${life.odd ? " odd" : ""}`}>{life.text}</span>}</div>
          <div className="wc-sub">{joined}</div>
          {items.length > 0 && (
            <div className="wc-items">
              {items.map((a) => (
                <button
                  key={a.id}
                  className={`wc-chip ${KINDS[a.kind].role}${phone ? " phone" : ""}${isStaleItem(a) ? " stale" : ""}`}
                  title={isStaleItem(a) ? "Showing the last good result" : a.title}
                  aria-label={`${KINDS[a.kind].label}: ${a.title}. ${KINDS[a.kind].verb}.`}
                  onClick={(e) => { e.stopPropagation(); setSelected(row.taskId); openTarget(row, a); }}
                >
                  <i /><span className="wc-chip-k">{KINDS[a.kind].label}</span>
                  {chipMeta(a) && <span className="wc-chip-m">{chipMeta(a)}</span>}
                  {isStaleItem(a) && <span className="wc-chip-clock" aria-label="stale">{Icon.clock()}</span>}
                  <span className="wc-chip-arr">{Icon.chevRight()}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="wc-side">
          {phone ? (
            <button className="wc-kebab" aria-label={`Actions for ${row.title}`} onClick={(e) => { e.stopPropagation(); setSheet({ taskId: row.taskId, snooze: false }); }}>{Icon.dots()}</button>
          ) : (
            <div className="wc-acts">
              {first && acts.map((a) => (
                <button
                  key={a}
                  className={`wc-act${a === "allow" || a === "accept" ? " pri" : ""}`}
                  disabled={o?.type === "pending"}
                  aria-haspopup={a === "waive" ? "dialog" : undefined}
                  aria-expanded={a === "waive" ? waive?.taskId === row.taskId : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (a === "waive") { menuOpenerRef.current = e.currentTarget; setWaive({ taskId: row.taskId }); return; }
                    doInline(row, first, a);
                  }}
                >
                  {a === "allow" ? "Allow once" : a === "deny" ? "Deny" : a === "ack" ? "Acknowledge"
                    : a === "accept" ? `Accept rev ${firstFacts?.revision ?? ""}` : a === "waive" ? "Waive…"
                    : a === "open" && first.kind === "agent_edit" ? "Revert…" : KINDS[first.kind].verb}
                  {a === "open" && first.kind !== "agent_edit" && Icon.chevRight()}
                </button>
              ))}
              <button
                className="wc-act ghost"
                aria-haspopup="menu"
                aria-expanded={menu?.taskId === row.taskId}
                onClick={(e) => { e.stopPropagation(); openMenu(row.taskId, e.currentTarget); }}
              >Snooze</button>
            </div>
          )}
        </div>
        {o && (
          <OutcomeStrip
            o={o}
            onRetry={() => retryRef.current[row.taskId]?.()}
            onDismiss={() => { viewState.current.resolved.delete(row.taskId); setOutcome(row.taskId, null); if (o.type === "conflict" || o.type === "ind") data.refresh(); }}
            onAck={(v) => setOutcome(row.taskId, { ...o, ack: v })}
          />
        )}
        {menu?.taskId === row.taskId && !phone && <SnoozeMenu onPick={(c) => snooze(row, c)} onClose={closeMenu} />}
        {waive?.taskId === row.taskId && !phone && first && firstFacts && (
          <WaiveMenu rev={firstFacts.revision} onWaive={(reason) => decideReview(row, first, "waive", reason)} onClose={closeWaive} />
        )}
      </div>
    );
  };

  // A loaded section's header is a button that collapses its rows; the loading skeleton's headers are static.
  const groupHead = (cls: GroupKey, label: string, n: CountView | null, hint?: string, nCount?: number, collapsible = false) => {
    const shut = collapsible && !!collapsed[cls];
    const inner = (
      <>
        {collapsible && Icon.chevDown({ className: "wc-grp-chev" })}
        {cls === "need" && <span className="wc-ico wc-ico-11 need">{Icon.needsYou()}</span>}
        {cls === "work" && <span className="wc-ico wc-ico-11 run still">{Icon.working()}</span>}
        {(cls === "wait" || cls === "rec") && <i />}
        {label}
        {n ? <span className={`wc-grp-n${n.kind === "unknown" || n.kind === "loading" ? " unk" : ""}`} title={n.title || undefined}>{n.txt}</span>
          : nCount !== undefined ? <span className="wc-grp-n">{nCount}</span> : null}
        {hint && <span className="wc-grp-hint">{hint}</span>}
      </>
    );
    if (!collapsible) return <div className={`wc-grp ${cls}`} role="presentation">{inner}</div>;
    return (
      <button
        type="button"
        className={`wc-grp wc-grp-btn ${cls}${shut ? " is-collapsed" : ""}`}
        aria-expanded={!shut}
        data-wc-group-head={cls}
        title={`${shut ? "Show" : "Hide"} ${label.toLowerCase()}`}
        onClick={() => toggleGroup(cls)}
      >
        {inner}
      </button>
    );
  };

  const skeleton = (n: number) => Array.from({ length: n }, (_, i) => (
    <div className="wc-sk" key={i} aria-hidden><i className="wc-sk-av" /><div className="wc-sk-l"><i /><i /></div><i /></div>
  ));

  // The Needs-you header number is the headline's task count; with partial coverage it reads known+.
  const needHeadN: CountView = h.need;
  const empty = !!groups && !groups.need.length && !groups.work.length && !groups.wait.length && h.need.kind !== "unknown";
  const showRecent = moreRecent ? recent : recent.slice(0, 4);
  const sheetRow = sheet && snap ? snap.tasks.find((t) => t.taskId === sheet.taskId) : undefined;

  return (
    <section
      className={`wc-surface ${phone ? "wc-phone" : "wc-pop"}`}
      role={phone ? "region" : "dialog"}
      aria-label="Work Center"
      onKeyDown={(e) => { onKeyDown(e); onTrap(e); }}
    >
      <div className="wc-head">
        <div className="wc-top">
          <h2 ref={headingRef} tabIndex={-1}>Work Center</h2>
          {!phone && <div className="wc-x"><button className="wc-btn" aria-label="Close" onClick={onClose}>{Icon.x()}</button></div>}
        </div>
        <div className="wc-counts">
          <div className={`wc-k run${phone ? "" : " inline"}`}>
            <b className={h.working.kind === "unknown" || h.working.kind === "loading" ? "unk" : ""} title={h.working.title || undefined}>
              <span className={`wc-ico wc-ico-14 run mid${h.working.kind === "value" ? "" : " still"}${h.working.kind === "unknown" || h.working.kind === "loading" ? " faded" : ""}`}>{Icon.working()}</span>{h.working.txt}
            </b>
            <span>working</span>
          </div>
          <div className={`wc-k need${phone ? "" : " inline"}`}>
            <b className={h.need.kind === "unknown" || h.need.kind === "loading" ? "unk" : ""} title={h.need.title || undefined}>
              <span className={`wc-ico wc-ico-14 need mid${h.need.kind === "unknown" || h.need.kind === "loading" ? " faded" : ""}`}>{Icon.needsYou()}</span>{h.need.txt}
              {h.items && <span className="wc-plus" title={`${h.items} decisions across ${h.need.txt} tasks`}>/ {h.items}</span>}
            </b>
            <span>need you{h.need.kind === "unknown" && <> · <em>total unknown</em></>}</span>
          </div>
        </div>
        <div className="wc-scope" role="status">
          <span className={`wc-dot${data.disconnected ? " down" : ""}`} />
          {!snap ? (data.error ? "Not loaded" : "Loading…")
            : data.disconnected ? "Reconnecting…"
            : `Live · ${data.lastOkAt && now - data.lastOkAt > 60_000 ? `${ago(now, data.lastOkAt)} ago` : "now"}`}
        </div>
      </div>

      {data.error && (
        <div className="wc-note err" role="alert">
          <Warn />
          <span><b>Couldn&apos;t refresh</b> · {data.error}.{snap && data.lastOkAt ? ` Showing data from ${ago(now, data.lastOkAt)} ago.` : " Nothing has loaded yet."}</span>
          <button className="wc-note-a" onClick={() => data.refresh()}>Retry now</button>
        </div>
      )}
      {partial.length > 0 && (
        <div className="wc-note warn">
          <Warn />
          <span><b>Partial</b> · {partial.join(", ").replace(/_/g, " ")} could not be read. Totals for needs-you are unknown; known items are listed.</span>
        </div>
      )}

      <div
        className={`wc-body ${phone ? "phone" : "pop"}`}
        role="listbox"
        aria-label="Operational list"
        aria-busy={!snap && !data.error}
        ref={bodyRef}
        onScroll={() => { viewState.current.scrollTop = bodyRef.current?.scrollTop ?? 0; }}
      >
        {!snap && !data.error && (
          <>
            {groupHead("work", "Working", h.working)}{skeleton(2)}
            {groupHead("need", "Needs you", h.need)}{skeleton(2)}
          </>
        )}
        {!snap && data.error && (
          <div className="wc-empty"><b>Work Center isn&apos;t loaded</b>Nothing here is a real zero until it loads.<small>Retrying automatically.</small></div>
        )}
        {snap && groups && (
          <>
            {GROUP_ORDER.map((g) => {
              if (g === "work" && groups.work.length > 0) {
                return <Fragment key={g}>{groupHead("work", "Working", null, "no decision pending", groups.work.length, true)}{!collapsed.work && groups.work.map((r) => renderRow(r, "work"))}</Fragment>;
              }
              if (g === "need" && (groups.need.length > 0 || h.need.kind === "unknown")) {
                return (
                  <Fragment key={g}>
                    {groupHead("need", "Needs you", needHeadN, itemsAreKnown ? "total unknown" : undefined, undefined, true)}
                    {!collapsed.need && groups.need.map((r) => renderRow(r, "need"))}
                  </Fragment>
                );
              }
              if (g === "wait" && groups.wait.length > 0) {
                return <Fragment key={g}>{groupHead("wait", "Waiting", null, undefined, groups.wait.length, true)}{!collapsed.wait && groups.wait.map((r) => renderRow(r, "wait"))}</Fragment>;
              }
              return null;
            })}
            {empty && recent.length === 0 && <div className="wc-empty"><b>Nothing is waiting on you</b>Nothing is working or waiting either.</div>}
            {empty && recent.length > 0 && <div className="wc-empty"><b>Nothing is waiting on you</b></div>}
            {recent.length > 0 && (
              <>
                {groupHead("rec", "Recently finished", null, "last 7 days", recent.length, true)}
                {!collapsed.rec && showRecent.map((r) => (
                  <button
                    key={r.taskId}
                    className={`wc-rec${phone ? " phone" : ""}${selected === `rec:${r.taskId}` ? " on" : ""}`}
                    data-wc-nav={`rec:${r.taskId}`}
                    tabIndex={selected === `rec:${r.taskId}` ? 0 : -1}
                    onFocus={() => { setSelected(`rec:${r.taskId}`); viewState.current.selected = `rec:${r.taskId}`; }}
                    onClick={() => { viewState.current.selected = `rec:${r.taskId}`; openTarget(r, null); }}
                  >
                    {avatar(r, true)}
                    <span className="wc-rec-t">{r.title}<small>{r.projectName}</small></span>
                    <span>
                      <span className={`wc-rec-o ${r.latestResult?.outcome ?? "unknown"}`} title={r.latestResult ? undefined : "Outcome unknown"}><i />{OUTCOME_LABEL[r.latestResult?.outcome ?? "unknown"]}</span>
                      <span className="wc-rec-age">{r.latestResult ? ago(now, r.latestResult.endedAt) : ""}</span>
                    </span>
                  </button>
                ))}
                {!collapsed.rec && recent.length > 4 && !moreRecent && <button className="wc-more" onClick={() => setMoreRecent(true)}>Show {recent.length - 4} more</button>}
              </>
            )}
          </>
        )}
      </div>

      {!phone && (
        <div className="wc-foot"><kbd>↑↓</kbd> move <kbd>↵</kbd> open <kbd>→</kbd> actions <kbd>S</kbd> snooze <kbd>Esc</kbd> close</div>
      )}
      {stale && snap && <span className="wc-sr" role="status">Work Center data may be stale</span>}

      {phone && sheet && sheetRow && (
        <ActionSheet
          row={sheetRow}
          item={liveItems(sheetRow, now, cleared)[0]}
          facts={factsFor(liveItems(sheetRow, now, cleared)[0])}
          snoozeStep={sheet.snooze}
          onClose={() => setSheet(null)}
          onOpenSnooze={() => setSheet({ taskId: sheet.taskId, snooze: true })}
          onOpen={(item) => { setSheet(null); openTarget(sheetRow, item ?? null); }}
          onAck={(item) => { setSheet(null); acknowledge(sheetRow, item); }}
          onAccept={(item) => { setSheet(null); decideReview(sheetRow, item, "accept", null); }}
          onSnooze={(c) => snooze(sheetRow, c)}
        />
      )}
    </section>
  );
}

// ---------- phone action sheet ----------

function ActionSheet({ row, item, facts, snoozeStep, onClose, onOpenSnooze, onOpen, onAck, onAccept, onSnooze }: {
  row: WorkRow; item: Attention | undefined; facts: ReviewFacts | null; snoozeStep: boolean;
  onClose: () => void; onOpenSnooze: () => void; onOpen: (item: Attention | undefined) => void; onAck: (item: Attention) => void;
  onAccept: (item: Attention) => void; onSnooze: (c: SnoozeChoice) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const choices = useMemo(() => snoozeChoices(Date.now()), []);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("button.wc-opt")?.focus(); }, [snoozeStep]);
  const acts = sheetActionsFor(item, facts);
  return (
    <>
      <div className="wc-scrim" onClick={onClose} />
      <div
        ref={ref}
        className="wc-sheet"
        role="dialog"
        aria-label="Actions"
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      >
        <div className="wc-grab" />
        <div className="wc-st">{row.title}<small>{item ? item.title : row.projectName}</small></div>
        {!snoozeStep ? (
          <>
            {acts.includes("open") && <button className="wc-opt" onClick={() => onOpen(item)}>{item ? `${KINDS[item.kind].verb} in session` : "Open in session"}<small>{item ? KINDS[item.kind].label : ""}</small></button>}
            {item && acts.includes("ack") && <button className="wc-opt" onClick={() => onAck(item)}>Acknowledge<small>no options</small></button>}
            {item && facts && acts.includes("accept") && <button className="wc-opt" onClick={() => onAccept(item)}>Accept rev {facts.revision}<small>does not merge</small></button>}
            <button className="wc-opt" onClick={onOpenSnooze}>Snooze<small>hide until later</small></button>
          </>
        ) : (
          <>
            {choices.map((c) => <button key={c.key} className="wc-opt" onClick={() => onSnooze(c)}>{c.label}<small>{c.hint}</small></button>)}
            <div className="wc-sheet-note">Hidden from Work Center until then.</div>
          </>
        )}
      </div>
    </>
  );
}
