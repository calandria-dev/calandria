"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  chipLadder,
  compareSignals,
  fmtWhen,
  headlineWindows,
  isPrimary,
  paceOf,
  staleLadder,
  summarizeUsage,
  toneFor,
  type ChipStep,
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
// shown agent reports anything; an agent that reports only why it can't be
// read still counts.

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
const DASH = 1.6;

/**
 * The chip's ring: a 14px gauge filled to `pct`. Loading and stale dash it;
 * hollow draws the track alone (every agent unavailable).
 */
export function UsageRing({ pct, tone, loading, dashed, hollow, size = 14 }: { pct: number; tone: Tone; loading?: boolean; dashed?: boolean; hollow?: boolean; size?: number }) {
  const fill = loading || hollow ? 0 : Math.max(0, Math.min(100, pct));
  const len = (RING_C * fill) / 100;
  // A dashed fill repeats dash/gap pairs up to the filled length, then one gap for the rest.
  const dashes = dashed ? [...Array(Math.floor(len / (2 * DASH))).fill(`${DASH} ${DASH}`), `0 ${RING_C}`].join(" ") : `${len} ${RING_C}`;
  return (
    <svg className={`uc-ring${toneClass(tone)}${loading || dashed ? " dashed" : ""}${loading ? " loading" : ""}${hollow ? " hollow" : ""}`} viewBox="0 0 14 14" width={size} height={size} aria-hidden>
      <circle className="uc-ring-track" cx="7" cy="7" r={RING_R} />
      {fill > 0 && (
        <circle className="uc-ring-fill" cx="7" cy="7" r={RING_R} strokeDasharray={dashes} transform="rotate(-90 7 7)" />
      )}
    </svg>
  );
}

// ---------------------------------------------------------------- meter

/** A projection past 100% shrinks the track to 100/projection of the width, up to this projection. */
const PROJECTION_CLAMP = 160;

/**
 * One window: label, percent used, bar, reset. A window with a known length
 * and reset also carries a pace tick (an even spread now) and, once enough of
 * the window has passed to project, a hollow circle at the projected end
 * point. A projection past 100% shrinks the track and draws a dashed tail from
 * its end to the circle, so the overshoot reads at the same height. A stale
 * agent's fill is hatched.
 */
export function UsageMeter({ w, tone, now = Date.now(), compact, stale, sep }: { w: PlanUsageWindow; tone?: Tone; now?: number; compact?: boolean; stale?: boolean; sep?: boolean }) {
  const t = tone ?? toneFor(w.utilization);
  const p = paceOf(w, now);
  const projected = p?.projected ?? null;
  const over = projected != null && projected > 100;
  const scale = over ? 100 / Math.min(projected, PROJECTION_CLAMP) : 1;
  const at = (v: number) => `${(Math.min(v, PROJECTION_CLAMP) * scale).toFixed(2)}%`;
  return (
    <div className={`uc-meter${toneClass(t)}${compact ? " compact" : ""}${stale ? " stale" : ""}${sep ? " sep" : ""}`}>
      <div className="uc-meter-head">
        <span className="uc-meter-label">{w.label}</span>
        <span className="uc-meter-pct">{Math.floor(w.utilization)}% used</span>
      </div>
      <div className="uc-track">
        <div className="uc-bar" style={over ? { width: `${(scale * 100).toFixed(2)}%` } : undefined}>
          <div className="uc-fill" style={{ width: `${Math.min(100, w.utilization)}%` }} />
        </div>
        {over && <span className={`uc-tail${t === "limit" ? " limit" : ""}`} style={{ left: `${(scale * 100).toFixed(2)}%` }} aria-hidden />}
        {p && <span className="uc-pace" style={{ left: at(p.pace) }} title={`Even pace: ${Math.round(p.pace)}%`} />}
        {projected != null && (
          <span className={`uc-proj${over ? " over" : ""}${t === "warn" || t === "limit" ? ` ${t}` : ""}`} style={{ left: at(projected) }} title={`Projected at reset: ${Math.round(projected)}%`} />
        )}
      </div>
      <div className="uc-meter-foot">
        {w.resetsAt != null ? <span>Resets {fmtWhen(w.resetsAt, now)}</span> : <span>Reset time unknown</span>}
        {projected != null && <span className={over ? "uc-over" : undefined}>{over ? `on pace for ${Math.round(projected)}%` : `→ ${Math.round(projected)}% by reset`}</span>}
      </div>
    </div>
  );
}

/**
 * The block under a usage-limit notice and on an unstarted task: the ring at
 * 100%, the window and its reset in the popover's wording, then the meter.
 */
