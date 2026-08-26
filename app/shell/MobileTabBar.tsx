"use client";

import { Icon } from "../icons";

export type MobileTabId = "board" | "diffs" | "terminals" | "insights";

const TABS: { id: MobileTabId; label: string; icon: () => React.ReactElement }[] = [
  { id: "board", label: "Board", icon: Icon.board },
  { id: "diffs", label: "Diffs", icon: Icon.diff },
  { id: "terminals", label: "Terminals", icon: Icon.terminal },
  { id: "insights", label: "Insights", icon: Icon.chart },
];

// Bottom tab bar (phone only). A plain flex sibling of .body inside .app.mobile
// rather than a fixed overlay — it claims its own row and .body's flex:1 shrinks
// to fit above it, so no manual bottom-padding/z-index bookkeeping is needed.
// `active: null` covers Settings, which is reachable but isn't one of these four
// tabs — nothing lights up while it's on screen.
export function MobileTabBar({ active, onSelect }: { active: MobileTabId | null; onSelect: (id: MobileTabId) => void }) {
  return (
    <nav className="mtabbar">
      {TABS.map((t) => (
        <button key={t.id} className={`mtabbar-item${active === t.id ? " on" : ""}`} onClick={() => onSelect(t.id)}>
          {t.icon()}
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
