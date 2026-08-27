"use client";

import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { jsend } from "./api";
import { isAwaiting, isWithdrawn } from "./format";
import { StatusDot } from "./shared";
import { TAG_COLORS, type TagRow, type TaskRow } from "./types";
import { tagTint } from "./TagChips";

// The tag strip: what a lit chip expands into. There is no tag route and no tag
// page — a tag's whole detail view is this band under the chip bar (design:
// docs/superpowers/specs/2026-08-27-tags-design.md). It shows the description,
// the progress, where the plan came from, the tasks in the order they have to
// happen, and the two verbs a tag has (Edit, Delete). Everything else about a
// tag IS its tasks.
//
// Shown only when exactly ONE chip is lit. Two lit chips are a filter over two
// plans, and stacking two strips (or picking one of them to expand) would put a
// band of prose about one feature above a list showing both. The chip bar is
// the multi-tag surface; this is the single-tag one.

/**
 * The members in dependency order — a topological sort over `depends_on`
 * restricted to the group, with ties broken by `position`, the project's
 * filing sequence.
 *
 * Filing order, deliberately, and NOT the order the caller passed: the tray
 * sorts by recency, and a plan's steps must not renumber themselves every time
 * one of them runs. `position` is the one total order both sides can agree on
 * (`created_at` collides — a planning turn files its whole batch inside one
 * millisecond), and lib/tagContext.ts sorts by exactly the same thing, so
 * "step 3 of 7" in a session's context and "3" on the user's screen keep
 * naming the same task.
 *
 * Edges to tasks WITHOUT this tag are ignored rather than treated as
 * blockers: tags and dependencies are orthogonal (a member may legitimately
 * wait on something in another feature), and ordering this list by them would
 * make "step 3 of 7" depend on tasks the list doesn't show.
 */
export function topoMembers(members: TaskRow[]): TaskRow[] {
  members = [...members].sort((a, b) => a.position - b.position);
  const ids = new Set(members.map((m) => m.id));
  const deps = new Map(members.map((m) => [m.id, (m.depends_on ?? []).filter((d) => ids.has(d))]));
  const placed = new Set<string>();
  const out: TaskRow[] = [];
  while (out.length < members.length) {
    const ready = members.find((m) => !placed.has(m.id) && deps.get(m.id)!.every((d) => placed.has(d)));
    // setTaskDeps refuses cycles, so `ready` is only ever empty if the graph
    // arrived broken — take the next unplaced member rather than spinning.
    const pick = ready ?? members.find((m) => !placed.has(m.id))!;
    placed.add(pick.id);
    out.push(pick);
  }
  return out;
}

/**
 * "5 done · 2 withdrawn". Terminal members are counted the way `blocks()`
 * counts them, so a tag on seven tasks with two withdrawn suggestions really is
 * finished at five — but the withdrawals are named beside the fraction rather
 * than folded into it, or `5/5` on a seven-row list reads as a lie. Withdrawn
 * and plainly cancelled are told apart here (the strip has the rows; the
 * tag's derived counts only know `cancelled`).
 */
