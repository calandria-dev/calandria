"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Popover } from "./shared";
import { jget } from "./api";
import { AgentMark, Icon } from "../icons";
import { agentLabel } from "./agents";
import type { AgentsBundle } from "./types";
import { GATEWAY_PLAN_ID, type PlanUsageSnapshot, type PlanUsageWindow } from "@/lib/types";
import { deferredStartFor } from "@/lib/usageReset";
import {
  agentSignals,
  compareSignals,
  fmtWhen,
  headlineWindows,
  isPrimary,
  NEAR_PCT,
  paceOf,
  summarizeUsage,
  toneFor,
  type Tone,
  type UsageAgent,
  type UsageSignal,
} from "./usageSignals";

export { headlineWindows } from "./usageSignals";

// The Usage Center: one titlebar chip for every metered agent, with the
// per-agent breakdown in a popover (desktop) or a bottom sheet (phone). The
// rules that decide what the chip says live in ./usageSignals.ts; this file
// only renders them.
//
// Polls GET /api/plan-usage once a minute while the tab is visible. The server
// answers from an instance-wide cache and reads a provider only when its own
// fetch floor allows (lib/agents/*/planUsage.ts). No chip renders when no
// shown agent reports plan usage.

const POLL_MS = 60_000;

// One poll per tab, shared by the chip, the queued-start button and the
// usage-limit notice: a module-level store with ref-counted polling. The
// interval runs while any subscriber is mounted.
type PlanUsageMap = Record<string, PlanUsageSnapshot>;
interface StoreState { map: PlanUsageMap; loaded: boolean }
const INITIAL: StoreState = { map: {}, loaded: false };
let current: StoreState = INITIAL;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function load() {
  if (document.hidden) return; // a hidden tab must not keep the server polling the provider
  jget<{ agents: PlanUsageMap }>("/api/plan-usage")
    .then((d) => { current = { map: d.agents, loaded: true }; listeners.forEach((l) => l()); })
    .catch(() => { /* transient: keep showing the last snapshot */ });
}
const onVis = () => { if (!document.hidden) load(); };
function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (listeners.size === 1) {
    load();
    timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", onVis);
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVis);
    }
  };
}

/** Re-read now, after a write that changes what the endpoint returns (a role pin). */
export function refreshPlanUsage() {
  load();
}

function usePlanUsageState(): StoreState {
  return useSyncExternalStore(subscribe, () => current, () => INITIAL);
}

/** Every agent's plan-usage snapshot, keyed by agent id; `{}` until the first poll answers. */
export function usePlanUsage(): PlanUsageMap {
  return usePlanUsageState().map;
}

/**
 * Whether an agent's usage is shown in the titlebar chip. Settings → Models
 * writes `plan_usage:<agent>` = "off" to hide one; unset means shown.
 */
export function planUsageShown(appDefaults: Record<string, string>, agentId: string): boolean {
  return appDefaults[`plan_usage:${agentId}`] !== "off";
}

// The open task's "resume when the limit resets" offer, published by
// SessionView while its newest message is the usage-limit notice, so the
// popover's at-limit note can carry the same action for the same agent.
export interface OpenTaskLimit {
  /** The plan-usage key the task draws on (an agent id or GATEWAY_PLAN_ID). */
  usageKey: string;
  queuedAt: number;
  resetAt: number | null;
  onQueue: (at: number) => void;
  onCancel: () => void;
}
let openTaskLimit: OpenTaskLimit | null = null;
const limitListeners = new Set<() => void>();
export function publishOpenTaskLimit(next: OpenTaskLimit | null) {
  openTaskLimit = next;
  limitListeners.forEach((l) => l());
}
function useOpenTaskLimit(): OpenTaskLimit | null {
  return useSyncExternalStore(
    (l) => { limitListeners.add(l); return () => { limitListeners.delete(l); }; },
    () => openTaskLimit,
    () => null,
  );
}

/**
 * The window that binds when a limit is reached: the rejected window, else
 * the first spent one. Null while nothing is at its limit. Mirrors the
 * ordering of usageResetAt() in lib/usageReset.ts.
 */
