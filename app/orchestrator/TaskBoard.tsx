"use client";

import { useState, type ReactNode } from "react";
import type { Status } from "@/lib/types";
import { Icon } from "../icons";
import { isAwaiting, isWithdrawn, relTime, withdrawnLast } from "./format";
import { isSnoozed, wasSnoozed, wakeLabel } from "./snooze";
import { SnoozeButton } from "./SnoozeMenu";
import { SEARCH_MIN, SNOOZE_LABEL, type ProjectRow, type TaskRow, type AgentsBundle, type TaskView } from "./types";
import { agentLabel } from "./agents";
import { StatusDot, PriPill, SearchBar, AgentBadge } from "./shared";
import { DiffFooter } from "./DiffFooter";

// The kanban alternative to the grouped task list (layout from the Claude
// Design "Calandria — Board View" study, rendered with the app's own tokens).
// Columns are live views over the same task rows the list renders — cards
// update as sessions stream — and dragging a card re-statuses it and/or
// persists a new manual order.
type ColKey = "suggested" | "not_started" | "in_progress" | "awaiting" | "snoozed" | "on_hold" | "done" | "cancelled";

const COL_ORDER: ColKey[] = ["suggested", "not_started", "in_progress", "awaiting", "snoozed", "on_hold", "done", "cancelled"];

// The fields a drop can rewrite. `snoozed_until` is here because dragging a
// card OUT of Snoozed has to wake it in the same write — see statusPatch.
export type TaskMovePatch = Partial<Pick<TaskRow, "status" | "suggested" | "snoozed_until">>;
// What lands on a task dropped into each column. `null` = the column rejects
// the drop (Suggested, Needs-input and Snoozed hold derived states you can't
// drag INTO — they still allow reordering their own cards). `{}` = position-only.
type Patch = TaskMovePatch | null;

const COLS: Record<ColKey, {
  label: string;
  accent?: boolean;   // Needs-input styling (blue header/rule)
  derived?: boolean;  // holds a derived state — badged, rejects foreign drops
  mini?: boolean;     // terminal column: compact rows, newest first, drops append
  always: boolean;    // On hold / Cancelled hide when empty (drop bays mid-drag)
  member: (t: TaskRow) => boolean;
  patchFor: (t: TaskRow) => Patch;
  noDropWhy?: string; // reason line for the "can't drop here" callout
}> = {
  suggested: {
    label: "Suggested", derived: true, always: true,
    member: (t) => !!t.suggested,
    patchFor: (t) => (t.suggested ? {} : null),
    noDropWhy: "Suggested is where agents propose work — accept a card out instead.",
  },
  not_started: {
    label: "Not started", always: true,
    member: (t) => inStatusColumn(t) && t.status === "not_started",
    patchFor: (t) => statusPatch(t, "not_started"),
  },
  in_progress: {
    label: "In progress", always: true,
    member: (t) => inStatusColumn(t) && t.status === "in_progress" && !isAwaiting(t),
    // Dropping an awaiting card here is "I've dealt with it": the explicit
    // status write clears the awaiting flag server-side, so patch even when
    // the status string wouldn't change.
    patchFor: (t) => (t.suggested ? { suggested: 0, status: "in_progress", ...wake(t) } : t.status !== "in_progress" || isAwaiting(t) || isSnoozed(t) ? { status: "in_progress", ...wake(t) } : {}),
  },
  awaiting: {
    label: "Needs input", accent: true, derived: true, always: true,
    member: (t) => inStatusColumn(t) && isAwaiting(t),
    patchFor: (t) => (inStatusColumn(t) && isAwaiting(t) ? {} : null),
    noDropWhy: "Needs input is derived from session state — the agent sets it when it asks you a question.",
  },
  snoozed: {
    // Parked work. Derived like Needs-input, but for a different reason: there
    // is no wake-up time in a drag gesture, so a drop here couldn't say WHEN —
    // the moon button on the card is the only place that question gets asked.
    // Dragging OUT is allowed and wakes the card (see statusPatch).
    //
    // Membership is spelled out rather than reusing inStatusColumn(), whose
    // whole job is to keep parked cards OUT — `inStatusColumn(t) && isSnoozed(t)`
    // reduces to `!isSnoozed && isSnoozed`, leaving this column permanently
    // empty. (It did, until e2e/12-snooze caught it.)
    label: SNOOZE_LABEL, derived: true, always: false,
    member: (t) => !t.suggested && isSnoozed(t),
    patchFor: (t) => (!t.suggested && isSnoozed(t) ? {} : null),
    noDropWhy: "A snooze needs a wake-up time — use the moon button on the card to pick one.",
  },
  on_hold: {
    label: "On hold", always: false,
    member: (t) => inStatusColumn(t) && t.status === "on_hold",
    patchFor: (t) => statusPatch(t, "on_hold"),
  },
  done: {
    label: "Done", mini: true, always: true,
    member: (t) => inStatusColumn(t) && t.status === "done",
    patchFor: (t) => statusPatch(t, "done"),
  },
  cancelled: {
    label: "Cancelled", mini: true, always: false,
    member: (t) => inStatusColumn(t) && t.status === "cancelled",
    patchFor: (t) => statusPatch(t, "cancelled"),
  },
};

