"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { groupIsDone, type TaskGroupRow, type TaskRow } from "./types";

// Task groups on the list and the board. A group is a FILTER over the status
// buckets both views are built on, plus a badge on every row and card — it
// never changes what a bucket is. (Design: docs/superpowers/specs/
// 2026-08-24-task-grouping-design.md; the strip, bulk assign and agent tools
// are later phases.)

// The chip/badge tint rides a CSS custom property so one rule set serves every
// palette entry (and the neutral no-color case) — see .gchip/.gbadge.
export function groupTint(color: string | null): CSSProperties | undefined {
  return color ? ({ "--gc": color } as CSSProperties) : undefined;
}

// "4/7": members done over members still counted. Cancelled and withdrawn are
// taken OUT of the denominator rather than shown as unfinished — a group of
// five with two withdrawn is 3/3 when the three land — and the tooltip says
// how many were withdrawn so the fraction doesn't read as a lie.
export function groupProgress(g: Pick<TaskGroupRow, "counts">): { done: number; of: number; label: string; detail: string } {
  const { total, done, cancelled, running, awaiting } = g.counts;
  const of = total - cancelled;
  const parts = [`${done} done`];
  if (cancelled) parts.push(`${cancelled} cancelled or withdrawn`);
  if (running) parts.push(`${running} running`);
  if (awaiting) parts.push(`${awaiting} need${awaiting === 1 ? "s" : ""} you`);
  return { done, of, label: total === 0 ? "no tasks yet" : `${done}/${of}`, detail: total === 0 ? "No tasks yet" : parts.join(" · ") };
}

const KEY = (projectId: string) => `orch_group_filter_${projectId}`;
// Fired when something OTHER than the chip bar picks a group — the badge in
// the session header, a landing card later — so every mounted bar follows.
const EVENT = "orch:group-filter";

/** Select a group's chip from anywhere (null = All). Persists, then tells every bar. */
export function selectGroupFilter(projectId: string, groupId: string | null) {
  try {
    if (groupId) localStorage.setItem(KEY(projectId), groupId);
    else localStorage.removeItem(KEY(projectId));
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId, groupId } }));
}

/**
 * Which group the list/board is narrowed to, per project, persisted the way
 * the collapsed Done/Cancelled sections are (localStorage, not the URL — it's
 * a working preference, not a location). A remembered id that no longer names
 * a group in `groups` (deleted, or another project's) reads as All rather than
 * filtering everything out.
 */
export function useGroupFilter(projectId: string, groups: TaskGroupRow[]) {
  const [raw, setRaw] = useState<string | null>(null);
  useEffect(() => {
    try { setRaw(localStorage.getItem(KEY(projectId))); } catch { setRaw(null); }
    const onPick = (e: Event) => {
      const d = (e as CustomEvent<{ projectId: string; groupId: string | null }>).detail;
      if (d.projectId === projectId) setRaw(d.groupId);
    };
    window.addEventListener(EVENT, onPick);
    return () => window.removeEventListener(EVENT, onPick);
  }, [projectId]);
  const selected = useMemo(() => (raw && groups.some((g) => g.id === raw) ? raw : null), [raw, groups]);
  const select = (id: string | null) => selectGroupFilter(projectId, id);
  return { selected, select };
}

/** The filter itself: null keeps everything, an id keeps that group's members. */
export function inGroup<T extends Pick<TaskRow, "group_id">>(tasks: T[], groupId: string | null): T[] {
  return groupId ? tasks.filter((t) => t.group_id === groupId) : tasks;
}

/**
 * The chip bar: All · <active groups> · Done (n). Renders nothing for a
 * project with no groups, so the bar costs nothing until the first one exists.
 * Finished groups fold behind the Done chip so a long-lived project's bar isn't
 * a wall of shipped features; the fold opens in place and stays open only for
 * this mount.
 */
export function GroupChips({ groups, selected, onSelect }: {
  groups: TaskGroupRow[]; selected: string | null; onSelect: (id: string | null) => void;
}) {
  const [showDone, setShowDone] = useState(false);
  if (groups.length === 0) return null;
  const active = groups.filter((g) => !groupIsDone(g));
  const done = groups.filter((g) => groupIsDone(g));
  // A selected chip inside the fold stays visible even when the fold is shut,
  // or the bar would show "All" unselected with the list still narrowed.
  const shownDone = showDone ? done : done.filter((g) => g.id === selected);
  const chip = (g: TaskGroupRow) => {
    const p = groupProgress(g);
    return (
      <button key={g.id} role="tab" aria-selected={selected === g.id}
        className={`gchip ${selected === g.id ? "on" : ""}`} style={groupTint(g.color)}
        title={`${g.name} — ${p.detail}${g.description ? `\n${g.description}` : ""}`}
        onClick={() => onSelect(selected === g.id ? null : g.id)}>
        <span className="gc-dot" />
        <span className="gc-name">{g.name}</span>
        <span className="gc-frac">{p.label}</span>
        {g.counts.awaiting > 0 && <span className="gc-need" title={`${g.counts.awaiting} need${g.counts.awaiting === 1 ? "s" : ""} you`} />}
      </button>
    );
  };
  return (
    <div className="gchips" role="tablist" aria-label="Filter by group">
      <button role="tab" aria-selected={selected === null} className={`gchip ${selected === null ? "on" : ""}`} onClick={() => onSelect(null)}>All</button>
      {active.map(chip)}
      {done.length > 0 && (
        <button className={`gchip fold ${showDone ? "open" : ""}`} aria-expanded={showDone}
          title={showDone ? "Hide finished groups" : "Show finished groups"} onClick={() => setShowDone((v) => !v)}>
          Done <span className="gc-frac">{done.length}</span>
        </button>
      )}
      {shownDone.map(chip)}
    </div>
  );
}

/**
 * The tinted pill a member row, card or session header carries. With
 * `onSelect` it's a button that selects the group's chip — the way into the
 * filter from any surface showing a task — otherwise a plain label.
 */
export function GroupBadge({ group, onSelect, className }: {
  // Name and tint are all a badge needs to RENDER; the counts are only for its
  // tooltip, and the palette's rows (listAllTasksLite) carry the name without
  // them. So they're optional rather than forcing a fake `counts` on callers.
  group: Pick<TaskGroupRow, "name" | "color"> & Partial<Pick<TaskGroupRow, "counts">>;
  onSelect?: () => void; className?: string;
}) {
  const title = group.counts ? `Group: ${group.name} — ${groupProgress({ counts: group.counts }).detail}` : `Group: ${group.name}`;
  const cls = `gbadge ${className ?? ""}`;
  if (!onSelect) return <span className={cls} style={groupTint(group.color)} title={title}>{group.name}</span>;
  return (
    <button type="button" className={cls} style={groupTint(group.color)} title={`${title}\nClick to show only this group`}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onKeyDown={(e) => e.stopPropagation()}>
      {group.name}
    </button>
  );
}
