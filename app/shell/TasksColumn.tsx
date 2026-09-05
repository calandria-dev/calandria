"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { Logo } from "../Logo";
import { blockedNote, isAwaiting, isPrRed, isUnreadRun, isWithdrawn, needsYou, relTime, withdrawnLast } from "./format";
import { AgentEditedChip } from "./AgentEdits";
import { isSnoozed, wasSnoozed, wakeLabel } from "./snooze";
import { isQueuedStart } from "./queuedStart";
import { IDLE_TITLE, idleFor, isIdleTurn, useIdleClock } from "./idleTurn";
import { IdleStopChip } from "./IdleStop";
import { SnoozeButton } from "./SnoozeMenu";
import { SLABEL, AWAIT_LABEL, CI_LABEL, SNOOZE_LABEL, RAN_LABEL, SEARCH_MIN, type ProjectRow, type TaskRow, type AgentsBundle, type TaskView, type TagRow } from "./types";
import { TagChips, TagBadges, useTagFilter, inTags, selectOneTag } from "./TagChips";
import { TagStrip } from "./TagStrip";
import { agentLabel } from "./agents";
import { StatusDot, PriPill, SearchBar, AgentBadge } from "./shared";
import { TaskCardSkeleton } from "./Layout";
import { TaskBoard, type TaskMovePatch } from "./TaskBoard";
import { BaseBranchBanner } from "./BaseBranchBanner";
import { DiffFooter } from "./DiffFooter";

// The multi-select checkbox. In a task row it sits inside the card, stacked
// over the status dot (.pick-slot), and swaps in on hover or while a
// selection is in progress. In a suggestion row it's an ordinary flex item.
// It stays faded until hovered or something is picked.
//
// Wired through onClick because the shift key is the range gesture and only
// a mouse event carries it. onChange keeps React from warning about a
// controlled input with no handler.
function PickBox({ picked, pickable, onPick }: { picked: boolean; pickable: boolean; onPick: (range: boolean) => void }) {
  return (
    <label className="pickbox" onClick={(e) => e.stopPropagation()}
      title={pickable ? "Select: shift-click to extend the range" : "A task mid-turn can't be re-filed. Nothing may move a worktree an agent is writing into"}>
      <input type="checkbox" checked={picked} disabled={!pickable} onChange={() => {}}
        onClick={(e) => { e.stopPropagation(); onPick(e.shiftKey); }} />
    </label>
  );
}

