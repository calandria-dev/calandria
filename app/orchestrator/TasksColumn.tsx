"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { Logo } from "../Logo";
import { isAwaiting, isWithdrawn, relTime, withdrawnLast } from "./format";
import { isSnoozed, wasSnoozed, wakeLabel } from "./snooze";
import { SnoozeButton } from "./SnoozeMenu";
import { SLABEL, AWAIT_LABEL, SNOOZE_LABEL, SEARCH_MIN, type ProjectRow, type TaskRow, type AgentsBundle, type TaskView } from "./types";
import { agentLabel } from "./agents";
import { StatusDot, PriPill, SearchBar, AgentBadge } from "./shared";
import { TaskCardSkeleton } from "./Layout";
import { TaskBoard, type TaskMovePatch } from "./TaskBoard";
import { BaseBranchBanner } from "./BaseBranchBanner";
import { DiffFooter } from "./DiffFooter";

// The multi-select checkbox that sits in every row's left gutter. Rendered
// outside the card (a checkbox inside a <button> is invalid, and the card IS a
// button) and faded until the row is hovered or anything is picked, so the
// affordance is there without turning the list into a form.
//
// Wired through onClick rather than onChange because the SHIFT key is the whole
// range gesture and only a mouse event carries it; onChange keeps React from
// warning about a controlled input with no handler.
function PickBox({ picked, pickable, onPick }: { picked: boolean; pickable: boolean; onPick: (range: boolean) => void }) {
  return (
    <label className="pickbox" onClick={(e) => e.stopPropagation()}
      title={pickable ? "Select — shift-click to extend the range" : "A task mid-turn can't be re-filed — nothing may move a worktree an agent is writing into"}>
      <input type="checkbox" checked={picked} disabled={!pickable} onChange={() => {}}
        onClick={(e) => { e.stopPropagation(); onPick(e.shiftKey); }} />
    </label>
  );
}

function TaskCard({ task, agents, selected, running, blockedBy, onSelect, picked, onPick, onSnooze, onUnsnooze, sparkline }: { task: TaskRow; agents: AgentsBundle; selected: boolean; running: boolean; blockedBy?: string[]; onSelect: () => void; picked: boolean; onPick: (id: string, range: boolean) => void; onSnooze: (id: string, until: number) => void; onUnsnooze: (id: string) => void; sparkline?: number[] }) {
  const sessionCount = task.started ? task.generation : Math.max(0, task.generation - 1);
  const snoozed = isSnoozed(task);
  // Snoozed beats awaiting: the whole point of parking a task that's asking you
  // a question is that it stops reading as "waiting on you" until it's back.
  const awaiting = !snoozed && isAwaiting(task);
  const blocked = !!blockedBy?.length && !task.started;
  // Awaiting wins over running: a turn parked on a question is live but really
  // waiting on you, so it should read "waiting", not "working".
  const activity = snoozed ? `snoozed · wakes ${wakeLabel(task.snoozed_until)}`
    : awaiting ? `waiting on you · ${relTime(task.updated_at)}`
    : running ? "live · working"
    : task.status === "done" ? `done · ${relTime(task.updated_at)}`
    : task.status === "cancelled" ? `cancelled · ${relTime(task.updated_at)}`
    : task.started ? relTime(task.updated_at) : "not started";
  return (
    <div className={`task-row ${picked ? "picked" : ""} ${snoozed ? "snoozed" : ""}`}>
      <PickBox picked={picked} pickable={canPick(task)} onPick={(range) => onPick(task.id, range)} />
      <button className={`task ${selected ? "sel" : ""} ${awaiting ? "awaiting" : ""}`} onClick={onSelect}>
      <div className="task-top">
        <StatusDot status={task.status} running={running} awaiting={awaiting} />
        <span className="ttitle">{task.title}</span>
        {/* Snoozed reports the category it came from, not "Snoozed": the group
            header already says that, and where it goes BACK to is the fact the
            row can't otherwise show. */}
        <span className={`slabel ${awaiting ? "await" : ""}`}>{awaiting ? AWAIT_LABEL : SLABEL[task.status]}</span>
        <AgentBadge label={agentLabel(agents, task.agent)} multi={agents.agents.length > 1} />
        <PriPill p={task.priority} />
      </div>
      {/* Why this card is back where you didn't leave it. An unread marker, not
          history — opening the task clears it (useOrchestrator). */}
      {!snoozed && wasSnoozed(task) && (
        <div className="snz-chip was" title={`Snoozed until ${new Date(task.snoozed_until).toLocaleString()}`}>
          {Icon.moon()} Was snoozed
        </div>
      )}
      {blocked && (task.auto_start ? (
        // Queued to auto-start ≠ plain blocked: this one launches itself the
        // moment its last blocker is marked done.
        <div className="blocked-chip auto" title={`Starts automatically once done: ${blockedBy!.join(", ")}`}>
          {Icon.bolt()} Auto-starts after {blockedBy!.length === 1 ? blockedBy![0] : `${blockedBy!.length} tasks`}
        </div>
      ) : (
        <div className="blocked-chip" title={`Blocked until done: ${blockedBy!.join(", ")}`}>
          {Icon.lock()} Blocked by {blockedBy!.length === 1 ? blockedBy![0] : `${blockedBy!.length} tasks`}
        </div>
      ))}
      {task.description && <div className="tdesc">{task.description}</div>}
      <DiffFooter task={task} points={sparkline} />
      <div className="task-foot">
        <span className="activity">{awaiting ? <span style={{ color: "var(--blue)" }}>●</span> : running ? <span style={{ color: "var(--amber)" }}>●</span> : null}{activity}</span>
        <span className="spacer" />
        {sessionCount > 0 && <span className="activity">{sessionCount} session{sessionCount !== 1 ? "s" : ""}</span>}
      </div>
      </button>
      {/* Right gutter, mirroring the pickbox on the left — and outside the card
          for the same reason it is: the card IS a button, and a button inside a
          button is invalid. Snoozing fades in on hover like the checkbox does;
          waking stays visible, because "unsnooze it from here" is the one
          action a parked row exists to offer. */}
      <div className="task-snz">
        {snoozed ? (
          <button className="snz-wake" title={`Wakes ${wakeLabel(task.snoozed_until)} — click to wake it now`}
            onClick={(e) => { e.stopPropagation(); onUnsnooze(task.id); }}>
            {Icon.sun()}
          </button>
        ) : (
          <SnoozeButton className="snz-set" onSnooze={(until) => onSnooze(task.id, until)} />
        )}
      </div>
    </div>
  );
}

