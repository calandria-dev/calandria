"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Priority, Status } from "@/lib/types";
import type { AgentProvider } from "@/lib/agentEnv";
import { Icon, AgentMark } from "../icons";
import { SCLS, SLABEL, AWAIT_LABEL } from "./types";
import { endpointSummary, type EndpointModelsState } from "./modelEndpoint";

// Touch-device detection, shared by every surface that must behave differently
// under a finger (TaskBoard drops draggable=true, the Composer's return key
// inserts a newline instead of sending). SSR renders false and the effect
// corrects on mount — the same pattern as useIsMobile in Shell.tsx.
export function useCoarsePointer() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const sync = () => setCoarse(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return coarse;
}

export function StatusDot({ status, running, awaiting, background, lg }: { status: Status; running?: boolean; awaiting?: boolean; background?: boolean; lg?: boolean }) {
  // Signal language (mission-control): "needs your input" is an alert coral, a
  // *live* working session is blue (both pulse to draw the eye), and an idle
  // status falls back to its base color. Awaiting wins over running — a turn
  // parked on a question is technically live but it's really waiting on you.
  // Background (a hollow blue ring) sits between: the session is live and held
  // open for run_in_background work, but the model isn't talking — nothing
  // needs the user, so it must NOT read as either "waiting" or plain "working".
  const cls = awaiting ? "c" : background ? "bg" : running ? "b" : SCLS[status];
  return (
    <span
      className={`sdot ${cls} ${lg ? "lg" : ""} ${awaiting || running || background ? "pulse" : ""}`}
      title={awaiting ? AWAIT_LABEL : background ? "Working in background" : running ? "Live" : SLABEL[status]}
    />
  );
}

export function PriPill({ p }: { p: Priority }) {
  const map: Record<Priority, string> = { hi: "HIGH", med: "MED", lo: "LOW" };
  return <span className={`pri ${p}`}>{map[p]}</span>;
}

export function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="search-bar">
      <span className="search-ic">{Icon.search()}</span>
      <input
        className="search-input" value={value} placeholder={placeholder} spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && value) { e.stopPropagation(); onChange(""); } }}
      />
      {value && <button className="search-clear" title="Clear search" onClick={() => onChange("")}>{Icon.x()}</button>}
    </div>
  );
}

// Chat avatar. The assistant side wears the brand mark of the agent the task
// actually runs on (Claude / Codex), so a transcript says at a glance who wrote
// it; an unknown or missing agent id falls back to the generic bolt.
export function Avatar({ who, agent }: { who: "user" | "cc"; agent?: string | null }) {
  if (who === "user") return <span className="av you">A</span>;
  const mark = agent ? AgentMark[agent] : undefined;
  return <span className={`av cc${mark ? ` ${agent}` : ""}`}>{mark ? mark() : Icon.bolt()}</span>;
}

// Which agent driver a task runs under (Claude Code / Codex …), as the brand
// mark alone, sat left of the title it qualifies. Hidden when only one agent is
// available (nothing to disambiguate) so single-agent workspaces stay
// clutter-free. `multi` is passed by the caller from the agents bundle.
//
// The label moved to the tooltip. A word of prose was spending chip-width the
// title beside it wanted, to say what a 14px logo says at a glance, and unlike
// the tags it used to sit with there is nothing to DO with the agent: it's
// fixed for the life of the session and clicking it filters nothing.
//
// An agent with no mark of its own (a third driver, the e2e mock) falls back to
// the generic bolt exactly as `Avatar` does, rather than to the name. The slot
// has to stay a FIXED, non-shrinking glyph: the title beside it is
// `flex:1;min-width:0`, so a nowrap text chip in this row squeezes it to zero
// width on a narrow column — which is the very crowding that had banished the
// old chip to the card footer. The name is a hover away either way.
export function AgentBadge({ agent, label, multi }: { agent?: string | null; label: string; multi: boolean }) {
  if (!multi) return null;
  const mark = agent ? AgentMark[agent] : undefined;
  return (
    <span className={`agent-badge${mark ? ` ${agent}` : ""}`} role="img" aria-label={`Runs on ${label}`} title={`Runs on ${label}`}>
      {mark ? mark() : Icon.bolt()}
    </span>
  );
}

// Which ENDPOINT a task's turns run against, when it isn't the agent's own
// cloud (lib/agentEnv.ts): a local model server or a custom base URL, set on
// the project or overridden on the task. Sits beside the agent mark and says
// the one thing the mark can't — that this Claude Code session is talking to
// Ollama, and isn't billed as Anthropic spend. Same fixed, non-shrinking
// discipline as AgentBadge: the title beside it is `flex:1;min-width:0`.
// Renders nothing for the cloud, so single-endpoint instances never see it.
export function ProviderBadge({ provider }: { provider: AgentProvider }) {
  if (provider.kind === "cloud") return null;
  const what = provider.kind === "local" ? "local model server" : provider.kind === "gateway" ? "LiteLLM gateway" : "custom endpoint";
  // The three non-cloud kinds are billed differently and the badge has to say
  // so: a local server really is free, a custom base URL may be a paid third
  // party we have no prices for, and a gateway knows its own prices but bills
  // either its key or the CLI's own plan. See ProviderPricing in lib/agentEnv.ts.
  const billing = provider.pricing === "free"
    ? "Not cloud spend: turns against it cost nothing."
    : provider.pricing === "gateway"
      ? provider.gateway_billing === "subscription"
        ? "Billed to your own plan: the gateway forwards the CLI's login. Turns are recorded unpriced and left out of cost totals."
        : "Billed to the gateway's key, not your plan. Turns are recorded unpriced and left out of cost totals."
      : "Not cloud spend, and not free either — its prices are unknown, so turns against it are recorded unpriced and left out of cost totals.";
  const title = `Runs against ${provider.host} (${what}${provider.model ? `, ${provider.model}` : ""}). ${billing}`;
  return (
    <span className={`provider-badge ${provider.kind}`} role="img" aria-label={title} title={title}>
      {provider.kind}
    </span>
  );
}