export function bindingWindow(snap: PlanUsageSnapshot | null | undefined, now: number = Date.now()): PlanUsageWindow | null {
  if (!snap) return null;
  const rejected = snap.status === "rejected" && !(snap.statusResetsAt != null && snap.statusResetsAt <= now);
  const spent = snap.windows.find((w) => w.utilization >= 100) ?? null;
  return rejected ? (snap.windows.find((w) => w.id === snap.statusWindow) ?? spent) : spent;
}

function agoText(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

const toneClass = (t: Tone) => (t ? ` ${t}` : "");

// ---------------------------------------------------------------- ring

const RING_R = 5.25;
const RING_C = 2 * Math.PI * RING_R;

/** The chip's ring: a 14px gauge filled to `pct`. Empty and dashed while loading. */
export function UsageRing({ pct, tone, loading }: { pct: number; tone: Tone; loading?: boolean }) {
  const fill = loading ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <svg className={`uc-ring${toneClass(tone)}${loading ? " loading" : ""}`} viewBox="0 0 14 14" width="14" height="14" aria-hidden>
      <circle className="uc-ring-track" cx="7" cy="7" r={RING_R} />
      {fill > 0 && (
        <circle
          className="uc-ring-fill" cx="7" cy="7" r={RING_R}
          strokeDasharray={`${(RING_C * fill) / 100} ${RING_C}`}
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  );
}

// ---------------------------------------------------------------- meter

/**
 * One window: label, percent used, bar, reset. A window with a known length
 * and reset also carries a pace tick (an even spread now) and, once enough of
 * the window has passed to project, a caret at the projected end point. A
 * projection past 100% pins the caret to the bar's end and says the number.
 */
export function UsageMeter({ w, tone, now = Date.now(), compact }: { w: PlanUsageWindow; tone?: Tone; now?: number; compact?: boolean }) {
  const t = tone ?? toneFor(w.utilization);
  const p = paceOf(w, now);
  const projected = p?.projected ?? null;
  const over = projected != null && projected > 100;
  return (
    <div className={`uc-meter${toneClass(t)}${compact ? " compact" : ""}`}>
      <div className="uc-meter-head">
        <span className="uc-meter-label">{w.label}</span>
        <span className="uc-meter-pct">{Math.floor(w.utilization)}% used</span>
      </div>
      <div className="uc-track">
        <div className="uc-bar"><div className="uc-fill" style={{ width: `${Math.min(100, w.utilization)}%` }} /></div>
        {p && <span className="uc-pace" style={{ left: `${p.pace}%` }} title={`Even pace: ${Math.round(p.pace)}%`} />}
        {projected != null && (
          <span className={`uc-proj${over ? " over" : ""}`} style={{ left: `${Math.min(100, projected)}%` }} title={`Projected at reset: ${Math.round(projected)}%`} />
        )}
      </div>
      <div className="uc-meter-foot">
        {w.resetsAt != null ? <span>Resets {fmtWhen(w.resetsAt, now)}</span> : <span>Reset time unknown</span>}
        {projected != null && <span className={over ? "uc-over" : undefined}>{over ? `on pace for ${Math.round(projected)}%` : `→ ${Math.round(projected)}% by reset`}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the chip

/**
 * The titlebar chip. Calm: a quiet ring on the primary agent's session window
 * and no text. Signal: the ring tracks the window the winning signal is about,
 * plus one line of text and a "+N" count when more notices wait in the
 * popover. Stale or unreadable data always carries a word, so it never reads
 * as calm.
 */
export function UsageChip({ agents, appDefaults, isMobile, onOpenSettings }: {
  agents: AgentsBundle;
  appDefaults: Record<string, string>;
  isMobile: boolean;
  onOpenSettings: () => void;
}) {
  const { map, loaded } = usePlanUsageState();
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);

  const list = useMemo<UsageAgent[]>(
    () => Object.entries(map)
      .filter(([id, s]) => planUsageShown(appDefaults, id) && (!s.available ? !!s.reason : s.windows.length > 0))
      .map(([id, snap]) => ({ id, name: id === GATEWAY_PLAN_ID ? "Gateway" : agentLabel(agents, id), snap })),
    [map, appDefaults, agents],
  );
  // An unreadable agent alone is no reason for a chip: the chip appears once
  // at least one shown agent reports a window, and unreadable ones then list
  // in the breakdown with their reason.
  const anyLive = list.some((a) => a.snap.available);

  // Remember that this instance has a chip, so the next page load can hold its
  // place with a loading ring. An instance with none never flashes one.
  useEffect(() => {
    if (!loaded) return;
    try { if (anyLive) localStorage.setItem("calandria.usageChip", "1"); else localStorage.removeItem("calandria.usageChip"); } catch { /* storage off */ }
  }, [loaded, anyLive]);
  // Read after mount: the server render has no storage, and the first client
  // render must match it.
  const [expectChip, setExpectChip] = useState(false);
  useEffect(() => {
    try { setExpectChip(localStorage.getItem("calandria.usageChip") === "1"); } catch { /* storage off */ }
  }, []);

  // Refresh "now" with each poll, so the countdowns move with the data.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [map]);
  const summary = useMemo(() => summarizeUsage(list, now), [list, now]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) chipRef.current?.focus();
  };

  if (!loaded) {
    if (!expectChip) return null;
    return (
      <div className="uc-anchor">
        <button className={`uc-chip loading${isMobile ? " tall" : ""}`} aria-label="Usage: loading" disabled>
          <UsageRing pct={0} tone="" loading />
        </button>
      </div>
    );
  }
  if (!anyLive) return null;

  const top = summary.signals[0];
  const more = summary.signals.length - 1;
  // The phone chip has room for the message only: the sheet names the agent
  // and lists the other notices, and the accessible name counts them.
  const who = isMobile ? "" : (top?.who ?? "");
  const full = top?.what ?? (summary.unavailable ? "unavailable" : summary.stale ? "stale" : "");
  // At 360px the separator is the width that costs the reset time.
  const what = isMobile ? full.replace(" · ", " ") : full;
  const tone: Tone = top?.tone ?? "";

  return (
    <div className="uc-anchor">
      <button
        ref={chipRef}
        className={`uc-chip${toneClass(tone)}${isMobile ? " tall" : ""}${summary.stale ? " stale" : ""}${open ? " open" : ""}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={summary.spoken}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={summary.spoken}
      >
        <UsageRing pct={summary.ring?.window.utilization ?? 0} tone={summary.ring?.tone ?? ""} />
        {what && (
          <span className="uc-text" aria-hidden>
            {who && <span className="uc-who">{who}</span>}
            <span className="uc-what">{what}</span>
          </span>
        )}
        {more > 0 && !isMobile && <span className="uc-more" aria-hidden>+{more}</span>}
      </button>
      {open && !isMobile && (
        <Popover onClose={() => close(false)}>
          <UsageDialog onEscape={() => close(true)}>
            <UsageCenterBody list={summary.order} now={now} named={list.length > 1} onOpenSettings={() => { close(false); onOpenSettings(); }} />
          </UsageDialog>
        </Popover>
      )}
      {open && isMobile && (
        <UsageSheet onClose={(refocus) => close(refocus)}>
          <UsageCenterBody list={summary.order} now={now} named={list.length > 1} onOpenSettings={() => { close(false); onOpenSettings(); }} />
        </UsageSheet>
      )}
    </div>
  );
}

/** Popover content wrapper: takes focus on open and closes on Escape. */
function UsageDialog({ children, onEscape }: { children: React.ReactNode; onEscape: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onEscape(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onEscape]);
  return <div ref={ref} className="uc-menu" role="dialog" aria-label="Usage" tabIndex={-1}>{children}</div>;
}

/** The phone presentation: a bottom sheet with a scrim, in Work Center's sheet language. */
function UsageSheet({ children, onClose }: { children: React.ReactNode; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(true); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <>
      <div className="uc-scrim" onClick={() => onClose(true)} />
      <div ref={ref} className="uc-sheet" role="dialog" aria-modal="true" aria-label="Usage" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="uc-grab" aria-hidden />
        {children}
      </div>
    </>,
    document.body,
  );
}

// ---------------------------------------------------------------- breakdown

function UsageCenterBody({ list, now, named, onOpenSettings }: { list: UsageAgent[]; now: number; named: boolean; onOpenSettings: () => void }) {
  return (
    <div className="uc-body">
      <div className="pop-sec">Plan usage</div>
      {list.map((a) => <AgentSection key={a.id} a={a} now={now} named={named} />)}
      <div className="uc-foot">
        <button className="uc-link" onClick={onOpenSettings}>{Icon.gear()} Usage settings</button>
      </div>
    </div>
  );
}

function AgentSection({ a, now, named }: { a: UsageAgent; now: number; named: boolean }) {
  const { snap } = a;
  const [showAll, setShowAll] = useState(false);
  const limit = useOpenTaskLimit();
  const signals = useMemo(() => agentSignals(a, now, named).sort(compareSignals), [a, now, named]);
  const top = signals[0] as UsageSignal | undefined;
  const mark = AgentMark[a.id];
  const planName = snap.plan ? snap.plan[0].toUpperCase() + snap.plan.slice(1) : null;
  const role = a.id === GATEWAY_PLAN_ID ? null : snap.role;

  // Headline windows and any window worth a glance stay visible; the rest
  // (per-model weeks, extra model groups) fold behind one toggle.
  const { session, week } = headlineWindows(snap.windows);
  const signalled = new Set(signals.map((s) => s.window).filter(Boolean));
  const primaryRows = snap.windows.filter((w) => w === session || w === week || signalled.has(w) || w.utilization >= NEAR_PCT || snap.windows.length <= 2);
  const shownRows = primaryRows.length ? primaryRows : snap.windows.slice(0, 2);
  const folded = snap.windows.filter((w) => !shownRows.includes(w));
  const rows = showAll ? snap.windows : shownRows;
  const rejectedId = snap.status === "rejected" ? snap.statusWindow : null;
  const offer = top?.kind === "limit" && limit && limit.usageKey === a.id ? limit : null;

  return (
    <section className="uc-agent" aria-label={`${a.name} usage`}>
      <div className="uc-agent-head">
        {mark && <span className="uc-mark" aria-hidden>{mark()}</span>}
        <span className="uc-agent-name">{a.name}{planName ? ` ${planName}` : ""}</span>
        {role && (
          <span className={`uc-role${isPrimary(a) ? " primary" : ""}`} title={role.source === "pinned" ? "Pinned in settings" : "Set automatically from last week's usage"}>
            {role.value === "primary" ? "Primary" : "Occasional"}{role.source === "pinned" ? " · pinned" : ""}
          </span>
        )}
      </div>
      {!snap.available && <div className="uc-note muted">Usage unavailable{snap.reason ? `: ${snap.reason}` : "."}</div>}
      {signals.map((s) => (
        <div key={s.kind} className={`uc-note ${s.tone}`}>
          {s.note}
          {s === top && offer && offer.queuedAt > 0 && (
            <div className="uc-note-act"><span>Queued: resumes {fmtWhen(offer.queuedAt, now)}.</span><button className="btn btn-sm" onClick={offer.onCancel}>Cancel</button></div>
          )}
          {s === top && offer && offer.queuedAt === 0 && offer.resetAt != null && (
            <div className="uc-note-act">
              <button className="btn btn-sm" onClick={() => offer.onQueue(deferredStartFor(offer.resetAt!))}>{Icon.clock()} Resume when the limit resets ({fmtWhen(offer.resetAt, now)})</button>
            </div>
          )}
        </div>
      ))}
      {snap.scope?.kind === "some" && (
        <div className="uc-note scoped">
          {snap.scope.redirected} of {snap.scope.redirected + snap.scope.onPlan} projects point{snap.scope.redirected === 1 ? "s" : ""} {a.name} at
          another endpoint. Those turns do not draw on this plan.
        </div>
      )}
      {snap.available && snap.windows.length === 0 && <div className="uc-note muted">No usage windows reported.</div>}
      {rows.map((w) => (
        <UsageMeter key={w.id} w={w} now={now} tone={toneFor(w.utilization, rejectedId === w.id)} />
      ))}
      {folded.length > 0 && (
        <button className="uc-more-rows" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
          {showAll ? "Fewer windows" : `${folded.length} more window${folded.length === 1 ? "" : "s"}`}
        </button>
      )}
      {snap.available && (
        <div className="uc-agent-foot">
          {snap.fetchedAt != null ? `Updated ${agoText(snap.fetchedAt)}` : "From live session telemetry"}
          {snap.stale && <span className="uc-stale">{` · stale${snap.reason ? `: ${snap.reason}` : ""}`}</span>}
        </div>
      )}
    </section>
  );
}
