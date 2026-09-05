"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { agentLabel, capsFor, defaultAgentFor, pickerAgents } from "./agents";
import { relTime } from "./format";
import { ErrNote } from "./shared";
import { Modal, PrioritySeg } from "./Modal";
import { ProjectTargetList } from "./modals";
import type { Priority } from "@/lib/types";
import { INHERIT_LABEL } from "./types";
import type { AgentsBundle, ProjectRow, RunbookRow, RunbooksResponse } from "./types";

// What the slash-command validator returns, mirrored from
// lib/schedule/commands.ts's PromptValidation. The endpoint is the schedules'
// one on purpose: it answers "would a session in this project expand /x", which
// is the same question whatever saved the prompt.
type Check = { ok: boolean; error?: string; suggestions?: string[]; unchecked?: boolean };

/** Swap the leading slash command, keeping whatever follows it. */
function withCommand(prompt: string, command: string): string {
  return prompt.replace(/^(\s*)\/[A-Za-z0-9_:-]+/, `$1/${command}`);
}

/** "Sweep: Aug 20, 14:32". Must match the run route's defaultTitle(). */
export function defaultRunTitle(name: string, now = new Date()): string {
  const stamp = new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(now);
  return `${name}: ${stamp}`;
}

/**
 * Create/edit form for a runbook.
 *
 * Close to ScheduleForm, minus the clock: the two are the same object with
 * and without one. The slash validation is the same call for the same reason
 * it exists there: an unknown command is a SUCCESS at run time ("Unknown
 * command: /x"), so a dispatch would report green having done nothing, and
 * this is the cheap place to catch a typo. Save is never blocked: the probe
 * reads one session's registry and can be wrong.
 */
