"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Status, Priority, ToolData, AskQuestion, AskAnswers, PermissionDecision } from "@/lib/types";
import { Icon } from "../icons";
import TaskChanges, { type ResolveResult } from "../TaskChanges";
import { fmtTokens, fmtCost, fmtJobCost, modelLabel, isAwaiting, isPrRed, prFailingChecks, buildSessions, usageSplit, costDisplay, usageTooltip } from "./format";
import {
  SLABEL, SSUB, AWAIT_LABEL, STATUSES, PLABEL, PRIORITIES,
  modelOptions, reasoningOptions, permissionOptions, INHERIT_LABEL, RAIL_W,
  type ProjectRow, type TaskRow, type Msg, type SyncStatusResp, type AgentsBundle, type InternalUsageEstimate, type TagRow,
} from "./types";
import { TagBadges, selectOneTag } from "./TagChips";
import { isSnoozed, wakeLabel } from "./snooze";
import { SnoozeButton } from "./SnoozeMenu";
import { isQueuedStart, resetClock } from "./queuedStart";
import { IDLE_TITLE, idleFor, isIdleTurn, useIdleClock } from "./idleTurn";
import { usePlanUsage } from "./PlanUsage";
import { usageResetAt, deferredStartFor } from "@/lib/usageReset";
import { capsFor, agentLabel, findAgent } from "./agents";
import { StatusDot, Avatar, Popover, AgentBadge, Skel } from "./shared";
import { MessageView, SessionBreak, type LimitResume, type SuggestionActions } from "./Transcript";
import { CollabDoc } from "./CollabDoc";
import { Composer } from "./Composer";
import { SessionRail } from "./SessionRail";
import { PrChip } from "./PrChip";
import { ReclaimButton } from "./ReclaimButton";
import { ColResize, ColRail } from "./Layout";
import { jget, jsend } from "./api";

// Non-blocking banner shown when a reopened task's worktree is behind its base
// branch. Computed (read-only) on open; the actual git op fires only when the user
// clicks. Fast-forward-able tasks show nothing here — they catch up silently on the
// next message — so the banner only appears for tier 2 (clean merge → Sync) and
// tier 3 (conflicts → Fix with AI). Fix with AI leaves the merge PAUSED — the
// resolution turn edits the files marker-free and is told not to commit — so
// there's a fourth state after it: "resolved" — Accept & merge lands it from
// right here (the same POST the Changes tab's button makes), Review opens that
// tab for a look first (Discard lives there). The banner clears once the merge
// is accepted (the task lands, so it has nothing left outside the base — NOT
// because `behind` drops to 0; landing writes a merge commit the branch doesn't
// carry, so it stays behind by one) or discarded (back to tier 3, which is
// honest — main still moved on).
// Under a PR landing policy the last tier changes shape: accepting the
// resolution commits the base→branch merge and STOPS. Landing it into the local
// base is exactly the move that can't be pushed afterwards, and the PR is what
// moves the base. The earlier tiers (Sync, Fix with AI) are the same work in
// either mode — they only ever touch the task's own branch — so they don't move.
function SyncBanner({ taskId, running, refresh, prMode, onResolveWithAI, onSwitchToChat, onReview, onMerged, onChanged }: {
  taskId: string; running: boolean;
  prMode: boolean; // the project lands through pull requests (projects.landing_mode === "pr")
  // Bumped by the parent when Changes mutates the merge state (accept, discard,
  // land) — the banner otherwise re-reads only when a turn ends.
  refresh: number;
  onResolveWithAI: (taskId: string) => Promise<ResolveResult>;
  onSwitchToChat: () => void;
  onReview: () => void;
  onMerged?: () => void; // the task landed — same hook TaskChanges fires
  onChanged: () => void; // this banner mutated the merge state — a mounted Changes tab must re-read
}) {
  const [st, setSt] = useState<SyncStatusResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const r = await fetch(`/api/tasks/${taskId}/sync`, { cache: "no-store" }); setSt(await r.json()); }
    catch { setSt(null); }
  }, [taskId]);

  // Recompute on open and whenever a turn finishes (a turn may have fast-forwarded
  // or otherwise moved the branch). Skip while running to avoid mid-merge reads.
  // `refresh` is a dependency only — the parent bumps it after Changes acts.
  useEffect(() => { if (!running) load(); }, [running, refresh, load]);

  if (!st || !st.isolated) return null;

  const conflicts = st.conflicts?.length ?? 0;
  const paused = !!st.mergeInProgress;
  const resolved = paused && conflicts === 0;

  // Nothing to report. A paused merge always is (it needs an accept or a
  // discard), so this only screens the unpaused tiers:
  //  · behind 0 — up to date.
  //  · canFastForward — resolves silently on the next message.
  //  · ahead 0 — the branch has no commit that isn't already in the base, so
  //    nothing is waiting to land and "main moved on before your work can land"
  //    has nothing to act on. This is precisely what a SUCCESSFUL Accept & merge
  //    leaves behind: landing the task writes a merge commit into the base that
  //    the task branch itself doesn't carry, so it reads `behind: 1` forever
  //    after. A clean worktree hid that via canFastForward; a dirty one didn't,
  //    so the banner came back as "1 commit to pick up / Sync" over a task that
  //    had just landed — and syncing it only re-merged the task's own merge.
  if (!st.behind || (!paused && (st.canFastForward || !st.ahead))) {
    // ...unless the last action failed, in which case the reason is the whole
    // point: a banner that vanishes on a failed click reads as a no-op too.
    if (!err) return null;
    return (
      <div className="sync-banner conflict" title={err}>
        <span className="sync-msg">{err}</span>
        <span className="sync-spacer" />
        <button className="tc-btn" onClick={() => setErr(null)}>Dismiss</button>
      </div>
    );
  }

  // After a resolution attempt, go where it left things: a turn was started →
  // watch it in the chat; nothing was left to resolve → the review state.
  const after = (res: ResolveResult) => {
    if (!res.ok || res.merged) return;
    if (res.resolving) onSwitchToChat(); else onReview();
  };

  // Every action here reports its own failure. The server refuses a sync it
  // can't do (a turn started, a merge that won't apply) with a 409 and a reason;
  // swallowing that made a click on a button that couldn't work look like a
  // button that did nothing at all.
  const doSync = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/tasks/${taskId}/sync`, { method: "POST" });
      const res: { ok?: boolean; error?: string; conflicts?: string[] } = await r.json().catch(() => ({}));
      // Prediction said clean but the real merge conflicted — escalate to Fix with AI.
      if (res?.conflicts?.length) after(await onResolveWithAI(taskId));
      else if (!res?.ok) setErr(res?.error || `sync failed (HTTP ${r.status})`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); load(); onChanged(); }
  };

  const doFix = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await onResolveWithAI(taskId);
      if (!res.ok) setErr(res.error || "could not start the resolution");
      else after(res);
    } finally { setBusy(false); load(); onChanged(); }
  };

  // Accept the resolution: commit the paused merge and land the branch into the
  // base — exactly what TaskChanges.doComplete does, so the banner's button and
  // the tab's button can't drift. On success `behind` reads 0 and the banner
  // goes away on its own reload; a failure stays on screen with the reason.
  // Under a PR policy it stops at the commit (`resolveOnly`), so nothing landed
  // and `onMerged` — which marks the task merged — must not fire.
  const doAccept = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/tasks/${taskId}/merge/complete`, {
        method: "POST",
        ...(prMode ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ resolveOnly: true }) } : {}),
      });
      const res: { ok?: boolean; error?: string; resolveOnly?: boolean } = await r.json().catch(() => ({ ok: false, error: `merge request failed (HTTP ${r.status})` }));
      if (res.ok && !res.resolveOnly) onMerged?.();
      else if (!res.ok) setErr(res.error || "could not complete the merge");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); load(); onChanged(); }
  };

  // A task that read "up to date" a moment ago can land here without having
  // changed at all: catching the local base branch up to its remote (or landing
  // another task) moves the goalposts under every task in flight. Saying which
  // side moved is the difference between "something is wrong with my task" and
  // "main moved on", so the message names it.
  const why = resolved
    ? prMode
      ? `The resolution turn edited the conflicted files but did not commit. The merge with ${st.baseBranch} stays paused until you accept it (commits it to this task's branch, which is what makes the PR mergeable) or discard it (restores the worktree). ${st.baseBranch} takes pull requests only, so nothing lands on it from here.`
      : `The resolution turn edited the conflicted files but did not commit. The merge with ${st.baseBranch} stays paused until you accept it (lands this task) or discard it (restores the worktree).`
    : `${st.baseBranch} has moved on since this task branched. Nothing is wrong with the task. It just needs the newer commits before its own work can land.`;

  const msg = resolved
    ? `Conflicts with ${st.baseBranch} resolved: review the result, then ${prMode ? "Accept resolution" : "Accept & merge"} or Discard`
    : paused
      ? `${st.baseBranch} moved on: ${conflicts} file${conflicts === 1 ? "" : "s"} still conflicted after the resolution`
      : conflicts > 0
        ? `${st.baseBranch} moved on: ${st.behind} ahead of this task, conflicts in ${conflicts} file${conflicts === 1 ? "" : "s"}`
        : `${st.baseBranch} moved on: ${st.behind} commit${st.behind === 1 ? "" : "s"} to pick up`;

  return (
    <div className={`sync-banner${conflicts ? " conflict" : ""}${resolved ? " resolved" : ""}`} title={why} data-sync-state={resolved ? "resolved" : conflicts ? "conflict" : "behind"}>
      <span className="sync-msg">{msg}</span>
      {err && <span className="sync-err" title={err}>{err}</span>}
      <span className="sync-spacer" />
      {resolved ? (
        <>
          <button className="tc-btn" onClick={onReview} disabled={busy || running}>Review</button>
          <button className="tc-btn primary" onClick={doAccept} disabled={busy || running}>
            {busy ? (prMode ? "Committing…" : "Merging…") : prMode ? "Accept resolution" : "Accept & merge"}
          </button>
        </>
      ) : conflicts > 0 ? (
        <button className="tc-btn primary" onClick={doFix} disabled={busy || running}>{busy ? "…" : "Fix with AI"}</button>
      ) : (
        <button className="tc-btn primary" onClick={doSync} disabled={busy || running}>{busy ? "Syncing…" : "Sync"}</button>
      )}
    </div>
  );
}

