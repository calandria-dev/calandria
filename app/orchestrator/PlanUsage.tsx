"use client";

import { useEffect, useState } from "react";
import { Popover } from "./shared";
import { jget } from "./api";
import type { PlanUsageSnapshot, PlanUsageWindow } from "@/lib/types";

// The titlebar subscription-usage meter — "how much of my Claude plan have my
// parallel sessions burned" at a glance, which matters here more than in a
// single terminal because this app's whole point is running many of them.
// Compact pill: session % · week %, tinted by the worst window. Click for the
// full per-window breakdown (all the windows the provider reports, including
// per-model weeks) with reset times and data freshness.
//
// Polls GET /api/plan-usage once a minute while the tab is visible. Cheap on
// purpose: the server answers from an instance-wide cache and only touches the
// (aggressively rate-limited) provider usage API when its own fetch floor
// allows — see lib/agents/claude/planUsage.ts. Hidden entirely when no agent
// reports plan usage (API-key auth, feature off, nothing fetched yet).

const POLL_MS = 60_000;

// Meter tinting: quiet until a window is actually worth glancing at.
function tone(pct: number, rejected: boolean): "" | "warn" | "limit" {
  if (rejected || pct >= 95) return "limit";
  if (pct >= 80) return "warn";
  return "";
}

function fmtReset(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" })}, ${time}`;
}

// Time left in a window, compact ("18m", "3h05m"). Null once the reset is
// past or unreported. Recomputed on every poll re-render, so it's at worst a
// minute stale — the same granularity it displays.
function fmtRemaining(resetsAt: number | null): string | null {
  if (resetsAt == null) return null;
  const mins = Math.ceil((resetsAt - Date.now()) / 60_000);
  if (mins <= 0) return null;
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
}

function agoText(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function Meter({ w, rejected }: { w: PlanUsageWindow; rejected: boolean }) {
  const t = tone(w.utilization, rejected);
  return (
    <div className={`pu-row${t ? ` ${t}` : ""}`}>
      <div className="pu-row-head">
        <span className="pu-label">{w.label}</span>
        <span className="pu-pct">{Math.floor(w.utilization)}% used</span>
      </div>
      <div className="pu-bar">
        <div className="pu-fill" style={{ width: `${Math.min(100, w.utilization)}%` }} />
      </div>
      {w.resetsAt != null && <div className="pu-reset">Resets {fmtReset(w.resetsAt)}</div>}
    </div>
  );
}

export function PlanUsagePill() {
  const [snap, setSnap] = useState<PlanUsageSnapshot | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return; // a hidden tab shouldn't keep the server polling the provider
      jget<{ agents: Record<string, PlanUsageSnapshot> }>("/api/plan-usage")
        .then((d) => { if (alive) setSnap(d.agents.claude ?? null); })
        .catch(() => { /* transient — keep showing the last snapshot */ });
    };
    load();
    const iv = setInterval(load, POLL_MS);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  if (!snap?.available || snap.windows.length === 0) return null;

  const session = snap.windows.find((w) => w.id === "five_hour");
  const week = snap.windows.find((w) => w.id === "seven_day");
  // Session reset countdown, on the pill itself: the 5-hour window is the one
  // you pace work against ("can I dispatch another batch before it rolls?"),
  // so its time-to-reset earns pill space where the week's doesn't — the
  // popover still shows every window's reset in full.
  const sessionLeft = session ? fmtRemaining(session.resetsAt) : null;
  const rejected = snap.status === "rejected";
  const worst = Math.max(...snap.windows.map((w) => w.utilization));
  const t = tone(worst, rejected);
  const planName = snap.plan ? snap.plan[0].toUpperCase() + snap.plan.slice(1) : null;

  return (
    <div style={{ position: "relative" }}>
      <button
        className={`plan-pill${t ? ` ${t}` : ""}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={`Claude ${planName ? `${planName} ` : ""}plan usage — click for the breakdown`}
      >
        {session && (
          <span className="pp-seg">
            5h {Math.floor(session.utilization)}%
            {sessionLeft && <span className="pp-left"> ({sessionLeft})</span>}
          </span>
        )}
        {session && week && <span className="pp-div">·</span>}
        {week && <span className="pp-seg">wk {Math.floor(week.utilization)}%</span>}
        {!session && !week && <span className="pp-seg">{Math.floor(worst)}%</span>}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)}>
          <div className="pu-menu">
            <div className="pop-sec">Claude {planName ? `${planName} ` : ""}plan usage</div>
            {rejected && (
              <div className="pu-note limit">
                Usage limit reached — turns resume{snap.statusResetsAt != null ? ` at ${fmtReset(snap.statusResetsAt)}` : " when the limit resets"}.
              </div>
            )}
            {snap.windows.map((w) => (
              <Meter key={w.id} w={w} rejected={rejected && snap.statusWindow === w.id} />
            ))}
            <div className="pu-foot">
              {snap.fetchedAt != null ? `Updated ${agoText(snap.fetchedAt)}` : "From live session telemetry"}
              {snap.stale && snap.reason ? ` · stale: ${snap.reason}` : ""}
            </div>
          </div>
        </Popover>
      )}
    </div>
  );
}