function RunbookForm({
  projectId, project, agents, initial, onCancel, onSaved,
}: {
  projectId: string;
  project: ProjectRow;
  agents: AgentsBundle;
  /** Present = editing this runbook; absent = creating one. */
  initial?: RunbookRow;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const uid = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [agent, setAgent] = useState(initial?.agent ?? defaultAgentFor(agents, project.default_agent));
  const [permissionMode, setPermissionMode] = useState<string | null>(initial?.permission_mode ?? null);
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? "med");
  const [sendContext, setSendContext] = useState(initial ? initial.send_context !== 0 : project.send_context !== 0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // Unlike a schedule's picker, the inherit head stays on offer. A schedule
  // always runs unattended, so "whatever the default resolves to" is the exact
  // ambiguity that field exists to remove; a runbook dispatch has somebody in
  // front of it who can answer a card, so inheriting the app default is a real
  // and usually correct answer.
  const modeCaps = useMemo(() => capsFor(agents, agent)?.permissionModes ?? [], [agents, agent]);
  // Clamp when the agent changes: Codex has no "acceptEdits" at all, and
  // leaving it selected-but-invalid would save a value that driver treats as
  // full auto-run despite the label promising otherwise.
  useEffect(() => {
    if (permissionMode && modeCaps.length && !modeCaps.some((m) => m.value === permissionMode)) setPermissionMode(null);
  }, [modeCaps, permissionMode]);

  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const validate = useCallback(async (p: string, a: string) => {
    if (!p.trim().startsWith("/")) { setCheck(null); return; }
    setChecking(true);
    try {
      setCheck(await jsend<Check>("/api/schedules/validate", "POST", { project_id: projectId, prompt: p, agent: a }));
    } catch {
      setCheck(null);
    } finally {
      setChecking(false);
    }
  }, [projectId]);
  // Check on open so an existing slash prompt shows its warning without the
  // user touching the field.
  useEffect(() => { void validate(prompt, agent); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applySuggestion = (command: string) => {
    const next = withCommand(prompt, command);
    setPrompt(next);
    void validate(next, agent);
  };

  const canSave = name.trim().length > 0 && prompt.trim().length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setErr("");
    const body = {
      name: name.trim(), description, prompt, agent, priority,
      permission_mode: permissionMode, send_context: sendContext,
    };
    try {
      if (initial) await jsend(`/api/runbooks/${initial.id}`, "PATCH", body);
      else await jsend(`/api/projects/${projectId}/runbooks`, "POST", body);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div className="rb-form">
      <div className="field">
        <label className="lab" htmlFor={`${uid}-name`}>Name</label>
        <input id={`${uid}-name`} type="text" value={name} placeholder="e.g. Push & babysit CI"
          onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label className="lab" htmlFor={`${uid}-desc`}>Description <span className="opt">(what it does)</span></label>
        <input id={`${uid}-desc`} type="text" value={description}
          placeholder="Push everything unpushed, then watch the pipeline."
          onChange={(e) => setDescription(e.target.value)} />
        <div className="hlp">Becomes the brief on every task this dispatches.</div>
      </div>
      <div className="field">
        <label className="lab" htmlFor={`${uid}-prompt`}>Prompt</label>
        <textarea id={`${uid}-prompt`} value={prompt} placeholder="/push-and-watch, or plain instructions"
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => void validate(prompt, agent)} />
        <div className="hlp">Sent as the first message of every task this dispatches, so a slash command expands.</div>
        {checking && <div className="hlp">Checking this project&rsquo;s slash commands…</div>}
        {check && !check.ok && (
          <div className="rb-check bad" role="alert">
            <div>{check.error}</div>
            {check.suggestions && check.suggestions.length > 0 && (
              <div className="rb-suggestions">
                Did you mean:
                {check.suggestions.map((s) => (
                  <button key={s} type="button" className="btn btn-line btn-sm" onClick={() => applySuggestion(s)}>/{s}</button>
                ))}
              </div>
            )}
            <div className="rb-note">
              Save still works. The check reads one session&rsquo;s command list and can be wrong. If it isn&rsquo;t,
              dispatching will fail rather than report success having done nothing.
            </div>
          </div>
        )}
        {check?.ok && check.unchecked && (
          <div className="hlp">Couldn&rsquo;t reach this project&rsquo;s command registry to check. Saving without verifying.</div>
        )}
        {check?.ok && !check.unchecked && prompt.trim().startsWith("/") && (
          <div className="hlp">{Icon.check()} recognized command</div>
        )}
      </div>
      <div className="field">
        <label className="lab" htmlFor={`${uid}-agent`}>Agent</label>
        <select id={`${uid}-agent`} value={agent} onChange={(e) => { setAgent(e.target.value); void validate(prompt, e.target.value); }}>
          {pickerAgents(agents, agent).map((a) => (
            <option key={a.id} value={a.id}>{a.label}{a.authenticated ? "" : " (not connected)"}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="lab" htmlFor={`${uid}-perm`}>Permission mode</label>
        {modeCaps.length > 0 ? (
          <select id={`${uid}-perm`} value={permissionMode ?? ""} onChange={(e) => setPermissionMode(e.target.value || null)}>
            {/* Same word the task pickers' head uses (INHERIT_LABEL), so "inherit
                the app default" and Claude's own mode spelled "default", right
                below in the provider's list, can't read as the same entry. */}
            <option value="">{INHERIT_LABEL}: use the app-level default</option>
            {modeCaps.map((m) => <option key={m.value} value={m.value} title={m.sub}>{m.label}</option>)}
          </select>
        ) : (
          <div className="hlp">{agentLabel(agents, agent)} has no configurable permission mode.</div>
        )}
      </div>
      <div className="field">
        <label className="lab">Priority</label>
        <PrioritySeg value={priority} onChange={setPriority} />
      </div>
      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--ink-2)", cursor: "pointer" }}>
          <input type="checkbox" checked={sendContext} onChange={(e) => setSendContext(e.target.checked)} />
          Send saved project context to the agent
        </label>
      </div>
      {err && <ErrNote>{err}</ErrNote>}
      <div className="rb-actions">
        <button className="btn btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="btn btn-accent" disabled={!canSave} onClick={save}>
          {Icon.check()} {saving ? "Saving…" : initial ? "Save changes" : "Create runbook"}
        </button>
      </div>
    </div>
  );
}

/**
 * The dispatch sheet: what this run will be called, what it will send, and one
 * box for anything extra. Everything else is already decided by the runbook,
 * which is the point of having saved it.
 */
function RunSheet({ runbook, agents, onCancel, onRan }: {
  runbook: RunbookRow;
  agents: AgentsBundle;
  onCancel: () => void;
  onRan: (taskId: string) => void;
}) {
  const uid = useId();
  const [title, setTitle] = useState(() => defaultRunTitle(runbook.name));
  const [extra, setExtra] = useState("");
  const [start, setStart] = useState(true);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");

  const go = async () => {
    // A double-click is two tasks and two live turns, so the button latches for
    // the whole round trip, not only while React re-renders.
    if (running) return;
    setRunning(true);
    setErr("");
    try {
      const { task } = await jsend<{ task: { id: string } }>(`/api/runbooks/${runbook.id}/run`, "POST", { title, extra, start });
      onRan(task.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  };

  return (
    <Modal
      title={`Run ${runbook.name}`}
      sub={runbook.description || "Dispatches a fresh task in this project"}
      onClose={onCancel}
      footer={<>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--ink-2)", cursor: "pointer" }}>
          <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Start session immediately
        </label>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onCancel} disabled={running}>Cancel</button>
        <button className="btn btn-accent" onClick={go} disabled={running}>
          {Icon.play()} {running ? "Dispatching…" : "Run"}
        </button>
      </>}
    >
      <div className="field">
        <label className="lab" htmlFor={`${uid}-title`}>Task title</label>
        <input id={`${uid}-title`} type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label className="lab">Sends</label>
        <pre className="rb-preview">{runbook.prompt}</pre>
      </div>
      <div className="field">
        <label className="lab" htmlFor={`${uid}-extra`}>Instructions for this run <span className="opt">(optional)</span></label>
        <textarea id={`${uid}-extra`} value={extra} placeholder="e.g. focus on CEAP-1234, and skip the flaky suite"
          onChange={(e) => setExtra(e.target.value)} />
        <div className="hlp">Appended to the prompt above. Leave blank to run it exactly as saved.</div>
      </div>
      <div className="rb-meta">
        <span>{agentLabel(agents, runbook.agent)}</span>
        <span>·</span>
        {/* Show the mode the way this runbook's agent names it (labels are
            provider-native); fall back to the stored value if the descriptor
            hasn't loaded or no longer lists it. */}
        <span>{capsFor(agents, runbook.agent)?.permissionModes.find((m) => m.value === runbook.permission_mode)?.label ?? runbook.permission_mode ?? "inherits the app permission default"}</span>
        <span>·</span>
        <span>{runbook.priority} priority</span>
      </div>
      {err && <ErrNote style={{ marginTop: 12 }}>{err}</ErrNote>}
    </Modal>
  );
}

/** "Copy to…": the same destination list the move flows render. */
function CopySheet({ runbook, projects, onCancel, onCopied }: {
  runbook: RunbookRow;
  projects: ProjectRow[];
  onCancel: () => void;
  onCopied: () => void;
}) {
  const targets = projects.filter((p) => p.id !== runbook.project_id);
  const [dest, setDest] = useState(targets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const copy = async () => {
    if (!dest || busy) return;
    setBusy(true);
    setErr("");
    try {
      await jsend(`/api/runbooks/${runbook.id}/copy`, "POST", { project_id: dest });
      onCopied();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Copy "${runbook.name}"`}
      sub="An independent copy. Editing one won't change the other"
      onClose={onCancel}
      footer={<>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-accent" onClick={copy} disabled={!dest || busy}>{Icon.copy()} Copy</button>
      </>}
    >
      {targets.length === 0 ? (
        <div className="rb-note">There is no other project to copy this into.</div>
      ) : (
        <ProjectTargetList targets={targets} value={dest} onChange={setDest} name="rb-copy-target" />
      )}
      {err && <ErrNote style={{ marginTop: 12 }}>{err}</ErrNote>}
    </Modal>
  );
}

/**
 * A project's saved runbooks: dispatch, edit, copy, delete.
 *
 * Sits above Schedules in the landing pane and speaks its visual language,
 * because the two are the same object with and without a clock and shouldn't
 * read as unrelated features.
 */
export function Runbooks({ project, projects, agents, onOpenTask }: {
  project: ProjectRow;
  projects: ProjectRow[];
  agents: AgentsBundle;
  onOpenTask: (taskId: string) => void;
}) {
  const projectId = project.id;
  const [data, setData] = useState<RunbooksResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await jget<RunbooksResponse>(`/api/projects/${projectId}/runbooks`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // Another tab, or an agent's create_runbook, changed this project's
  // runbooks. A window event, not a prop: the card owns its own fetch,
  // and threading a refresh counter through ProjectLanding for one rare
  // mutation would put this component's state in its grandparent.
  useEffect(() => {
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<string>).detail === projectId) void load();
    };
    window.addEventListener("calandria:runbooks", onChanged);
    return () => window.removeEventListener("calandria:runbooks", onChanged);
  }, [projectId, load]);

  // A ⌘K dispatch that failed. The palette has closed by then and the user may
  // have been anywhere, so useShell sends them here and hands the
  // message to the one surface that can show it next to the recipe that
  // produced it.
  useEffect(() => {
    const onErr = (e: Event) => {
      const d = (e as CustomEvent<{ projectId: string; message: string }>).detail;
      if (d.projectId === projectId) setError(d.message);
    };
    window.addEventListener("calandria:runbook-error", onErr);
    return () => window.removeEventListener("calandria:runbook-error", onErr);
  }, [projectId]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  // The confirmation says what happens to a linked schedule, because "delete
  // the thing my 08:30 job depends on" is otherwise unanswerable from the
  // button alone.
  const confirmDelete = (r: RunbookRow) =>
    window.confirm(
      r.used_by.length
        ? `Delete "${r.name}"?\n\n${r.used_by.map((s) => s.name).join(", ")} will keep firing this prompt. The recipe is copied back into ${r.used_by.length === 1 ? "it" : "them"} first.`
        : `Delete "${r.name}"? This can't be undone.`
    );

  if (!data) return null;

  const runTarget = data.runbooks.find((r) => r.id === runningId) ?? null;
  const copyTarget = data.runbooks.find((r) => r.id === copyingId) ?? null;

  return (
    <section className="rb-card">
      <div className="rb-header">
        <h3>Runbooks</h3>
        <span className="spacer" />
        {!creating && (
          <button className="btn btn-line btn-sm" onClick={() => { setCreating(true); setEditingId(null); }}>
            {Icon.plus()} New runbook
          </button>
        )}
      </div>
      {error ? <div className="rb-alert rb-alert-bad">{error}</div> : null}
      {creating && (
        <RunbookForm
          projectId={projectId}
          project={project}
          agents={agents}
          onCancel={() => setCreating(false)}
          onSaved={() => { setCreating(false); void load(); }}
        />
      )}
      {data.runbooks.length === 0 && !creating ? (
        <div className="rb-note">
          No runbooks yet. Save a task you run often and dispatch it from here or ⌘K.
        </div>
      ) : null}
      {data.runbooks.map((r) => {
        if (editingId === r.id) {
          return (
            <RunbookForm
              key={r.id}
              projectId={projectId}
              project={project}
              agents={agents}
              initial={r}
              onCancel={() => setEditingId(null)}
              onSaved={() => { setEditingId(null); void load(); }}
            />
          );
        }
        return (
          <div key={r.id} className="rb-row">
            <div className="rb-head">
              <strong>{r.name}</strong>
              {r.created_by ? <span className="rb-badge">added by {agentLabel(agents, r.created_by)}</span> : null}
              <span className="spacer" />
              <button className="btn btn-accent btn-sm" disabled={busy === r.id} onClick={() => setRunningId(r.id)}>
                {Icon.play()} Run
              </button>
              <button className="btn btn-line btn-sm" disabled={busy === r.id} onClick={() => { setEditingId(r.id); setCreating(false); }}>
                {Icon.edit()} Edit
              </button>
              <button className="btn btn-line btn-sm" disabled={busy === r.id} onClick={() => setCopyingId(r.id)}>
                {Icon.copy()} Copy to…
              </button>
              <button
                className="btn btn-line btn-sm"
                disabled={busy === r.id}
                onClick={() => { if (confirmDelete(r)) void act(r.id, () => jsend(`/api/runbooks/${r.id}`, "DELETE")); }}
              >
                {Icon.x()} Delete
              </button>
            </div>
            {r.description ? <div className="rb-desc">{r.description}</div> : null}
            <div className="rb-meta">
              {r.last_run ? (
                <button className="btn btn-ghost btn-sm" onClick={() => onOpenTask(r.last_run!.id)}>
                  last run {relTime(r.last_run.created_at)}
                </button>
              ) : (
                <span className="rb-note">never run</span>
              )}
            </div>
            {/* The cost of the convenience, stated: a linked schedule reads its
                prompt from this row at fire time, so an edit here changes work
                that runs with nobody watching. */}
            {r.used_by.length > 0 && (
              <div className="rb-note">
                {Icon.clock()} Also fired by {r.used_by.map((s) => s.name).join(", ")}. Editing this changes what those schedules run.
              </div>
            )}
          </div>
        );
      })}
      {runTarget && (
        <RunSheet
          runbook={runTarget}
          agents={agents}
          onCancel={() => setRunningId(null)}
          onRan={(taskId) => { setRunningId(null); void load(); onOpenTask(taskId); }}
        />
      )}
      {copyTarget && (
        <CopySheet
          runbook={copyTarget}
          projects={projects}
          onCancel={() => setCopyingId(null)}
          onCopied={() => { setCopyingId(null); void load(); }}
        />
      )}
    </section>
  );
}