export function memberProgress(members: TaskRow[]): { done: number; of: number; pct: number; parts: string[] } {
  const done = members.filter((m) => m.status === "done").length;
  const withdrawn = members.filter((m) => isWithdrawn(m)).length;
  const cancelled = members.filter((m) => m.status === "cancelled").length - withdrawn;
  const of = members.length - withdrawn - cancelled;
  const parts = [`${done} done`];
  if (withdrawn) parts.push(`${withdrawn} withdrawn`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  return { done, of, pct: of > 0 ? (done / of) * 100 : 0, parts };
}

export function TagStrip({ tag, members, originTask, onSelectTask, onDeleted }: {
  tag: TagRow;
  /** Every task carrying the tag, in tray order — the strip sorts them itself. */
  members: TaskRow[];
  /** The planning session that filed this tag, when it's still in this project. */
  originTask?: TaskRow;
  onSelectTask: (id: string) => void;
  /** Called after the tag row is gone, so the chip bar can fall back to All. */
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(tag.name);
  const [desc, setDesc] = useState(tag.description);
  const [color, setColor] = useState<string | null>(tag.color);

  // Another tab (or the delete below) can change the tag under the form.
  // Re-seed the fields whenever the row we're editing actually changes.
  useEffect(() => {
    setName(tag.name);
    setDesc(tag.description);
    setColor(tag.color);
  }, [tag.id, tag.name, tag.description, tag.color]);

  const ordered = topoMembers(members);
  const p = memberProgress(members);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // The tags_changed echo refetches the project, so nothing is
      // written into local state here — the chip bar and this strip re-render
      // from the same read.
      await jsend(`/api/tags/${tag.id}`, "PATCH", { name: name.trim(), description: desc, color: color ?? "" });
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    // Two-step, like every other hard delete here: the first click arms it and
    // says how many tasks it touches, so the count is on screen before the
    // tag is gone.
    if (!confirmDel) return setConfirmDel(true);
    setBusy(true);
    setErr(null);
    try {
      await jsend(`/api/tags/${tag.id}`, "DELETE");
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setConfirmDel(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gstrip" style={tagTint(tag.color)}>
      {editing ? (
        <div className="gs-edit">
          <input className="gs-name-in" value={name} aria-label="Tag name" autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }} />
          <textarea className="gs-desc-in" value={desc} rows={2} aria-label="Tag description"
            placeholder="What this tag means — shown here and given to every session carrying it."
            onChange={(e) => setDesc(e.target.value)} />
          <div className="gs-colors" role="group" aria-label="Tag color">
            <button type="button" className={`gs-sw none ${color === null ? "on" : ""}`} title="No tint"
              aria-pressed={color === null} onClick={() => setColor(null)} />
            {TAG_COLORS.map((c) => (
              <button key={c} type="button" className={`gs-sw ${color === c ? "on" : ""}`} style={{ background: c }}
                title={c} aria-label={`Color ${c}`} aria-pressed={color === c} onClick={() => setColor(c)} />
            ))}
            <span className="spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(false); setErr(null); }}>Cancel</button>
            <button className="btn btn-accent btn-sm" disabled={!name.trim() || busy} onClick={() => void save()}>Save</button>
          </div>
        </div>
      ) : (
        <>
          <div className="gs-head">
            <span className="gs-name">{tag.name}</span>
            <span className="gs-frac mono">{p.parts.join(" · ")}</span>
            <span className="spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)} title="Rename, describe or recolor this tag">
              {Icon.edit()} Edit
            </button>
            <button className={`btn btn-sm ${confirmDel ? "btn-danger" : "btn-ghost"}`} disabled={busy} onClick={() => void del()}
              title="Delete the tag — its tasks are kept, and keep their other tags">
              {confirmDel
                ? `Delete — ${members.length} task${members.length === 1 ? "" : "s"} stay${members.length === 1 ? "s" : ""}`
                : "Delete tag"}
            </button>
            {confirmDel && <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(false)}>Cancel</button>}
          </div>
          {/* The bar measures work still counted: withdrawn and cancelled
              tasks are out of the denominator, named in the fraction above. */}
          <div className="gs-bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.of} aria-valuenow={p.done}
            aria-label={`${tag.name} progress`}>
            <span style={{ width: `${p.pct}%` }} />
          </div>
          {tag.description && <div className="gs-desc">{tag.description}</div>}
          {originTask && (
            <button className="gs-origin" onClick={() => onSelectTask(originTask.id)}
              title="The session that planned this tag — its transcript is the brief">
              {Icon.spark()} Planned in <em>{originTask.title}</em>
            </button>
          )}
          <ol className="gs-members">
            {ordered.map((t, i) => (
              <li key={t.id}>
                <button className={`gs-member ${isWithdrawn(t) ? "gone" : ""}`} onClick={() => onSelectTask(t.id)}>
                  <span className="gs-step mono">{i + 1}</span>
                  <StatusDot status={t.status} running={t.running === 1} awaiting={isAwaiting(t)} />
                  <span className="gs-mtitle">{t.title}</span>
                  {t.suggested === 1 && !isWithdrawn(t) && <span className="gs-tag">suggested</span>}
                  {isWithdrawn(t) && <span className="gs-tag">withdrawn</span>}
                </button>
              </li>
            ))}
            {ordered.length === 0 && <li className="gs-none">No tasks yet — nothing carries this tag.</li>}
          </ol>
        </>
      )}
      {err && <div className="gs-err">{err}</div>}
    </div>
  );
}