// Does this card belong in one of the plain status columns? A real (not
// suggested) task that isn't parked. Snoozed is a category over the top of the
// status ones — a snoozed task keeps the status it will return to — so every
// status column has to exclude it or the card would be drawn in two places.
// (Declared as a function, like statusPatch below, because COLS is evaluated
// above it and only calls these later.)
function inStatusColumn(t: TaskRow): boolean {
  return !t.suggested && !isSnoozed(t);
}

// Dragging a card out of Snoozed is an explicit "I'll deal with this now", so
// the drop wakes it in the same write — otherwise the card would bounce
// straight back into the Snoozed column. A deadline of now (rather than 0) is
// what leaves the "was snoozed" chip behind on the card it lands as.
function wake(t: TaskRow): { snoozed_until?: number } {
  return isSnoozed(t) ? { snoozed_until: Date.now() } : {};
}

// Dropping into a plain status column: accept a suggestion into the real list,
// change status when it differs, wake it if it was parked, or (same column,
// same state) just reorder.
function statusPatch(t: TaskRow, status: Status): Patch {
  if (t.suggested) return { suggested: 0, status, ...wake(t) };
  return t.status !== status || isSnoozed(t) ? { status, ...wake(t) } : {};
}

// Terminal columns show at most this many rows before the "Show all" veil.
const MINI_CAP = 7;

// Day bucket for the Done column's group dividers (newest first).
function dayBucket(ts: number): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = day(new Date());
  if (ts >= today) return "Today";
  if (ts >= today - 86_400_000) return "Yesterday";
  return "Earlier";
}