// Whether a task can be picked for a bulk move, as far as the client can tell.
// The server decides for real (it also refuses one whose turn is merely in
// flight, and reports that as a skip) — this only keeps the obvious cases from
// being selectable at all.
//
// A STARTED task IS pickable: it moves by discarding the worktree it cut from
// this project's repo, and the move modal asks for that per row, with what that
// particular checkout holds beside the box. Only a live turn is unpickable —
// no answer moves a task an agent is writing into.
const canPick = (t: TaskRow) => t.running === 0;

function TaskGroup({ label, tasks, agents, selTaskId, running, blockedBy, onSelect, picked, onPick, onSnooze, onUnsnooze, sparklines, accent, collapsible, collapsed, onToggle }: { label: string; tasks: TaskRow[]; agents: AgentsBundle; selTaskId: string | null; running: Set<string>; blockedBy: Map<string, string[]>; onSelect: (id: string) => void; picked: Set<string>; onPick: (id: string, range: boolean) => void; onSnooze: (id: string, until: number) => void; onUnsnooze: (id: string) => void; sparklines: Record<string, number[]>; accent?: boolean; collapsible?: boolean; collapsed?: boolean; onToggle?: () => void }) {
  if (tasks.length === 0) return null;
  const cards = tasks.map((t) => (
    <TaskCard key={t.id} task={t} agents={agents} selected={t.id === selTaskId} running={running.has(t.id)}
      blockedBy={blockedBy.get(t.id)} onSelect={() => onSelect(t.id)} picked={picked.has(t.id)} onPick={onPick}
      onSnooze={onSnooze} onUnsnooze={onUnsnooze} sparkline={sparklines[t.id]} />
  ));
  if (collapsible) {
    return (
      <>
        <button className={`task-group-h tgh-btn ${collapsed ? "is-collapsed" : ""}`} onClick={onToggle} title={`${collapsed ? "Show" : "Hide"} ${label.toLowerCase()} tasks`}>
          {Icon.chevDown({ className: "tgh-chev" })}
          {label} <span className="gcount">{tasks.length}</span><span className="gline" />
        </button>
        {!collapsed && cards}
      </>
    );
  }
  return (
    <>
      <div className={`task-group-h ${accent ? "needs-you" : ""}`}>{label} <span className="gcount">{tasks.length}</span><span className="gline" /></div>
      {cards}
    </>
  );
}

