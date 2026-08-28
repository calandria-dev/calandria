"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { tagIsDone, type TagRow, type TaskRow } from "./types";

// Tags on the list and the board. A tag is a FILTER over the status buckets
// both views are built on, plus a badge on every row and card — it never
// changes what a bucket is. (Design: docs/superpowers/specs/
// 2026-08-27-tags-design.md.)
//
// SEVERAL chips can be lit at once, because a task carries several tags. The
// default is ANY (union): ticking "auth migration" and "mobile PWA" shows both
// plans, which is what a chip bar reads like — a set of things to look at, not
// a query being narrowed. The `ALL` toggle beside them switches to the
// intersection, which is the other question worth asking ("what is in the auth
// migration AND touches mobile") and is meaningless with one chip lit, so it
// only appears once two are.

// The chip/badge tint rides a CSS custom property so one rule set serves every
// palette entry (and the neutral no-color case) — see .gchip/.gbadge.
export function tagTint(color: string | null): CSSProperties | undefined {
  return color ? ({ "--gc": color } as CSSProperties) : undefined;
}

// "4/7": members done over members still counted. Cancelled and withdrawn are
// taken OUT of the denominator rather than shown as unfinished — a tag on five
// tasks with two withdrawn is 3/3 when the three land — and the tooltip says
// how many were withdrawn so the fraction doesn't read as a lie.
export function tagProgress(t: Pick<TagRow, "counts">): { done: number; of: number; label: string; detail: string } {
  const { total, done, cancelled, running, awaiting } = t.counts;
  const of = total - cancelled;
  const parts = [`${done} done`];
  if (cancelled) parts.push(`${cancelled} cancelled or withdrawn`);
  if (running) parts.push(`${running} running`);
  if (awaiting) parts.push(`${awaiting} need${awaiting === 1 ? "s" : ""} you`);
  return { done, of, label: total === 0 ? "no tasks yet" : `${done}/${of}`, detail: total === 0 ? "No tasks yet" : parts.join(" · ") };
}

/** How several lit chips combine. "any" = union (the default), "all" = intersection. */
export type TagMatch = "any" | "all";

/** What the bar and the views share: which tags are lit, and how they combine. */
export interface TagFilter {
  ids: string[];
  match: TagMatch;
}

const EMPTY: TagFilter = { ids: [], match: "any" };

const KEY = (projectId: string) => `calandria_tag_filter_${projectId}`;
// The single-group selection this replaced, so an upgrade doesn't drop the chip
// the user had lit. Read once, then written back in the new shape.
const LEGACY_KEYS = (projectId: string) => [`calandria_group_filter_${projectId}`, `orch_group_filter_${projectId}`];
// Fired when something OTHER than the chip bar changes the filter — a badge on
// a card, a landing card, the palette — so every mounted bar follows.
const EVENT = "calandria:tag-filter";

function read(projectId: string): TagFilter {
  try {
    const raw = localStorage.getItem(KEY(projectId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TagFilter>;
      const ids = Array.isArray(parsed?.ids) ? parsed.ids.filter((id): id is string => typeof id === "string") : [];
      return { ids, match: parsed?.match === "all" ? "all" : "any" };
    }
    for (const legacy of LEGACY_KEYS(projectId)) {
      const id = localStorage.getItem(legacy);
      if (id) return { ids: [id], match: "any" };
    }
  } catch {}
  return EMPTY;
}

/** Set the filter from anywhere ([] = All). Persists, then tells every bar. */
export function selectTagFilter(projectId: string, filter: TagFilter) {
  try {
    if (filter.ids.length) localStorage.setItem(KEY(projectId), JSON.stringify(filter));
    else {
      localStorage.removeItem(KEY(projectId));
      for (const legacy of LEGACY_KEYS(projectId)) localStorage.removeItem(legacy);
    }
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId, filter } }));
}

/** Light exactly one tag — what a badge click means, from any surface. */
export function selectOneTag(projectId: string, tagId: string | null) {
  selectTagFilter(projectId, tagId ? { ids: [tagId], match: "any" } : EMPTY);
}

/**
 * Which tags the list/board is narrowed to, per project, persisted the way the
 * collapsed Done/Cancelled sections are (localStorage, not the URL — it's a
 * working preference, not a location). Remembered ids that no longer name a tag
 * in `tags` (deleted, or another project's) are dropped rather than filtering
 * everything out; when none survives, the bar reads as All.
 */
export function useTagFilter(projectId: string, tags: TagRow[]) {
  const [raw, setRaw] = useState<TagFilter>(EMPTY);
  useEffect(() => {
    setRaw(read(projectId));
    const onPick = (e: Event) => {
      const d = (e as CustomEvent<{ projectId: string; filter: TagFilter }>).detail;
      if (d.projectId === projectId) setRaw(d.filter);
    };
    window.addEventListener(EVENT, onPick);
    return () => window.removeEventListener(EVENT, onPick);
  }, [projectId]);
  const filter = useMemo<TagFilter>(() => {
    const ids = raw.ids.filter((id) => tags.some((t) => t.id === id));
    return ids.length === raw.ids.length ? raw : { ids, match: raw.match };
  }, [raw, tags]);
  const set = (next: TagFilter) => selectTagFilter(projectId, next);
  // Ticking a chip on and off, keeping the rest — the bar's own verb.
  const toggle = (id: string) =>
    set({ ids: filter.ids.includes(id) ? filter.ids.filter((x) => x !== id) : [...filter.ids, id], match: filter.match });
  return { filter, set, toggle };
}

/**
 * The filter itself: no lit chips keeps everything; `any` keeps a task carrying
 * at least one of them, `all` only a task carrying every one.
 */