export function UsageLimitBlock({ w, now = Date.now() }: { w: PlanUsageWindow; now?: number }) {
  return (
    <div className="uc-limit-block">
      <div className="uc-limit-head">
        <UsageRing pct={100} tone="limit" />
        <span>{w.label} limit is reached</span>
        <span className="uc-limit-rs">{w.resetsAt != null ? `resets ${fmtWhen(w.resetsAt, now)}` : "reset time unknown"}</span>
      </div>
      <UsageMeter w={w} tone="limit" compact />
    </div>
  );
}

// ---------------------------------------------------------------- the chip

const px = (v: string) => parseFloat(v) || 0;

/**
 * The truncation ladder, measured. The probe holds every candidate in the
 * chip's own styles (so a user-selected mono face measures true); each is
 * checked against the chip's max width less its border, padding, ring, gaps
 * and the `+N` count. Returns the first step that fits, or -1 for the ring
 * alone. Re-measures on resize, on a font load, and on an appearance change
 * (the mono face is a custom property on the root element).
 */
function useLadderFit(chipRef: React.RefObject<HTMLButtonElement | null>, probeRef: React.RefObject<HTMLSpanElement | null>, steps: ChipStep[], more: number): number {
  const [fit, setFit] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener("resize", bump);
    document.fonts?.addEventListener?.("loadingdone", bump);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    return () => {
      window.removeEventListener("resize", bump);
      document.fonts?.removeEventListener?.("loadingdone", bump);
      mo.disconnect();
    };
  }, []);
  const key = steps.map((x) => `${x.who}|${x.what}`).join("\n");
  useLayoutEffect(() => {
    const chip = chipRef.current;
    const probe = probeRef.current;
    if (!chip || !probe || steps.length === 0) { setFit(-1); return; }
    const cs = getComputedStyle(chip);
    const max = px(cs.maxWidth);
    if (!max) { setFit(0); return; }
    const gap = px(cs.columnGap);
    const ring = chip.querySelector<SVGElement>(".uc-ring")?.getBoundingClientRect().width ?? 14;
    const moreW = more > 0 ? (chip.querySelector<HTMLElement>(".uc-more")?.getBoundingClientRect().width ?? 0) + gap : 0;
    // One pixel of slack for sub-pixel advances.
    const avail = max - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - ring - gap - moreW - 1;
    const widths = Array.from(probe.children, (el) => el.getBoundingClientRect().width);
    setFit(widths.findIndex((w) => w <= avail));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, more, tick]);
  return fit;
}

function ChipText({ step, measure }: { step: ChipStep; measure?: boolean }) {
  return (
    <span className={`uc-text${measure ? " measure" : ""}`} aria-hidden>
      {step.who && <span className="uc-who">{step.who}</span>}
      <span className="uc-what">{step.what}</span>
    </span>
  );
}

/**
 * The titlebar chip. Calm: a quiet ring on the primary agent's session window
 * and no text. Signal: the ring tracks the window the winning signal is about,
 * plus one line of text and a "+N" count when more notices wait in the
 * popover. Stale data dashes the border and ring and, with no signal, says
 * "stale" and its age. Every shown agent unreadable: a hollow ring and
 * "unavailable". The text follows the truncation ladder (useLadderFit) and
 * may drop to the ring alone; the title and accessible name always carry it
 * in full.
 */