function TaskCard({ task, agents, selected, running, blockedBy, onSelect, picked, onPick, onSnooze, onUnsnooze, onAckRun, onStopTurn, sparkline, tagsById, onSelectTag, projectBranch }: { task: TaskRow; agents: AgentsBundle; selected: boolean; running: boolean; blockedBy?: string[]; onSelect: () => void; picked: boolean; onPick: (id: string, range: boolean) => void; onSnooze: (id: string, until: number) => void; onUnsnooze: (id: string) => void; onAckRun: (id: string) => void; onStopTurn: (id: string) => void; sparkline?: number[]; tagsById: Map<string, TagRow>; onSelectTag: (id: string) => void; projectBranch: string }) {
  const sessionCount = task.started ? task.generation : Math.max(0, task.generation - 1);
  const snoozed = isSnoozed(task);
  // Snoozed beats awaiting: parking a task that's asking a question stops it
  // from reading as "waiting on you" until it's back.
  const awaiting = !snoozed && isAwaiting(task);
  // The other half of "needs you": an open PR whose checks are failing. Below
  // awaiting, because a parked question is a person being asked something
  // directly; a red PR is a fact about work that already ended. Both land the
  // card in the same group, so the row has to be able to say which it is.
  const ciRed = !snoozed && !awaiting && isPrRed(task);
  const blocked = !!blockedBy?.length && !task.started;
  // Ran on its own and nobody has read it yet. Below snoozed and awaiting for
  // the same reason they're ordered that way: a parked or questioning row
  // describes something more urgent than "there is output here".
  const ranClean = !snoozed && !awaiting && !ciRed && isUnreadRun(task);
  // The model's turn ended but the session is held open for run_in_background
  // work: live, but nothing to watch and nothing needed from the user.
  const inBackground = !snoozed && !awaiting && running && !!task.background_pending;
  // Live, but nothing has come out of it for a long time (./idleTurn.ts). Shown
  // alongside the running state: the turn is still going and may be doing
  // real work, so this reports the gap and leaves the call to whoever reads
  // it.
  const idle = isIdleTurn(task, running) && !awaiting;
  useIdleClock(idle);
  const idleNote = idle ? ` · ${idleFor(task.idle_since ?? 0)}` : "";
  // Awaiting wins over running: a turn parked on a question is live but really
  // waiting on you, so it should read "waiting", not "working".
  const activity = snoozed ? `snoozed · wakes ${wakeLabel(task.snoozed_until)}`
    : awaiting ? `waiting on you · ${relTime(task.updated_at)}`
    : ranClean ? `ran clean · ${relTime(task.unread_run_at)}`
    : inBackground ? `live · ${task.background_note || "working in background"}${idleNote || ` · ${relTime(task.updated_at)}`}`
    : running ? `live · working${idleNote}`
    // Below `running`: a Fix-CI turn is live IN a task whose PR is still red,
    // and "live · working" is the more useful of the two facts while it runs.
    : ciRed ? `CI failing on PR #${task.pr_number}`
    : task.status === "done" ? `done · ${relTime(task.updated_at)}`
    : task.status === "cancelled" ? `cancelled · ${relTime(task.updated_at)}`
    : task.started ? relTime(task.updated_at) : "not started";
  const pickable = canPick(task);
  return (
    <div className={`task-row ${picked ? "picked" : ""} ${snoozed ? "snoozed" : ""}`}>
      {/* An <article role="button">, not a <button>: the card hosts real
          controls (the pick checkbox, the snooze corner), and interactive
          content inside a <button> is invalid. Same shape and same reason as
          the board's BoardCard. Keeping them inside lets the card run the
          column's full width without reserving side gutters. */}
      <article className={`task ${selected ? "sel" : ""} ${awaiting ? "awaiting" : ""}`} role="button" tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onSelect(); } }}>
      <div className="task-top">
        {/* The status dot doubles as the pick affordance: a pickable row swaps
            it for the checkbox on hover (or whenever a selection is going). */}
        <span className={`pick-slot${pickable ? "" : " no-pick"}`}>
          <StatusDot status={task.status} running={running} awaiting={awaiting} background={inBackground} />
          <PickBox picked={picked} pickable={pickable} onPick={(range) => onPick(task.id, range)} />
        </span>
        {/* Left of the title, where a logo costs only a line-height's width,
            so the agent mark can qualify the title without taking space
            from it. */}
        <AgentBadge agent={task.agent} label={agentLabel(agents, task.agent)} multi={agents.agents.length > 1} />
        <span className="ttitle">{task.title}</span>
        {/* Which feature(s) this is a step of; a task can carry several. Placed
            after the title. Clicking one lights that tag alone. */}
        <TagBadges tagIds={task.tag_ids} tagsById={tagsById} onSelect={onSelectTag} />
        {/* Snoozed reports the category it came from, not "Snoozed": the status
            group header already says that, and where it goes BACK to is the
            fact the row can't otherwise show. */}
        <span className={`slabel ${awaiting || ciRed ? "await" : ""}`}>{awaiting ? AWAIT_LABEL : ciRed ? CI_LABEL : SLABEL[task.status]}</span>
        <PriPill p={task.priority} />
      </div>
      <AgentEditedChip task={task} variant="list" />
      {/* Why this card is back where you didn't leave it: an unread marker.
          Opening the task clears it (useShell). */}
      {!snoozed && wasSnoozed(task) && (
        <div className="snz-chip was" title={`Snoozed until ${new Date(task.snoozed_until).toLocaleString()}`}>
          {Icon.moon()} Was snoozed
        </div>
      )}
      {/* A scheduled run that finished with nothing to answer. The button sits
          on the card, not just in a menu, because acknowledging is a status
          write: the server clears the mark and files the row in Done instead
          of leaving it in the undifferentiated "In progress" pile. Sending
          another message also clears the mark, when the next turn's session
          opens. */}
      {ranClean && (
        <div className="ran-chip" title={`Ran on its own ${relTime(task.unread_run_at)}, unattended, with nothing to answer. Read it, then mark it done`}>
          {Icon.check()} Ran clean · {relTime(task.unread_run_at)}
          <span className="spacer" />
          <button className="ran-ack" title="Mark done: you've read this run" onClick={(e) => { e.stopPropagation(); onAckRun(task.id); }}>Mark done</button>
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
      {/* Queued for the usage-window reset (./queuedStart.ts). Blue like the
          auto-start chip, since both say "this launches itself". */}
      {isQueuedStart(task) && !running && (
        <div className="blocked-chip auto" title={`Queued for the usage-window reset: ${task.started ? "resumes" : "starts"} ${wakeLabel(task.start_at)}`}>
          {Icon.clock()} {task.started ? "Resumes" : "Starts"} {wakeLabel(task.start_at)}
        </div>
      )}
      {task.description && <div className="tdesc">{task.description}</div>}
      <DiffFooter task={task} points={sparkline} projectBranch={projectBranch} />
      <div className="task-foot">
        <span className={`activity${idle ? " idle" : ""}`} title={idle ? IDLE_TITLE : undefined}>{awaiting ? <span style={{ color: "var(--blue)" }}>●</span> : running ? <span style={{ color: "var(--amber)" }}>●</span> : null}{activity}</span>
        <span className="spacer" />
        {sessionCount > 0 && <span className="activity">{sessionCount} session{sessionCount !== 1 ? "s" : ""}</span>}
      </div>
      {/* The idle mark's affordance, directly under the activity line that
          explains it: the chip's own label is only the verb. It lives on the
          card, not in the session, because the session's composer already
          has Stop; reaching that here means selecting the task first. It
          confirms; ./IdleStop.tsx has why. */}
      {idle && <IdleStopChip variant="list" onStop={() => onStopTurn(task.id)} />}
      {/* Corner affordance, mirroring the board card's .bc-snz. Snoozing fades
          in on hover like the checkbox; waking stays visible, since a
          parked row's only action here is "unsnooze it". SnoozeButton stops
          click propagation itself, so opening the menu doesn't select the
          task. */}
      <div className="task-snz">
        {snoozed ? (
          <button className="snz-wake" title={`Wakes ${wakeLabel(task.snoozed_until)}. Click to wake it now`}
            onClick={(e) => { e.stopPropagation(); onUnsnooze(task.id); }}>
            {Icon.sun()}
          </button>
        ) : (
          <SnoozeButton className="snz-set" onSnooze={(until) => onSnooze(task.id, until)} />
        )}
      </div>
      </article>
    </div>
  );
}