// The red-PR twin of SyncBanner: this task's pull request is open and its check
// rollup is failing, so the work needs a human even though no turn is parked on
// anything. It is the SESSION's half of the same fact the titlebar pill and the
// board badge carry (lib/store.ts's NEEDS_YOU predicate) — the place the user
// lands when they click through, and therefore the place that has to say which
// job broke and offer to do something about it.
//
// Everything it draws comes off the task row, kept fresh by lib/prState.ts over
// /api/events. Nothing here polls, and nothing here re-derives a verdict: the
// server already collapsed the rollup and named the red entries.
function CiBanner({ task, running, onFixCi, onSwitchToChat }: {
  task: TaskRow; running: boolean;
  onFixCi: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  onSwitchToChat: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const failing = prFailingChecks(task);

  const doFix = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await onFixCi(task.id);
      // The turn is fire-and-forget, so switching to the chat is what makes the
      // click feel like it did something: the diagnosis streams in live.
      if (res.ok) onSwitchToChat();
      else setErr(res.error || "could not start the fix");
    } finally { setBusy(false); }
  };

  return (
    <div className="sync-banner ci-failing" data-ci-state="failing">
      <span className="sync-msg">
        CI failing on PR #{task.pr_number}
        {failing.length > 0 && ": "}
        {failing.map((c, i) => (
          <Fragment key={`${c.name}-${i}`}>
            {i > 0 && ", "}
            {c.url
              ? <a className="ci-check" href={c.url} target="_blank" rel="noreferrer" title={c.workflow ? `${c.workflow} — open the run on GitHub` : "Open the run on GitHub"}>{c.name}</a>
              : <span className="ci-check">{c.name}</span>}
          </Fragment>
        ))}
      </span>
      {err && <span className="sync-err" title={err}>{err}</span>}
      <span className="sync-spacer" />
      <a className="tc-btn" href={task.pr_url} target="_blank" rel="noreferrer">Open PR</a>
      <button
        className="tc-btn primary"
        onClick={doFix}
        disabled={busy || running}
        title="Start a turn in this session, seeded with the failing job and the tail of its log"
      >
        {busy ? "Reading logs…" : "Fix CI"}
      </button>
    </div>
  );
}

