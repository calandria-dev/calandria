"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Priority } from "@/lib/types";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { relTime, duration, fmtJobCost } from "./format";
import { SLABEL, permissionOptions, type BulkMoveResult, type DiscardPreview, type ProjectRow, type ProjectSession, type TaskRow, type AgentsBundle, type InternalUsageEstimate } from "./types";
import { agentLabel, defaultAgentFor, findAgent } from "./agents";
import { StatusDot, Skel, ErrNote } from "./shared";
import { Modal, BrowseDirButton, PrioritySeg, DepPicker } from "./Modal";
import { GitHubClonePicker } from "./github";
import { Markdown } from "../Markdown";
import { clientFeatures } from "@/lib/features";

// Segmented agent picker (Claude Code / Codex …). Hidden when only one agent is
// registered — nothing to choose. An unauthenticated agent is still selectable
// (you can create a not-started task and connect later) but flagged, with a
// Connect CTA that jumps to the setup wizard.
export function AgentPicker({ agents, value, onChange, onConnect, help, label = "Agent" }: {
  agents: AgentsBundle; value: string; onChange: (id: string) => void; onConnect?: () => void; help?: string; label?: string;
}) {
  if (agents.agents.length <= 1) return null;
  const sel = findAgent(agents, value);
  return (
    <div className="field">
      <div className="lab">{label}</div>
      <div className="seg" style={{ flexWrap: "wrap" }}>
        {agents.agents.map((a) => (
          <button key={a.id} className={a.id === value ? "on" : ""} onClick={() => onChange(a.id)}
            title={a.authenticated ? `Run on ${a.label}` : `${a.label} isn't connected yet`}>
            {a.label}{!a.authenticated && <span className="opt"> · not connected</span>}
          </button>
        ))}
      </div>
      {sel && !sel.authenticated ? (
        <div className="hlp" style={{ color: "var(--amber)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>{sel.label} isn’t connected — connect it before starting a session.</span>
          {onConnect && <button className="btn btn-line btn-sm" onClick={onConnect}>Connect {sel.label}</button>}
        </div>
      ) : (
        <div className="hlp">{help ?? "Can be changed until the task's first session starts."}</div>
      )}
    </div>
  );
}

export function NewTaskModal({ project, agents, tasks, onClose, onCreate, onOpenSetup }: { project: ProjectRow; agents: AgentsBundle; tasks: TaskRow[]; onClose: () => void; onCreate: (i: { title: string; desc: string; priority: Priority; agent: string; startNow: boolean; sendContext: boolean; depends_on: string[]; auto_start: boolean; permission_mode: string | null }) => void; onOpenSetup?: () => void }) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState<Priority>("med");
  const [agent, setAgent] = useState(() => defaultAgentFor(agents, project.default_agent));
  const [startNow, setStartNow] = useState(false);
  const [sendContext, setSendContext] = useState(project.send_context !== 0);
  const [deps, setDeps] = useState<string[]>([]);
  const [autoStart, setAutoStart] = useState(false);
  // null = the picker's "Default" head: inherit the app-level default, then the
  // driver's. Set here (not just in the session rail) because the auto-start
  // opt-in below decides this task will run with NOBODY WATCHING, and an
  // unattended permission prompt declines itself — so the one dialog that
  // schedules unattended work has to be able to say "don't stop to ask".
  const [permission, setPermission] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  // The bundle can arrive after mount; adopt the resolved default until the user picks.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setAgent(defaultAgentFor(agents, project.default_agent)); }, [agents, project.default_agent]);
  const pickAgent = (id: string) => { touched.current = true; setAgent(id); };
  const can = title.trim().length > 0;
  // A task with unfinished blockers can't start now, so the two options are exclusive.
  const blocked = deps.some((id) => tasks.find((t) => t.id === id)?.status !== "done");
  // Can't launch a session on an agent that isn't signed in — but the task can
  // still be created (not started) and started once the agent is connected.
  const selAgent = findAgent(agents, agent);
  const agentReady = selAgent ? selAgent.authenticated : true;
  const canStart = !blocked && agentReady;
  const willAutoStart = autoStart && deps.length > 0;
  const permissionOpts = permissionOptions(selAgent?.capabilities);
  // Auto-run is the only mode that never parks on a card. "Default" (null) can
  // resolve to one that does, so it counts as unsafe-for-unattended too — we
  // deliberately don't guess what it resolves to and claim it's fine.
  const unattendedRisk = willAutoStart && permission !== "bypassPermissions";
  const create = () => can && onCreate({ title: title.trim(), desc: desc.trim(), priority, agent, startNow: startNow && canStart, sendContext, depends_on: deps, auto_start: willAutoStart, permission_mode: permission });
  return (
    <Modal title="New task" sub={`${project.name} · title + description define ${agentLabel(agents, agent)}'s task context`} onClose={onClose}
      footer={<>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: !canStart ? "var(--ink-4)" : "var(--ink-2)", cursor: !canStart ? "not-allowed" : "pointer" }}
          title={blocked ? "Can't start now — this task is blocked by unfinished tasks" : !agentReady ? `Connect ${selAgent?.label} to start a session` : undefined}>
          <input type="checkbox" checked={startNow && canStart} disabled={!canStart} onChange={(e) => setStartNow(e.target.checked)} /> Start session immediately
        </label>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" disabled={!can} onClick={create}>{Icon.plus()} Create task</button>
      </>}>
      <div className="field">
        <div className="lab">Title</div>
        <input ref={ref} type="text" value={title} placeholder="e.g. Add rate-limiting to auth endpoints"
          onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && can) create(); }} />
      </div>
      <div className="field">
        <div className="lab">Description <span className="opt">— what to do</span></div>
        <textarea value={desc} placeholder="Describe the feature or task. The agent receives this in its injected task context." onChange={(e) => setDesc(e.target.value)} />
        {sendContext && <div className="hlp">Project context is prepended automatically — no need to restate the stack or conventions.</div>}
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12.5, color: "var(--ink-2)", cursor: "pointer" }}
          title="Uncheck to start this task's sessions without the saved project context. Task details and orchestrator tools are always included.">
          <input type="checkbox" checked={sendContext} onChange={(e) => setSendContext(e.target.checked)} />
          Send saved project context to the agent
        </label>
      </div>
      <AgentPicker agents={agents} value={agent} onChange={pickAgent} onConnect={onOpenSetup} />
      <div className="field">
        <div className="lab">Priority</div>
        <PrioritySeg value={priority} onChange={setPriority} />
      </div>
      {permissionOpts.length > 1 && (
        <div className="field">
          <div className="lab">{Icon.lock()} Permission mode</div>
          <div className="seg" style={{ flexWrap: "wrap", maxWidth: 520 }}>
            {permissionOpts.map((p) => (
              <button key={p.label} className={permission === p.value ? "on" : ""} title={p.sub}
                onClick={() => setPermission(p.value)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="hlp">
            {permissionOpts.find((p) => p.value === permission)?.sub ?? "inherit the agent's default"}
            {" — changeable later from the session rail."}
          </div>
        </div>
      )}
      <DepPicker candidates={tasks} value={deps} onChange={setDeps} autoStart={autoStart} onAutoStart={setAutoStart} />
      {unattendedRisk && (
        <div className="hlp" style={{ color: "var(--amber)" }}>
          This task auto-starts when its blockers clear, which may be while nobody is watching. Any mode but{" "}
          <strong>Auto-run</strong> parks on a permission card, and an unanswered card declines itself and stops the
          turn. Pick Auto-run if it needs to run all the way through unattended.
        </div>
      )}
    </Modal>
  );
}

// The destination radio list, shared by the single-task field below and the
// bulk MoveTasksModal — one rendering of "which project", so the two paths
// can't drift on what a destination looks like.
function ProjectTargetList({ targets, value, onChange, name }: {
  targets: ProjectRow[]; value: string; onChange: (id: string) => void; name: string;
}) {
  return (
    <div className="dep-list">
      {targets.map((p) => (
        <label key={p.id} className={`dep-row ${value === p.id ? "on" : ""}`}>
          <input type="radio" name={name} checked={value === p.id} onChange={() => onChange(p.id)} />
          <span aria-hidden style={{ width: 15, height: 15, borderRadius: 5, background: p.color, flex: "0 0 auto" }} />
          <span className="dep-title">{p.name}</span>
          <span className="dep-status">{p.task_count} task{p.task_count !== 1 ? "s" : ""}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * Whether a task moving into `dest` would have its inherited settings
 * re-derived, and what to. Mirrors moveTask's rule server-side (lib/store.ts
 * deriveMoved): a value that still matches the CURRENT project's default reads
 * as inherited, so it re-derives in the destination — an explicit choice
 * travels with the task. Previewed rather than sprung on the user, since the
 * guess can only ever be a guess.
 */
function moveDerivation(task: TaskRow, src: ProjectRow | undefined, dest: ProjectRow) {
  const destAgent = dest.default_agent || "claude";
  const switching = task.agent === (src?.default_agent || "claude") && destAgent !== task.agent ? destAgent : null;
  const srcSend = src ? (src.send_context !== 0 ? 1 : 0) : 1;
  const destSend = dest.send_context !== 0 ? 1 : 0;
  const contextFlip = task.send_context === srcSend && destSend !== task.send_context ? destSend : null;
  return { switching, contextFlip };
}

// Re-parent a misfiled task. Acts immediately (like Delete below it) rather
// than riding along with Save: a move isn't a field set — it renumbers the
// task's order in the destination, re-derives what it inherited from the old
// project, re-points the sessions and spend recorded against the old one, and
// drops the blocked-by links that would otherwise span projects.
//
// A STARTED task can move too, but only by throwing away the git worktree it
// was working in — that checkout was cut from the current project's repo, and
// no amount of re-parenting makes it belong to another one. So the field turns
// into the same two-step confirmation Delete uses, and it names the cost first:
// what's in that worktree is read from the server (uncommitted edits, commits
// the base branch never took) rather than guessed at, because "merged and
// clean" and "an afternoon of unsaved work" are the same button otherwise.
//
// (Re-filing SEVERAL tasks is the task list's multi-select + MoveTasksModal —
// which can keep a link whose both ends are moving, as one task alone can't,
// and which asks this same question once per started row.)
function MoveProjectField({ task, tasks, projects, agents, onMove }: {
  task: TaskRow; tasks: TaskRow[]; projects: ProjectRow[]; agents: AgentsBundle;
  onMove: (id: string, projectId: string, opts?: { discardWorktree?: boolean; discardUnsafe?: boolean }) => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [moving, setMoving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState<DiscardPreview | null>(null);
  const targets = useMemo(() => projects.filter((p) => p.id !== task.project_id), [projects, task.project_id]);
  const dest = targets.find((p) => p.id === target) ?? null;

  // What the teardown would cost, read once a destination is picked. Cheap for
  // a task with no worktree (the route answers without touching git), so it's
  // not worth gating on `started` — which is only half the story anyway: a
  // failed launch can leave a worktree on a task that never opened a session.
  const loadPreview = useCallback(() => {
    jget<DiscardPreview>(`/api/tasks/${task.id}/move`).then(setPreview).catch(() => setPreview(null));
  }, [task.id]);
  useEffect(() => { if (target) loadPreview(); }, [target, loadPreview]);

  if (targets.length === 0) return null;
  // Every edge touching this task goes — the ones it owns and the ones pointing
  // at it. Counted from the persisted rows, so unsaved picker edits don't lie.
  const dependents = tasks.filter((t) => t.id !== task.id && (t.depends_on ?? []).includes(task.id)).length;
  const links = (task.depends_on?.length ?? 0) + dependents;
  const src = projects.find((p) => p.id === task.project_id);
  const { switching, contextFlip } = dest ? moveDerivation(task, src, dest) : { switching: null, contextFlip: null };
  // The server refuses a started task without the acknowledgement even when its
  // worktree is already gone, so `started` alone is enough to require one.
  const needsAck = task.started === 1 || !!preview?.has_worktree;
  const unsafe = !!preview && preview.has_worktree && !preview.safe;

  const move = async () => {
    if (!dest) return;
    // Two-step, like Delete: the first click on a started task's button only
    // arms it, so the cost below is on screen before anything is destroyed.
    if (needsAck && !confirm) return setConfirm(true);
    setMoving(true);
    setErr(null);
    try {
      await onMove(task.id, dest.id, needsAck ? { discardWorktree: true, discardUnsafe: unsafe } : undefined);
    } catch (e) {
      // The one refusal the user can answer: the worktree picked up unsaved work
      // between the preview and the click (their own editor — no turn can run
      // while this is held). Re-read it so the warning now names what's there,
      // and disarm, so confirming again is a decision about the real state.
      setErr(e instanceof Error ? e.message : String(e));
      setConfirm(false);
      loadPreview();
      setMoving(false);
    }
  };

  const label = !needsAck ? `Move to ${dest?.name}` : confirm ? "Move and discard the worktree" : "Discard worktree and move…";
  return (
    <div className="field">
      <div className="lab">Move to project <span className="opt">{task.started === 1 ? "— discards this task's worktree" : "— transcript and history come along"}</span></div>
      <ProjectTargetList targets={targets} value={target} name="move-project" onChange={(id) => { setTarget(id); setErr(null); setConfirm(false); }} />
      {dest ? (
        <>
          <div className="hlp" style={{ color: "var(--amber)" }}>
            Moves this task to {dest.name} right away — unsaved edits above are discarded.
            {links > 0 && ` ${links} blocked-by link${links !== 1 ? "s" : ""} drop${links === 1 ? "s" : ""}: dependencies can't span projects.`}
            {switching && ` It will run on ${agentLabel(agents, switching)}, ${dest.name}'s default.`}
            {contextFlip === 1 && ` Sessions will include ${dest.name}'s saved project context.`}
            {contextFlip === 0 && ` Sessions won't include project context — ${dest.name}'s default.`}
          </div>
          {needsAck && (
            <div className="hlp" style={{ color: unsafe ? "var(--red)" : "var(--amber)", marginTop: 8 }}>
              {preview?.has_worktree ? (
                <>
                  This task&rsquo;s git worktree{preview.branch && <> and branch <code>{preview.branch}</code></>} belong to{" "}
                  {src?.name ?? "its current project"}&rsquo;s repo, so moving deletes them.{" "}
                  {unsafe
                    ? `That destroys ${preview.reason} — permanently, with no way back.`
                    : "Nothing is lost: it's clean and everything on it is already in the base branch."}
                </>
              ) : (
                <>This task has already run, so it moves as a started task: the next turn cuts a fresh worktree from {dest.name}&rsquo;s repo.</>
              )}{" "}
              The transcript, summaries and cost history come with it; the merge and PR it recorded against{" "}
              {src?.name ?? "the old project"} do not.
            </div>
          )}
          <button className={confirm ? "btn-danger on" : "btn btn-line"} style={{ marginTop: 8 }} disabled={moving} onClick={move}>
            {confirm ? Icon.x() : Icon.chevRight()} {moving ? "Moving…" : label}
          </button>
        </>
      ) : (
        <div className="hlp">Pick a project to re-file this task under. Its transcript and description come with it.</div>
      )}
      {err && <ErrNote style={{ marginTop: 8 }}>{err}</ErrNote>}
    </div>
  );
}

/**
 * Re-file a whole selection at once — the answer to a handful of tasks landing
 * in the wrong project, which used to be one open-edit-pick-move round trip
 * each. One request, one transaction, one event for the other tabs.
 *
 * Three things it says that the single-task field can't. Dependencies: a link
 * whose BOTH ends are in the selection SURVIVES the move (it stays inside one
 * project, so nothing is violated) — the count of what's kept is previewed
 * beside the count of what drops, because "select the whole chain" is the
 * difference between the two. Refusals are per task: a task that couldn't move
 * is reported by name afterwards rather than quietly left behind, so the modal
 * stays open on a partial result instead of closing on a half-truth.
 *
 * And the started ones. A task that has run holds a worktree cut from the old
 * repo and can only move by having it destroyed, which is a different
 * irreversible answer for every row — so every row gets its OWN checkbox, off
 * until ticked, carrying what that particular checkout holds (read for the
 * whole selection in one go by GET /api/tasks/move). One switch over eleven of
 * them would be a shrug; eleven answers is the thing itself. Ticking none is
 * the old behaviour exactly, and a row left unticked is reported in `skipped`
 * with its checkout untouched — three dirty worktrees don't refuse the eight
 * clean ones.
 */
export function MoveTasksModal({ selected, tasks, projects, agents, sourceProjectId, onClose, onMove, onMoved }: {
  /** The picked rows, in list order. */
  selected: TaskRow[];
  /** Every task in the source project — needed to see links pointing INTO the selection. */
  tasks: TaskRow[];
  projects: ProjectRow[]; agents: AgentsBundle; sourceProjectId: string;
  onClose: () => void;
  onMove: (ids: string[], projectId: string, opts?: { discard?: string[]; discardUnsafe?: string[] }) => Promise<BulkMoveResult>;
  /** Ids that actually moved, so the caller can drop them from the selection. */
  onMoved: (movedIds: string[]) => void;
}) {
  const [target, setTarget] = useState("");
  const [moving, setMoving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<BulkMoveResult | null>(null);
  // Null until the read lands: "not known yet" and "nothing to discard" are
  // different answers, and only one of them may be ticked.
  const [previews, setPreviews] = useState<Record<string, DiscardPreview> | null>(null);
  const [previewErr, setPreviewErr] = useState(false);
  const [discard, setDiscard] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const targets = useMemo(() => projects.filter((p) => p.id !== sourceProjectId), [projects, sourceProjectId]);
  const dest = targets.find((p) => p.id === target) ?? null;
  const src = projects.find((p) => p.id === sourceProjectId);

  // What each row's checkout holds, for the whole selection in one read — a
  // checkbox that doesn't say what it destroys is the blanket switch again,
  // just spelled out N times. Fetched on open rather than when a destination is
  // picked (unlike the single-task field): here it decides which rows can be
  // ticked at all, so it's part of the list, not part of the confirmation.
  const idKey = selected.map((t) => t.id).join(",");
  useEffect(() => {
    let alive = true;
    if (!idKey) return;
    jget<{ previews: Record<string, DiscardPreview> }>(`/api/tasks/move?${new URLSearchParams({ ids: idKey })}`)
      .then((r) => { if (alive) setPreviews(r.previews); })
      // Not fatal — the unstarted rows still move — but no row can be ticked
      // without it, so the failure has to be visible rather than looking like
      // "these worktrees hold nothing".
      .catch(() => { if (alive) setPreviewErr(true); });
    return () => { alive = false; };
  }, [idKey]);

  // A live turn can't be moved by any answer — nothing may delete a worktree an
  // agent is writing into. Everything else that has run needs one: `started`
  // alone is enough (the server refuses it even with the worktree already
  // reclaimed), and a worktree on a task that never opened a session — a failed
  // launch — needs it too, which only the preview can see.
  const pv = previews ?? {};
  const isLive = (t: TaskRow) => t.running === 1;
  const needsAck = (t: TaskRow) => !isLive(t) && (t.started === 1 || !!pv[t.id]?.has_worktree);
  // An answer can only be given once the question is on screen: until the read
  // lands, a started row's box is inert. Ticking one on a "nothing to discard"
  // that only meant "still loading" would destroy a checkout nobody described.
  const canAck = previews !== null;
  const ticked = new Set(discard);
  const unsafeOf = (t: TaskRow) => { const p = pv[t.id]; return !!p?.has_worktree && !p.safe; };
  const movable = selected.filter((t) => !isLive(t) && (!needsAck(t) || ticked.has(t.id)));
  const stuck = selected.length - movable.length;
  const moving_ = new Set(movable.map((t) => t.id));
  // Only what's actually going: a ticked row whose turn started under the modal
  // is refused anyway, and its answer shouldn't ride along.
  const discarding = movable.filter((t) => ticked.has(t.id));
  const unsafeTicked = discarding.filter(unsafeOf);
  const toggle = (id: string, on: boolean) => {
    // Arming describes the answers as they stand, so changing one disarms.
    setConfirm(false);
    setDiscard((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));
  };
  // Every blocked-by link with at least one end in the moving set. Both ends
  // moving means it survives; one end means it would span projects, so it goes.
  let kept = 0;
  let dropped = 0;
  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      const from = moving_.has(t.id);
      const to = moving_.has(dep);
      if (from && to) kept++;
      else if (from || to) dropped++;
    }
  }
  const switching = dest ? movable.filter((t) => moveDerivation(t, src, dest).switching).length : 0;
  const contextFlips = dest ? movable.filter((t) => moveDerivation(t, src, dest).contextFlip !== null).length : 0;

  const move = async () => {
    if (!dest) return;
    // Two-step once anything is being destroyed, like the single-task field and
    // like Delete: the first click only arms it, with the total on screen.
    if (discarding.length > 0 && !confirm) return setConfirm(true);
    setMoving(true);
    setErr(null);
    try {
      // Every selected id, not the locally movable subset: the client's view of
      // what can move is a snapshot that can be stale by now (a task the user
      // started while this was open, or one whose turn is merely in flight,
      // which the client can't see at all). Sending them all means the server
      // reports what it refused instead of us quietly dropping it.
      //
      // The acknowledgements are the narrow half: only the rows ticked, and
      // `discardUnsafe` only where the user was actually shown unsaved work.
      // A row that picked one up since is refused by the server's own re-read,
      // which is what keeps "nothing unsaved dies unnamed" true here too.
      const res = await onMove(selected.map((t) => t.id), dest.id, {
        discard: discarding.map((t) => t.id),
        discardUnsafe: unsafeTicked.map((t) => t.id),
      });
      onMoved(res.moved);
      // A clean sweep needs no report — anything left behind does.
      if (res.skipped.length === 0) onClose();
      else setResult(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setMoving(false);
    }
  };

  const byId = new Map(selected.map((t) => [t.id, t]));
  const n = selected.length;
  return (
    <Modal title={`Move ${n} task${n !== 1 ? "s" : ""}`} sub="Re-file the selection under another project" onClose={onClose}
      footer={<>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>{result ? "Done" : "Cancel"}</button>
        {!result && (
          <button className={confirm ? "btn-danger on" : "btn btn-accent"} disabled={!dest || moving || movable.length === 0} onClick={move}>
            {confirm ? Icon.x() : Icon.check()}{" "}
            {moving ? "Moving…" : !dest ? "Move" : discarding.length === 0 ? `Move to ${dest.name}` : confirm
              ? `Move and discard ${discarding.length} worktree${discarding.length !== 1 ? "s" : ""}`
              : `Discard ${discarding.length} worktree${discarding.length !== 1 ? "s" : ""} and move…`}
          </button>
        )}
      </>}>
      {result ? (
        <div className="field">
          <div className="lab">Result</div>
          <div className="hlp">{result.moved.length} task{result.moved.length !== 1 ? "s" : ""} moved to {dest?.name}.</div>
          {result.discarded.length > 0 && (
            <div className="hlp" style={{ color: "var(--amber)", marginTop: 4 }}>
              {result.discarded.length} worktree{result.discarded.length !== 1 ? "s" : ""} and{" "}
              {result.discarded.length !== 1 ? "their branches" : "its branch"} were deleted from {src?.name ?? "the old project"}
              &rsquo;s repo. The next turn cuts a fresh one from {dest?.name}.
            </div>
          )}
          {result.skipped.length > 0 && (
            <>
              <div className="hlp" style={{ color: "var(--amber)", marginTop: 8 }}>
                {result.skipped.length} stayed behind:
              </div>
              <div className="dep-list" style={{ marginTop: 6 }}>
                {result.skipped.map((s) => (
                  <div key={s.id} className="dep-row" style={{ cursor: "default" }}>
                    <span className="dep-title">{byId.get(s.id)?.title ?? s.id}</span>
                    <span className="dep-status">{s.reason.split(" — ")[0]}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="field">
            <div className="lab">Moving <span className="opt">— tick a started task to discard its worktree</span></div>
            <div className="dep-list">
              {selected.map((t) => {
                const ack = needsAck(t);
                const on = ticked.has(t.id);
                const p = pv[t.id];
                const unsafe = unsafeOf(t);
                const can = moving_.has(t.id);
                return (
                  // The row IS the question for a started task: the checkbox
                  // beside the cost of that one checkout, off until answered.
                  <label key={t.id} className={`dep-row ${on ? "on" : ""}`} style={{ cursor: ack && canAck ? "pointer" : "default", opacity: can || ack ? 1 : 0.55 }}>
                    {ack && <input type="checkbox" checked={on} disabled={!canAck} onChange={(e) => toggle(t.id, e.target.checked)} />}
                    <StatusDot status={t.status} />
                    <span className="dep-title">{t.title}</span>
                    <span className="dep-status" style={{ color: unsafe || previewErr ? "var(--red)" : ack || isLive(t) ? "var(--amber)" : undefined }}>
                      {isLive(t) ? "running — stays"
                        : !ack ? ""
                        : !canAck ? (previewErr ? "couldn't read its worktree" : "reading its worktree…")
                        : unsafe ? `${on ? "discards" : "holds"} ${p!.reason}`
                        : p?.has_worktree ? `${on ? "discards" : "holds"} worktree ${p.branch}`
                        : on ? "started — moves, no worktree left" : "started — nothing to discard"}
                    </span>
                  </label>
                );
              })}
            </div>
            {previewErr && (
              <div className="hlp" style={{ color: "var(--red)" }}>
                Couldn&rsquo;t read what these worktrees hold, so none of them can be discarded from here — a checkbox that
                can&rsquo;t say what it destroys isn&rsquo;t worth ticking. The rest of the selection still moves.
              </div>
            )}
            {unsafeTicked.length > 0 && (
              <div className="hlp" style={{ color: "var(--red)" }}>
                {unsafeTicked.length === 1 ? "One ticked worktree holds" : `${unsafeTicked.length} ticked worktrees hold`} work
                nothing else has: it is destroyed permanently, with no way back.
              </div>
            )}
            {stuck > 0 && (
              <div className="hlp" style={{ color: "var(--amber)" }}>
                {stuck} of these {stuck === 1 ? "stays" : "stay"} put — {stuck === 1 ? "it holds" : "they hold"} a git worktree cut
                from {src?.name ?? "this project"}&rsquo;s repo, or {stuck === 1 ? "is" : "are"} mid-turn. The rest still move.
              </div>
            )}
          </div>
          <div className="field">
            <div className="lab">Destination</div>
            <ProjectTargetList targets={targets} value={target} name="move-tasks-project" onChange={(id) => { setTarget(id); setErr(null); setConfirm(false); }} />
            {dest ? (
              <div className="hlp" style={{ color: "var(--amber)" }}>
                Moves {movable.length} task{movable.length !== 1 ? "s" : ""} to {dest.name} right away.
                {dropped > 0 && ` ${dropped} blocked-by link${dropped !== 1 ? "s" : ""} drop${dropped === 1 ? "s" : ""} — the other end isn't coming.`}
                {kept > 0 && ` ${kept} link${kept !== 1 ? "s" : ""} survive${kept === 1 ? "s" : ""}: both ends are moving together.`}
                {switching > 0 && ` ${switching} will switch to ${agentLabel(agents, dest.default_agent || "claude")}, ${dest.name}'s default agent.`}
                {contextFlips > 0 && ` ${contextFlips} will follow ${dest.name}'s project-context setting.`}
              </div>
            ) : (
              <div className="hlp">Pick a project to re-file these under. Transcripts and descriptions come with them.</div>
            )}
          </div>
          {err && <ErrNote>{err}</ErrNote>}
        </>
      )}
    </Modal>
  );
}

export function EditTaskModal({ task, tasks, projects, agents, onClose, onSave, onDelete, onMove, onOpenSetup }: { task: TaskRow; tasks: TaskRow[]; projects: ProjectRow[]; agents: AgentsBundle; onClose: () => void; onSave: (id: string, patch: { title: string; description: string; priority: Priority; agent?: string; depends_on: string[]; auto_start: boolean }) => void; onDelete: (id: string) => void; onMove: (id: string, projectId: string, opts?: { discardWorktree?: boolean; discardUnsafe?: boolean }) => Promise<void>; onOpenSetup?: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [agent, setAgent] = useState(task.agent);
  const [deps, setDeps] = useState<string[]>(task.depends_on ?? []);
  const [autoStart, setAutoStart] = useState(!!task.auto_start);
  const [confirmDel, setConfirmDel] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const can = title.trim().length > 0;
  const canChangeAgent = task.started === 0 && task.running === 0;
  const candidates = useMemo(() => tasks.filter((t) => t.id !== task.id), [tasks, task.id]);
  const save = () => can && onSave(task.id, { title: title.trim(), description: desc.trim(), priority, agent: canChangeAgent ? agent : undefined, depends_on: deps, auto_start: autoStart && deps.length > 0 });
  return (
    <Modal title="Edit task" sub="Title + description define the agent's task context" onClose={onClose}
      footer={<>
        {confirmDel ? (
          <button className="btn-danger on" onClick={() => onDelete(task.id)} title="Permanently remove this task, its session and worktree">{Icon.x()} Delete task permanently</button>
        ) : (
          <button className="btn-danger" onClick={() => setConfirmDel(true)}>{Icon.x()} Delete task</button>
        )}
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" disabled={!can} onClick={save}>{Icon.check()} Save changes</button>
      </>}>
      <div className="field">
        <div className="lab">Title</div>
        <input ref={ref} type="text" value={title} placeholder="e.g. Add rate-limiting to auth endpoints"
          onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && can) save(); }} />
      </div>
      <div className="field">
        <div className="lab">Description <span className="opt">— what to do</span></div>
        <textarea value={desc} placeholder="Describe the feature or task. This is the body of the prompt the agent starts with." onChange={(e) => setDesc(e.target.value)} />
        {/* The description is injected into each SESSION's system prompt at
            session start, so once a task has run this field is no longer the
            thing steering the agent in front of you — it's the brief the NEXT
            session gets. Said plainly, because the pre-start wording ("the body
            of the prompt the agent starts with") invites the opposite reading. */}
        {task.started === 1 ? (
          <div className="hlp">Already sent to the agent — edits here update the task record and any future sessions, not the running one.</div>
        ) : (
          <div className="hlp">Project context is prepended automatically — no need to restate the stack or conventions.</div>
        )}
      </div>
      {canChangeAgent && <AgentPicker agents={agents} value={agent} onChange={setAgent} onConnect={onOpenSetup} />}
      <div className="field">
        <div className="lab">Priority</div>
        <PrioritySeg value={priority} onChange={setPriority} />
      </div>
      <DepPicker candidates={candidates} value={deps} onChange={setDeps} autoStart={autoStart} onAutoStart={setAutoStart} />
      {/* Unlike the agent picker above, this is NOT gated on the task being
          unstarted: a started one can move by discarding the worktree it cut
          from this project's repo, which the field asks for explicitly. Only a
          live turn is refused outright, and the field surfaces the server's
          reason. */}
      <MoveProjectField task={task} tasks={tasks} projects={projects} agents={agents} onMove={onMove} />
      {confirmDel && (
        <div className="hlp" style={{ color: "var(--red)", marginTop: 16 }}>
          This permanently removes “{task.title}”, its agent session and git worktree from the orchestrator. Any unmerged work in the worktree is discarded.
        </div>
      )}
    </Modal>
  );
}

// Mirror of the server's RefreshState (lib/contextRefresh.ts) — the detached
// "Refresh with AI" job state the modal polls.
type RefreshState = { status: "idle" | "running" | "done" | "error"; draft: string; error: string; started_at: number; estimate?: InternalUsageEstimate | null };

export function ContextModal({ project, agents, onSetDefaultAgent, onClose, onSave, onDelete, onDeprecate }: { project: ProjectRow; agents: AgentsBundle; onSetDefaultAgent: (agent: string) => void; onClose: () => void; onSave: (p: { name: string; context: string; send_context: number; repo_path: string; branch: string; dev_command: string; setup_command: string; test_command: string }) => void; onDelete: () => void; onDeprecate: () => void }) {
  const [name, setName] = useState(project.name);
  const [context, setContext] = useState(project.context);
  const [sendContext, setSendContext] = useState(project.send_context !== 0);
  const [repo, setRepo] = useState(project.repo_path);
  const [branch, setBranch] = useState(project.branch);
  const [devCmd, setDevCmd] = useState(project.dev_command);
  const [setupCmd, setSetupCmd] = useState(project.setup_command);
  const [testCmd, setTestCmd] = useState(project.test_command);
  const [confirmDel, setConfirmDel] = useState(false);
  const showServices = clientFeatures().services;
  // AI context refresh: let Claude read the repo and draft fresh context. The
  // draft now runs as a DETACHED server-side job (it can take minutes and must
  // survive sleep/reload), so the client starts it and polls for the result
  // rather than holding one long request open. The drafted text replaces the
  // textarea but isn't saved until Save — we stash the prior text for Undo.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  const [prevContext, setPrevContext] = useState<string | null>(null);
  const [refreshEstimate, setRefreshEstimate] = useState<InternalUsageEstimate | null>(null);
  // Edit vs. rendered-markdown preview of the context. Refreshing forces edit
  // (the textarea shows the disabled/loading state).
  const [preview, setPreview] = useState(false);
  const showPreview = preview && !refreshing;

  // Latest edited context, read inside async handlers without making them
  // depend on `context` (which would churn the polling effect / stale-close it).
  const contextRef = useRef(context);
  contextRef.current = context;
  // started_at of the job whose result we've already applied — so a draft is
  // consumed exactly once even if a POST reply and a poll tick race.
  const appliedRef = useRef(0);

  const ackRefresh = useCallback(() => {
    jsend(`/api/projects/${project.id}/refresh-context`, "DELETE").catch(() => {});
  }, [project.id]);

  // Fold a polled job state into the UI. Idempotent: applies a finished draft at
  // most once, then acks it so it doesn't resurface on the next modal open.
  const handleState = useCallback((s: RefreshState) => {
    setRefreshEstimate(s.estimate ?? null);
    if (s.status === "running") { setRefreshing(true); return; }
    if (s.started_at && appliedRef.current !== s.started_at) {
      if (s.status === "done" && s.draft) {
        appliedRef.current = s.started_at;
        setPrevContext(contextRef.current);
        setContext(s.draft);
        setRefreshErr(null);
        ackRefresh();
      } else if (s.status === "error") {
        appliedRef.current = s.started_at;
        setRefreshErr(s.error || "refresh failed");
        ackRefresh();
      }
    }
    setRefreshing(false);
  }, [ackRefresh]);

  // On open, reconnect to whatever the server has: a still-running job, or a
  // draft/error left from a job that finished while the modal was closed.
  useEffect(() => {
    let alive = true;
    jget<RefreshState>(`/api/projects/${project.id}/refresh-context`)
      .then((s) => { if (alive) handleState(s); })
      .catch(() => {});
    return () => { alive = false; };
  }, [project.id, handleState]);

  // While a job runs, poll for its result. Stops when refreshing flips false
  // (terminal state) or the modal unmounts — the job keeps running server-side.
  useEffect(() => {
    if (!refreshing) return;
    const t = setInterval(() => {
      jget<RefreshState>(`/api/projects/${project.id}/refresh-context`).then(handleState).catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [refreshing, project.id, handleState]);

  const refreshContext = async () => {
    if (refreshing) return;
    setRefreshErr(null);
    setRefreshing(true);
    try {
      handleState(await jsend<RefreshState>(`/api/projects/${project.id}/refresh-context`, "POST"));
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      try { const j = JSON.parse(msg); if (j?.error) msg = j.error; } catch { /* not JSON — show raw */ }
      setRefreshErr(msg);
      setRefreshing(false);
    }
  };

  return (
    <Modal title="Project context" sub={`prepended to every task in ${project.name}`} onClose={onClose} width={620}
      footer={<>
        {confirmDel ? (
          <button className="btn-danger on" onClick={onDelete} title="Permanently remove this project, its tasks and chat history">{Icon.x()} Delete {project.name} permanently</button>
        ) : (
          <>
            <button className="btn-danger" onClick={() => setConfirmDel(true)}>{Icon.x()} Delete project</button>
            <button className="btn btn-line" onClick={onDeprecate} title="Hide this project under the sidebar's deprecated area. Nothing is deleted — restore it any time.">{Icon.archive()} Deprecate</button>
          </>
        )}
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" onClick={() => onSave({ name, context, send_context: sendContext ? 1 : 0, repo_path: repo, branch, dev_command: devCmd, setup_command: setupCmd, test_command: testCmd })}>{Icon.check()} Save</button>
      </>}>
      <div className="field">
        <div className="lab">Project name</div>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <div className="lab ctx-lab">
          <span>What we&apos;re building</span>
          <div className="ctx-actions">
            {prevContext != null && !refreshing && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => { setContext(prevContext); setPrevContext(null); }}
                title="Restore the context from before the AI refresh"
              >Undo</button>
            )}
            <button
              className={`btn btn-line btn-sm${showPreview ? " on" : ""}`}
              onClick={() => setPreview((p) => !p)}
              disabled={refreshing}
              title="Toggle a rendered-markdown preview"
            >{Icon.doc()} {showPreview ? "Edit" : "Preview"}</button>
            <button
              className="btn btn-line btn-sm"
              onClick={refreshContext}
              disabled={refreshing || !repo}
              title={repo ? "Let an agent read the repo and draft fresh context. Review and edit before saving." : "Set a working directory first"}
            >{Icon.spark()} {refreshing ? "Reading the repo…" : "Refresh with AI"}</button>
            {refreshEstimate && !refreshing && (
              <span className="job-cost-hint">
                {refreshEstimate.source === "project_latest" ? "Last run used" : "Typical run uses"} {fmtJobCost(refreshEstimate)}
              </span>
            )}
          </div>
        </div>
        {showPreview ? (
          <div className={`md-preview${context.trim() ? "" : " empty"}`} style={{ minHeight: 150, maxHeight: 320 }}>
            {context.trim() ? <Markdown>{context}</Markdown> : "Nothing to preview yet."}
          </div>
        ) : (
          <textarea style={{ minHeight: 150 }} value={context} disabled={refreshing} onChange={(e) => setContext(e.target.value)} />
        )}
        {refreshErr ? (
          <ErrNote style={{ marginTop: 7 }} onRetry={refreshContext} retryLabel="Try again">{refreshErr}</ErrNote>
        ) : refreshing ? (
          <div className="hlp" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="typing"><i /><i /><i /></span>
            Exploring {repo.split("/").pop() || "the repo"} to draft fresh context — this can take a minute.
          </div>
        ) : prevContext != null ? (
          <div className="hlp">Drafted from the repo. Review and edit it, then Save — or Undo to revert.</div>
        ) : (
          <div className="hlp">Be specific about stack, conventions, and constraints. Every task in this project inherits it.</div>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12.5, color: "var(--ink-2)", cursor: "pointer" }}>
          <input type="checkbox" checked={sendContext} onChange={(e) => setSendContext(e.target.checked)} />
          Include this context in new agent sessions
        </label>
        {!sendContext && (
          <div className="hlp">New tasks will start without the saved context (task details and orchestrator tools are still included). Each task can override this when it starts.</div>
        )}
      </div>
      <div style={{ display: "flex", gap: 14 }}>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <div className="lab">{Icon.folder()} Working dir <span className="opt">— required to run tasks</span></div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="text" className="ctx-mono" style={{ flex: 1, minWidth: 0 }} value={repo} placeholder="/Users/you/code/project" onChange={(e) => setRepo(e.target.value)} />
            <BrowseDirButton initial={repo} onPick={setRepo} />
          </div>
        </div>
        <div className="field" style={{ flex: "0 0 170px", marginBottom: 0 }}>
          <div className="lab">{Icon.git()} Branch</div>
          <input type="text" className="ctx-mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <AgentPicker
          agents={agents} value={project.default_agent} onChange={onSetDefaultAgent}
          label="Default agent for new tasks"
          help="New tasks in this project default to this agent. Existing tasks keep the agent they were created with."
        />
      </div>
      {showServices && (
        <div className="field" style={{ marginTop: 14 }}>
          <div className="lab ctx-lab">
            <span>{Icon.sliders()} Services</span>
            <span className="opt" style={{ fontWeight: 400 }}>port <code className="ctx-mono">{project.port || "—"}</code> injected as <code className="ctx-mono">PORT</code></span>
          </div>
          <div className="hlp" style={{ marginTop: 0, marginBottom: 8 }}>
            The orchestrator supervises these in {repo ? repo.split("/").pop() : "the working dir"} — start/stop them from the Services panel; they outlive the tab.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label className="svc-cfg-row">
              <span className="svc-cfg-lab">Dev server</span>
              <input type="text" className="ctx-mono" value={devCmd} placeholder="npm run dev" onChange={(e) => setDevCmd(e.target.value)} />
            </label>
            <label className="svc-cfg-row">
              <span className="svc-cfg-lab">Setup <span className="opt">— optional</span></span>
              <input type="text" className="ctx-mono" value={setupCmd} placeholder="npm install" onChange={(e) => setSetupCmd(e.target.value)} />
            </label>
            <label className="svc-cfg-row">
              <span className="svc-cfg-lab">Test <span className="opt">— optional</span></span>
              <input type="text" className="ctx-mono" value={testCmd} placeholder="npm test" onChange={(e) => setTestCmd(e.target.value)} />
            </label>
          </div>
        </div>
      )}
      {confirmDel && (
        <div className="hlp" style={{ color: "var(--red)", marginTop: 16 }}>
          This permanently removes “{project.name}”, its tasks and chat history from the orchestrator. Your code on disk{repo ? ` in ${repo}` : ""} is not touched.
        </div>
      )}
    </Modal>
  );
}

export function SessionsModal({ project, onClose, onJump }: { project: ProjectRow; onClose: () => void; onJump: (taskId: string) => void }) {
  const [sessions, setSessions] = useState<ProjectSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    setSessions(null);
    jget<ProjectSession[]>(`/api/projects/${project.id}/sessions`)
      .then(setSessions)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  const total = sessions?.length ?? 0;
  return (
    <Modal
      title="Sessions"
      sub={`every agent session run under ${project.name}${sessions ? ` · ${total} total` : ""}`}
      onClose={onClose}
      width={640}
    >
      {error && <ErrNote onRetry={load}>Couldn&apos;t load sessions: {error}</ErrNote>}
      {!sessions && !error && (
        // Skeleton mirroring the session rows below, so the modal doesn't reflow
        // when the real list lands.
        <div className="skel-list" aria-hidden>
          {[52, 38, 46].map((w, i) => (
            <div key={i} className="task" style={{ cursor: "default", marginBottom: 0 }}>
              <div className="task-top">
                <Skel w={9} h={9} r="50%" />
                <Skel w={`${w}%`} h={12} />
                <span style={{ flex: 1 }} />
                <Skel w={70} h={10} />
              </div>
              <div className="task-foot">
                <Skel w={150} h={9} />
              </div>
            </div>
          ))}
        </div>
      )}
      {sessions && total === 0 && (
        <div className="empty" style={{ padding: "24px 8px" }}>
          <div className="e-t">No sessions yet</div>
          <div className="e-s">Start a task to open the project&apos;s first agent session.</div>
        </div>
      )}
      {sessions && total > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {sessions.map((s) => (
            <button
              key={s.id}
              className="task"
              style={{ textAlign: "left", width: "100%" }}
              onClick={() => onJump(s.task_id)}
              title="Open this task"
            >
              <div className="task-top">
                <StatusDot status={s.task_status} running={!s.ended_at} />
                <span className="ttitle">{s.task_title}</span>
                <span className="slabel">Session {s.generation}</span>
              </div>
              <div className="task-foot">
                <span className="activity">{relTime(s.started_at)} · {duration(s.started_at, s.ended_at)} · {s.message_count} msg{s.message_count !== 1 ? "s" : ""}</span>
                <span className="spacer" />
                {s.claude_session_id ? (
                  <span className="activity ctx-mono" title={s.claude_session_id} style={{ fontSize: 11, opacity: 0.7 }}>
                    {s.claude_session_id.slice(0, 8)}
                  </span>
                ) : (
                  <span className="activity" style={{ opacity: 0.5 }}>no session id</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function NewProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (i: { name: string; sub: string; color: string; context: string; repo_path: string; branch?: string }) => void | Promise<void> }) {
  const [name, setName] = useState("");
  const [sub, setSub] = useState("");
  const [context, setContext] = useState("");
  const [repo, setRepo] = useState("");
  const colors = ["#C2603C", "#3E7CA8", "#6B6F8C", "#5C8C5A", "#9A6E14", "#9E5BA0"];
  const [color, setColor] = useState(colors[0]);
  // Where the code comes from: a local folder — existing repo or greenfield —
  // or a clone of one of the user's GitHub repos (the onboarding path).
  const [mode, setMode] = useState<"fresh" | "clone">("fresh");
  const [cloneSpec, setCloneSpec] = useState(""); // owner/repo or pasted URL
  const [cloning, setCloning] = useState(false);
  const [cloneErr, setCloneErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const ok = name.trim().length > 0 && !cloning && (mode === "fresh" || cloneSpec.trim().length > 0);

  const submit = async () => {
    if (!ok) return;
    const base = { name: name.trim(), sub: sub.trim() || "app", color, context: context.trim() };
    if (mode === "fresh") { await onCreate({ ...base, repo_path: repo.trim() }); return; }
    // Clone first; only create the project once the repo actually landed.
    setCloning(true);
    setCloneErr(null);
    try {
      const r = await jsend<{ path: string; branch: string }>("/api/github/clone", "POST", { repo: cloneSpec.trim() });
      await onCreate({ ...base, repo_path: r.path, branch: r.branch });
    } catch (e) {
      setCloneErr(e instanceof Error ? e.message : String(e));
      setCloning(false);
    }
  };

  return (
    <Modal title="New project" sub="each project is a separate app you're building" onClose={onClose}
      footer={<>
        {cloneErr && <span className="hlp" style={{ color: "var(--red)", margin: 0 }}>⚠ {cloneErr}</span>}
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" disabled={!ok} onClick={submit}>
          {Icon.plus()} {mode === "clone" ? (cloning ? "Cloning…" : "Clone & create") : "Create project"}
        </button>
      </>}>
      <div style={{ display: "flex", gap: 14 }}>
        <div className="field" style={{ flex: 1 }}>
          <div className="lab">Project name</div>
          <input ref={ref} type="text" value={name} placeholder="e.g. Northwind" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field" style={{ flex: "0 0 150px" }}>
          <div className="lab">Tagline</div>
          <input type="text" value={sub} placeholder="email client" onChange={(e) => setSub(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <div className="lab">Accent color</div>
        <div style={{ display: "flex", gap: 9 }}>
          {colors.map((c) => (
            <button key={c} onClick={() => setColor(c)} style={{ width: 34, height: 34, borderRadius: 9, background: c, outline: color === c ? "2px solid var(--ink)" : "none", outlineOffset: 2, border: "none", cursor: "pointer" }} />
          ))}
        </div>
      </div>
      <div className="field">
        <div className="lab">{Icon.folder()} Code</div>
        <div className="seg">
          <button className={mode === "fresh" ? "on" : ""} onClick={() => setMode("fresh")}>Local folder</button>
          <button className={mode === "clone" ? "on" : ""} onClick={() => setMode("clone")}>{Icon.github()} Clone from GitHub</button>
        </div>
      </div>
      {mode === "fresh" ? (
        <div className="field">
          <div className="lab">Working dir <span className="opt">— pick an existing repo or folder, or leave blank to start fresh and add one later</span></div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="text" className="ctx-mono" style={{ flex: 1, minWidth: 0 }} value={repo} placeholder="/Users/you/code/project" onChange={(e) => setRepo(e.target.value)} />
            <BrowseDirButton initial={repo} onPick={setRepo} />
          </div>
        </div>
      ) : (
        <GitHubClonePicker
          value={cloneSpec}
          onChange={(spec, shortName) => {
            setCloneSpec(spec);
            // Picking a repo names the project after it (only if still unnamed).
            if (shortName && !name.trim()) setName(shortName);
          }}
        />
      )}
      <div className="field">
        <div className="lab">What we&apos;re building <span className="opt">— optional, can add later</span></div>
        <textarea value={context} placeholder="Description, stack, conventions…" onChange={(e) => setContext(e.target.value)} />
      </div>
    </Modal>
  );
}