// Whether a task can be picked for a bulk move, as far as the client can
// tell. The server makes the real decision (it also refuses one whose turn
// is merely in flight, reporting that as a skip); this only keeps the
// obvious cases from being selectable at all.
//
// A started task is pickable: it moves by discarding the worktree it cut
// from this project's repo, and the move modal asks for that per row, with
// what that particular checkout holds beside the box. Only a live turn is
// unpickable: no answer moves a task an agent is writing into.
const canPick = (t: TaskRow) => t.running === 0;

// Header dot color, keyed the same as the per-card <StatusDot> classes (see
// shared.tsx). "c" (needs you) and "z" (snoozed) aren't real Statuses, so
// they're passed explicitly instead of derived from SCLS.
type DotCls = "r" | "a" | "h" | "g" | "x" | "c" | "z" | "u";

function TaskGroup({ label, tasks, agents, selTaskId, running, blockedBy, onSelect, picked, onPick, onSnooze, onUnsnooze, onAckRun, onStopTurn, sparklines, tagsById, onSelectTag, projectBranch, accent, dot, collapsible, collapsed, onToggle }: { label: string; tasks: TaskRow[]; agents: AgentsBundle; selTaskId: string | null; running: Set<string>; blockedBy: Map<string, string[]>; onSelect: (id: string) => void; picked: Set<string>; onPick: (id: string, range: boolean) => void; onSnooze: (id: string, until: number) => void; onUnsnooze: (id: string) => void; onAckRun: (id: string) => void; onStopTurn: (id: string) => void; sparklines: Record<string, number[]>; tagsById: Map<string, TagRow>; onSelectTag: (id: string) => void; projectBranch: string; accent?: boolean; dot?: DotCls; collapsible?: boolean; collapsed?: boolean; onToggle?: () => void }) {
  if (tasks.length === 0) return null;
  const cards = tasks.map((t) => (
    <TaskCard key={t.id} task={t} agents={agents} selected={t.id === selTaskId} running={running.has(t.id)}
      blockedBy={blockedBy.get(t.id)} onSelect={() => onSelect(t.id)} picked={picked.has(t.id)} onPick={onPick}
      onSnooze={onSnooze} onUnsnooze={onUnsnooze} onAckRun={onAckRun} onStopTurn={onStopTurn} sparkline={sparklines[t.id]}
      tagsById={tagsById} onSelectTag={onSelectTag} projectBranch={projectBranch} />
  ));
  const dotEl = dot && <span className={`sdot sm ${dot}`} />;
  if (collapsible) {
    return (
      <>
        <button className={`task-group-h tgh-btn ${collapsed ? "is-collapsed" : ""}`} onClick={onToggle} title={`${collapsed ? "Show" : "Hide"} ${label.toLowerCase()} tasks`}>
          {Icon.chevDown({ className: "tgh-chev" })}
          {dotEl}
          {label} <span className="gcount">{tasks.length}</span><span className="gline" />
        </button>
        {!collapsed && cards}
      </>
    );
  }
  return (
    <>
      <div className={`task-group-h ${accent ? "needs-you" : ""}`}>
        {dotEl}
        {label} <span className="gcount">{tasks.length}</span><span className="gline" />
      </div>
      {cards}
    </>
  );
}