/**
 * The multi-select: which task ids are picked for a bulk action, and the
 * shift-click range gesture over `order` — the ids as they are actually
 * rendered, top to bottom.
 *
 * Deliberately NOT persisted, and dropped whenever the project or the view
 * changes: a selection is a gesture in progress, and one surviving a navigation
 * would act on rows that are no longer on screen — worse, the board doesn't
 * render the action bar, so a selection carried into it would be invisible.
 * Pruned against `order` on every render for the same reason — a picked task
 * that got moved, deleted, filtered out by the search box, or launched into a
 * turn under the selection must leave it.
 */
function usePicked(scope: string, order: string[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Where the last plain click landed: a shift-click selects from there to here,
  // the way every list with checkboxes has always behaved.
  const anchor = useRef<string | null>(null);
  useEffect(() => { setPicked(new Set()); anchor.current = null; }, [scope]);

  const live = order.filter((id) => picked.has(id));
  useEffect(() => {
    if (live.length !== picked.size) setPicked(new Set(live));
    // Compared by value: `live` is a fresh array every render.
  }, [live.join(","), picked.size]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (id: string, range: boolean) => {
    // Resolve the range BEFORE touching the ref: a setState updater runs at
    // render time, so a ref read inside it would see the value written on the
    // line below rather than the anchor this click is extending from.
    const from = anchor.current ? order.indexOf(anchor.current) : -1;
    const to = order.indexOf(id);
    // Always re-anchor, including on a shift-click. A shift-click with no anchor
    // yet (the first gesture, or after the anchor was pruned) can only toggle
    // itself — if it didn't leave an anchor behind, every later range gesture
    // would degrade to the same single toggle and the list would be stuck going
    // one task at a time. Re-anchoring costs nothing here because the range is
    // additive: extending from the last click never un-picks anything.
    anchor.current = id;
    setPicked((prev) => {
      const next = new Set(prev);
      if (range && from >= 0 && to >= 0) {
        // Extending: everything between the anchor and here joins the selection.
        // Additive, never subtractive — a range gesture that silently deselected
        // rows above it would be a nasty surprise on a long list.
        const [lo, hi] = from < to ? [from, to] : [to, from];
        for (const between of order.slice(lo, hi + 1)) next.add(between);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return { picked, pick, clearPicked: () => { setPicked(new Set()); anchor.current = null; } };
}

/**
 * Which suggestion rows have their brief expanded. A suggestion's description
 * is the whole case FOR it, and the tray clamps it to one line — so every row
 * gets a disclosure triangle.
 *
 * Deliberately NOT persisted, and dropped when the project changes: expanding
 * is a reading gesture, not a preference. A remembered set would also re-open
 * rows whose text the user has already read, which is the opposite of what the
 * clamp is for.
 */
function useExpanded(scope: string) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => { setExpanded(new Set()); }, [scope]);
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  return { expanded, toggleExpanded: toggle };
}

// Per-group collapsed flag, persisted in localStorage under `key`.
function useCollapsed(key: string, def: boolean) {
  const [collapsed, setCollapsed] = useState(def);
  useEffect(() => {
    try {
      const v = localStorage.getItem(key);
      setCollapsed(v === null ? def : v === "1");
    } catch {}
  }, [key, def]);
  const toggle = () => setCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem(key, next ? "1" : "0"); } catch {}
    return next;
  });
  return [collapsed, toggle] as const;
}

export function TasksColumn({ project, agents, tasks, suggested, selTaskId, running, blockedBy, sparklines, width, loading, view, onSetView, onMoveTask, onSelectTask, onNewTask, onEditContext, onShowSessions, onShowRecap, onEditTask, onStartSuggestion, onAcceptSuggestion, onDismissSuggestion, onSnoozeTask, onUnsnoozeTask, onBulkMove, onCollapse, mobile, onBack, baseBranchTick }: {
  project: ProjectRow; agents: AgentsBundle; tasks: TaskRow[]; suggested: TaskRow[]; selTaskId: string | null; running: Set<string>; blockedBy: Map<string, string[]>; sparklines: Record<string, number[]>; width: number; loading?: boolean;
  view: TaskView; onSetView: (v: TaskView) => void;
  onMoveTask: (id: string, patch: TaskMovePatch, orderedIds: string[]) => void;
  onSnoozeTask: (id: string, until: number) => void; onUnsnoozeTask: (id: string) => void;
  onSelectTask: (id: string) => void; onNewTask: () => void; onEditContext: () => void; onShowSessions: () => void; onShowRecap: () => void;
  onEditTask: (id: string) => void; onCollapse: () => void;
  onStartSuggestion: (id: string) => void; onAcceptSuggestion: (id: string) => void; onDismissSuggestion: (id: string) => void;
  // Hand a multi-select off to the bulk-move modal. Owned by the shell (it owns
  // every modal) — this column only decides WHAT is selected.
  onBulkMove: (ids: string[]) => void;
  mobile?: boolean; onBack?: () => void;
  // Bumped when a merge lands, so the base-branch banner re-reads a branch the merge just moved.
  baseBranchTick?: number;
}) {
  const [query, setQuery] = useState("");
  // Minimize the Done/Cancelled groups so a long backlog of finished (or
  // abandoned) tasks doesn't force scrolling past them. Per-project, persisted
  // so the choice sticks across reloads. Cancelled starts collapsed — it's the
  // graveyard, not the working set.
  const [doneCollapsed, toggleDone] = useCollapsed(`orch_done_collapsed_${project.id}`, false);
  const [cancelledCollapsed, toggleCancelled] = useCollapsed(`orch_cancelled_collapsed_${project.id}`, true);
  const q = query.trim().toLowerCase();
  const match = (t: TaskRow) => !q || t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q);
  const shown = tasks.filter(match);
  // Withdrawn suggestions sink to the bottom of the tray: they're retractions
  // awaiting a decision, not proposals competing for attention.
  const shownSuggested = suggested.filter(match).sort(withdrawnLast);
  // Snoozed is a category ABOVE the status groups, not one of them: a parked
  // task keeps its status the whole time (that's what it returns to), so it has
  // to be lifted out of `awake` before anything else partitions the list, or it
  // would be drawn twice.
  const snoozedGroup = shown.filter((t) => isSnoozed(t)).sort((a, b) => a.snoozed_until - b.snoozed_until);
  const awake = shown.filter((t) => !isSnoozed(t));
  const needsYou = awake.filter((t) => isAwaiting(t));
  const groups = {
    a: awake.filter((t) => t.status === "in_progress" && !isAwaiting(t)),
    h: awake.filter((t) => t.status === "on_hold" && !isAwaiting(t)),
    r: awake.filter((t) => t.status === "not_started"),
    z: snoozedGroup,
    g: awake.filter((t) => t.status === "done").sort((a, b) => b.updated_at - a.updated_at),
    x: awake.filter((t) => t.status === "cancelled").sort((a, b) => b.updated_at - a.updated_at),
  };
  const canSearch = tasks.length + suggested.length >= SEARCH_MIN;
  const noMatches = q && shown.length === 0 && shownSuggested.length === 0;

  // The rows a shift-click range runs over: every group in render order, then
  // the Suggested tray. Collapsed groups are excluded — a range must not sweep
  // up tasks the user can't see — and so are the ones mid-turn, which can't be
  // re-filed at all, so a range spanning one skips it rather than selecting
  // something the server will only refuse. Started rows are swept up like any
  // other; what their move costs is asked for one row at a time in the modal.
  // Suggested rows are ordinary unstarted task rows server-side, so a range
  // crossing into the tray is a real selection, not a category error.
  const order = [
    ...needsYou, ...groups.a, ...groups.h, ...groups.r, ...groups.z,
    ...(doneCollapsed && !q ? [] : groups.g),
    ...(cancelledCollapsed && !q ? [] : groups.x),
    ...shownSuggested,
  ].filter(canPick).map((t) => t.id);
  const { picked, pick, clearPicked } = usePicked(`${project.id}:${view}`, order);
  const { expanded, toggleExpanded } = useExpanded(project.id);

  return (
    <div className="col col-tasks" style={{ flexBasis: width }}>
      <div className="proj-banner">
        <div className="pb-row">
          {onBack && <button className="mobile-back" onClick={onBack} title="Back to projects" aria-label="Back to projects">{Icon.chevRight({ style: { transform: "rotate(180deg)" } })}</button>}
          {/* The project home: recap, schedules, project-level overview. An
              explicit intent, not just "deselect the task" — the landing
              decision in useRecaps.ts auto-picks a task whenever none is
              selected, which used to bounce this click straight back and made
              the button dead on any project that had a task. */}
          <button className="pb-home" onClick={onShowRecap} aria-label="Project home" title="Project home — recap, schedules and overview">
            <span className="pb-pic" style={{ background: project.color }}>{project.name[0]}</span>
            <span className="pb-name">{project.name}</span>
          </button>
          <button className="btn btn-line btn-sm" onClick={onShowSessions} title="Agent sessions run under this project">{Icon.clock()} Sessions</button>
          <button className="btn btn-line btn-sm" onClick={onNewTask}>{Icon.plus()} Task</button>
          <div className="view-toggle" role="tablist" aria-label="Task layout">
            <button className={view === "list" ? "on" : ""} role="tab" aria-selected={view === "list"} title="List view" onClick={() => onSetView("list")}>{Icon.list()}</button>
            <button className={view === "board" ? "on" : ""} role="tab" aria-selected={view === "board"} title="Board view" onClick={() => onSetView("board")}>{Icon.board()}</button>
          </div>
          {!mobile && <button className="icon-btn" onClick={onCollapse} title="Hide tasks panel">{Icon.chevRight({ style: { transform: "rotate(180deg)" } })}</button>}
        </div>
        <button className="pb-ctx" onClick={onEditContext} title="Edit project context">
          <div className={`ctx-txt ${project.context ? "" : "empty-ctx"}`}>
            {project.context || "Add project context — description, stack & conventions, prepended to every task."}
          </div>
          <div className="ctx-edit">{Icon.edit()} Context</div>
        </button>
        <BaseBranchBanner projectId={project.id} refreshKey={baseBranchTick} />
      </div>
      {canSearch && <SearchBar value={query} onChange={setQuery} placeholder="Search tasks…" />}
      {loading ? (
        // The list in state is still the previous project's — skeleton cards
        // instead of a flash of the wrong tasks (or a false "No tasks yet").
        <div className="scroll">
          <div className="task-scroll">
            {[0, 1, 2].map((i) => <TaskCardSkeleton key={i} i={i} />)}
          </div>
        </div>
      ) : view === "board" ? (
        <div className="board-wrap">
          {noMatches && <div className="search-empty">No tasks match “{query.trim()}”.</div>}
          <TaskBoard
            tasks={shown} suggested={shownSuggested} agents={agents} selTaskId={selTaskId}
            running={running} blockedBy={blockedBy} sparklines={sparklines} canDrag={!q}
            onSelect={onSelectTask} onEditTask={onEditTask} onMove={onMoveTask}
            onStartSuggestion={onStartSuggestion} onAcceptSuggestion={onAcceptSuggestion} onDismissSuggestion={onDismissSuggestion}
            onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask}
          />
        </div>
      ) : (
      <div className="scroll">
        <div className="task-scroll">
          {tasks.length === 0 && (
            <div className="empty void" style={{ margin: "16px" }}>
              <div className="e-ic"><Logo size={32} /></div>
              <div className="e-t">No tasks yet</div>
              <div className="e-s">Create one to start an agent session.</div>
            </div>
          )}
          {noMatches && <div className="search-empty">No tasks match “{query.trim()}”.</div>}
          <TaskGroup label="Needs your input" tasks={needsYou} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} sparklines={sparklines} accent />
          <TaskGroup label="In progress" tasks={groups.a} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} sparklines={sparklines} />
          <TaskGroup label="On hold" tasks={groups.h} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} sparklines={sparklines} />
          <TaskGroup label="Not started" tasks={groups.r} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} sparklines={sparklines} />
          {/* Parked work sits between the live groups and the terminal ones —
              it isn't finished, but it isn't asking for anything either. */}
          <TaskGroup label={SNOOZE_LABEL} tasks={groups.z} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} sparklines={sparklines} />
          <TaskGroup label="Done" tasks={groups.g} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} sparklines={sparklines} collapsible collapsed={doneCollapsed && !q} onToggle={toggleDone} />
          <TaskGroup label="Cancelled" tasks={groups.x} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} sparklines={sparklines} collapsible collapsed={cancelledCollapsed && !q} onToggle={toggleCancelled} />
        </div>
        {shownSuggested.length > 0 && (
          <div className="suggest">
            <div className="suggest-h">{Icon.spark()} Suggested by agents<span className="sp">{shownSuggested.length}</span></div>
            {shownSuggested.map((s) => {
              // Retracted by the agent that filed it. The row stays here on
              // purpose — struck through, with the reason where the brief was —
              // because the retraction is a recommendation, not a deletion:
              // Add/Start revive it (clearing the cancel server-side), the ✕
              // still dismisses it for good.
              const gone = isWithdrawn(s);
              // The brief is clamped to one line, so anything with text behind
              // that clamp gets a disclosure triangle. A withdrawn row has two
              // things to reveal — the retraction reason AND the proposal it
              // retracts, which the collapsed row replaces entirely.
              const expandable = gone ? !!(s.withdrawn_reason || s.description) : !!s.description;
              const open = expandable && expanded.has(s.id);
              const meta = (
                <>
                  <div className="sg-name">{s.title}</div>
                  {gone ? (
                    <div className="sg-why gone" title={open ? undefined : s.withdrawn_reason || undefined}>
                      Withdrawn{s.withdrawn_reason ? ` — ${s.withdrawn_reason}` : ""}
                    </div>
                  ) : (
                    s.description && <div className="sg-why">{s.description}</div>
                  )}
                  {/* Expanded, a withdrawn row shows what was proposed under
                      why it was pulled — otherwise accepting or dismissing it
                      is a decision made on the retraction alone. */}
                  {open && gone && s.description && <div className="sg-why">{s.description}</div>}
                </>
              );
              return (
              <div key={s.id} className={`sug ${picked.has(s.id) ? "picked" : ""} ${gone ? "withdrawn" : ""} ${open ? "open" : ""}`}>
                <PickBox picked={picked.has(s.id)} pickable={canPick(s)} onPick={(range) => pick(s.id, range)} />
                {/* The spacer keeps titles aligned on a row with nothing to expand. */}
                {expandable ? (
                  <button className="sug-chev" aria-expanded={open} onClick={() => toggleExpanded(s.id)}
                    title={open ? "Collapse" : "Show the full description"}>{Icon.chevDown()}</button>
                ) : <span className="sug-chev is-spacer" aria-hidden />}
                <StatusDot status={gone ? "cancelled" : "not_started"} />
                {/* The brief itself toggles too — the triangle alone is a small
                    target, and the row has no other click behavior. */}
                {expandable ? (
                  <button className="sg-meta" aria-expanded={open} onClick={() => toggleExpanded(s.id)}
                    title={open ? "Collapse" : "Show the full description"}>{meta}</button>
                ) : <div className="sg-meta">{meta}</div>}
                {/* Grouped so the whole set can drop to its own line when the
                    row is expanded — inline, four buttons leave the brief a
                    column barely wide enough for one word. */}
                <div className="sug-acts">
                  <button className="sug-dismiss" title="Edit title & description" onClick={() => onEditTask(s.id)}>{Icon.edit()}</button>
                  <button className="sug-add" title={gone ? "Disagree — restore it to the task list" : "Add to task list to start later"} onClick={() => onAcceptSuggestion(s.id)}>{Icon.plus()} {gone ? "Restore" : "Add"}</button>
                  <button className="sug-btn" onClick={() => onStartSuggestion(s.id)}>{Icon.play()} Start</button>
                  <button className="sug-dismiss" title="Dismiss" onClick={() => onDismissSuggestion(s.id)}>{Icon.x()}</button>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
      )}
      {/* The multi-select action bar. Only in list view — the board's cards are
          drag targets, and a second selection model over them would fight the
          drag. Docked to the bottom of the column so a long list can scroll
          under it while the count and the action stay put. */}
      {view === "list" && picked.size > 0 && (
        <div className="pick-bar">
          <span className="pb-count">{picked.size} selected</span>
          <span className="spacer" />
          <button className="btn btn-line btn-sm" onClick={() => onBulkMove([...picked])} title="Re-file every selected task under another project">
            {Icon.chevRight()} Move to project…
          </button>
          <button className="btn btn-ghost btn-sm" onClick={clearPicked}>Clear</button>
        </div>
      )}
    </div>
  );
}
