"use client";

import { Icon } from "../icons";
import type { CountView } from "./workCenter";

export type MobileTabId = "board" | "services" | "terminals" | "work" | "insights";

const TABS: { id: MobileTabId; label: string; icon: () => React.ReactElement }[] = [
  { id: "board", label: "Board", icon: Icon.board },
  { id: "services", label: "Services", icon: Icon.sliders },
  { id: "terminals", label: "Terminals", icon: Icon.terminal },
  { id: "work", label: "Work", icon: Icon.work },
  { id: "insights", label: "Insights", icon: Icon.chart },
];

// Bottom tab bar (phone only). A plain flex sibling of .body inside .app.mobile,
// not a fixed overlay: it claims its own row and .body's flex:1 shrinks to fit
// above it, so no manual bottom-padding/z-index bookkeeping is needed.
// `active: null` covers Settings, which is reachable but isn't one of these
// tabs, so nothing lights up while it's on screen.
// `services` is dropped when the services feature is off, leaving four tabs.
// The Work tab carries the needs-you badge: the snapshot's visible task count,
// dashed when the total is unknown, grey when the snapshot is stale, and absent
// before the first snapshot or at a real zero.
export function MobileTabBar({ active, onSelect, services = true, workBadge, workStale }: {
  active: MobileTabId | null;
  onSelect: (id: MobileTabId) => void;
  services?: boolean;
  workBadge?: CountView;
  workStale?: boolean;
}) {
  const tabs = services ? TABS : TABS.filter((t) => t.id !== "services");
  const badge = workBadge && (workBadge.kind === "value" || workBadge.kind === "unknown") ? workBadge : null;
  return (
    <nav className="mtabbar">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`mtabbar-item${active === t.id ? " on" : ""}`}
          onClick={() => onSelect(t.id)}
          aria-label={t.id === "work" && workBadge ? `Work, ${workBadge.txt} need you${workBadge.kind === "unknown" ? " (total unknown)" : ""}` : undefined}
        >
          {t.icon()}
          <span>{t.label}</span>
          {t.id === "work" && badge && (
            <span className={`wc-tab-badge${badge.kind === "unknown" ? " unk" : ""}${workStale ? " stale" : ""}`}>{badge.txt}</span>
          )}
        </button>
      ))}
    </nav>
  );
}