export function UsageChip({ agents, appDefaults, isMobile, onOpenSettings, onOpenProjects }: {
  agents: AgentsBundle;
  appDefaults: Record<string, string>;
  isMobile: boolean;
  /** Opens Settings → Models on this agent's provider page, or the section alone. */
  onOpenSettings: (agentId?: string) => void;
  /** Opens the project list (the scope note's "Which" link). */
  onOpenProjects: () => void;
}) {
  const { map, loaded } = usePlanUsageState();
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);

  const list = useMemo<UsageAgent[]>(
    () => Object.entries(map)
      .filter(([id, s]) => planUsageShown(appDefaults, id) && (!s.available ? !!s.reason : s.windows.length > 0))
      .map(([id, snap]) => ({ id, name: id === GATEWAY_PLAN_ID ? "Gateway" : agentLabel(agents, id), snap })),
    [map, appDefaults, agents],
  );
  const any = list.length > 0;

  // Remember that this instance has a chip, so the next page load can hold its
  // place with a loading ring. An instance with none never flashes one.
  useEffect(() => {
    if (!loaded) return;
    try { if (any) localStorage.setItem("calandria.usageChip", "1"); else localStorage.removeItem("calandria.usageChip"); } catch { /* storage off */ }
  }, [loaded, any]);
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

  const top = summary.signals[0];
  const more = summary.unavailable ? 0 : summary.signals.length - 1;
  const steps = useMemo<ChipStep[]>(
    () => summary.unavailable ? [{ who: "", what: "unavailable" }]
      : top ? chipLadder(top)
      : summary.stale ? staleLadder(summary.staleSince, summary.allStale, now)
      : [],
    [summary, top, now],
  );
  const fit = useLadderFit(chipRef, probeRef, steps, more);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) chipRef.current?.focus();
  };

  if (!loaded) {
    if (!expectChip) return null;
    return (
      <div className="uc-anchor">
        <button className={`uc-chip loading${isMobile ? " tall" : ""}`} aria-label="Usage: loading" disabled>
          <UsageRing pct={0} tone="" loading size={isMobile ? 16 : 14} />
        </button>
      </div>
    );
  }
  if (!any) return null;

  const tone: Tone = top?.tone ?? "";
  const step = fit >= 0 ? steps[fit] : undefined;
  const settingsFor = (id?: string) => { close(false); onOpenSettings(id); };
  const projects = () => { close(false); onOpenProjects(); };
  const body = (
    <UsageCenterBody
      list={summary.order} now={now} named={list.length > 1} notices={summary.signals.length}
      onClose={isMobile ? () => close(true) : undefined}
      staleAgents={summary.staleAgents} allStale={summary.allStale}
      onOpenSettings={settingsFor} onOpenProjects={projects}
    />
  );

  return (
    <div className="uc-anchor">
      <button
        ref={chipRef}
        className={`uc-chip${toneClass(tone)}${isMobile ? " tall" : ""}${summary.stale ? " stale" : ""}${summary.unavailable ? " unavailable" : ""}${step ? "" : " bare"}${open ? " open" : ""}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={summary.spoken}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={summary.spoken}
      >
        <UsageRing pct={summary.ring?.window.utilization ?? 0} tone={summary.ring?.tone ?? ""} dashed={summary.stale} hollow={summary.unavailable} size={isMobile ? 16 : 14} />
        {step && <ChipText step={step} />}
        {more > 0 && <span className="uc-more" aria-hidden>+{more}</span>}
        <span ref={probeRef} className="uc-probe" aria-hidden>
          {steps.map((x, i) => <ChipText key={i} step={x} measure />)}
        </span>
      </button>
      {open && !isMobile && (
        <Popover className="uc-pop" onClose={() => close(true)}>
          <UsageDialog onEscape={() => close(true)}>{body}</UsageDialog>
        </Popover>
      )}
      {open && isMobile && <UsageSheet onClose={(refocus) => close(refocus)}>{body}</UsageSheet>}
    </div>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Focus handling shared by the popover and the sheet: the first control takes
 * focus on open, Tab and Shift+Tab cycle inside the container, and Escape
 * closes with focus returned to the chip.
 */
function useDialogKeys(ref: React.RefObject<HTMLDivElement | null>, onEscape: () => void) {
  // A frame later: the popover is hidden until it has measured its position, and a hidden element cannot take focus.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const root = ref.current;
      (root?.querySelector<HTMLElement>(FOCUSABLE) ?? root)?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [ref]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onEscape(); return; }
      if (e.key !== "Tab") return;
      const root = ref.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && (active === first || active === root)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ref, onEscape]);
}

/** Popover content wrapper: takes focus on open, traps Tab, closes on Escape. */
function UsageDialog({ children, onEscape }: { children: React.ReactNode; onEscape: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogKeys(ref, onEscape);
  return <div ref={ref} className="uc-menu" role="dialog" aria-label="Usage" tabIndex={-1}>{children}</div>;
}

/** The phone presentation: a bottom sheet with a scrim, in Work Center's sheet language. */
function UsageSheet({ children, onClose }: { children: React.ReactNode; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const escape = useCallback(() => onClose(true), [onClose]);
  useDialogKeys(ref, escape);
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

function UsageCenterBody({ list, now, named, notices, onClose, staleAgents, allStale, onOpenSettings, onOpenProjects }: {
  list: UsageAgent[];
  now: number;
  named: boolean;
  notices: number;
  /** Set on the phone sheet, which pins a close button in its header. */
  onClose?: () => void;
  staleAgents: UsageAgent[];
  allStale: boolean;
  onOpenSettings: (agentId?: string) => void;
  onOpenProjects: () => void;
}) {
  const reads = list.filter((a) => a.snap.available && !a.snap.stale).map((a) => a.snap.fetchedAt).filter((t): t is number => t != null);
  const updated = reads.length ? Math.max(...reads) : null;
  const staleReason = staleAgents.find((a) => a.snap.reason)?.snap.reason ?? "refresh failed";
  // The footer link lands on the first listed agent's provider page; the gateway has no bundled page.
  const footAgent = list.find((a) => a.id !== GATEWAY_PLAN_ID)?.id;
  return (
    <div className="uc">
      <div className="uc-top">
        <h2>Usage</h2>
        <span className="uc-count">{notices > 0 ? <><b>{notices}</b> notice{notices === 1 ? "" : "s"}</> : "all clear"}</span>
        {onClose && <button className="uc-close" onClick={onClose} aria-label="Close">{Icon.x()}</button>}
      </div>
      <div className="uc-body">
        {list.map((a) => <AgentSection key={a.id} a={a} now={now} named={named} onOpenSettings={() => onOpenSettings(a.id)} onOpenProjects={onOpenProjects} />)}
      </div>
      <div className="uc-foot">
        {updated != null && <span className="uc-updated">Updated {agoText(updated)}</span>}
        {staleAgents.length > 0 && (
          <span className="uc-stale">{allStale ? "Stale" : `${staleAgents.map((a) => a.name).join(", ")} stale`} · {staleReason}</span>
        )}
        <button className="uc-link" onClick={() => onOpenSettings(footAgent)}>{Icon.gear()} Usage settings</button>
      </div>
    </div>
  );
}

/** The windows always shown: the session, the first week, a gateway budget. The rest fold. */
function splitWindows(windows: PlanUsageWindow[]): { shown: PlanUsageWindow[]; folded: PlanUsageWindow[] } {
  const { session, week } = headlineWindows(windows);
  const shown = windows.filter((w) => w === session || w === week || w.kind === "gateway_budget");
  if (shown.length === 0) return { shown: windows.slice(0, 2), folded: windows.slice(2) };
  return { shown, folded: windows.filter((w) => !shown.includes(w)) };
}

function AgentSection({ a, now, named, onOpenSettings, onOpenProjects }: {
  a: UsageAgent;
  now: number;
  named: boolean;
  onOpenSettings: () => void;
  onOpenProjects: () => void;
}) {
  const { snap } = a;
  const [showAll, setShowAll] = useState(false);
  const limit = useOpenTaskLimit();
  const signals = useMemo(() => agentSignals(a, now, named).sort(compareSignals), [a, now, named]);
  const top = signals[0] as UsageSignal | undefined;
  const mark = AgentMark[a.id];
  const planName = snap.plan ? snap.plan[0].toUpperCase() + snap.plan.slice(1) : null;
  const role = a.id === GATEWAY_PLAN_ID ? null : snap.role;

  const { shown, folded } = splitWindows(snap.windows);
  // A folded window that carries a notice unfolds the group on its own.
  const forced = folded.some((w) => signals.some((s) => s.window === w));
  const expanded = forced || showAll;
  const rows = expanded ? snap.windows : shown;
  const rejectedId = snap.status === "rejected" ? snap.statusWindow : null;
  const offer = top?.kind === "limit" && limit && limit.usageKey === a.id ? limit : null;

  return (
    <section className="uc-agent" aria-label={`${a.name} usage`}>
      <div className="uc-agent-head">
        {mark && <span className="uc-mark" aria-hidden>{mark()}</span>}
        <span className="uc-agent-name">{a.name}{planName ? ` ${planName}` : ""}</span>
        {role && isPrimary(a) && (
          <span className="uc-role primary" title={role.source === "pinned" ? "Pinned in settings" : "Set automatically from last week's usage"}>
            Primary{role.source === "pinned" ? " · pinned" : ""}
          </span>
        )}
        <button className="uc-gear" onClick={onOpenSettings} aria-label={`${a.name} settings`} title={`Settings → Models → ${a.name}`}>{Icon.gear()}</button>
      </div>
      {!snap.available && (
        <div className="uc-note muted uc-unavailable">
          <span>Usage can't be read{snap.reason ? `: ${snap.reason}` : "."}</span>
          <button className="btn btn-sm" onClick={onOpenSettings}>Sign in</button>
        </div>
      )}
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
      {snap.available && snap.windows.length === 0 && <div className="uc-note muted">No usage windows reported.</div>}
      {rows.map((w, i) => (
        <UsageMeter key={w.id} sep={i > 0} w={w} now={now} tone={toneFor(w.utilization, rejectedId === w.id)} stale={snap.stale} />
      ))}
      {folded.length > 0 && !forced && (
        <button className="uc-more-rows" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
          <span>{showAll ? "Hide" : "Show"} {folded.length} more window{folded.length === 1 ? "" : "s"}</span>
          {!showAll && <span className="uc-more-pcts">{folded.map((w) => `${Math.floor(w.utilization)}%`).join(" · ")}</span>}
        </button>
      )}
      {snap.scope?.kind === "some" && (
        <div className="uc-note scoped">
          {snap.scope.redirected} of {snap.scope.redirected + snap.scope.onPlan} projects route {a.name} through
          another endpoint; their turns don&apos;t draw on this plan.{" "}
          <button className="uc-inline-link" onClick={onOpenProjects}>Which</button>
        </div>
      )}
    </section>
  );
}