// ---- async-state primitives (pair with the .spinner/.load-note/.skel/.err-note
// styles in globals.css) — every panel that fetches uses these, so loading and
// error presentation stays uniform across the app. ----

export function Spinner({ size }: { size?: number }) {
  return <span className="spinner" role="status" aria-label="Loading" style={size ? { width: size, height: size } : undefined} />;
}

// Standard "we're fetching" line: spinner + quiet text. Replaces bare "Loading…".
export function LoadNote({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="load-note" style={style}><Spinner size={13} />{children}</div>;
}

// One shimmer bar. Compose a few for card/list/transcript skeletons.
export function Skel({ w, h = 10, r, style }: { w: number | string; h?: number; r?: number | string; style?: React.CSSProperties }) {
  return <span className="skel" aria-hidden style={{ width: w, height: h, ...(r !== undefined ? { borderRadius: r } : null), ...style }} />;
}

// Recoverable-error line: the message plus an inline Retry when the caller can
// simply refetch. Same warm-red voice as transcript system errors.
export function ErrNote({ children, onRetry, retryLabel = "Retry", style }: {
  children: React.ReactNode; onRetry?: () => void; retryLabel?: string; style?: React.CSSProperties;
}) {
  return (
    <div className="err-note" style={style}>
      <span className="err-msg">⚠ {children}</span>
      {onRetry && <button className="btn btn-line btn-sm" onClick={onRetry}>{Icon.restore()} {retryLabel}</button>}
    </div>
  );
}

// Collapsed raw output beneath a one-line error headline — a rejected push's
// pre-push/pre-receive hook output, which a single-line error would otherwise
// throw away. Closed by default so it reads as detail, not noise.
export function ErrDetail({ detail }: { detail?: string }) {
  if (!detail) return null;
  return (
    <details className="err-detail">
      <summary>Show git output</summary>
      <pre>{detail}</pre>
    </details>
  );
}

// A dropdown menu anchored to its trigger. It renders into document.body via a
// portal and positions itself `fixed` from the trigger's measured rect, so it is
// never clipped or pushed off-screen by an ancestor's `overflow` — which is
// exactly what happened on mobile, where the trigger lives inside the
// horizontally-scrolling `.sh-tools` rail (the menu opened ~570px to the right of
// a 390px-wide screen and was unreachable). The trigger is found as the parent of
// an in-place marker span, so call sites don't need to pass a ref.
export function Popover({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = markerRef.current?.parentElement; // the position:relative wrapper ≈ the trigger
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 200;
    const mh = menu.offsetHeight || 0;
    const vw = window.innerWidth, vh = window.innerHeight;
    // Right-align under the trigger, then clamp into the viewport (both axes).
    const left = Math.max(8, Math.min(r.right - mw, vw - mw - 8));
    let top = r.bottom + 4;
    if (top + mh > vh - 8) top = Math.max(8, r.top - mh - 4); // flip above if it'd overflow the bottom
    setPos({ top, left });
  }, []);

  // Close on any outside click (the trigger and menu stopPropagation), and on
  // scroll of an *ancestor* — a fixed menu doesn't follow a scrolling ancestor, so
  // dismiss instead. But scrolling inside the menu itself (a long, overflow-scroll
  // list) must NOT close it, so ignore scroll events originating within the menu.
  useEffect(() => {
    const close = () => onClose();
    const onScroll = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("click", close);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", onScroll, true); };
  }, [onClose]);

  return (
    <>
      <span ref={markerRef} style={{ display: "none" }} />
      {createPortal(
        <div
          ref={menuRef}
          className="popover"
          style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, right: "auto", visibility: pos ? "visible" : "hidden" }}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * That sentence as the picker renders it: plain when the endpoint answered, and
 * flagged when it didn't — an unreachable endpoint means every turn this
 * project starts will fail, which is worth saying before the task is created
 * rather than in the transcript afterwards.
 */
export function EndpointNote({ state }: { state: EndpointModelsState }) {
  const text = endpointSummary(state.data, state.loading);
  if (!text) return null;
  const down = !!state.data && !state.data.reachable;
  if (!down) return <>{text}</>;
  return <span className="wiz-warn">{Icon.bolt()} {text}. Turns will fail until it answers.</span>;
}
