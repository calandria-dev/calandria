"use client";

import { Icon } from "../icons";

export type MobileTabId = "board" | "services" | "terminals" | "insights";

const TABS: { id: MobileTabId; label: string; icon: () => React.ReactElement }[] = [
  { id: "board", label: "Board", icon: Icon.board },
  { id: "services", label: "Services", icon: Icon.sliders },
  { id: "terminals", label: "Terminals", icon: Icon.terminal },
  { id: "insights", label: "Insights", icon: Icon.chart },
];

// Bottom tab bar (phone only). A plain flex sibling of .body inside .app.mobile,
// not a fixed overlay: it claims its own row and .body's flex:1 shrinks to fit
// above it, so no manual bottom-padding/z-index bookkeeping is needed.
// `active: null` covers Settings, which is reachable but isn't one of these four
// tabs, so nothing lights up while it's on screen.
// `services` is dropped when the services feature is off, leaving three tabs.
export function MobileTabBar({ active, onSelect, services = true }: {
  active: MobileTabId | null;
  onSelect: (id: MobileTabId) => void;
  services?: boolean;
}) {
  const tabs = services ? TABS : TABS.filter((t) => t.id !== "services");
  return (
    <nav className="mtabbar">
      {tabs.map((t) => (
        <button key={t.id} className={`mtabbar-item${active === t.id ? " on" : ""}`} onClick={() => onSelect(t.id)}>
          {t.icon()}
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
