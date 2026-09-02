"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LandingMode, Priority } from "@/lib/types";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { relTime, duration, fmtJobCost, alphabetical, isBlocking } from "./format";
import { SLABEL, modelOptions, permissionOptions, type BulkMoveResult, type DiscardPreview, type ProjectRow, type ProjectSession, type SaveAction, type TaskRow, type AgentsBundle, type InternalUsageEstimate, type TagRow } from "./types";
import { tagProgress } from "./TagChips";
import { agentLabel, agentPickerNeeded, defaultAgentFor, findAgent } from "./agents";
import { StatusDot, Skel, ErrNote, EndpointNote } from "./shared";
import { Modal, BrowseDirButton, FreeFormModel, ModelField, PrioritySeg, DepPicker } from "./Modal";
import { GitHubClonePicker } from "./github";
import { Markdown } from "../Markdown";
import { clientFeatures } from "@/lib/features";
import { describeProvider, normalizeBaseUrl, parseAgentEnv, providerPresetEnv, serializeAgentEnv, taskProvider, type ProviderKind } from "@/lib/agentEnv";
import { useEndpointModels } from "./modelEndpoint";

// Segmented agent picker (Claude Code / Codex …). Hidden when there is nothing
// to choose: one agent registered, OR one agent CONNECTED and it's the one
// already selected. Every driver is always registered, so "length <= 1" alone
// never fired on a real instance — a Claude-only user saw a two-button picker
// whose other button was a dead "Codex · not connected" every time they made a
// task. The selected-check keeps the picker (and its Connect CTA) visible when
// the value is an unconnected agent — an old Codex task in Edit, a project
// default pointing at an agent that was since signed out — because hiding it
// there would strand the task on an agent it can't run and hide the way out.
// Nothing connected keeps the picker too, so the connect CTA still renders.
// An unauthenticated agent is still selectable (you can create a not-started
// task and connect later) but flagged, with a Connect CTA that jumps to the
// setup wizard.
export function AgentPicker({ agents, value, onChange, onConnect, help, label = "Agent" }: {
  agents: AgentsBundle; value: string; onChange: (id: string) => void; onConnect?: () => void; help?: string; label?: string;
}) {
  if (!agentPickerNeeded(agents, value)) return null;
  const sel = findAgent(agents, value);
  return (
    <div className="field">
      <div className="lab">{label}</div>
      <div className="seg wrap">
        {agents.agents.map((a) => (
          <button key={a.id} className={a.id === value ? "on" : ""} onClick={() => onChange(a.id)}
            title={a.authenticated ? `Run on ${a.label}` : `${a.label} isn't connected yet`}>
            {a.label}{!a.authenticated && <span className="opt"> · not connected</span>}
          </button>
        ))}
      </div>
      {sel && !sel.authenticated ? (
        <div className="hlp" style={{ color: "var(--amber)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>{sel.label} isn’t connected. Connect it before starting a session.</span>
          {onConnect && <button className="btn btn-line btn-sm" onClick={onConnect}>Connect {sel.label}</button>}
        </div>
      ) : (
        <div className="hlp">{help ?? "Can be changed until the task's first session starts."}</div>
      )}
    </div>
  );
}

// The Tags field — which features this task is a step of, MANY at once (a
// task can belong to several plans). A checkbox list over the project's tags,
// styled like DepPicker's Blocked-by list rather than a <select>, since a
// single-choice control can't express a set — plus an inline "New tag…" (name
// only; description and color come from the tag strip later). Sits above
// Blocked by in both task dialogs, since "which feature(s)" is decided before
// "which step". Without `onCreate` (no project to mint into, or the bulk
// modal's Remove mode, where minting a tag nobody has yet is meaningless) it
// only offers the existing tags.
export function TagsField({ tags, value, onChange, onCreate, label = "Tags", hint = "(which features this is a step of)" }: {
  tags: TagRow[]; value: string[]; onChange: (ids: string[]) => void;
  onCreate?: (name: string) => Promise<TagRow>;
  label?: string; hint?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Alphabetical, not the strip's manual order: this is a lookup list, and the
  // user is scanning it for a tag name they already have in mind.
  const rows = useMemo(() => [...tags].sort((a, b) => alphabetical(a.name, b.name)), [tags]);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const cancel = () => { setCreating(false); setName(""); setErr(null); };
  const create = async () => {
    const n = name.trim();
    if (!n || !onCreate || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const t = await onCreate(n);
      onChange([...value, t.id]);
      cancel();
    } catch (e) {
      // 409 on a name collision: the tag exists, so say so and leave the
      // name in place — ticking it in the list below is one click away.
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (tags.length === 0 && !onCreate) return null;
  return (
    <div className="field tag-field">
      <div className="lab">{label} {hint && <span className="opt">{hint}</span>}</div>
      {tags.length > 0 ? (
        <div className="dep-list">
          {rows.map((t) => (
            <label key={t.id} className={`dep-row ${value.includes(t.id) ? "on" : ""}`}>
              <input type="checkbox" checked={value.includes(t.id)} onChange={() => toggle(t.id)} />
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: t.color ?? "var(--ink-4)", flex: "0 0 auto" }} />
              <span className="dep-title">{t.name}</span>
              <span className="dep-status">{tagProgress(t).label}</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="hlp">No tags in this project yet.</div>
      )}
      {creating ? (
        <div className="tag-new">
          <input type="text" value={name} placeholder="Tag name, e.g. Auth migration" autoFocus aria-label="New tag name"
            onChange={(e) => { setName(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void create(); } if (e.key === "Escape") { e.stopPropagation(); cancel(); } }} />
          <button className="btn btn-line btn-sm" disabled={!name.trim() || busy} onClick={() => void create()}>{busy ? "Creating…" : "Create"}</button>
          <button className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button>
        </div>
      ) : onCreate && (
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => setCreating(true)}>{Icon.plus()} New tag…</button>
      )}
      {err && <ErrNote style={{ marginTop: 8 }}>{err}</ErrNote>}
      <div className="hlp">Tags filter the list and board, and badge every member. A task can carry several; a tag never spans projects.</div>
    </div>
  );
}

export function NewTaskModal({ project, agents, tasks, tags, onClose, onCreate, onCreateTag, onOpenSetup }: { project: ProjectRow; agents: AgentsBundle; tasks: TaskRow[]; tags: TagRow[]; onClose: () => void; onCreate: (i: { title: string; desc: string; priority: Priority; agent: string; startNow: boolean; sendContext: boolean; depends_on: string[]; auto_start: boolean; model: string | null; permission_mode: string | null; tag_ids: string[] }) => void; onCreateTag: (name: string) => Promise<TagRow>; onOpenSetup?: () => void }) {
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState<Priority>("med");
  const [agent, setAgent] = useState(() => defaultAgentFor(agents, project.default_agent));
  const [startNow, setStartNow] = useState(false);
  const [sendContext, setSendContext] = useState(project.send_context !== 0);
  const [deps, setDeps] = useState<string[]>([]);
  const [autoStart, setAutoStart] = useState(false);
  // null = the picker's "Inherit" head: use the app-level default, then the
  // driver's. Set here (not just in the session rail) because the auto-start
  // opt-in below decides this task will run with NOBODY WATCHING, and an
  // unattended permission prompt declines itself — so the one dialog that
  // schedules unattended work has to be able to say "don't stop to ask".
  const [permission, setPermission] = useState<string | null>(null);
  // Same inherit semantics for the model. Chosen here rather than only in the
  // session rail because "Start session immediately" makes the first turn part
  // of this dialog: a rail pick afterwards would land a model behind the turn
  // that already ran on the default one.
  const [model, setModel] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  // The bundle can arrive after mount; adopt the resolved default until the user picks.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setAgent(defaultAgentFor(agents, project.default_agent)); }, [agents, project.default_agent]);
  const pickAgent = (id: string) => { touched.current = true; setAgent(id); };
  const can = title.trim().length > 0;
  // A task with unfinished blockers can't start now, so the two options are exclusive.
  // One rule, shared with the "Blocked by" chip and with blocks() server-side:
  // terminal doesn't block, and neither does a ref that resolves to nothing
  // (see isBlocking). An unreviewed suggestion DOES block, and `tasks` carries
  // the suggested rows so the picker above can show and untick it.
  const blocked = deps.some((id) => isBlocking(tasks.find((t) => t.id === id)));
  // Can't launch a session on an agent that isn't signed in — but the task can
  // still be created (not started) and started once the agent is connected.
  const selAgent = findAgent(agents, agent);
  const agentReady = selAgent ? selAgent.authenticated : true;
  const canStart = !blocked && agentReady;
  const willAutoStart = autoStart && deps.length > 0;
  const permissionOpts = useMemo(() => permissionOptions(selAgent?.capabilities), [selAgent]);
  const modelOpts = useMemo(() => modelOptions(selAgent?.capabilities), [selAgent]);
  // Which SHAPE the model field takes. A cloud project picks from the driver's
  // catalog; a project pointed at a local server types an id, because the ids
  // on that machine are whatever was pulled and no catalog can know them
  // (lib/agentEnv.ts). The suggestions are what the endpoint reports, asked
  // server-side — the browser generally can't reach a loopback model server.
  const provider = useMemo(() => taskProvider(project), [project]);
  const localModel = provider.kind !== "cloud";
  const endpoint = useEndpointModels(project.id, "", localModel);
  // Permission modes and models are both provider-specific (each driver labels
  // its own — Claude speaks Anthropic's mode names and model aliases, Codex its
  // sandbox modes and GPT ids), so a choice made under one agent may not exist
  // under the next: switching agents drops it back to Inherit rather than
  // silently sending a value the new driver would coerce.
  useEffect(() => {
    if (permission && !permissionOpts.some((p) => p.value === permission)) setPermission(null);
  }, [permissionOpts, permission]);
  // …except under an override, where the catalog isn't the authority on what is
  // runnable and clearing a typed id would be the bug rather than the fix.
  useEffect(() => {
    if (localModel) return;
    if (model && !modelOpts.some((m) => m.value === model)) setModel(null);
  }, [modelOpts, model, localModel]);
  // What this agent calls its never-asks mode, for the unattended warning below.
  const bypassLabel = permissionOpts.find((p) => p.value === "bypassPermissions")?.label ?? "bypassPermissions";
  // bypassPermissions is the only mode that never parks on a card. "Inherit"
  // (null) can resolve to one that does, so it counts as unsafe-for-unattended
  // too — we deliberately don't guess what it resolves to and claim it's fine.
  const unattendedRisk = willAutoStart && permission !== "bypassPermissions";
  const create = () => can && onCreate({ title: title.trim(), desc: desc.trim(), priority, agent, startNow: startNow && canStart, sendContext, depends_on: deps, auto_start: willAutoStart, model, permission_mode: permission, tag_ids: tagIds });
  return (
    <Modal title="New task" sub={`${project.name} · title + description define ${agentLabel(agents, agent)}'s task context`} onClose={onClose}
      footer={<>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: !canStart ? "var(--ink-4)" : "var(--ink-2)", cursor: !canStart ? "not-allowed" : "pointer" }}
          title={blocked ? "Can't start now. This task is blocked by unfinished tasks" : !agentReady ? `Connect ${selAgent?.label} to start a session` : undefined}>
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
        <div className="lab">Description <span className="opt">(what to do)</span></div>
        <textarea value={desc} placeholder="Describe the feature or task. The agent receives this in its injected task context." onChange={(e) => setDesc(e.target.value)} />
        {sendContext && <div className="hlp">Project context is prepended automatically. No need to restate the stack or conventions.</div>}
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12.5, color: "var(--ink-2)", cursor: "pointer" }}
          title="Uncheck to start this task's sessions without the saved project context. Task details and Calandria tools are always included.">
          <input type="checkbox" checked={sendContext} onChange={(e) => setSendContext(e.target.checked)} />
          Send saved project context to the agent
        </label>
      </div>
      <AgentPicker agents={agents} value={agent} onChange={pickAgent} onConnect={onOpenSetup} />
      <ModelField options={modelOpts} value={model} onChange={setModel}
        freeForm={localModel} suggestions={endpoint.models} status={<EndpointNote state={endpoint} />}
        help=" (changeable later from the session rail)." />
      <div className="field">
        <div className="lab">Priority</div>
        <PrioritySeg value={priority} onChange={setPriority} />
      </div>
      {permissionOpts.length > 1 && (
        <div className="field">
          <div className="lab">{Icon.lock()} Permission mode</div>
          <div className="seg wrap" style={{ maxWidth: 520 }}>
            {permissionOpts.map((p) => (
              <Fragment key={p.label}>
                <button className={permission === p.value ? "on" : ""} title={p.sub}
                  onClick={() => setPermission(p.value)}>
                  {p.label}
                </button>
                {/* Rule after the inherit head. Everything past it is the
                    provider's own mode list — Claude's includes one spelled
                    "default", which the head must not read as a copy of. */}
                {p.value === null && <span className="seg-sep" aria-hidden />}
              </Fragment>
            ))}
          </div>
          <div className="hlp">
            {permissionOpts.find((p) => p.value === permission)?.sub ?? permissionOpts[0]?.sub}
            {" (changeable later from the session rail)."}
          </div>
        </div>
      )}
      <TagsField tags={tags} value={tagIds} onChange={setTagIds} onCreate={onCreateTag} />
      <DepPicker candidates={tasks} value={deps} onChange={setDeps} autoStart={autoStart} onAutoStart={setAutoStart} />
      {unattendedRisk && (
        <div className="hlp" style={{ color: "var(--amber)" }}>
          This task auto-starts when its blockers clear, which may be while nobody is watching. Any mode but{" "}
          <strong>{bypassLabel}</strong> parks on a permission card, and an unanswered card declines itself and stops the
          turn. Pick {bypassLabel} if it needs to run all the way through unattended.
        </div>
      )}
    </Modal>
  );
}

// The destination radio list, shared by the single-task field below, the bulk
// MoveTasksModal, and the Runbooks card's "Copy to…" — one rendering of "which
// project", so those paths can't drift on what a destination looks like.
export function ProjectTargetList({ targets, value, onChange, name }: {
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

/**
 * The branch this task is based on — what its worktree was cut from, what Sync
 * catches it up to, and what Merge lands it into (lib/baseBranch.ts). Empty
 * means "inherit", and the placeholder says what that inherits to, so the field
 * never has to be filled in to be understood.
 *
 * Deliberately NOT part of the dialog's Save: retargeting a started task can
 * create a local ref and re-cut its worktree, and it reports what it did. That
 * is its own endpoint (POST /api/tasks/[id]/base-branch) and its own button,
 * exactly like the move field below — a field whose blast radius is a git
 * operation shouldn't ride along on "Save changes".
 */
function BaseBranchField({ task, project }: { task: TaskRow; project?: ProjectRow }) {
  const [value, setValue] = useState(task.base_branch ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const inherited = project?.branch || "main";
  const current = task.base_branch || inherited;
  const dirty = value.trim() !== (task.base_branch ?? "");

  const apply = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await jsend<{ message?: string; baseBranch?: string }>(`/api/tasks/${task.id}/base-branch`, "POST", { branch: value.trim() });
      setNote(r.message ?? `Now based on ${r.baseBranch ?? inherited}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <div className="lab">Base branch <span className="opt">(cut from, synced to, merged into)</span></div>
      <div style={{ display: "flex", gap: 8 }}>
        <input type="text" className="ctx-mono" style={{ flex: 1, minWidth: 0 }} value={value}
          placeholder={`${inherited} (from the project)`}
          onChange={(e) => { setValue(e.target.value); setErr(null); setNote(null); }} disabled={busy} />
        <button className="btn btn-line" disabled={!dirty || busy} onClick={apply}
          title={value.trim() ? `Point this task at ${value.trim()}` : `Go back to inheriting ${inherited}`}>
          {busy ? "Working…" : value.trim() ? "Retarget" : "Inherit"}
        </button>
      </div>
      {err ? <ErrNote style={{ marginTop: 8 }}>{err}</ErrNote> : note ? (
        <div className="hlp" style={{ color: "var(--blue)" }}>{note}</div>
      ) : task.started === 1 ? (
        <div className="hlp">
          Currently {current}. Changing it never rewrites anything: a task that has already committed keeps every commit
          and is told how far behind the new base it is. One Sync catches it up.
        </div>
      ) : (
        <div className="hlp">Leave empty to follow the project&rsquo;s default. The worktree is cut from this branch on the first turn.</div>
      )}
    </div>
  );
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
function MoveProjectField({ task, tasks, tags, projects, agents, onMove }: {
  task: TaskRow; tasks: TaskRow[]; tags: TagRow[]; projects: ProjectRow[]; agents: AgentsBundle;
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
  // A tag follows its whole membership or not at all (the both-ends rule the
  // dependency links get), so a task moving ALONE takes a tag with it exactly
  // when it is that tag's only member. Read off each tag's own derived count,
  // not by filtering `tasks`, which is scoped to whatever the caller passed in,
  // while a sibling sitting in the Suggested tray is a member like any other.
  // Unlike the old
  // single group this can split both ways in one move: some of the task's tags
  // may be solo, others shared.
  const carriedTags: string[] = [];
  const droppedTags: string[] = [];
  for (const id of task.tag_ids) {
    const t = tags.find((x) => x.id === id);
    if (!t) continue;
    (t.counts.total === 1 ? carriedTags : droppedTags).push(t.name);
  }
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
      <div className="lab">Move to project <span className="opt">{task.started === 1 ? "(discards this task's worktree)" : "(transcript and history come along)"}</span></div>
      <ProjectTargetList targets={targets} value={target} name="move-project" onChange={(id) => { setTarget(id); setErr(null); setConfirm(false); }} />
      {dest ? (
        <>
          <div className="hlp" style={{ color: "var(--amber)" }}>
            Moves this task to {dest.name} right away. Unsaved edits above are discarded.
            {links > 0 && ` ${links} blocked-by link${links !== 1 ? "s" : ""} drop${links === 1 ? "s" : ""}: dependencies can't span projects.`}
            {carriedTags.length > 0 && ` ${carriedTags.length === 1 ? `Its “${carriedTags[0]}” tag has` : `${carriedTags.length} of its tags have`} no other members, so ${carriedTags.length === 1 ? "it comes" : "they come"} along too, renamed if that name is taken there.`}
            {droppedTags.length > 0 && ` ${droppedTags.length === 1 ? `Its “${droppedTags[0]}” tag is` : `${droppedTags.length} of its tags are`} cleared: a tag moves only when every one of its members does, and the others are staying.`}
            {switching && ` It will run on ${agentLabel(agents, switching)}, ${dest.name}'s default.`}
            {contextFlip === 1 && ` Sessions will include ${dest.name}'s saved project context.`}
            {contextFlip === 0 && ` Sessions won't include project context: ${dest.name}'s default.`}
          </div>
          {needsAck && (
            <div className="hlp" style={{ color: unsafe ? "var(--red)" : "var(--amber)", marginTop: 8 }}>
              {preview?.has_worktree ? (
                <>
                  This task&rsquo;s git worktree{preview.branch && <> and branch <code>{preview.branch}</code></>} belong to{" "}
                  {src?.name ?? "its current project"}&rsquo;s repo, so moving deletes them.{" "}
                  {unsafe
                    ? `That destroys ${preview.reason}, permanently, with no way back.`
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
  // Tags get the links' both-ends rule: a tag whose EVERY member is in the
  // selection travels with it (re-keyed to the destination, suffixed there if
  // the name is taken), and one selected only in part stays behind — with the
  // rows that go losing that badge. Counted per tag over the whole project
  // (a task can carry several, so it can appear in more than one tally), since
  // a member left out of the selection is exactly what decides this.
  const tagTally = new Map<string, { total: number; going: number }>();
  for (const t of tasks) {
    for (const tagId of t.tag_ids) {
      const e = tagTally.get(tagId) ?? { total: 0, going: 0 };
      e.total++;
      if (moving_.has(t.id)) e.going++;
      tagTally.set(tagId, e);
    }
  }
  const inPlay = [...tagTally.values()].filter((e) => e.going > 0);
  const carried = inPlay.filter((e) => e.going === e.total).length;
  const untagged = inPlay.filter((e) => e.going < e.total).reduce((n, e) => n + e.going, 0);
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
          {result.carried.length > 0 && (
            <div className="hlp" style={{ marginTop: 4 }}>
              {result.carried.map((g) => g.renamed_from ? `“${g.renamed_from}” arrived as “${g.name}” (that name was taken)` : `“${g.name}” came along whole`).join("; ")}.
            </div>
          )}
          {result.untagged.length > 0 && (
            <div className="hlp" style={{ color: "var(--amber)", marginTop: 4 }}>
              {result.untagged.length} task{result.untagged.length !== 1 ? "s" : ""} left {[...new Set(result.untagged.map((u) => u.tag_name))].map((n) => `“${n}”`).join(", ")} behind. The rest of that tag stayed.
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
                    <span className="dep-status">{s.reason.split(/[:.] /)[0]}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="field">
            <div className="lab">Moving <span className="opt">(tick a started task to discard its worktree)</span></div>
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
                      {isLive(t) ? "running: stays"
                        : !ack ? ""
                        : !canAck ? (previewErr ? "couldn't read its worktree" : "reading its worktree…")
                        : unsafe ? `${on ? "discards" : "holds"} ${p!.reason}`
                        : p?.has_worktree ? `${on ? "discards" : "holds"} worktree ${p.branch}`
                        : on ? "started: moves, no worktree left" : "started: nothing to discard"}
                    </span>
                  </label>
                );
              })}
            </div>
            {previewErr && (
              <div className="hlp" style={{ color: "var(--red)" }}>
                Couldn&rsquo;t read what these worktrees hold, so none of them can be discarded from here. A checkbox that
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
                {stuck} of these {stuck === 1 ? "stays" : "stay"} put. {stuck === 1 ? "It holds" : "They hold"} a git worktree cut
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
                {dropped > 0 && ` ${dropped} blocked-by link${dropped !== 1 ? "s" : ""} drop${dropped === 1 ? "s" : ""}. The other end isn't coming.`}
                {carried > 0 && ` ${carried} tag${carried !== 1 ? "s" : ""} come${carried === 1 ? "s" : ""} along whole. Every member is in the selection.`}
                {untagged > 0 && ` ${untagged} ${untagged === 1 ? "task loses a" : "tasks lose a"} tag: the rest of it isn't moving.`}
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

/**
 * Add or remove a set of tags across a whole selection — the list's selection
 * bar beside "Move to project…". The cheap path for the case tags were
 * designed around: an agent filed seven suggestions before the tag existed,
 * and tagging them one edit dialog at a time is seven round trips.
 *
 * Add/Remove rather than the old single group's replace-the-set: a mixed
 * selection rarely shares the same tags (many-to-many means each row can
 * already carry a different set), so "these and only these" would silently
 * strip whatever a row had that wasn't picked. Whole-batch, unlike the move
 * beside it: there is nothing per-row to refuse (no worktree, no turn,
 * nothing irreversible), so the route applies all of it or none, and this
 * modal only has to decide which tags and which direction.
 */
export function TagTasksModal({ selected, tags, onClose, onApply, onCreateTag }: {
  /** The picked rows, in list order. */
  selected: TaskRow[];
  tags: TagRow[];
  onClose: () => void;
  onApply: (ids: string[], tagIds: string[], mode: "add" | "remove") => Promise<void>;
  onCreateTag: (name: string) => Promise<TagRow>;
}) {
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = selected.length;
  // Rows that already agree with the write aren't touched server-side; saying
  // so keeps the button honest about what it's about to do.
  const changing = tagIds.length === 0 ? 0 : selected.filter((t) =>
    mode === "add" ? tagIds.some((id) => !t.tag_ids.includes(id)) : tagIds.some((id) => t.tag_ids.includes(id))
  ).length;

  const apply = async () => {
    if (busy || tagIds.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      await onApply(selected.map((t) => t.id), tagIds, mode);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Tags for ${n} task${n !== 1 ? "s" : ""}`} sub="A mixed selection rarely shares tags, so add or remove rather than replace" onClose={onClose}
      footer={<>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" disabled={busy || tagIds.length === 0 || changing === 0} onClick={apply}>
          {Icon.check()} {busy ? "Saving…" : tagIds.length === 0 ? "Pick a tag" : changing === 0 ? "No change" : mode === "add" ? `Add to ${changing}` : `Remove from ${changing}`}
        </button>
      </>}>
      <div className="field">
        <div className="lab">Action</div>
        <div className="seg">
          <button className={mode === "add" ? "on" : ""} onClick={() => setMode("add")}>Add</button>
          <button className={mode === "remove" ? "on" : ""} onClick={() => setMode("remove")}>Remove</button>
        </div>
      </div>
      <TagsField tags={tags} value={tagIds} onChange={setTagIds} onCreate={mode === "add" ? onCreateTag : undefined}
        label={mode === "add" ? "Tags to add" : "Tags to remove"} hint="" />
      <div className="field">
        <div className="lab">Selection</div>
        <div className="dep-list">
          {selected.map((t) => (
            <div key={t.id} className="dep-row" style={{ cursor: "default" }}>
              <StatusDot status={t.status} />
              <span className="dep-title">{t.title}</span>
              <span className="dep-status">
                {tagIds.length === 0 ? "" : mode === "add"
                  ? tagIds.every((id) => t.tag_ids.includes(id)) ? "already tagged" : "will be tagged"
                  : tagIds.some((id) => t.tag_ids.includes(id)) ? "will be untagged" : "not tagged"}
              </span>
            </div>
          ))}
        </div>
      </div>
      {err && <ErrNote>{err}</ErrNote>}
    </Modal>
  );
}

export function EditTaskModal({ task, tasks, tags, projects, agents, onClose, onSave, onDelete, onMove, onCreateTag, onOpenSetup }: { task: TaskRow; tasks: TaskRow[]; tags: TagRow[]; projects: ProjectRow[]; agents: AgentsBundle; onClose: () => void; onSave: (id: string, patch: { title: string; description: string; priority: Priority; agent?: string; model: string | null; depends_on: string[]; auto_start: boolean; tag_ids: string[] }, action?: SaveAction) => void; onCreateTag: (name: string) => Promise<TagRow>; onDelete: (id: string) => void; onMove: (id: string, projectId: string, opts?: { discardWorktree?: boolean; discardUnsafe?: boolean }) => Promise<void>; onOpenSetup?: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [agent, setAgent] = useState(task.agent);
  // Not gated the way the agent picker below is: a session's model is chosen
  // per turn, so this stays editable for a task's whole life (it's the same
  // value the session rail's picker writes) and takes effect on the next turn.
  const [model, setModel] = useState<string | null>(task.model);
  const [deps, setDeps] = useState<string[]>(task.depends_on ?? []);
  const [tagIds, setTagIds] = useState<string[]>(task.tag_ids ?? []);
  const [autoStart, setAutoStart] = useState(!!task.auto_start);
  const [confirmDel, setConfirmDel] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const can = title.trim().length > 0;
  const canChangeAgent = task.started === 0 && task.running === 0;
  const candidates = useMemo(() => tasks.filter((t) => t.id !== task.id), [tasks, task.id]);
  const save = (action?: SaveAction) => can && onSave(task.id, { title: title.trim(), description: desc.trim(), priority, agent: canChangeAgent ? agent : undefined, model, depends_on: deps, auto_start: autoStart && deps.length > 0, tag_ids: tagIds }, action);
  // Editing a suggestion is usually the last step before deciding on it, so the
  // tray's two verbs live here too: sharpen the brief and accept it in one
  // gesture, rather than saving, closing, and hunting for the row again.
  // (`add` is meaningless once it's out of the tray; `start` still isn't — an
  // added-but-unstarted task can be launched from here the same way.)
  const isSuggestion = task.suggested === 1;
  const startable = !task.started;
  // Same two gates the New-task dialog puts on "Start session immediately":
  // an unfinished blocker means the task isn't allowed to run yet, and a
  // disconnected agent has no session to launch.
  // One rule, shared with the "Blocked by" chip and with blocks() server-side:
  // terminal doesn't block, and neither does a ref that resolves to nothing
  // (see isBlocking). An unreviewed suggestion DOES block, and `tasks` carries
  // the suggested rows so the picker above can show and untick it.
  const blocked = deps.some((id) => isBlocking(tasks.find((t) => t.id === id)));
  const selAgent = findAgent(agents, canChangeAgent ? agent : task.agent);
  const modelOpts = useMemo(() => modelOptions(selAgent?.capabilities), [selAgent]);
  // Same two shapes as the New-task dialog, over this task's OWN effective
  // provider: the project's override with the task's laid over it, since a task
  // can be sent to a local endpoint (or back to the cloud) on its own row.
  const taskProject = projects.find((p) => p.id === task.project_id);
  const provider = useMemo(() => taskProvider(taskProject, task), [taskProject, task]);
  const localModel = provider.kind !== "cloud";
  const endpoint = useEndpointModels(task.project_id, "", localModel);
  // Switching an unstarted task's agent invalidates a model chosen under the old
  // one, same as the New-task dialog: drop to Inherit rather than save an id the
  // new driver would never resolve. Gated on the agent actually having MOVED,
  // unlike the New dialog's copy — merely being absent from the catalog is also
  // what a not-yet-loaded bundle and a provider change look like, and rewriting
  // the row's model just because the dialog was opened is the worse failure.
  useEffect(() => {
    if (!model || agent === task.agent) return;
    if (!modelOpts.some((m) => m.value === model)) setModel(null);
  }, [agent, task.agent, modelOpts, model]);
  const agentReady = selAgent ? selAgent.authenticated : true;
  const startWhy = !can ? "A title is required" : blocked ? "Blocked by unfinished tasks. Clear them or drop the dependency first"
    : !agentReady ? `Connect ${selAgent?.label} to start a session` : undefined;
  const canStartNow = can && !blocked && agentReady;
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
        {/* Save stays the primary action only when it's the only one — on an
            unstarted task, launching it is what the dialog is usually open for.
            Its label shortens beside the tray verbs so five buttons still fit
            one row of the footer. */}
        <button className={`btn ${startable ? "btn-line" : "btn-accent"}`} disabled={!can} onClick={() => save()}
          title={isSuggestion ? "Save the edits and leave this in the suggestions tray" : undefined}>
          {Icon.check()} {isSuggestion ? "Save" : "Save changes"}
        </button>
        {isSuggestion && (
          <button className="btn btn-line" disabled={!can} onClick={() => save("add")}
            title={task.status === "cancelled" ? "Disagree with the withdrawal: save and restore it to the task list" : "Save and move this out of the suggestions tray, to start later"}>
            {Icon.plus()} {task.status === "cancelled" ? "Restore" : "Add"}
          </button>
        )}
        {startable && (
          <button className="btn btn-accent" disabled={!canStartNow} onClick={() => save("start")} title={startWhy ?? "Save and launch the first session now"}>
            {Icon.play()} {isSuggestion ? "Add & start" : "Save & start"}
          </button>
        )}
      </>}>
      <div className="field">
        <div className="lab">Title</div>
        <input ref={ref} type="text" value={title} placeholder="e.g. Add rate-limiting to auth endpoints"
          onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && can) save(); }} />
      </div>
      <div className="field">
        <div className="lab">Description <span className="opt">(what to do)</span></div>
        <textarea value={desc} placeholder="Describe the feature or task. This is the body of the prompt the agent starts with." onChange={(e) => setDesc(e.target.value)} />
        {/* The description is injected into each SESSION's system prompt at
            session start, so once a task has run this field is no longer the
            thing steering the agent in front of you — it's the brief the NEXT
            session gets. Said plainly, because the pre-start wording ("the body
            of the prompt the agent starts with") invites the opposite reading. */}
        {task.started === 1 ? (
          <div className="hlp">Already sent to the agent. Edits here update the task record and any future sessions, not the running one.</div>
        ) : (
          <div className="hlp">Project context is prepended automatically. No need to restate the stack or conventions.</div>
        )}
      </div>
      {canChangeAgent && <AgentPicker agents={agents} value={agent} onChange={setAgent} onConnect={onOpenSetup} />}
      <ModelField options={modelOpts} value={model} onChange={setModel}
        freeForm={localModel} suggestions={endpoint.models} status={<EndpointNote state={endpoint} />}
        help={task.started === 1 ? " (takes effect on this task's next turn)." : undefined} />
      <div className="field">
        <div className="lab">Priority</div>
        <PrioritySeg value={priority} onChange={setPriority} />
      </div>
      <TagsField tags={tags} value={tagIds} onChange={setTagIds} onCreate={onCreateTag} />
      <BaseBranchField task={task} project={taskProject} />
      <DepPicker candidates={candidates} value={deps} onChange={setDeps} autoStart={autoStart} onAutoStart={setAutoStart} />
      {/* Unlike the agent picker above, this is NOT gated on the task being
          unstarted: a started one can move by discarding the worktree it cut
          from this project's repo, which the field asks for explicitly. Only a
          live turn is refused outright, and the field surfaces the server's
          reason. */}
      <MoveProjectField task={task} tasks={tasks} tags={tags} projects={projects} agents={agents} onMove={onMove} />
      {confirmDel && (
        <div className="hlp" style={{ color: "var(--red)", marginTop: 16 }}>
          This permanently removes “{task.title}”, its agent session and git worktree from Calandria. Any unmerged work in the worktree is discarded.
        </div>
      )}
    </Modal>
  );
}

// Mirror of the server's RefreshState (lib/contextRefresh.ts) — the detached
// "Refresh with AI" job state the modal polls.
type RefreshState = { status: "idle" | "running" | "done" | "error"; draft: string; error: string; started_at: number; estimate?: InternalUsageEstimate | null };

// ---------- landing mode (merge vs PR) ----------

/** What POST /api/github/landing-mode answers with. `mode: null` = couldn't tell. */
interface LandingProbeResult { mode: LandingMode | null; reason: string; source?: "rules" | "protection" | "none" }

/**
 * Ask the server whether this repo's base branch requires a pull request.
 * Resolves to a null-mode result on any transport failure, because a probe is
 * an aid: it must never be able to block saving a project.
 */
function probeLanding(repo: string, branch: string): Promise<LandingProbeResult> {
  return jsend<LandingProbeResult>("/api/github/landing-mode", "POST", { repo_path: repo, branch })
    .catch((e) => ({ mode: null, reason: e instanceof Error ? e.message : "Could not reach GitHub." }));
}

/**
 * How a project's work is meant to reach its base branch. This is not cosmetic:
 * it's the sentence every session in the project is told (buildProjectContext),
 * so on a PR-required repo it's the difference between an agent that opens a PR
 * and one that spends its last turn pressing a Merge the server will reject.
 */
function LandingSeg({ value, onChange, branch }: { value: LandingMode; onChange: (m: LandingMode) => void; branch: string }) {
  const b = branch.trim() || "the base branch";
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <div className="lab">{Icon.git()} How work lands <span className="opt">(on {b})</span></div>
      <div className="seg">
        <button className={value === "merge" ? "on" : ""} onClick={() => onChange("merge")}>Merge</button>
        <button className={value === "pr" ? "on" : ""} onClick={() => onChange("pr")}>Pull request</button>
      </div>
      <div className="hlp">
        {value === "pr"
          ? `${b} is protected, so Merge is rejected. Sessions are told to finish by opening a PR against it.`
          : `Calandria merges a finished task's branch into ${b} itself. Sessions are told so.`}
      </div>
    </div>
  );
}

export function ContextModal({ project, agents, onSetDefaultAgent, onClose, onSave, onDelete, onDeprecate }: { project: ProjectRow; agents: AgentsBundle; onSetDefaultAgent: (agent: string) => void; onClose: () => void; onSave: (p: { name: string; context: string; send_context: number; repo_path: string; branch: string; landing_mode: LandingMode; auto_reclaim: number; dev_command: string; setup_command: string; test_command: string; agent_env: string }) => void; onDelete: () => void; onDeprecate: () => void }) {
  const [name, setName] = useState(project.name);
  const [context, setContext] = useState(project.context);
  const [sendContext, setSendContext] = useState(project.send_context !== 0);
  const [repo, setRepo] = useState(project.repo_path);
  const [branch, setBranch] = useState(project.branch);
  // How this project's work lands, plus what GitHub says about it. The probe
  // runs once when the dialog opens and is REPORTED, never applied: overwriting
  // a saved choice because a repo happens to have a ruleset would take the
  // decision away from the one person who knows about the exception (a project
  // pointed at a staging branch that merges locally under a PR-required repo is
  // a real configuration). Applying it is one click, spelled out below.
  const [landing, setLanding] = useState<LandingMode>(project.landing_mode === "pr" ? "pr" : "merge");
  const [autoReclaim, setAutoReclaim] = useState(project.auto_reclaim === 1);
  // Which endpoint the project's turns run against (lib/agentEnv.ts). The
  // stored form is an env-shaped override; the form edits the three things a
  // person actually chooses — kind, base URL, model (plus a token for a custom
  // endpoint) — and writes the override back through providerPresetEnv, so the
  // form and the presets `suggest_task` writes can't produce different shapes.
  const savedProvider = describeProvider(parseAgentEnv(project.agent_env));
  const [providerKind, setProviderKind] = useState<ProviderKind>(savedProvider.kind);
  const [providerUrl, setProviderUrl] = useState(normalizeBaseUrl(savedProvider.anthropic_base_url ?? savedProvider.openai_base_url ?? ""));
  const [providerModel, setProviderModel] = useState(savedProvider.model ?? "");
  const [providerToken, setProviderToken] = useState(savedProvider.auth_token ?? "");
  const localDefaultUrl = agents.local_base_url || "http://localhost:11434";
  // What the URL in the box right now actually has. Probed through the server
  // (the endpoint is loopback THERE, not in this browser) and keyed on the
  // TYPED url rather than the saved one, so the suggestions and the "reachable,
  // 4 models" line follow the field being edited instead of appearing only
  // after a save.
  const endpoint = useEndpointModels(project.id, providerUrl || localDefaultUrl, providerKind !== "cloud");
  const agentEnvOut = () =>
    providerKind === "cloud" ? "" : serializeAgentEnv(providerPresetEnv({ baseUrl: providerUrl || localDefaultUrl, model: providerModel, token: providerToken }));
  const [probe, setProbe] = useState<LandingProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeAsked, setProbeAsked] = useState(false); // the user pressed Detect — show failures too
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

  // One probe when the dialog opens, against the SAVED repo/branch: the fields
  // are editable and re-probing per keystroke would fire a gh subprocess at a
  // half-typed path. Re-running it after an edit is what Detect is for.
  const repoRef = useRef(repo);
  repoRef.current = repo;
  const branchRef = useRef(branch);
  branchRef.current = branch;
  const detect = useCallback(async (opts: { asked?: boolean } = {}) => {
    if (opts.asked) setProbeAsked(true);
    setProbing(true);
    try {
      setProbe(await probeLanding(repoRef.current, branchRef.current));
    } finally {
      setProbing(false);
    }
  }, []);
  useEffect(() => {
    if (project.repo_path && project.branch) void detect();
  }, [detect, project.repo_path, project.branch]);

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
            <button className="btn btn-line" onClick={onDeprecate} title="Hide this project under the sidebar's deprecated area. Nothing is deleted. Restore it any time.">{Icon.archive()} Deprecate</button>
          </>
        )}
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        {/* Saving a blank branch is refused here rather than repaired later: every
            task in the project inherits this column for its base, so one cleared
            field flags all of them at once. updateProject() keeps the old value
            anyway, but a Save that silently ignores what the field says is worse
            than one that won't run. */}
        <button className="btn btn-accent" disabled={!branch.trim()} title={branch.trim() ? undefined : "Every task in this project falls back to this branch, so it can't be blank."} onClick={() => onSave({ name, context, send_context: sendContext ? 1 : 0, repo_path: repo, branch: branch.trim(), landing_mode: landing, auto_reclaim: autoReclaim ? 1 : 0, dev_command: devCmd, setup_command: setupCmd, test_command: testCmd, agent_env: agentEnvOut() })}>{Icon.check()} Save</button>
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
            Exploring {repo.split("/").pop() || "the repo"} to draft fresh context. This can take a minute.
          </div>
        ) : prevContext != null ? (
          <div className="hlp">Drafted from the repo. Review and edit it, then Save, or Undo to revert.</div>
        ) : (
          <div className="hlp">Be specific about stack, conventions, and constraints. Every task in this project inherits it.</div>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12.5, color: "var(--ink-2)", cursor: "pointer" }}>
          <input type="checkbox" checked={sendContext} onChange={(e) => setSendContext(e.target.checked)} />
          Include this context in new agent sessions
        </label>
        {!sendContext && (
          <div className="hlp">New tasks will start without the saved context (task details and Calandria tools are still included). Each task can override this when it starts.</div>
        )}
      </div>
      <div style={{ display: "flex", gap: 14 }}>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <div className="lab">{Icon.folder()} Working dir <span className="opt">(required to run tasks)</span></div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="text" className="ctx-mono" style={{ flex: 1, minWidth: 0 }} value={repo} placeholder="/Users/you/code/project" onChange={(e) => setRepo(e.target.value)} />
            <BrowseDirButton initial={repo} onPick={setRepo} />
          </div>
        </div>
        <div className="field" style={{ flex: "0 0 170px", marginBottom: 0 }}>
          <div className="lab">{Icon.git()} Branch <span className="opt">(required)</span></div>
          <input type="text" className="ctx-mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginTop: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <LandingSeg value={landing} onChange={setLanding} branch={branch} />
        </div>
        <div style={{ flex: "0 0 auto", paddingTop: 22 }}>
          <button className="btn btn-line btn-sm" onClick={() => detect({ asked: true })} disabled={probing || !repo || !branch}
            title={repo && branch ? "Ask GitHub whether this branch requires a pull request" : "Set a working directory and branch first"}>
            {probing ? "Checking GitHub…" : "Detect"}
          </button>
        </div>
      </div>
      {probe?.mode && probe.mode !== landing ? (
        <div className="hlp" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          <span>GitHub says: {probe.reason}</span>
          <button className="btn btn-line btn-sm" onClick={() => setLanding(probe.mode!)}>
            Use {probe.mode === "pr" ? "pull request" : "merge"}
          </button>
        </div>
      ) : probe?.mode ? (
        <div className="hlp" style={{ marginTop: 6 }}>GitHub agrees: {probe.reason}</div>
      ) : probe && probeAsked ? (
        <div className="hlp" style={{ marginTop: 6 }}>{probe.reason}</div>
      ) : null}
      {/* The tail of landing: what happens to the CHECKOUT once work lands. Off
          by default, and per project, because it deletes a local branch without
          being asked — see lib/reclaim.ts. The button in the session header
          does the same thing on demand whether or not this is on. */}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 12, fontSize: 12.5, color: "var(--ink-2)", cursor: "pointer" }}>
        <input type="checkbox" checked={autoReclaim} onChange={(e) => setAutoReclaim(e.target.checked)} />
        <span>
          Reclaim a task&apos;s worktree when its work lands
          <span className="hlp" style={{ display: "block", marginTop: 2 }}>
            {landing === "pr"
              ? "When its pull request reports merged, catch " + (branch || "the base branch") + " up with origin, remove the task's checkout, delete its local branch and mark it done. Never over unsaved work — that still asks."
              : "When it merges into " + (branch || "the base branch") + ", remove the task's checkout, delete its local branch and mark it done. Never over unsaved work — that still asks."}
          </span>
        </span>
      </label>
      <div style={{ marginTop: 14 }}>
        <AgentPicker
          agents={agents} value={project.default_agent} onChange={onSetDefaultAgent}
          label="Default agent for new tasks"
          help="New tasks in this project default to this agent. Existing tasks keep the agent they were created with."
        />
      </div>
      {/* The endpoint behind that agent. Cloud is the agent's own login; the
          other two point BOTH CLIs at an Anthropic-/OpenAI-compatible server
          (Claude Code via ANTHROPIC_BASE_URL, Codex via a config.toml provider
          entry the driver writes) with no new driver. A task can override this
          on its own row — that is how a session delegates to a local model. */}
      <div className="field" style={{ marginTop: 14 }}>
        <div className="lab">{Icon.spark()} Model provider</div>
        <div className="model-field">
          <select value={providerKind} aria-label="Model provider" onChange={(e) => {
            const kind = e.target.value as ProviderKind;
            setProviderKind(kind);
            if (kind === "local" && (!providerUrl || providerKind === "cloud")) setProviderUrl(localDefaultUrl);
          }}>
            <option value="cloud">Cloud — the agent&apos;s own login</option>
            <option value="local">Local model — Ollama or LM Studio</option>
            <option value="custom">Custom base URL</option>
          </select>
        </div>
        {providerKind !== "cloud" && (
          <>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input type="text" className="ctx-mono" style={{ flex: 1, minWidth: 0 }} value={providerUrl} placeholder={localDefaultUrl}
                title="Base URL of the server. Ollama and LM Studio serve both APIs from one origin; /v1 is added where each CLI needs it."
                onChange={(e) => setProviderUrl(e.target.value)} />
              <FreeFormModel value={providerModel} onChange={setProviderModel} suggestions={endpoint.models}
                style={{ flex: "0 0 190px" }} label="Model" placeholder="model, e.g. qwen3-coder"
                title="The model every task in this project runs unless the task picks its own. Claude Code's opus/sonnet/haiku aliases resolve to it too. The suggestions are what this server reports; anything it has can be typed." />
            </div>
            {providerKind === "custom" && (
              <input type="text" className="ctx-mono" style={{ marginTop: 8 }} value={providerToken} placeholder="auth token (ollama)"
                title="Sent as the Anthropic auth token. Ollama and LM Studio require one and ignore its value. The instance's own Anthropic/OpenAI keys are never sent to a custom endpoint."
                onChange={(e) => setProviderToken(e.target.value)} />
            )}
            {/* What the server just said, ahead of the advice about what to
                type: an unreachable endpoint answers most of the questions
                that advice is trying to pre-empt. */}
            <div className="hlp"><EndpointNote state={endpoint} /></div>
            <div className="hlp">
              {providerModel.trim()
                ? "Turns are not billed as cloud spend. Codex reaches the same server through a provider entry of its own, so ~/.codex/config.toml is left alone."
                : "Name a model, or the CLIs will ask the server for their cloud defaults and fail. Codex needs an OpenAI Responses endpoint: Ollama 0.13+ and LM Studio."}
            </div>
          </>
        )}
      </div>
      {showServices && (
        <div className="field" style={{ marginTop: 14 }}>
          <div className="lab ctx-lab">
            <span>{Icon.sliders()} Services</span>
            <span className="opt" style={{ fontWeight: 400 }}>port <code className="ctx-mono">{project.port || "—"}</code> injected as <code className="ctx-mono">PORT</code></span>
          </div>
          <div className="hlp" style={{ marginTop: 0, marginBottom: 8 }}>
            Calandria supervises these in {repo ? repo.split("/").pop() : "the working dir"}: start/stop them from the Services panel; they outlive the tab.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label className="svc-cfg-row">
              <span className="svc-cfg-lab">Dev server</span>
              <input type="text" className="ctx-mono" value={devCmd} placeholder="npm run dev" onChange={(e) => setDevCmd(e.target.value)} />
            </label>
            <label className="svc-cfg-row">
              <span className="svc-cfg-lab">Setup <span className="opt">(optional)</span></span>
              <input type="text" className="ctx-mono" value={setupCmd} placeholder="npm install" onChange={(e) => setSetupCmd(e.target.value)} />
            </label>
            <label className="svc-cfg-row">
              <span className="svc-cfg-lab">Test <span className="opt">(optional)</span></span>
              <input type="text" className="ctx-mono" value={testCmd} placeholder="npm test" onChange={(e) => setTestCmd(e.target.value)} />
            </label>
          </div>
        </div>
      )}
      {confirmDel && (
        <div className="hlp" style={{ color: "var(--red)", marginTop: 16 }}>
          This permanently removes “{project.name}”, its tasks and chat history from Calandria. Your code on disk{repo ? ` in ${repo}` : ""} is not touched.
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

export function NewProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (i: { name: string; sub: string; color: string; context: string; repo_path: string; branch?: string; landing_mode?: LandingMode }) => void | Promise<void> }) {
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
  // How this project's work will land. Creation is the one moment detection may
  // PRESELECT outright — there is no choice yet to override — so a repo whose
  // default branch requires a pull request starts the project honest instead of
  // telling every session for the next month that Merge lands into main.
  // Touching the control pins it: a later probe result never moves it back.
  const [landing, setLanding] = useState<LandingMode>("merge");
  const [landingProbe, setLandingProbe] = useState<LandingProbeResult | null>(null);
  const landingTouched = useRef(false);
  const pickLanding = (m: LandingMode) => { landingTouched.current = true; setLanding(m); };
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const ok = name.trim().length > 0 && !cloning && (mode === "fresh" || cloneSpec.trim().length > 0);

  // Probe the folder the user pointed at, debounced so a path being typed
  // doesn't spawn a gh subprocess per keystroke. Only the "fresh" path needs
  // this; a clone is probed once, after it lands, in submit() below.
  useEffect(() => {
    const dir = repo.trim();
    if (mode !== "fresh" || !dir) { setLandingProbe(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      const r = await probeLanding(dir, "");
      if (!live) return;
      setLandingProbe(r);
      if (r.mode && !landingTouched.current) setLanding(r.mode);
    }, 600);
    return () => { live = false; clearTimeout(t); };
  }, [repo, mode]);

  const submit = async () => {
    if (!ok) return;
    const base = { name: name.trim(), sub: sub.trim() || "app", color, context: context.trim() };
    if (mode === "fresh") { await onCreate({ ...base, repo_path: repo.trim(), landing_mode: landing }); return; }
    // Clone first; only create the project once the repo actually landed.
    setCloning(true);
    setCloneErr(null);
    try {
      const r = await jsend<{ path: string; branch: string }>("/api/github/clone", "POST", { repo: cloneSpec.trim() });
      // Now the repo exists on disk and its default branch is known, so this is
      // the first moment the ruleset probe can answer for it. A user who already
      // picked a mode keeps it; otherwise the repo's own rules decide.
      const probed = landingTouched.current ? null : await probeLanding(r.path, r.branch);
      await onCreate({ ...base, repo_path: r.path, branch: r.branch, landing_mode: probed?.mode ?? landing });
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
          <div className="lab">Working dir <span className="opt">(pick an existing repo or folder, or leave blank to start fresh and add one later)</span></div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="text" className="ctx-mono" style={{ flex: 1, minWidth: 0 }} value={repo} placeholder="/Users/you/code/project" onChange={(e) => setRepo(e.target.value)} />
            <BrowseDirButton initial={repo} onPick={setRepo} />
          </div>
          {repo.trim() && (
            <div style={{ marginTop: 12 }}>
              <LandingSeg value={landing} onChange={pickLanding} branch="" />
              {landingProbe?.mode && <div className="hlp" style={{ marginTop: 6 }}>GitHub says: {landingProbe.reason}</div>}
            </div>
          )}
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
        <div className="lab">What we&apos;re building <span className="opt">(optional, can add later)</span></div>
        <textarea value={context} placeholder="Description, stack, conventions…" onChange={(e) => setContext(e.target.value)} />
      </div>
    </Modal>
  );
}