function BoardCard({ task, agents, selected, running, blockedBy, mini, dragging, canDrag, onSelect, onDragStart, onDragOverCard, onDropOnCard, onDragEnd, onSnooze, onUnsnooze, actions, sparkline }: {
  task: TaskRow; agents: AgentsBundle; selected: boolean; running: boolean; blockedBy?: string[];
  mini?: boolean; dragging: boolean; canDrag: boolean;
  onSelect: () => void; onDragStart: () => void; onDragOverCard: (e: React.DragEvent) => void;
  onDropOnCard: (e: React.DragEvent) => void; onDragEnd: () => void;
  onSnooze: (until: number) => void; onUnsnooze: () => void; actions?: ReactNode; sparkline?: number[];
}) {
  const snoozed = isSnoozed(task);
  // Snoozed beats awaiting, the way it does in the list: a parked task must
  // stop reading as "waiting on you" until it comes back.
  const awaiting = !snoozed && isAwaiting(task);
  const blocked = !!blockedBy?.length && !task.started;
  const sessionCount = task.started ? task.generation : Math.max(0, task.generation - 1);
  // A suggestion the filing agent retracted. It reads "withdrawn", not
  // "cancelled": nothing was ever started, so nothing was called off.
  const withdrawn = isWithdrawn(task);
  // Held open for run_in_background work — live, but the model isn't talking.
  const inBackground = !snoozed && !awaiting && running && !!task.background_pending;
  const activity = snoozed ? `wakes ${wakeLabel(task.snoozed_until)}`
    : awaiting ? `waiting on you · ${relTime(task.updated_at)}`
    : inBackground ? "live · working in background"
    : running ? "live · working"
    : withdrawn ? `withdrawn · ${relTime(task.updated_at)}`
    : task.status === "done" ? `done · ${relTime(task.updated_at)}`
    : task.status === "cancelled" ? `cancelled · ${relTime(task.updated_at)}`
    : task.status === "on_hold" ? `held · ${relTime(task.updated_at)}`
    : task.started ? relTime(task.updated_at) : "not started";
  return (
    <article
      role="button" tabIndex={0}
      className={`bcard ${mini ? "mini" : ""} ${selected ? "sel" : ""} ${awaiting ? "needs" : ""} ${running ? "working" : ""} ${dragging ? "dragging" : ""} ${withdrawn ? "withdrawn" : ""} ${snoozed ? "snoozed" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      draggable={canDrag}
      onDragStart={(e) => { onDragStart(); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={onDragOverCard}
      onDrop={onDropOnCard}
      onDragEnd={onDragEnd}
      title={canDrag ? "Drag to move / reorder" : undefined}
    >
      <div className="bc-top">
        <StatusDot status={task.status} running={running} awaiting={awaiting} background={inBackground} />
        <h3 className="bc-title">{task.title}</h3>
        {!mini && <PriPill p={task.priority} />}
      </div>
      <div className="bc-meta">
        <AgentBadge label={agentLabel(agents, task.agent)} multi={!mini && agents.agents.length > 1} />
        <span className={`bc-act ${awaiting ? "need" : running ? "on" : ""}`}>{activity}</span>
      </div>
      {running && <div className="bc-bar"><i /></div>}
      {/* Why this card is back in a column you didn't move it to. */}
      {!snoozed && !mini && wasSnoozed(task) && (
        <div className="bc-chip snz" title={`Snoozed until ${new Date(task.snoozed_until).toLocaleString()}`}>
          {Icon.moon()} Was snoozed
        </div>
      )}
      {/* The reason IS the card's content once it's withdrawn — a struck-through
          title with no explanation gives the user nothing to judge. */}
      {withdrawn && task.withdrawn_reason && (
        <div className="bc-withdrawn" title={task.withdrawn_reason}>{task.withdrawn_reason}</div>
      )}
      {actions}
      {/* Corner affordance: snoozing fades in on hover so it doesn't compete
          with the card's content, waking stays put — a parked card exists to
          offer exactly that. Absent on the compact terminal rows, where there
          is nothing left to defer. */}
      {!mini && !task.suggested && (
        <div className="bc-snz">
          {snoozed ? (
            <button className="snz-wake" title={`Wakes ${wakeLabel(task.snoozed_until)} — click to wake it now`}
              onClick={(e) => { e.stopPropagation(); onUnsnooze(); }}>{Icon.sun()}</button>
          ) : (
            <SnoozeButton className="snz-set" onSnooze={onSnooze} />
          )}
        </div>
      )}
      {!mini && <DiffFooter task={task} points={sparkline} />}
      {(blocked || sessionCount > 0) && !mini && (
        <div className="bc-foot">
          {blocked && (task.auto_start ? (
            <span className="bc-chip autostart" title={`Starts automatically once done: ${blockedBy!.join(", ")}`}>
              {Icon.bolt()} Auto-starts after {blockedBy!.length === 1 ? "1 task" : `${blockedBy!.length} tasks`}
            </span>
          ) : (
            <span className="bc-chip block" title={`Blocked until done: ${blockedBy!.join(", ")}`}>
              {Icon.lock()} Blocked by {blockedBy!.length === 1 ? "1 task" : `${blockedBy!.length} tasks`}
            </span>
          ))}
          <span className="sp" />
          {sessionCount > 0 && <span className="bc-sess" title={`${sessionCount} session${sessionCount !== 1 ? "s" : ""}`}>{Icon.clock()} {sessionCount}</span>}
        </div>
      )}
    </article>
  );
}

export function TaskBoard({ tasks, suggested, agents, selTaskId, running, blockedBy, sparklines, canDrag, onSelect, onEditTask, onMove, onStartSuggestion, onAcceptSuggestion, onDismissSuggestion, onSnooze, onUnsnooze }: {
  tasks: TaskRow[]; suggested: TaskRow[]; agents: AgentsBundle; selTaskId: string | null;
  running: Set<string>; blockedBy: Map<string, string[]>; sparklines: Record<string, number[]>;
  // Dragging is disabled while a search filter is active: hidden cards would be
  // silently dropped from the persisted order.
  canDrag: boolean;
  onSelect: (id: string) => void; onEditTask: (id: string) => void;
  onMove: (id: string, patch: TaskMovePatch, orderedIds: string[]) => void;
  onStartSuggestion: (id: string) => void; onAcceptSuggestion: (id: string) => void; onDismissSuggestion: (id: string) => void;
  onSnooze: (id: string, until: number) => void; onUnsnooze: (id: string) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ col: ColKey; index: number } | null>(null);
  // Terminal columns past MINI_CAP rows collapse under a veil until expanded.
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const all = [...suggested, ...tasks];
  const dragTask = dragId ? all.find((x) => x.id === dragId) : undefined;
  // Position-order membership per column — the source of truth for drag math.
  // Suggested is the one column with a second sort on top: withdrawn cards sink
  // below live ones. Applied HERE rather than at render time on purpose — drop
  // indices are computed against these lists, so a display-only sort would make
  // a reorder land somewhere other than where it was dropped.
  const cols = new Map<ColKey, TaskRow[]>(
    COL_ORDER.map((k) => [k, k === "suggested" ? all.filter(COLS[k].member).sort(withdrawnLast) : all.filter(COLS[k].member)])
  );
  const reset = () => { setDragId(null); setOver(null); };

  const drop = (colKey: ColKey, index: number) => {
    const t = dragId ? all.find((x) => x.id === dragId) : undefined;
    reset();
    if (!t) return;
    const patch = COLS[colKey].patchFor(t);
    if (patch === null) return; // column rejects this card
    // Rebuild every column's id list with the card removed, insert it at the
    // drop index (computed against the pre-removal list, so dragging downward
    // lands after the hovered card — same feel as the projects sidebar), then
    // flatten in column order into the project's new manual order.
    const lists = new Map<ColKey, string[]>(
      COL_ORDER.map((k) => [k, cols.get(k)!.map((x) => x.id).filter((id) => id !== t.id)])
    );
    const destination = lists.get(colKey)!;
    destination.splice(Math.min(index, destination.length), 0, t.id);
    const orderedIds = COL_ORDER.flatMap((k) => lists.get(k)!);
    onMove(t.id, patch, orderedIds);
  };

  // On hold / Cancelled aren't part of the core flow: at rest they only appear
  // when something is in them — but while a drag they'd accept is live, they
  // materialise as empty drop bays so every status stays reachable without
  // permanent column bloat. Bays are APPENDED after the resting columns:
  // splicing them into their canonical slot would shift the columns to their
  // right mid-drag, moving the drop target out from under the cursor.
  const resting = COL_ORDER.filter((k) => COLS[k].always || cols.get(k)!.length > 0);
  const bays = COL_ORDER.filter(
    (k) => !resting.includes(k) && !!dragTask && COLS[k].patchFor(dragTask) !== null
  );

  return (
    <div className="board">
      {[...resting, ...bays].map((key) => {
        const def = COLS[key];
        const colTasks = cols.get(key)!;
        const accepts = !!dragTask && def.patchFor(dragTask) !== null;
        const reject = !!dragTask && !accepts;
        const isOver = over?.col === key;
        // Terminal columns render newest-first in compact rows; ordering within
        // them is meaningless, so drops append and no insertion line is shown.
        const display = def.mini ? [...colTasks].sort((a, b) => b.updated_at - a.updated_at) : colTasks;
        const expanded = !!showAll[key];
        const visible = def.mini && !expanded ? display.slice(0, MINI_CAP) : display;
        const hidden = display.length - visible.length;
        let lastDay: string | null = null;
        return (
          <div
            key={key}
            className={`bcol k-${key} ${accepts && isOver ? "drag-over" : ""} ${reject ? "reject" : ""}`}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = accepts ? "move" : "none"; if (dragId) setOver({ col: key, index: colTasks.length }); }}
            onDragLeave={(e) => { if (isOver && !e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
            onDrop={(e) => { e.preventDefault(); drop(key, colTasks.length); }}
          >
            <div className="bcol-h">
              <span className={`cn ${def.accent ? "needs-you" : ""}`}><span className="bcol-dot" />{key === "suggested" && Icon.spark()}{def.label}</span>
              <span className={`ct ${def.accent ? "needs-you" : ""}`}>{colTasks.length}</span>
              <span className="sp" />
              {def.derived && <span className="derived" title="Reflects agent/session state — drag cards out, not in">derived</span>}
            </div>
            <div className="bcol-rule" />
            {reject && isOver && (
              <div className="b-nodrop">
                <span className="x">{Icon.x()}</span>
                Can’t drop here
                {def.noDropWhy && <small>{def.noDropWhy}</small>}
              </div>
            )}
            <div className="bcol-body">
              {visible.map((t, i) => {
                const day = def.mini && key === "done" ? dayBucket(t.updated_at) : null;
                const divider = day !== null && day !== lastDay ? <div className="b-day" key={`day-${day}`}>{day}<i /></div> : null;
                lastDay = day;
                return (
                  <div className="b-slot" key={t.id}>
                    {divider}
                    {accepts && isOver && !def.mini && over!.index === i && <div className="b-dropline" />}
                    <BoardCard
                      task={t}
                      agents={agents}
                      selected={t.id === selTaskId}
                      running={running.has(t.id)}
                      blockedBy={blockedBy.get(t.id)}
                      mini={def.mini}
                      dragging={dragId === t.id}
                      canDrag={canDrag}
                      onSelect={() => (t.suggested ? onEditTask(t.id) : onSelect(t.id))}
                      onDragStart={() => setDragId(t.id)}
                      onDragOverCard={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = accepts ? "move" : "none"; if (dragId) setOver({ col: key, index: def.mini ? colTasks.length : i }); }}
                      onDropOnCard={(e) => { e.preventDefault(); e.stopPropagation(); drop(key, def.mini ? colTasks.length : i); }}
                      onDragEnd={reset}
                      onSnooze={(until) => onSnooze(t.id, until)}
                      onUnsnooze={() => onUnsnooze(t.id)}
                      sparkline={sparklines[t.id]}
                      actions={t.suggested ? (
                        <div className="bsug-acts" onClick={(e) => e.stopPropagation()}>
                          <button className="go" onClick={() => onStartSuggestion(t.id)}>{Icon.play()} Start</button>
                          {/* Same button either way — accepting a withdrawn
                              suggestion IS reviving it (the server clears the
                              cancel and the reason together) — but the label has
                              to say which of the two you're doing. */}
                          <button onClick={() => onAcceptSuggestion(t.id)} title={isWithdrawn(t) ? "Disagree — restore it to the list" : "Add to list to start later"}>
                            {Icon.plus()} {isWithdrawn(t) ? "Restore" : "Add"}
                          </button>
                          <button className="no" onClick={() => onDismissSuggestion(t.id)} title="Dismiss">{Icon.x()}</button>
                        </div>
                      ) : undefined}
                    />
                  </div>
                );
              })}
              {accepts && isOver && !def.mini && over!.index >= visible.length && visible.length > 0 && <div className="b-dropline" />}
              {hidden > 0 && (
                <button className="b-showall" onClick={() => setShowAll((s) => ({ ...s, [key]: true }))}>Show all {display.length} →</button>
              )}
              {def.mini && expanded && display.length > MINI_CAP && (
                <button className="b-showall" onClick={() => setShowAll((s) => ({ ...s, [key]: false }))}>Show less</button>
              )}
              {visible.length === 0 && (
                accepts ? <div className="b-emptydrop">Drop here</div> : <div className="bcol-empty">Empty</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Full-workspace board shell (desktop): owns everything right of the projects
// sidebar — header with the List/Board toggle, the board, and (via `children`)
// the slide-over session panel + drawers the composition root mounts on top.
export function BoardWorkspace({ project, agents, tasks, suggested, selTaskId, running, blockedBy, sparklines, loading, onSetView, onMoveTask, onSelectTask, onNewTask, onEditContext, onShowSessions, onEditTask, onStartSuggestion, onAcceptSuggestion, onDismissSuggestion, onSnoozeTask, onUnsnoozeTask, children }: {
  project: ProjectRow; agents: AgentsBundle; tasks: TaskRow[]; suggested: TaskRow[]; selTaskId: string | null;
  running: Set<string>; blockedBy: Map<string, string[]>; sparklines: Record<string, number[]>; loading?: boolean;
  onSetView: (v: TaskView) => void;
  onMoveTask: (id: string, patch: TaskMovePatch, orderedIds: string[]) => void;
  onSelectTask: (id: string) => void; onNewTask: () => void; onEditContext: () => void; onShowSessions: () => void;
  onEditTask: (id: string) => void;
  onStartSuggestion: (id: string) => void; onAcceptSuggestion: (id: string) => void; onDismissSuggestion: (id: string) => void;
  onSnoozeTask: (id: string, until: number) => void; onUnsnoozeTask: (id: string) => void;
  children?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const match = (t: TaskRow) => !q || t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q);
  const shown = tasks.filter(match);
  const shownSuggested = suggested.filter(match);
  const total = tasks.length;
  return (
    <div className="col board-ws">
      <div className="bws-h">
        <span className="bws-pic" style={{ background: project.color }}>{project.name[0]}</span>
        <h1 className="bws-name">{project.name}</h1>
        <span className="bws-count">{total} task{total !== 1 ? "s" : ""}</span>
        <span className="spacer" />
        {total + suggested.length >= SEARCH_MIN && (
          <div className="bws-search"><SearchBar value={query} onChange={setQuery} placeholder="Search tasks…" /></div>
        )}
        <button className="btn btn-line btn-sm" onClick={onShowSessions} title="Agent sessions run under this project">{Icon.clock()} Sessions</button>
        <button className="btn btn-line btn-sm" onClick={onEditContext} title="Edit project context">{Icon.edit()} Context</button>
        <div className="bseg" role="tablist" aria-label="Task layout">
          <button role="tab" aria-selected={false} onClick={() => onSetView("list")}>{Icon.list()} List</button>
          <button className="on" role="tab" aria-selected>{Icon.board()} Board</button>
        </div>
        <button className="btn btn-accent btn-sm" onClick={onNewTask}>{Icon.plus()} Task</button>
      </div>
      {q && shown.length === 0 && shownSuggested.length === 0 && <div className="search-empty">No tasks match “{query.trim()}”.</div>}
      {loading ? (
        <div className="board board-loading">
          {["Suggested", "Not started", "In progress"].map((label) => (
            <div className="bcol" key={label}>
              <div className="bcol-h"><span className="cn">{label}</span></div>
              <div className="bcol-rule" />
              <div className="bcol-body"><div className="bcard skel-card"><div className="skel" style={{ width: "80%" }} /><div className="skel" style={{ width: "45%", marginTop: 8 }} /></div></div>
            </div>
          ))}
        </div>
      ) : (
        <TaskBoard
          tasks={shown} suggested={shownSuggested} agents={agents} selTaskId={selTaskId}
          running={running} blockedBy={blockedBy} sparklines={sparklines} canDrag={!q}
          onSelect={onSelectTask} onEditTask={onEditTask} onMove={onMoveTask}
          onStartSuggestion={onStartSuggestion} onAcceptSuggestion={onAcceptSuggestion} onDismissSuggestion={onDismissSuggestion}
          onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask}
        />
      )}
      {children}
    </div>
  );
}