/**
 * The multi-select: which task ids are picked for a bulk action, and the
 * shift-click range gesture over `order`, the ids as they are actually
 * rendered, top to bottom.
 *
 * Not persisted, and dropped whenever the project or the view changes: a
 * selection is a gesture in progress, and one surviving a navigation would
 * act on rows no longer on screen. The board doesn't render the action bar
 * either, so a selection carried into it would be invisible. Pruned against
 * `order` on every render for the same reason: a picked task that got
 * moved, deleted, filtered out by the search box, or launched into a turn
 * under the selection must leave it.
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
    // Resolve the range before touching the ref: a setState updater runs at
    // render time, so a ref read inside it would see the value written on
    // the line below instead of the anchor this click is extending from.
    const from = anchor.current ? order.indexOf(anchor.current) : -1;
    const to = order.indexOf(id);
    // Always re-anchor, including on a shift-click. A shift-click with no
    // anchor yet (the first gesture, or after the anchor was pruned) can
    // only toggle itself. Leaving no anchor behind would make every later
    // range gesture degrade to the same single toggle, stuck going one task
    // at a time. Re-anchoring costs nothing here because the range is
    // additive: extending from the last click never un-picks anything.
    anchor.current = id;
    setPicked((prev) => {
      const next = new Set(prev);
      if (range && from >= 0 && to >= 0) {
        // Extending: everything between the anchor and here joins the selection.
        // Additive, never subtractive: a range gesture that deselected rows
        // above it would be a nasty surprise on a long list.
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
 * is the whole case for it, and the tray clamps it to one line, so every row
 * gets a disclosure triangle.
 *
 * Not persisted, and dropped when the project changes: expanding is a
 * reading gesture, not a preference. A remembered set would also re-open
 * rows whose text the user has already read, which defeats the clamp.
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

// Per-group collapsed flag, persisted in localStorage under `key` (falling
// back to `legacyKey` for a reader that hasn't written the new key yet).
function useCollapsed(key: string, legacyKey: string, def: boolean) {
  const [collapsed, setCollapsed] = useState(def);
  useEffect(() => {
    try {
      const v = localStorage.getItem(key) ?? localStorage.getItem(legacyKey);
      setCollapsed(v === null ? def : v === "1");
    } catch {}
  }, [key, legacyKey, def]);
  const toggle = () => setCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem(key, next ? "1" : "0"); } catch {}
    return next;
  });
  return [collapsed, toggle] as const;
}

export function TasksColumn({ project, agents, tasks, suggested, tags, selTaskId, running, blockedBy, sparklines, width, loading, view, onSetView, onMoveTask, onSelectTask, onNewTask, onEditContext, onShowSessions, onShowRecap, onEditTask, onStartSuggestion, onAcceptSuggestion, onDismissSuggestion, onSnoozeTask, onUnsnoozeTask, onAckRun, onStopTurn, onBulkMove, onBulkTag, onCollapse, mobile, onBack, baseBranchTick }: {
  project: ProjectRow; agents: AgentsBundle; tasks: TaskRow[]; suggested: TaskRow[]; tags: TagRow[]; selTaskId: string | null; running: Set<string>; blockedBy: Map<string, string[]>; sparklines: Record<string, number[]>; width: number; loading?: boolean;
  view: TaskView; onSetView: (v: TaskView) => void;
  onMoveTask: (id: string, patch: TaskMovePatch) => void;
  onSnoozeTask: (id: string, until: number) => void; onUnsnoozeTask: (id: string) => void;
  // Acknowledge a clean unattended run ("I've read it"): a status write that
  // files the task under Done and clears the mark (useShell.ts).
  onAckRun: (id: string) => void;
  onStopTurn: (id: string) => void;
  onSelectTask: (id: string) => void; onNewTask: () => void; onEditContext: () => void; onShowSessions: () => void; onShowRecap: () => void;
  onEditTask: (id: string) => void; onCollapse: () => void;
  onStartSuggestion: (id: string) => void; onAcceptSuggestion: (id: string) => void; onDismissSuggestion: (id: string) => void;
  // Hand a multi-select off to the bulk-move / bulk-tag modal. Owned by the
  // shell, which owns every modal; this column only decides what is selected.
  onBulkMove: (ids: string[]) => void;
  onBulkTag: (ids: string[]) => void;
  mobile?: boolean; onBack?: () => void;
  // Bumped when a merge lands, so the base-branch banner re-reads a branch the merge just moved.
  baseBranchTick?: number;
}) {
  const [query, setQuery] = useState("");
  // Minimize the Done/Cancelled groups so a long backlog of finished (or
  // abandoned) tasks doesn't force scrolling past them. Per-project,
  // persisted so the choice sticks across reloads. Cancelled starts
  // collapsed: it's the graveyard.
  const [doneCollapsed, toggleDone] = useCollapsed(`calandria_done_collapsed_${project.id}`, `orch_done_collapsed_${project.id}`, false);
  const [cancelledCollapsed, toggleCancelled] = useCollapsed(`calandria_cancelled_collapsed_${project.id}`, `orch_cancelled_collapsed_${project.id}`, true);
  // The tag chips narrow every bucket below, including the Suggested tray,
  // to the lit tags' members (any/all: TagChips.tsx). Applied before the
  // search so the two compose. (Named `tags`, not `groups`: the status
  // buckets below keep that name, and a task carrying several tags never
  // collides with them.)
  const { filter: tagFilter, set: setTagFilter, toggle: toggleTag } = useTagFilter(project.id, tags);
  const tagsById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  // The strip is single-tag only (TagStrip.tsx's own reasoning): two lit
  // chips filter over two plans, and the strip only has room for one plan's
  // detail.
  const selectedTag = tagFilter.ids.length === 1 ? tagsById.get(tagFilter.ids[0]) ?? null : null;
  // A badge click lights exactly one tag, from any surface. The chip bar's
  // own toggle (above) is the only thing that builds a multi-tag filter.
  const selectTag = (id: string) => selectOneTag(project.id, id);
  const q = query.trim().toLowerCase();
  const match = (t: TaskRow) => !q || t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q);
  const shown = inTags(tasks, tagFilter).filter(match);
  // Withdrawn suggestions sink to the bottom of the tray: they're retractions
  // awaiting a decision, not proposals competing for attention.
  const shownSuggested = inTags(suggested, tagFilter).filter(match).sort(withdrawnLast);
  // Snoozed is a category ABOVE the status groups, not one of them: a parked
  // task keeps its status the whole time (that's what it returns to), so it has
  // to be lifted out of `awake` before anything else partitions the list, or it
  // would be drawn twice.
  const snoozedGroup = shown.filter((t) => isSnoozed(t)).sort((a, b) => a.snoozed_until - b.snoozed_until);
  const awake = shown.filter((t) => !isSnoozed(t));
  // Both arms of "needs you" (./format.ts): parked on a question, or an open
  // PR gone red. Every status group below has to exclude the same predicate.
  // A done task with a red PR belongs here; left in `g` as well it would be
  // drawn twice.
  const needsYouGroup = awake.filter((t) => needsYou(t));
  // Unattended runs that finished clean and haven't been read. Lifted out of
  // "In progress" like needsYou is, and for the stronger reason: nothing is
  // running in them and nothing ever will again on its own, so left in that
  // group they were permanent rows pretending to be live work (issue #28).
  const ranClean = awake.filter((t) => isUnreadRun(t) && !needsYou(t));
  const groups = {
    a: awake.filter((t) => t.status === "in_progress" && !needsYou(t) && !isUnreadRun(t)),
    h: awake.filter((t) => t.status === "on_hold" && !needsYou(t)),
    r: awake.filter((t) => t.status === "not_started"),
    z: snoozedGroup,
    g: awake.filter((t) => t.status === "done" && !needsYou(t)).sort((a, b) => b.updated_at - a.updated_at),
    x: awake.filter((t) => t.status === "cancelled").sort((a, b) => b.updated_at - a.updated_at),
  };
  const canSearch = tasks.length + suggested.length >= SEARCH_MIN;
  const noMatches = q && shown.length === 0 && shownSuggested.length === 0;
  // Nothing left after the tag filter (every member deleted, or the
  // remembered chips name tags whose members all moved). Say so instead of
  // showing "No tasks yet" for a project that has plenty. One lit tag names
  // it; several name the plural, since "these tags" is the honest
  // description of an intersection or union over more than one.
  const tagEmpty = !q && tagFilter.ids.length > 0 && shown.length === 0 && shownSuggested.length === 0;
  const tagEmptyMsg = tagFilter.ids.length === 1
    ? `No tasks in ${tagsById.get(tagFilter.ids[0])?.name ?? "this tag"}.`
    : "No tasks with these tags.";

  // The rows a shift-click range runs over: every group in render order,
  // then the Suggested tray. Collapsed groups are excluded, since a range
  // must not sweep up tasks the user can't see, and so are the ones
  // mid-turn, which can't be re-filed at all: a range spanning one skips it
  // instead of selecting something the server will only refuse. Started
  // rows are swept up like any other; what their move costs is asked for
  // one row at a time in the modal. Suggested rows are ordinary unstarted
  // task rows server-side, so a range crossing into the tray is a real
  // selection.
  const order = [
    ...needsYouGroup, ...ranClean, ...groups.a, ...groups.h, ...groups.r, ...groups.z,
    ...(doneCollapsed && !q ? [] : groups.g),
    ...(cancelledCollapsed && !q ? [] : groups.x),
    ...shownSuggested,
  ].filter(canPick).map((t) => t.id);
  // The tag filter is part of the scope: narrowing the list is a navigation,
  // and a selection surviving it would act on rows no longer on screen.
  const { picked, pick, clearPicked } = usePicked(`${project.id}:${view}:${tagFilter.ids.join(",")}:${tagFilter.match}`, order);
  const { expanded, toggleExpanded } = useExpanded(project.id);

  // Everything above the list (the project banner, the search field, the
  // tag chips, and the selected tag's summary strip) scrolls with the tasks
  // instead of being pinned above them: stacked, they take most of a narrow
  // column's height, and none of them is needed while scrolling a backlog.
  // The app titlebar is the only thing that stays put. Board view is the
  // exception: its columns scroll individually and only have a height
  // because the wrapper is bounded, so pinning is what makes it work.
  const head = (
    <>
      <div className="proj-banner">
        <div className="pb-row">
          {onBack && <button className="mobile-back" onClick={onBack} title="Back to projects" aria-label="Back to projects">{Icon.chevRight({ style: { transform: "rotate(180deg)" } })}</button>}
          {/* The project home: recap, schedules, project-level overview. An
              explicit intent, since the landing decision in useRecaps.ts
              auto-picks a task whenever none is selected: this button must
              stay reachable even on a project that has a task. */}
          <button className="pb-home" onClick={onShowRecap} aria-label="Project home" title="Project home: recap, schedules and overview">
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
            {project.context || "Add project context: description, stack & conventions, prepended to every task."}
          </div>
          <div className="ctx-edit">{Icon.edit()} Context</div>
        </button>
        <BaseBranchBanner projectId={project.id} refreshKey={baseBranchTick} />
      </div>
      {canSearch && <SearchBar value={query} onChange={setQuery} placeholder="Search tasks…" />}
      <TagChips tags={tags} filter={tagFilter} onToggle={toggleTag} onSet={setTagFilter} />
      {/* The selected chip's detail: description, progress, provenance, the
          members in dependency order, and the two verbs a tag has. A tag has
          no route of its own; this band is the epic page. Members come from
          both lists because a plan lands in the tray first. Shown only with
          exactly one chip lit (two lit chips filter over two plans), and
          filtered by that tag alone: a second lit chip elsewhere doesn't
          narrow what the strip itself shows. */}
      {selectedTag && (
        <TagStrip
          tag={selectedTag}
          members={[...tasks, ...suggested].filter((t) => t.tag_ids.includes(selectedTag.id))}
          allTags={tags}
          projectBranch={project.branch}
          originTask={selectedTag.origin_task_id
            ? [...tasks, ...suggested].find((t) => t.id === selectedTag.origin_task_id)
            : undefined}
          onSelectTask={onSelectTask}
          onDeleted={() => setTagFilter({ ids: [], match: "any" })}
        />
      )}
    </>
  );

  return (
    <div className="col col-tasks" style={{ flexBasis: width }}>
      {loading ? (
        // The list in state is still the previous project's: skeleton cards
        // instead of a flash of the wrong tasks (or a false "No tasks yet").
        <div className="scroll">
          {head}
          <div className="task-scroll">
            {[0, 1, 2].map((i) => <TaskCardSkeleton key={i} i={i} />)}
          </div>
        </div>
      ) : view === "board" ? (
        <>
        {head}
        <div className="board-wrap">
          {noMatches && <div className="search-empty">No tasks match “{query.trim()}”.</div>}
          {tagEmpty && <div className="search-empty">{tagEmptyMsg}</div>}
          <TaskBoard
            tasks={shown} suggested={shownSuggested} agents={agents} selTaskId={selTaskId}
            running={running} blockedBy={blockedBy} sparklines={sparklines}
            tagsById={tagsById} onSelectTag={selectTag} projectBranch={project.branch}
            onSelect={onSelectTask} onEditTask={onEditTask} onMove={onMoveTask}
            onStartSuggestion={onStartSuggestion} onAcceptSuggestion={onAcceptSuggestion} onDismissSuggestion={onDismissSuggestion}
            onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} onAckRun={onAckRun} onStopTurn={onStopTurn}
          />
        </div>
        </>
      ) : (
      <div className="scroll">
        {head}
        <div className="task-scroll">
          {tasks.length === 0 && (
            <div className="empty void" style={{ margin: "16px" }}>
              <div className="e-ic"><Logo size={32} /></div>
              <div className="e-t">No tasks yet</div>
              <div className="e-s">Create one to start an agent session.</div>
            </div>
          )}
          {noMatches && <div className="search-empty">No tasks match “{query.trim()}”.</div>}
          {tagEmpty && <div className="search-empty">{tagEmptyMsg}</div>}
          <TaskGroup label="Needs your input" tasks={needsYouGroup} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} onAckRun={onAckRun} onStopTurn={onStopTurn} sparklines={sparklines} tagsById={tagsById} onSelectTag={selectTag} projectBranch={project.branch} accent dot="c" />
          {/* Between the two for a reason: a clean run needs reading, which
              is less than answering a question and more than a task that is
              simply still open. */}
          <TaskGroup label={RAN_LABEL} tasks={ranClean} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} onAckRun={onAckRun} onStopTurn={onStopTurn} sparklines={sparklines} tagsById={tagsById} onSelectTag={selectTag} projectBranch={project.branch} dot="u" />
          <TaskGroup label="In progress" tasks={groups.a} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} onAckRun={onAckRun} onStopTurn={onStopTurn} sparklines={sparklines} tagsById={tagsById} onSelectTag={selectTag} projectBranch={project.branch} dot="a" />
          <TaskGroup label="On hold" tasks={groups.h} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} onAckRun={onAckRun} onStopTurn={onStopTurn} sparklines={sparklines} tagsById={tagsById} onSelectTag={selectTag} projectBranch={project.branch} dot="h" />
          <TaskGroup label="Not started" tasks={groups.r} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} onAckRun={onAckRun} onStopTurn={onStopTurn} sparklines={sparklines} tagsById={tagsById} onSelectTag={selectTag} projectBranch={project.branch} dot="r" />
          {/* Parked work sits between the live groups and the terminal ones:
              it isn't finished, but it isn't asking for anything either. */}
          <TaskGroup label={SNOOZE_LABEL} tasks={groups.z} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} onAckRun={onAckRun} onStopTurn={onStopTurn} sparklines={sparklines} tagsById={tagsById} onSelectTag={selectTag} projectBranch={project.branch} dot="z" />
          <TaskGroup label="Done" tasks={groups.g} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} onAckRun={onAckRun} onStopTurn={onStopTurn} sparklines={sparklines} tagsById={tagsById} onSelectTag={selectTag} projectBranch={project.branch} dot="g" collapsible collapsed={doneCollapsed && !q} onToggle={toggleDone} />
          <TaskGroup label="Cancelled" tasks={groups.x} agents={agents} selTaskId={selTaskId} running={running} blockedBy={blockedBy} onSelect={onSelectTask} picked={picked} onPick={pick} onSnooze={onSnoozeTask} onUnsnooze={onUnsnoozeTask} onAckRun={onAckRun} onStopTurn={onStopTurn} sparklines={sparklines} tagsById={tagsById} onSelectTag={selectTag} projectBranch={project.branch} dot="x" collapsible collapsed={cancelledCollapsed && !q} onToggle={toggleCancelled} />
        </div>
        {shownSuggested.length > 0 && (
          <div className="suggest">
            <div className="suggest-h">{Icon.spark()} Suggested by agents<span className="sp">{shownSuggested.length}</span></div>
            {shownSuggested.map((s) => {
              // Retracted by the agent that filed it. The row stays here,
              // struck through, with the reason where the brief was, because
              // the retraction is a recommendation, not a deletion. Add or
              // Start revives it (clearing the cancel server-side); the ✕
              // still dismisses it for good.
              const gone = isWithdrawn(s);
              // Blockers gate a start; accepting a suggestion does not. Add
              // stays live, Start does not: the server 409s a blocked first
              // turn, and `startSuggestion` accepts the task before it asks
              // for the turn, so an offered Start here would put the task on
              // the board and then be refused the run.
              const blockNote = blockedNote(blockedBy.get(s.id));
              // The brief is clamped to one line, so anything with text
              // behind that clamp gets a disclosure triangle. A withdrawn row
              // has two things to reveal: the retraction reason and the
              // proposal it retracts, which the collapsed row replaces
              // entirely.
              const expandable = gone ? !!(s.withdrawn_reason || s.description) : !!s.description;
              const open = expandable && expanded.has(s.id);
              const meta = (
                <>
                  <div className="sg-name">
                    {s.title}
                    <TagBadges tagIds={s.tag_ids} tagsById={tagsById} onSelect={selectTag} />
                  </div>
                  {gone ? (
                    <div className="sg-why gone" title={open ? undefined : s.withdrawn_reason || undefined}>
                      Withdrawn{s.withdrawn_reason ? `: ${s.withdrawn_reason}` : ""}
                    </div>
                  ) : (
                    s.description && <div className="sg-why">{s.description}</div>
                  )}
                  {/* Expanded, a withdrawn row shows what was proposed under
                      why it was pulled. Otherwise accepting or dismissing it
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
                {/* The brief itself toggles too: the triangle alone is a
                    small target, and the row has no other click behavior. */}
                {expandable ? (
                  <button className="sg-meta" aria-expanded={open} onClick={() => toggleExpanded(s.id)}
                    title={open ? "Collapse" : "Show the full description"}>{meta}</button>
                ) : <div className="sg-meta">{meta}</div>}
                {/* Grouped so the whole set can drop to its own line when the
                    row is expanded: inline, four buttons leave the brief a
                    column barely wide enough for one word. */}
                <div className="sug-acts">
                  <button className="sug-dismiss" title="Edit title & description" onClick={() => onEditTask(s.id)}>{Icon.edit()}</button>
                  <button className="sug-add" title={gone ? "Disagree: restore it to the task list" : "Add to task list to start later"} onClick={() => onAcceptSuggestion(s.id)}>{Icon.plus()} {gone ? "Restore" : "Add"}</button>
                  <button className="sug-btn" disabled={!!blockNote} title={blockNote} onClick={() => onStartSuggestion(s.id)}>{Icon.play()} Start</button>
                  <button className="sug-dismiss" title="Dismiss" onClick={() => onDismissSuggestion(s.id)}>{Icon.x()}</button>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
      )}
      {/* The multi-select action bar. Only in list view: the board's cards
          are drag targets, and a second selection model over them would
          fight the drag. Docked to the bottom of the column so a long list
          can scroll under it while the count and the action stay put. */}
      {view === "list" && picked.size > 0 && (
        <div className="pick-bar">
          <span className="pb-count">{picked.size} selected</span>
          <span className="spacer" />
          <button className="btn btn-line btn-sm" onClick={() => onBulkTag([...picked])} title="Add or remove tags across every selected task: the quick way to tag a plan an agent filed before the tag existed">
            {Icon.spark()} Tags…
          </button>
          <button className="btn btn-line btn-sm" onClick={() => onBulkMove([...picked])} title="Re-file every selected task under another project">
            {Icon.chevRight()} Move to project…
          </button>
          <button className="btn btn-ghost btn-sm" onClick={clearPicked}>Clear</button>
        </div>
      )}
    </div>
  );
}