function TaskHero({ task, project, onStart, onEdit, onSetSendContext, onSetAutoStart, running, blockedBy, resetAt, onQueueStart, onCancelQueuedStart }: { task: TaskRow; project: ProjectRow; onStart: () => void; onEdit: () => void; onSetSendContext: (v: boolean) => void; onSetAutoStart: (v: boolean) => void; running: boolean; blockedBy?: string[]; resetAt: number | null; onQueueStart: (at: number) => void; onCancelQueuedStart: () => void }) {
  const carried = task.generation > 1;
  const blocked = !!blockedBy?.length && !task.started;
  // Queued for the usage-window reset (./queuedStart.ts): the server launches
  // it on its own when the deadline passes; "Start now" is still offered.
  const queued = isQueuedStart(task);
  const sendContext = task.send_context !== 0;
  const tagCount = task.tag_ids.length;
  const statusLine = carried ? "Fresh window · summary carried" : `${SLABEL[task.status]} · no session yet`;
  return (
    <div className="hero">
      <div className="h-ic">{Icon.bolt()}</div>
      <div className="h-status"><StatusDot status={task.status} /> {statusLine}</div>
      <h2>{task.title}</h2>
      {task.description && <p className="h-desc">{task.description}</p>}
      {/* The brief above IS the brief — this card must not restate it. It used
          to print "**title.** description" under an "initial prompt" header,
          which was both a near-verbatim repeat of the two lines above it and a
          fiction: the opening user turn is the fixed INITIAL_TASK_PROMPT, and
          the title/details reach the session through buildProjectContext() in
          the system prompt. So the card answers the question the brief can't —
          which BLOCKS of context get assembled around it — and owns the one
          knob that changes the answer, rather than stating it twice (readout
          here, checkbox below). Rows are in the order buildProjectContext()
          emits them. */}
      <div className="h-prompt">
        <div className="hp-h">What the session starts with</div>
        <ul className="hp-list">
          <li>
            <label className={running ? "off" : undefined}
              title="Uncheck to start without the saved project context. Task details and Calandria tools are always included.">
              <input type="checkbox" checked={sendContext} disabled={running} onChange={(e) => onSetSendContext(e.target.checked)} />
              <span>{project.name} project context</span>
            </label>
          </li>
          <li><span className="hp-fixed" aria-hidden /><span>This task&rsquo;s title and details</span></li>
          {/* Suppressed by send_context = 0 exactly like the project context —
              lib/tagContext.ts returns "" for it — so the row follows the box. */}
          {sendContext && tagCount > 0 && (
            <li><span className="hp-fixed" aria-hidden /><span>Where this task sits in {tagCount === 1 ? "its feature" : `its ${tagCount} features`}</span></li>
          )}
          {carried && <li><span className="hp-fixed" aria-hidden /><span>Summary of {task.generation - 1 === 1 ? "the previous session" : `all ${task.generation - 1} previous sessions`}</span></li>}
        </ul>
      </div>
      {/* Blocked, and what to do about it. The `auto_start` flag is the one
          thing this screen can change without a modal — the dependency EDGES
          stay the edit dialog's, since choosing them needs the task list. So
          each notice carries the button that flips the flag the other way: the
          answer to "this is blocked and I don't want to babysit it" is one
          click here rather than Edit → tick a box → Save. Same shape as the
          queued-start notice below, which owns its own Cancel for the same
          reason. */}
      {blocked && (task.auto_start ? (
        <div className="hero-blocked auto" title={`Starts automatically once done: ${blockedBy!.join(", ")}`}>
          {Icon.bolt()} <span>Queued: starts automatically once {blockedBy!.length === 1 ? <strong>{blockedBy![0]}</strong> : `${blockedBy!.length} tasks`} {blockedBy!.length === 1 ? "is" : "are"} done.</span>
          <button className="btn btn-line btn-sm" onClick={() => onSetAutoStart(false)} disabled={running} title="Leave it for you to start by hand once the blockers are done">Cancel</button>
        </div>
      ) : (
        <div className="hero-blocked" title={`Blocked until done: ${blockedBy!.join(", ")}`}>
          {Icon.lock()} <span>Blocked until {blockedBy!.length === 1 ? <strong>{blockedBy![0]}</strong> : `${blockedBy!.length} tasks`} {blockedBy!.length === 1 ? "is" : "are"} done. Edit the task to change its dependencies.</span>
          <button className="btn btn-line btn-sm" onClick={() => onSetAutoStart(true)} disabled={running}
            title={`Launch this task's first turn by itself once every blocker is done: ${blockedBy!.join(", ")}`}>
            {Icon.bolt()} Start when unblocked
          </button>
        </div>
      ))}
      {queued && !blocked && (
        <div className="hero-blocked auto" title={`Starts on its own ${wakeLabel(task.start_at)}, a minute after the usage window resets`}>
          {Icon.clock()} <span>Queued: starts <strong>{wakeLabel(task.start_at)}</strong> when the usage window resets.</span>
          <button className="btn btn-line btn-sm" onClick={onCancelQueuedStart} title="Leave it for you to start by hand">Cancel</button>
        </div>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="btn btn-accent" style={{ height: 38, padding: "0 20px", fontSize: 14 }} onClick={onStart} disabled={running || blocked} title={blocked ? `Blocked until done: ${blockedBy!.join(", ")}` : undefined}>
          {Icon.play()} {running ? "Starting…" : blocked ? (task.auto_start ? "Queued" : "Blocked") : queued ? "Start now" : "Start session"}
        </button>
        {/* "Start at reset": only when this task's agent reports a usage window
            with a known reset — the plan meter's data, so a Codex task or an
            API-key login never sees a button that would have nothing to aim
            at. Hidden once queued (the notice above owns cancelling) and while
            blocked (a dependency decides when it may start, not the clock). */}
        {!queued && !blocked && resetAt != null && (
          <button className="btn btn-line" style={{ height: 38, padding: "0 16px", fontSize: 14 }} onClick={() => onQueueStart(deferredStartFor(resetAt))} disabled={running}
            title="Queue this task to start on its own a minute after the usage window resets, no need to come back for it">
            {Icon.clock()} Start at reset ({resetClock(resetAt)})
          </button>
        )}
        <button className="btn btn-line" style={{ height: 38, padding: "0 16px", fontSize: 14 }} onClick={onEdit} disabled={running} title="Edit title & description before starting">
          {Icon.edit()} Edit
        </button>
      </div>
    </div>
  );
}

// Ref-backed identity-stable wrapper: Shell passes fresh inline handlers
// on every render, which would defeat MessageView's memo — the wrapper keeps one
// function identity for the component's lifetime while always invoking the
// latest handler.
function useStableHandler<A extends unknown[]>(fn?: (...args: A) => void): (...args: A) => void {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => { ref.current?.(...args); }, []);
}

/** The same trick for a handler whose RESULT the caller needs — the repair
 *  button shows its own failure inline instead of waiting for a transcript
 *  line, so its handler has to resolve to one. */
function useStableAsync<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

export function SessionView({ project, task, tagsById, agents, messages, running, blockedBy, transcriptLoading, onSend, onStart, onStop, onClear, clearConfirming, onConfirmClear, onCancelClear, onEdit, onReconnect, onSetStatus, onSetPriority, onSetModel, onSetReasoning, onSetPermission, onSetSendContext, onSetAutoStart, onSnooze, onUnsnooze, onQueueStart, onCancelQueuedStart, onResolveWithAI, onFixCi, onMerged, onPrCreated, onAnswer, onDecidePermission, onCancelQueued, onStartSuggestion, onAcceptSuggestion, onDismissSuggestion, onBack, mobile, railW, onRailWidth, onRailReset, railCollapsed, onRailCollapse, onRailExpand }: {
  project: ProjectRow; task: TaskRow; tagsById: Map<string, TagRow>; agents: AgentsBundle; messages: Msg[]; running: boolean; blockedBy?: string[]; transcriptLoading?: boolean;
  onSend: (t: string) => void; onStart: () => void; onStop: () => void; onClear: () => void; onEdit: () => void;
  clearConfirming?: boolean; onConfirmClear?: () => void; onCancelClear?: () => void;
  // Deep-link to Settings → Agents, for the transcript's "your login died" recovery button.
  onReconnect?: () => void;
  onSetStatus: (s: Status) => void; onSetPriority: (p: Priority) => void; onSetModel: (m: string | null) => void;
  onSetReasoning: (r: string | null) => void; onSetPermission: (p: string | null) => void;
  onSetSendContext: (v: boolean) => void;
  // The blocked-task hero's "Start when unblocked" toggle (tasks.auto_start).
  onSetAutoStart: (v: boolean) => void;
  onSnooze: (until: number) => void; onUnsnooze: () => void;
  // Queue / un-queue a start at the usage-window reset (PATCH start_at; see ./queuedStart.ts).
  onQueueStart: (at: number) => void; onCancelQueuedStart: () => void;
  onResolveWithAI: (taskId: string) => Promise<ResolveResult>;
  onFixCi: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  onMerged?: () => void;
  onPrCreated?: (url: string) => void;
  onAnswer: (askId: string, questions: AskQuestion[], answers: AskAnswers) => void;
  onDecidePermission: (permId: string, decision: PermissionDecision, note: string) => void;
  onCancelQueued: (pendingId: string) => void;
  // The Suggested tray's own three actions, reached from a suggestion card the
  // transcript settles onto the suggest_task call that filed the task. Passed
  // through rather than reimplemented: a suggestion started from the transcript
  // must behave exactly like one started from the tray.
  onStartSuggestion?: (taskId: string) => void | Promise<void>;
  onAcceptSuggestion?: (taskId: string) => void | Promise<void>;
  onDismissSuggestion?: (taskId: string) => void | Promise<void>;
  onBack?: () => void; mobile?: boolean;
  railW: number; onRailWidth: (w: number) => void; onRailReset: () => void;
  railCollapsed: boolean; onRailCollapse: () => void; onRailExpand: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  // Mobile: the header rail shows only the essentials (Chat/Changes, status)
  // until "More" expands it into wrapped rows with the full control set.
  const [toolsOpen, setToolsOpen] = useState(false);
  const [priOpen, setPriOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<"chat" | "changes">("chat");
  // Sync banner ↔ Changes tab coupling: both read the worktree's merge state,
  // so an accept/discard/land in Changes bumps `syncTick` to make the banner
  // re-read, and the banner's "Review" bumps `diffFocus` to bring the DIFF
  // rail tab forward (mobile has no rail — it switches the view instead).
  const [syncTick, setSyncTick] = useState(0);
  const onSyncChanged = useCallback(() => setSyncTick((n) => n + 1), []);
  const [diffFocus, setDiffFocus] = useState(0);
  // The banner's Accept & merge changes what a mounted Changes tab is showing
  // (its review state); it reloads on this counter, not on `syncTick`, which
  // Changes itself bumps and must not answer with a reload of its own.
  const [changesTick, setChangesTick] = useState(0);
  const onBannerChanged = useCallback(() => setChangesTick((n) => n + 1), []);
  const onReview = useCallback(() => {
    if (mobile) { setView("changes"); return; }
    if (railCollapsed) onRailExpand();
    setDiffFocus((n) => n + 1);
  }, [mobile, railCollapsed, onRailExpand]);
  const [clearEstimate, setClearEstimate] = useState<InternalUsageEstimate | null>(null);
  const sessions = useMemo(() => buildSessions(messages), [messages]);
  const hasSession = task.started === 1 || messages.length > 0;
  const awaiting = isAwaiting(task);
  // Live but silent for a long stretch (./idleTurn.ts). The transcript is the
  // one surface that can say WHY nobody should be surprised — the turn is open,
  // the model just isn't producing — so the age goes beside the typing dots and
  // the held-open notice rather than into a banner of its own.
  const idleTurn = isIdleTurn(task, running) && !awaiting;
  useIdleClock(idleTurn);
  const stableAnswer = useStableHandler(onAnswer);
  const stableDecidePermission = useStableHandler(onDecidePermission);
  const stableCancelQueued = useStableHandler(onCancelQueued);
  const stableClear = useStableHandler(onClear);
  const stableReconnect = useStableHandler(onReconnect);
  // When this task's agent says its usage window resets — the plan meter's
  // snapshot, keyed by agent, so only an agent that reports one gets the
  // queue-at-reset offers (the hero's button, the usage-limit notice's).
  const planUsage = usePlanUsage();
  const resetAt = usageResetAt(planUsage[task.agent] ?? null);
  const stableQueueStart = useStableHandler(onQueueStart);
  const stableCancelQueuedStart = useStableHandler(onCancelQueuedStart);
  const limitResume = useMemo<LimitResume>(
    () => ({ queuedAt: task.start_at, resetAt, onQueue: stableQueueStart, onCancel: stableCancelQueuedStart }),
    [task.start_at, resetAt, stableQueueStart, stableCancelQueuedStart],
  );
  // Retry for an approval-blocked failure (Transcript's APPROVAL_BLOCKED_NOTICE
  // branch): resend the user message that preceded the failure line — the Codex
  // driver has since negotiated a working approval policy, so the same message
  // goes through on the second attempt. Resolved at click time so the memoized
  // MessageView never needs the surrounding messages.
  const stableRetry = useStableHandler((msgId: string) => {
    const at = messages.findIndex((m) => m.id === msgId);
    for (let j = (at === -1 ? messages.length : at) - 1; j >= 0; j--) {
      if (messages[j].role === "user") { onSend(messages[j].content); return; }
    }
  });
  // Repair for a worktree-prep failure (Transcript's WORKTREE_REPAIR_NOTICE
  // branch): clear the stale lock / prune the stale registration / re-cut, then
  // send the message that never made it. An unstarted task has no user message
  // to resend — the opening one is only persisted once the worktree exists — so
  // that case starts the task instead, which is the same launch. Resolves to an
  // error string when the repair itself failed, so the button can say so rather
  // than resend a message that would fail identically.
  const stableRepairWorktree = useStableAsync(async (msgId: string): Promise<string | null> => {
    try {
      await jsend(`/api/tasks/${task.id}/repair-worktree`, "POST");
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    const at = messages.findIndex((m) => m.id === msgId);
    for (let j = (at === -1 ? messages.length : at) - 1; j >= 0; j--) {
      if (messages[j].role === "user") { onSend(messages[j].content); return null; }
    }
    onStart();
    return null;
  });
  // The suggestion card's three actions, identity-stable for MessageView's memo
  // and bundled into one object so the memo isn't defeated by a fresh literal
  // each render. `project.id` rides along because the card has to know whether
  // the suggestion was filed HERE — Start navigates, and a cross-project card
  // deliberately doesn't offer it (see SuggestionView).
  //
  // useStableAsync rather than useStableHandler: the card re-reads the task as
  // soon as the action resolves, so a wrapper that dropped the promise would
  // have it refetching the state the action hasn't finished changing.
  const stableStartSuggestion = useStableAsync(async (id: string) => { await onStartSuggestion?.(id); });
  const stableAcceptSuggestion = useStableAsync(async (id: string) => { await onAcceptSuggestion?.(id); });
  const stableDismissSuggestion = useStableAsync(async (id: string) => { await onDismissSuggestion?.(id); });
  const suggestionActions = useMemo<SuggestionActions>(
    () => ({ projectId: project.id, onStart: stableStartSuggestion, onAccept: stableAcceptSuggestion, onDismiss: stableDismissSuggestion }),
    [project.id, stableStartSuggestion, stableAcceptSuggestion, stableDismissSuggestion],
  );
  // Worktree-relative path open in collaboration mode from a tool card, or
  // null. Dropped on task switch: the path was resolved against THAT task's
  // worktree, and the setter is passed to MessageView as-is (a stable identity,
  // so the memo holds).
  const [collab, setCollab] = useState<string | null>(null);
  useEffect(() => { setCollab(null); }, [task.id]);
  const closeCollab = useCallback(() => setCollab(null), []);
  useEffect(() => {
    if (!clearConfirming) { setClearEstimate(null); return; }
    let alive = true;
    jget<{ estimate: InternalUsageEstimate | null }>(`/api/tasks/${task.id}/clear`)
      .then((r) => { if (alive) setClearEstimate(r.estimate); })
      .catch(() => { if (alive) setClearEstimate(null); });
    return () => { alive = false; };
  }, [clearConfirming, task.id]);
  // Run-control pickers + feature gates come from this task's agent capabilities,
  // never a hardcoded list — so the options always match the agent it runs under.
  const caps = capsFor(agents, task.agent);
  const models = modelOptions(caps);
  const reasoningOpts = reasoningOptions(caps);
  const permissionOpts = permissionOptions(caps);
  // Usage chip: tokens split into fresh work vs re-read cache (the raw total is
  // mostly cache reads and wildly overstates what ran), and a dollar figure whose
  // presentation follows how this agent is signed in — a subscription login's
  // figure is an API-price equivalent covered by plan quota, not a bill. Both
  // derivations live in ./format so the wording has one home.
  const usage = usageSplit(task);
  const cost = costDisplay(findAgent(agents, task.agent));
  const multiAgent = agents.agents.length > 1;
  // True while a question card is still unanswered — hides the "thinking" dots,
  // since Claude is parked on the user, not working.
  const awaitingAnswer = useMemo(() => messages.some((m) => {
    if (m.role !== "tool") return false;
    try { const d = JSON.parse(m.content) as ToolData; return !!d.ask && !d.ask.answers; } catch { return false; }
  }), [messages]);

  // Auto-scroll only while the user is parked at the bottom. If they scroll up to
  // read earlier output, we leave their position alone even as new messages stream
  // in, and surface a "jump to bottom" button instead.
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    pinned.current = bottom;
    setAtBottom(bottom);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    pinned.current = true;
    setAtBottom(true);
  }, []);

  // Jump between the user's own messages in the transcript. dir < 0 goes to the
  // previous one above the current scroll position, dir > 0 to the next below it;
  // queued (not-yet-sent) bubbles are excluded so nav only lands on real turns.
  const scrollToUserMsg = useCallback((dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    const base = el.getBoundingClientRect().top;
    const tops = Array.from(el.querySelectorAll<HTMLElement>(".msg.user:not(.queued)"))
      .map((n) => n.getBoundingClientRect().top - base + el.scrollTop);
    if (!tops.length) return;
    const cur = el.scrollTop;
    const eps = 8;
    let target: number;
    if (dir < 0) {
      const prev = tops.filter((t) => t < cur - eps);
      target = prev.length ? prev[prev.length - 1] : tops[0];
    } else {
      const next = tops.filter((t) => t > cur + eps);
      target = next.length ? next[0] : tops[tops.length - 1];
    }
    el.scrollTo({ top: Math.max(0, target - 12), behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (pinned.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, running]);

  // Switching tasks (or in/out of chat view) always jumps to the latest.
  useEffect(() => {
    pinned.current = true;
    setAtBottom(true);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [task.id, view]);

  const chatPane = (
    <>
      <div className="transcript-wrap">
      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="tw">
          {transcriptLoading && messages.length === 0 && (
            // Snapshot hasn't streamed in yet — sketch a user turn and an agent
            // reply so opening a started task never flashes an empty chat.
            <div aria-hidden>
              <div className="session-label"><span className="ln" />Loading session<span className="ln" /></div>
              <div className="msg user" style={{ opacity: .7 }}>
                <div className="who"><Skel w={18} h={18} r={5} /><Skel w={34} h={9} /></div>
                <div className="msg-body"><Skel w="72%" h={12} /><Skel w="46%" h={12} style={{ marginTop: 9 }} /></div>
              </div>
              <div className="msg" style={{ opacity: .7 }}>
                <div className="who"><Skel w={18} h={18} r={5} /><Skel w={70} h={9} /></div>
                <Skel w="90%" h={11} />
                <Skel w="83%" h={11} style={{ marginTop: 8 }} />
                <Skel w="58%" h={11} style={{ marginTop: 8 }} />
                <Skel w="100%" h={34} r="var(--r)" style={{ marginTop: 12 }} />
              </div>
            </div>
          )}
          {sessions.map((s, si) => (
            <div key={s.n}>
              {si > 0 && s.summaryBefore && <SessionBreak summary={s.summaryBefore} />}
              <div className="session-label"><span className="ln" />Session {s.n}{si === sessions.length - 1 ? " · current" : ""}<span className="ln" /></div>
              {s.messages.map((m, mi) => {
                const prev = s.messages[mi - 1];
                // collapse the repeated "Claude Code" header across an assistant run (text → tool → text)
                const hideWho = m.role === "assistant" && !!prev && (prev.role === "assistant" || prev.role === "tool");
                // Only the newest message may offer to resume at the reset —
                // an older usage-limit notice describes a limit that has healed.
                const last = si === sessions.length - 1 && mi === s.messages.length - 1;
                return <MessageView key={m.id} m={m} initial={mi === 0 && m.role === "user"} hideWho={hideWho} running={running} agent={task.agent} agentLabel={agentLabel(agents, task.agent)} onAnswer={stableAnswer} onDecidePermission={stableDecidePermission} onCancelQueued={stableCancelQueued} onClear={stableClear} onReconnect={stableReconnect} onRetry={stableRetry} onRepairWorktree={stableRepairWorktree} onCollaborate={setCollab} suggestionActions={suggestionActions} limitResume={last ? limitResume : undefined} />;
              })}
            </div>
          ))}
          {running && !awaitingAnswer && (
            // A lingering turn isn't "typing": the model stopped talking and
            // the session is held open for run_in_background work — say so, or
            // the dots promise imminent output that may be minutes away.
            task.background_pending ? (
              <div className="msg assistant"><div className="who"><Avatar who="cc" agent={task.agent} /> Agent</div><div className="msg-body"><span style={{ color: "var(--ink-2)", fontStyle: "italic" }}>{task.background_note ? `Session held open: ${task.background_note}. It continues on its own when that settles.` : "Working in background: the session stays open and continues when the task finishes."}</span>{idleTurn && <span className="idle-note" title={IDLE_TITLE}> {idleFor(task.idle_since ?? 0)}.</span>}</div></div>
            ) : (
              <div className="msg assistant"><div className="who"><Avatar who="cc" agent={task.agent} /> Agent</div><div className="msg-body">{idleTurn
                // The dots keep promising output. After this long they are the
                // wrong promise on their own, so the gap goes next to them —
                // without removing them, because the turn genuinely is still
                // live and may simply be inside a long tool call.
                ? <><span className="typing"><i /><i /><i /></span><span className="idle-note" title={IDLE_TITLE}> {idleFor(task.idle_since ?? 0)}.</span></>
                : <span className="typing"><i /><i /><i /></span>}</div></div>
            )
          )}
          {/* Follow-ups queued mid-turn, pinned below the live turn — they
              send in order once it ends. */}
          {messages.filter((m) => m.role === "queued").map((m) => (
            <MessageView key={m.id} m={m} initial={false} hideWho={false} onAnswer={stableAnswer} onDecidePermission={stableDecidePermission} onCancelQueued={stableCancelQueued} suggestionActions={suggestionActions} />
          ))}
        </div>
      </div>
      <div className="msg-nav">
        <button className="msg-nav-btn" onClick={() => scrollToUserMsg(-1)} title="Previous message" aria-label="Scroll to previous message">
          {Icon.chevUp()}
        </button>
        <button className="msg-nav-btn" onClick={() => scrollToUserMsg(1)} title="Next message" aria-label="Scroll to next message">
          {Icon.chevDown()}
        </button>
        {!atBottom && (
          <button className="msg-nav-btn" onClick={() => scrollToBottom()} title="Jump to latest" aria-label="Jump to latest">
            {Icon.toBottom()}
          </button>
        )}
      </div>
      </div>
      <Composer task={task} agentLabel={agentLabel(agents, task.agent)} disabled={task.started !== 1} running={running} onSend={onSend} onStop={onStop} onClear={onClear} />
    </>
  );

  // Header chips — rendered at the head of the tools rail on desktop, demoted
  // to its tail on mobile (see the rail's comment). Read-only but for Reclaim,
  // which sits with the PR chip because that is where "this landed" is shown.
  const infoChips = (
    <>
      {/* Live PR state — number, state, check rollup, review decision — read off
          the task row and kept fresh by lib/prState.ts. */}
      <PrChip task={task} />
      {/* The one exception to "read-only" here, and it belongs beside the chip
          that reports the fact it acts on: once this task's work has LANDED, one
          click frees the checkout, deletes the local branch and marks it done
          (lib/reclaim.ts). Renders nothing until then. */}
      <ReclaimButton task={task} />
      {/* Which feature(s) this session is a step of — a task can carry several.
          Clicking one lights that tag's chip in the list/board, the way the
          row badges do. */}
      <TagBadges tagIds={task.tag_ids} tagsById={tagsById} onSelect={(id) => selectOneTag(project.id, id)} />
      <AgentBadge label={agentLabel(agents, task.agent)} multi={multiAgent} />
      {(task.cost_usd > 0 || task.total_tokens > 0) && (
        <span className="usage-chip" title={usageTooltip(usage, task.cost_usd, cost)}>
          {fmtTokens(usage.fresh)} tok
          {usage.cacheRead > 0 && <> <span className="usage-dot">·</span> <span className="usage-cached">{fmtTokens(usage.cacheRead)} cached</span></>}
          {cost.show && <> <span className="usage-dot">·</span> {cost.approx && "~"}{fmtCost(task.cost_usd)}</>}
        </span>
      )}
    </>
  );

  // The status picker, extracted because the two layouts place it differently:
  // desktop keeps it inline between priority and snooze; mobile promotes it to
  // the rail's always-visible row (it's the control that answers "what state is
  // this task in" and flips it — the one thing a phone glance needs).
  const statusCtl = (
    <div style={{ position: "relative" }}>
      <button className={`status-ctl ${awaiting ? "awaiting" : ""}`} onClick={(e) => { e.stopPropagation(); setStatusOpen((o) => !o); setPriOpen(false); setModelOpen(false); setSettingsOpen(false); }}>
        <StatusDot status={task.status} running={running} awaiting={awaiting} background={!awaiting && running && !!task.background_pending} />
        <span className="cv">{awaiting ? AWAIT_LABEL : SLABEL[task.status]}</span>
        {Icon.chevDown()}
      </button>
      {statusOpen && (
        <Popover onClose={() => setStatusOpen(false)}>
          {STATUSES.map((s) => (
            <div key={s} className="pop-item" onClick={() => { onSetStatus(s); setStatusOpen(false); }}>
              <StatusDot status={s} />
              <div><div>{SLABEL[s]}</div><div className="pi-sub">{SSUB[s]}</div></div>
              {task.status === s && <span className="pi-check">{Icon.check()}</span>}
            </div>
          ))}
        </Popover>
      )}
    </div>
  );

  return (
      <div className="session">
        <div className="sess-head">
          {onBack && <button className="mobile-back" onClick={onBack} title="Back to tasks" aria-label="Back to tasks">{Icon.chevRight({ style: { transform: "rotate(180deg)" } })}</button>}
          <div className="sh-main">
            <div className="crumb">
              <span className="pic" style={{ width: 16, height: 16, borderRadius: 5, background: project.color, display: "grid", placeItems: "center", color: "#fff", fontSize: 9, fontWeight: 700 }}>{project.name[0]}</span>
              {project.name} <span className="sep">/</span> task
            </div>
            <div className="sh-title">{task.title}</div>
          </div>
          {/* Desktop: one row, everything inline, chips leading. Mobile: the
              rail defaults to the essentials — Chat/Changes, status, "More" —
              and More expands it into wrapped rows carrying the full control
              set with the read-only chips (PR link, agent, usage) last. One
              endless horizontal scroll of every control buried the core ones. */}
          <div className={`sh-tools${mobile && toolsOpen ? " open" : ""}`}>
            {mobile && hasSession && (
              <div className="viewseg">
                <button className={`viewseg-btn ${view === "chat" ? "on" : ""}`} onClick={() => setView("chat")}>Chat</button>
                <button className={`viewseg-btn ${view === "changes" ? "on" : ""}`} onClick={() => setView("changes")}>Changes</button>
              </div>
            )}
            {!mobile && infoChips}
            {mobile && statusCtl}
            {mobile && (
              <button className={`status-ctl${toolsOpen ? " on" : ""}`} aria-expanded={toolsOpen} title={toolsOpen ? "Hide extra task controls" : "Model, reasoning, priority, snooze & more"}
                onClick={() => setToolsOpen((o) => !o)}>
                {Icon.dots()} <span className="cv">{toolsOpen ? "Less" : "More"}</span>
              </button>
            )}
            {(!mobile || toolsOpen) && <>
            <div style={{ position: "relative" }}>
              <button className="status-ctl" title={`Model this task's ${agentLabel(agents, task.agent)} session uses`} onClick={(e) => { e.stopPropagation(); setModelOpen((o) => !o); setStatusOpen(false); setPriOpen(false); setSettingsOpen(false); }}>
                {Icon.spark()}
                {/* The chip says INHERIT_LABEL, never "Default" — the same word the
                    picker's head uses, so the two can't read as different states. */}
                <span className="cv">{models.find((m) => m.value === task.model)?.label ?? INHERIT_LABEL}</span>
                {task.resolved_model && <span className="model-badge" title={`Last ran on ${task.resolved_model}`}>{modelLabel(task.resolved_model, caps)}</span>}
                {Icon.chevDown()}
              </button>
              {modelOpen && (
                <Popover onClose={() => setModelOpen(false)}>
                  {models.map((m, i) => (
                    <Fragment key={m.label}>
                      {/* Section header whenever the group changes — Claude Code's
                          list runs to a dozen-plus pins, so it needs the structure. */}
                      {m.group && m.group !== models[i - 1]?.group && <div className="pop-sec">{m.group}</div>}
                      <div className="pop-item" onClick={() => { onSetModel(m.value); setModelOpen(false); }}>
                        <div><div>{m.label}</div><div className="pi-sub">{m.sub}</div></div>
                        {(task.model ?? null) === m.value && <span className="pi-check">{Icon.check()}</span>}
                      </div>
                      {/* Rule under the inherit head: everything below it is the
                          provider's own catalog, spelled the provider's way. */}
                      {m.value === null && <div className="divider" />}
                    </Fragment>
                  ))}
                </Popover>
              )}
            </div>
            <div style={{ position: "relative" }}>
              <button className="status-ctl" title="Reasoning level & permission mode for this task" onClick={(e) => { e.stopPropagation(); setSettingsOpen((o) => !o); setModelOpen(false); setStatusOpen(false); setPriOpen(false); }}>
                {Icon.gear()}
                <span className="cv">{reasoningOpts.find((r) => r.value === task.reasoning)?.label ?? INHERIT_LABEL}</span>
                {Icon.chevDown()}
              </button>
              {settingsOpen && (
                <Popover onClose={() => setSettingsOpen(false)}>
                  <div className="pop-sec">Reasoning</div>
                  {reasoningOpts.map((r) => (
                    <Fragment key={r.label}>
                      <div className="pop-item" onClick={() => { onSetReasoning(r.value); setSettingsOpen(false); }}>
                        <div><div>{r.label}</div><div className="pi-sub">{r.sub}</div></div>
                        {(task.reasoning ?? null) === r.value && <span className="pi-check">{Icon.check()}</span>}
                      </div>
                      {r.value === null && <div className="divider" />}
                    </Fragment>
                  ))}
                  <div className="divider" />
                  <div className="pop-sec">Permission</div>
                  {permissionOpts.map((p) => (
                    <Fragment key={p.label}>
                      <div className="pop-item" onClick={() => { onSetPermission(p.value); setSettingsOpen(false); }}>
                        <div><div>{p.label}</div><div className="pi-sub">{p.sub}</div></div>
                        {(task.permission_mode ?? null) === p.value && <span className="pi-check">{Icon.check()}</span>}
                      </div>
                      {/* Claude's own mode is spelled "default"; the rule keeps it
                          from reading as a second copy of the inherit head. */}
                      {p.value === null && <div className="divider" />}
                    </Fragment>
                  ))}
                </Popover>
              )}
            </div>
            <div style={{ position: "relative" }}>
              <button className="status-ctl" onClick={(e) => { e.stopPropagation(); setPriOpen((o) => !o); setStatusOpen(false); setModelOpen(false); setSettingsOpen(false); }}>
                {Icon.flag()} <span className="cv">{PLABEL[task.priority]}</span>
              </button>
              {priOpen && (
                <Popover onClose={() => setPriOpen(false)}>
                  {PRIORITIES.map((p) => (
                    <div key={p} className="pop-item" onClick={() => { onSetPriority(p); setPriOpen(false); }}>
                      <span className={`pri ${p}`}>{PLABEL[p].toUpperCase()}</span>
                      {task.priority === p && <span className="pi-check">{Icon.check()}</span>}
                    </div>
                  ))}
                </Popover>
              )}
            </div>
            {!mobile && statusCtl}
            {/* Snoozing, beside the status it deliberately does NOT change —
                the status is the category this task drops back into when the
                deadline passes. While parked, the control becomes the wake
                button and says when it would have come back on its own. */}
            {isSnoozed(task) ? (
              <button className="status-ctl snz-on" title={`Snoozed: wakes ${wakeLabel(task.snoozed_until)}. Click to wake it now.`}
                onClick={onUnsnooze}>
                {Icon.moon()} <span className="cv">Wakes {wakeLabel(task.snoozed_until)}</span>
              </button>
            ) : (
              <SnoozeButton className="status-ctl" label="Snooze" onSnooze={onSnooze} />
            )}
            {/* A started task queued to resume at the usage-window reset: the
                chip is the cancel, the way the snoozed chip is the wake. */}
            {hasSession && isQueuedStart(task) && !running && (
              <button className="status-ctl snz-on" title={`Resumes on its own ${wakeLabel(task.start_at)}, once the usage window resets. Click to cancel.`}
                onClick={onCancelQueuedStart}>
                {Icon.clock()} <span className="cv">Resumes {wakeLabel(task.start_at)}</span>
              </button>
            )}
            {/* The counterpart to TaskHero's Edit button, which only exists
                before the first session. Everything in that modal still applies
                to a task that has run — its title and description are the
                agent's task context on every future turn, its dependencies
                still gate it, and it can still be re-filed under another
                project (by discarding the worktree it cut from this one).
                Deliberately NOT disabled mid-turn: the transcript has replaced
                the only surface showing the description, so a live turn is
                exactly when "what did I actually ask for?" gets asked, and the
                modal is the sole way left to read or copy it. Nothing in there
                is unsafe against a running turn — the description is injected
                at SESSION start so an edit provably can't reach the turn in
                flight (which the field now says), the agent picker is already
                gated on `running`, Move is refused by the server with the
                reason shown inline, and Delete aborts the turn under the task
                lock before it tears the worktree down. */}
            {hasSession && (
              <button className="btn btn-line btn-sm" title="View & edit title, description, dependencies; or move this task to another project" onClick={onEdit}>{Icon.edit()} Edit</button>
            )}
            {hasSession && task.started === 1 && (
              <button className="btn btn-line btn-sm" title="Save summary & start a fresh context window" onClick={onClear} disabled={running}>{Icon.clear()} /clear</button>
            )}
            {mobile && infoChips}
            </>}
          </div>
        </div>

        {hasSession && (
          <SyncBanner taskId={task.id} running={running} refresh={syncTick} prMode={project.landing_mode === "pr"} onResolveWithAI={onResolveWithAI} onSwitchToChat={() => setView("chat")} onReview={onReview} onMerged={onMerged} onChanged={onBannerChanged} />
        )}

        {/* Red PR. Under the sync banner rather than over it: a task that is
            both behind its base AND red should be caught up first, since the
            catch-up is what its next CI run will actually test. */}
        {isPrRed(task) && (
          <CiBanner task={task} running={running} onFixCi={onFixCi} onSwitchToChat={() => setView("chat")} />
        )}

        {clearConfirming && (
          <div className="clear-confirm">
            <span>Save a summary and start a fresh context?</span>
            {clearEstimate && <span className="job-cost-hint">Estimated to use {fmtJobCost(clearEstimate)}</span>}
            <span className="spacer" />
            <button className="btn btn-ghost btn-sm" onClick={onCancelClear}>Cancel</button>
            <button className="btn btn-accent btn-sm" onClick={onConfirmClear}>{Icon.clear()} Confirm /clear</button>
          </div>
        )}

        {!hasSession ? (
          <TaskHero task={task} project={project} onStart={onStart} onEdit={onEdit} onSetSendContext={onSetSendContext} onSetAutoStart={onSetAutoStart} running={running} blockedBy={blockedBy} resetAt={resetAt} onQueueStart={onQueueStart} onCancelQueuedStart={onCancelQueuedStart} />
        ) : !mobile ? (
          // Desktop: transcript beside the DIFF / PREVIEW / CONTEXT rail. The
          // zero-width seam between them holds the drag handle (a 0px grid track),
          // so the rail can be resized just like the projects/tasks columns.
          // Collapsed → the rail is swapped for a slim spine that restores it,
          // handing the full width to the transcript (mirrors the side columns).
          railCollapsed ? (
            <div className="sess-split" style={{ gridTemplateColumns: "minmax(0,1fr) 30px" }}>
              <div className="sess-main">{chatPane}</div>
              <ColRail label="Diff & Context" right onExpand={onRailExpand} />
            </div>
          ) : (
            <div className="sess-split" style={{ gridTemplateColumns: `minmax(0,1fr) 0px ${railW}px` }}>
              <div className="sess-main">{chatPane}</div>
              <ColResize
                side="right" min={RAIL_W.min} max={RAIL_W.max}
                onWidth={onRailWidth} onReset={onRailReset}
              />
              <SessionRail
                project={project} task={task} sessions={sessions} running={running} reportsContext={caps?.reportsContext !== false}
                onResolveWithAI={onResolveWithAI} onMerged={onMerged} onPrCreated={onPrCreated} onSyncChanged={onSyncChanged} focusDiff={diffFocus} refreshChanges={changesTick} onClear={onClear} onCollapse={onRailCollapse} onSwitchToChat={() => { /* desktop transcript is always visible */ }}
                onSend={onSend}
              />
            </div>
          )
        ) : view === "changes" ? (
          <TaskChanges taskId={task.id} projectId={project.id} running={running} pr={task} landingMode={project.landing_mode} onMerged={onMerged} onPrCreated={onPrCreated} onSyncChanged={onSyncChanged} refresh={changesTick} onSend={onSend} onResolveWithAI={async (id) => {
            const res = await onResolveWithAI(id);
            // Resolution turn was kicked off (conflicts, not a clean merge) —
            // jump back to Chat so the user sees the message stream in. With
            // nothing left to resolve no turn starts, and this tab's review
            // state is the right place to stay.
            if (res.resolving) setView("chat");
            return res;
          }} />
        ) : (
          chatPane
        )}
      {/* Collaboration mode opened from a transcript tool card (the Changes
          tab mounts its own for files it lists). Same modal, same send path. */}
      {collab && (
        <CollabDoc taskId={task.id} file={collab} running={running} onClose={closeCollab} onSend={onSend} />
      )}
      </div>
  );
}
