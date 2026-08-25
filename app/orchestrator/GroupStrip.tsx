"use client";

import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { jsend } from "./api";
import { isAwaiting, isWithdrawn } from "./format";
import { StatusDot } from "./shared";
import { GROUP_COLORS, type TaskGroupRow, type TaskRow } from "./types";
import { groupTint } from "./GroupChips";

// The group strip: what a selected chip expands into. There is no group route
// and no group page — a group's whole detail view is this band under the chip
// bar (design: docs/superpowers/specs/2026-08-24-task-grouping-design.md).
// It shows the description, the progress, where the plan came from, the members
// in the order they have to happen, and the two verbs a group has (Edit,
// Delete). Everything else about a group IS its tasks.

/**
 * The members in dependency order — a topological sort over `depends_on`
 * restricted to the group, with ties broken by the order the caller passed
 * (which is the tray's own order; `position` never reaches the client).
 *
 * Edges to tasks OUTSIDE the group are ignored rather than treated as
 * blockers: groups and dependencies are orthogonal (a member may legitimately
 * wait on something in another feature), and ordering this list by them would
 * make "step 3 of 7" depend on tasks the list doesn't show.
 */
export function topoMembers(members: TaskRow[]): TaskRow[] {
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
 * counts them, so a group of seven with two withdrawn suggestions really is
 * finished at five — but the withdrawals are named beside the fraction rather
 * than folded into it, or `5/5` on a seven-row list reads as a lie. Withdrawn
 * and plainly cancelled are told apart here (the strip has the rows; the
 * group's derived counts only know `cancelled`).
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

export function GroupStrip({ group, members, originTask, onSelectTask, onDeleted }: {
  group: TaskGroupRow;
  /** Every task in the group, in tray order — the strip sorts them itself. */
  members: TaskRow[];
  /** The planning session that filed this group, when it's still in this project. */
  originTask?: TaskRow;
  onSelectTask: (id: string) => void;
  /** Called after the group row is gone, so the chip bar can fall back to All. */
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(group.name);
  const [desc, setDesc] = useState(group.description);
  const [color, setColor] = useState<string | null>(group.color);

  // Another tab (or the delete below) can change the group under the form.
  // Re-seed the fields whenever the row we're editing actually changes.
  useEffect(() => {
    setName(group.name);
    setDesc(group.description);
    setColor(group.color);
  }, [group.id, group.name, group.description, group.color]);

  const ordered = topoMembers(members);
  const p = memberProgress(members);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // The task_groups_changed echo refetches the project, so nothing is
      // written into local state here — the chip bar and this strip re-render
      // from the same read.
      await jsend(`/api/groups/${group.id}`, "PATCH", { name: name.trim(), description: desc, color: color ?? "" });
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
    // group is gone.
    if (!confirmDel) return setConfirmDel(true);
    setBusy(true);
    setErr(null);
    try {
      await jsend(`/api/groups/${group.id}`, "DELETE");
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setConfirmDel(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gstrip" style={groupTint(group.color)}>
      {editing ? (
        <div className="gs-edit">
          <input className="gs-name-in" value={name} aria-label="Group name" autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }} />
          <textarea className="gs-desc-in" value={desc} rows={2} aria-label="Group description"
            placeholder="What this feature is — shown here and given to every member session."
            onChange={(e) => setDesc(e.target.value)} />
          <div className="gs-colors" role="group" aria-label="Group color">
            <button type="button" className={`gs-sw none ${color === null ? "on" : ""}`} title="No tint"
              aria-pressed={color === null} onClick={() => setColor(null)} />
            {GROUP_COLORS.map((c) => (
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
            <span className="gs-name">{group.name}</span>
            <span className="gs-frac mono">{p.parts.join(" · ")}</span>
            <span className="spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)} title="Rename, describe or recolor this group">
              {Icon.edit()} Edit
            </button>
            <button className={`btn btn-sm ${confirmDel ? "btn-danger" : "btn-ghost"}`} disabled={busy} onClick={() => void del()}
              title="Delete the group — its tasks are kept and simply ungrouped">
              {confirmDel
                ? `Delete — ${members.length} task${members.length === 1 ? "" : "s"} stay${members.length === 1 ? "s" : ""}`
                : "Delete group"}
            </button>
            {confirmDel && <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(false)}>Cancel</button>}
          </div>
          {/* The bar measures work still counted: withdrawn and cancelled
              members are out of the denominator, named in the fraction above. */}
          <div className="gs-bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.of} aria-valuenow={p.done}
            aria-label={`${group.name} progress`}>
            <span style={{ width: `${p.pct}%` }} />
          </div>
          {group.description && <div className="gs-desc">{group.description}</div>}
          {originTask && (
            <button className="gs-origin" onClick={() => onSelectTask(originTask.id)}
              title="The session that planned this group — its transcript is the brief">
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
            {ordered.length === 0 && <li className="gs-none">No tasks yet — nothing has been filed under this group.</li>}
          </ol>
        </>
      )}
      {err && <div className="gs-err">{err}</div>}
    </div>
  );
}