export function inTags<T extends Pick<TaskRow, "tag_ids">>(tasks: T[], filter: TagFilter): T[] {
  if (!filter.ids.length) return tasks;
  return tasks.filter((t) =>
    filter.match === "all" ? filter.ids.every((id) => t.tag_ids.includes(id)) : filter.ids.some((id) => t.tag_ids.includes(id))
  );
}

/**
 * The chip bar: All · <active tags> · Done (n) · [any|all]. Renders nothing for
 * a project with no tags, so the bar costs nothing until the first one exists.
 * Finished tags fold behind the Done chip so a long-lived project's bar isn't a
 * wall of shipped features; the fold opens in place and stays open only for
 * this mount.
 */
export function TagChips({ tags, filter, onToggle, onSet }: {
  tags: TagRow[]; filter: TagFilter; onToggle: (id: string) => void; onSet: (f: TagFilter) => void;
}) {
  const [showDone, setShowDone] = useState(false);
  if (tags.length === 0) return null;
  const active = tags.filter((t) => !tagIsDone(t));
  const done = tags.filter((t) => tagIsDone(t));
  // A lit chip inside the fold stays visible even when the fold is shut, or the
  // bar would show "All" unselected with the list still narrowed.
  const shownDone = showDone ? done : done.filter((t) => filter.ids.includes(t.id));
  const chip = (t: TagRow) => {
    const p = tagProgress(t);
    const on = filter.ids.includes(t.id);
    return (
      <button key={t.id} role="tab" aria-selected={on}
        className={`gchip ${on ? "on" : ""}`} style={tagTint(t.color)}
        title={`${t.name}: ${p.detail}${t.description ? `\n${t.description}` : ""}`}
        onClick={() => onToggle(t.id)}>
        <span className="gc-dot" />
        <span className="gc-name">{t.name}</span>
        <span className="gc-frac">{p.label}</span>
        {t.counts.awaiting > 0 && <span className="gc-need" title={`${t.counts.awaiting} need${t.counts.awaiting === 1 ? "s" : ""} you`} />}
      </button>
    );
  };
  return (
    <div className="gchips" role="tablist" aria-label="Filter by tag">
      <button role="tab" aria-selected={filter.ids.length === 0} className={`gchip ${filter.ids.length === 0 ? "on" : ""}`}
        onClick={() => onSet(EMPTY)}>All</button>
      {active.map(chip)}
      {done.length > 0 && (
        <button className={`gchip fold ${showDone ? "open" : ""}`} aria-expanded={showDone}
          title={showDone ? "Hide finished tags" : "Show finished tags"} onClick={() => setShowDone((v) => !v)}>
          Done <span className="gc-frac">{done.length}</span>
        </button>
      )}
      {shownDone.map(chip)}
      {/* Only with two chips lit: with one, union and intersection are the same
          set, and a toggle that changes nothing invites the user to wonder what
          it did. */}
      {filter.ids.length > 1 && (
        <button className={`gchip match ${filter.match === "all" ? "on" : ""}`} aria-pressed={filter.match === "all"}
          title={filter.match === "all"
            ? "Showing tasks with EVERY lit tag. Click for tasks with any of them"
            : "Showing tasks with ANY lit tag. Click for only those with all of them"}
          onClick={() => onSet({ ids: filter.ids, match: filter.match === "all" ? "any" : "all" })}>
          {filter.match === "all" ? "all" : "any"}
        </button>
      )}
    </div>
  );
}

/**
 * The tinted pill a task's row, card or session header carries — one per tag.
 * With `onSelect` it's a button that lights that tag's chip alone — the way
 * into the filter from any surface showing a task — otherwise a plain label.
 */
export function TagBadge({ tag, onSelect, className }: {
  // Name and tint are all a badge needs to RENDER; the counts are only for its
  // tooltip, and the palette's rows (listAllTasksLite) carry the name without
  // them. So they're optional rather than forcing a fake `counts` on callers.
  tag: Pick<TagRow, "name" | "color"> & Partial<Pick<TagRow, "counts">>;
  onSelect?: () => void; className?: string;
}) {
  const title = tag.counts ? `Tag: ${tag.name} (${tagProgress({ counts: tag.counts }).detail})` : `Tag: ${tag.name}`;
  const cls = `gbadge ${className ?? ""}`;
  if (!onSelect) return <span className={cls} style={tagTint(tag.color)} title={title}>{tag.name}</span>;
  return (
    <button type="button" className={cls} style={tagTint(tag.color)} title={`${title}\nClick to show only this tag`}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onKeyDown={(e) => e.stopPropagation()}>
      {tag.name}
    </button>
  );
}

/**
 * Every badge a row shows, in tag order. Its own component because three
 * surfaces (list row, board card, session header) render the same list from the
 * same two inputs, and a task with five tags must not push its title off the
 * card — `max` caps what's drawn and the rest becomes a "+2" pill that still
 * names them on hover.
 */
export function TagBadges({ tagIds, tagsById, onSelect, max = 3, className }: {
  tagIds: string[];
  tagsById: Map<string, TagRow>;
  onSelect?: (id: string) => void;
  max?: number;
  className?: string;
}) {
  const tags = tagIds.map((id) => tagsById.get(id)).filter((t): t is TagRow => !!t);
  if (!tags.length) return null;
  const shown = tags.slice(0, max);
  const rest = tags.slice(max);
  return (
    <>
      {shown.map((t) => (
        <TagBadge key={t.id} tag={t} className={className} onSelect={onSelect ? () => onSelect(t.id) : undefined} />
      ))}
      {rest.length > 0 && (
        <span className={`gbadge more ${className ?? ""}`} title={rest.map((t) => t.name).join("\n")}>
          +{rest.length}
        </span>
      )}
    </>
  );
}
