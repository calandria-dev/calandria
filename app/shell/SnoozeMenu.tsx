"use client";

import { useState } from "react";
import { Icon } from "../icons";
import { Popover } from "./shared";
import { snoozePresets, relativeUntil, wakeLabel, type SnoozeUnit } from "./snooze";

const UNITS: SnoozeUnit[] = ["minutes", "hours", "days", "weeks"];

// The value a <input type="datetime-local"> wants: local wall-clock, no zone.
// toISOString() would be UTC, which silently offsets the default the user sees.
function localInputValue(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Picking a snooze deadline: the three ways of saying "later" the feature
 * promises, in the order they're actually reached for.
 *
 *   presets   — one click, covering the common cases
 *   relative  — "in 2 hours", for a duration the presets don't hold
 *   exact     — a date and time, for "the morning of the demo"
 *
 * Every route resolves to one absolute ms epoch before it leaves here, so the
 * caller (and the column) only ever deals in deadlines. A deadline in the past
 * is refused rather than clamped — a snooze that ends before it starts reads as
 * the button being broken.
 */
export function SnoozeMenu({ onPick, onClose }: { onPick: (until: number) => void; onClose: () => void }) {
  // Frozen at open: the menu lives for seconds, and a `now` that drifted
  // mid-interaction would move the preset under the cursor.
  const [now] = useState(() => Date.now());
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<SnoozeUnit>("hours");
  const [exact, setExact] = useState(() => localInputValue(now + 24 * 3_600_000));
  const [err, setErr] = useState("");

  const commit = (until: number, what: string) => {
    if (!Number.isFinite(until) || until <= Date.now()) { setErr(`${what} is not in the future.`); return; }
    onPick(Math.round(until));
  };
  const n = Number(amount);
  const relative = Number.isFinite(n) && n > 0 ? relativeUntil(now, n, unit) : NaN;

  return (
    <Popover onClose={onClose}>
      <div className="pop-sec">Snooze until</div>
      {snoozePresets(now).map((p) => (
        // data-preset is a stable hook for tests. Matching these rows on their
        // TEXT is ambiguous by nature: every row also renders its wake time, so
        // late in the evening the "3 hours" row's sub-label reads "tomorrow
        // at 12:07 AM" and collides with the "Tomorrow" row's label.
        <div key={p.key} data-preset={p.key} className="pop-item" onClick={() => commit(p.until, p.label)}>
          <div>
            <div>{p.label}</div>
            <div className="pi-sub">{wakeLabel(p.until, now)}</div>
          </div>
        </div>
      ))}
      <div className="pop-sec">For a while</div>
      {/* stopPropagation so typing/clicking inside the fields doesn't reach the
          Popover's outside-click handler and close the menu mid-entry. */}
      <div className="snz-row" onClick={(e) => e.stopPropagation()}>
        <span className="snz-lead">in</span>
        <input className="snz-num" type="number" min={1} value={amount} inputMode="numeric"
          onChange={(e) => { setAmount(e.target.value); setErr(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") commit(relative, "That"); }} aria-label="Snooze amount" />
        <select className="snz-unit" value={unit} onChange={(e) => setUnit(e.target.value as SnoozeUnit)} aria-label="Snooze unit">
          {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <button className="btn btn-line btn-sm" onClick={() => commit(relative, "That")}>Snooze</button>
      </div>
      <div className="pop-sec">On a date</div>
      <div className="snz-row" onClick={(e) => e.stopPropagation()}>
        <input className="snz-when" type="datetime-local" value={exact}
          onChange={(e) => { setExact(e.target.value); setErr(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") commit(new Date(exact).getTime(), "That time"); }} aria-label="Snooze until date and time" />
        <button className="btn btn-line btn-sm" onClick={() => commit(new Date(exact).getTime(), "That time")}>Snooze</button>
      </div>
      {err && <div className="snz-err">{err}</div>}
    </Popover>
  );
}

/**
 * The button that opens the menu, with its own open state — every surface that
 * offers snoozing (the session header, a list row, a board card) needs exactly
 * this pairing, and the Popover positions itself against its parent, so the
 * relative wrapper has to travel with the trigger.
 */
export function SnoozeButton({ onSnooze, className = "btn btn-line btn-sm", label }: {
  onSnooze: (until: number) => void;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
      <button className={className} title="Snooze: hide this until later" onClick={() => setOpen((o) => !o)}>
        {Icon.moon()}{label ? ` ${label}` : ""}
      </button>
      {open && <SnoozeMenu onClose={() => setOpen(false)} onPick={(until) => { setOpen(false); onSnooze(until); }} />}
    </div>
  );
}
