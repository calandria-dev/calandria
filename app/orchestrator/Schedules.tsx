"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { nextFireAt } from "@/lib/schedule/time";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { agentLabel, capsFor, defaultAgentFor } from "./agents";
import { schedulerAlert } from "./format";
import { ErrNote } from "./shared";
import type { AgentPickerOption, AgentsBundle, ProjectRow, ScheduleRow, ScheduleRunRow, SchedulesResponse } from "./types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = 62; // Mon–Fri: bits 1..5

const maskLabel = (mask: number) =>
  mask === 127 ? "Every day" : mask === WEEKDAYS ? "Mon–Fri" : mask === 65 ? "Sat–Sun"
    : DAYS.filter((_, i) => mask & (1 << i)).join(", ");

/** "tomorrow 08:30" beats an ISO string when you're deciding whether to trust it. */
function whenLabel(ms: number, timezone: string): string {
  if (!ms) return "—";
  const now = new Date();
  const then = new Date(ms);
  const day = new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: "short", month: "short", day: "numeric" }).format(then);
  const time = new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(then);
  const days = Math.round((then.setHours(0, 0, 0, 0) - now.setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return `${day} ${time}`;
}

// Only call out the zone when it isn't the one the browser already assumes —
// otherwise every row would carry a redundant "America/Los_Angeles".
function zoneSuffix(timezone: string): string {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone && timezone !== local ? ` (${timezone})` : "";
}

const OUTCOME: Record<ScheduleRunRow["status"], { label: string; tone: "muted" | "busy" | "ok" | "bad" | "warn" }> = {
  claimed: { label: "starting", tone: "muted" },
  running: { label: "running", tone: "busy" },
  succeeded: { label: "ran", tone: "ok" },
  failed: { label: "failed", tone: "bad" },
  stopped: { label: "stopped", tone: "muted" },
  interrupted: { label: "interrupted", tone: "bad" },
  missed: { label: "missed", tone: "warn" },
  skipped_overlap: { label: "skipped", tone: "warn" },
};

function RunLine({ run, timezone }: { run: ScheduleRunRow; timezone: string }) {
  const outcome = OUTCOME[run.status];
  // Show what it was DUE at next to when it actually went, whenever they differ —
  // otherwise a catch-up looks like the schedule fires at the wrong time.
  const late = run.fired_at && Math.abs(run.fired_at - run.scheduled_for) > 60_000;
  return (
    <div className="sched-run">
      <span className={`sched-badge sched-${outcome.tone}`}>{outcome.label}</span>
      <span className="sched-when">due {whenLabel(run.scheduled_for, timezone)}</span>
      {late ? <span className="sched-note">ran {whenLabel(run.fired_at, timezone)}</span> : null}
      {run.trigger === "catch_up" ? <span className="sched-note">catch-up</span> : null}
      {run.trigger === "manual" ? <span className="sched-note">manual</span> : null}
      {run.dst_adjusted ? <span className="sched-note">DST adjusted</span> : null}
      {run.detail ? <span className="sched-detail" title={run.detail}>{run.detail}</span> : null}
    </div>
  );
}

// What the mock/real slash-command validator can return, mirrored from
// lib/schedule/commands.ts's PromptValidation.
type Check = { ok: boolean; error?: string; suggestions?: string[]; unchecked?: boolean; note?: string };

// Replace the leading slash command in a prompt with a suggested one, keeping
// whatever follows it — "/jira, triage" + "plugin:jira" -> "/plugin:jira, triage".
function withCommand(prompt: string, command: string): string {
  return prompt.replace(/^(\s*)\/[A-Za-z0-9_:-]+/, `$1/${command}`);
}

// The permission modes a schedule can meaningfully pick for a given agent —
// sourced from the driver's own capability descriptor (GET /api/agents), the
// same one app/orchestrator/modals.tsx's NewTaskModal reads via
// permissionOptions(), so the two pickers can't drift onto different claims
// about what a mode does. Unlike that picker, "auto"/"default" (Claude's
// inherit-a-default modes) are dropped: a schedule always runs unattended, so
// "whatever the default happens to be" is exactly the ambiguity this field
// exists to rule out — every remaining option must be a concrete, named
// answer. Codex's descriptor has no "acceptEdits" at all (its driver treats
// anything but "plan" as full workspace-write), so filtering from the REAL
// per-agent list — rather than a fixed three-item list — is what stops a
// Codex schedule from offering a mode that quietly behaves like Auto-run.
function scheduleModesFor(agents: AgentsBundle, agent: string): AgentPickerOption[] {
  return (capsFor(agents, agent)?.permissionModes ?? []).filter((p) => p.value !== "auto" && p.value !== "default");
}

// The plain-English consequence line. Driven by the SAME filtered list the
// select renders, so it can only describe a mode that's actually on offer for
// this agent — never an assumption ("declines automatically") that happens to
// be true for Claude's acceptEdits but false for Codex's.
function permissionConsequence(mode: string, modes: AgentPickerOption[], label: string): string {
  if (modes.length === 0) {
    return `${label} doesn't expose a configurable permission mode for a scheduled run — it runs using whatever this agent falls back to with nobody watching.`;
  }
  if (!modes.some((m) => m.value !== "bypassPermissions")) {
    return `${label} offers no mode that declines instead of running — Auto-run is the only choice here, and it does whatever the prompt needs without asking.`;
  }
  return mode === "bypassPermissions"
    ? "This run does whatever the prompt needs without asking. Nobody is around when it fires to approve anything."
    : "Anything needing approval will be declined automatically, and the run may stop early.";
}

/**
 * Create/edit form for a schedule. Two behaviours are the point, not the
 * fields: validating a slash prompt against the project's real command
 * registry before saving (an unknown command reports SUCCESS at run time, so
 * this is the only cheap place to catch it), and previewing the next three
 * occurrences so a timezone or day-mask mistake is visible now, not next
 * Monday.
 *
 * Validation never blocks Save — but the reason is narrower than it used to be.
 * The old one was a false positive: `slashCommandOf` read a prompt that merely
 * STARTS with a filesystem path ("/etc/passwd, tell me what's in it") as the
 * command "etc". That is fixed at the root (a token followed by `/` is a path),
 * because the same check runs again at FIRE time, where it settles the run
 * `failed` and mints nothing — non-blocking here and hard-blocking there was
 * two halves of one decision contradicting each other.
 *
 * What's left is a genuine limit of the probe rather than a bug in it: it reads
 * one session's registry, so a command that a plugin registers conditionally,
 * or one added between saving and firing, can read as unknown. The check is a
 * typo catcher, not an authority — a failure is shown prominently, with
 * suggestions one click away and a warning that a run WILL fail on it, but Save
 * stays live.
 */
function ScheduleForm({
  projectId, project, agents, initial, onCancel, onSaved,
}: {
  projectId: string;
  project: ProjectRow;
  agents: AgentsBundle;
  /** Present = editing this schedule; absent = creating a new one. */
  initial?: ScheduleRow;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const uid = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [mask, setMask] = useState(initial?.days_mask ?? WEEKDAYS);
  const [time, setTime] = useState(initial?.time_of_day ?? "09:00");
  const [tz, setTz] = useState(initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [agent, setAgent] = useState(initial?.agent ?? defaultAgentFor(agents, project.default_agent));
  const [permissionMode, setPermissionMode] = useState(initial?.permission_mode ?? "bypassPermissions");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // The modes actually on offer for the CURRENTLY selected agent. Recomputed
  // whenever the agent changes, and the value is clamped to stay inside it —
  // e.g. switching from Claude (which has acceptEdits) to Codex (which
  // doesn't) must not leave `acceptEdits` selected-but-invalid, silently
  // saving a value the target driver would treat as Auto-run.
  const modeCaps = useMemo(() => scheduleModesFor(agents, agent), [agents, agent]);
  useEffect(() => {
    if (modeCaps.length && !modeCaps.some((m) => m.value === permissionMode)) setPermissionMode(modeCaps[0].value);
  }, [modeCaps, permissionMode]);

  // Validate a slash prompt BEFORE saving. An unknown command does not fail at
  // run time — it returns "Unknown command: /x" as a SUCCESS — so catching it
  // here is the difference between a working schedule and one that reports
  // green every morning having done nothing.
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const validate = useCallback(async (p: string, a: string) => {
    if (!p.trim().startsWith("/")) { setCheck(null); return; }
    setChecking(true);
    try {
      setCheck(await jsend<Check>(`/api/schedules/validate`, "POST", { project_id: projectId, prompt: p, agent: a }));
    } catch {
      setCheck(null);
    } finally {
      setChecking(false);
    }
  }, [projectId]);
  // Check immediately when opening the editor on an existing slash prompt, so
  // the warning (if any) is visible without the user touching the field.
  useEffect(() => { void validate(prompt, agent); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applySuggestion = (command: string) => {
    const next = withCommand(prompt, command);
    setPrompt(next);
    void validate(next, agent);
  };

  // Preview the next three occurrences. A timezone or day-mask mistake should
  // be visible while the user is still looking at the form, not the following
  // Monday.
  const preview = useMemo(() => {
    try {
      const spec = { daysMask: mask, timeOfDay: time, timezone: tz };
      const out: number[] = [];
      let cursor = Date.now();
      for (let i = 0; i < 3; i++) {
        cursor = nextFireAt(spec, cursor).ms;
        out.push(cursor);
      }
      return out;
    } catch {
      return [];
    }
  }, [mask, time, tz]);

  const toggleDay = (i: number) => setMask((m) => (m & (1 << i) ? m & ~(1 << i) : m | (1 << i)));

  const canSave = name.trim().length > 0 && prompt.trim().length > 0 && mask > 0 && /^\d{2}:\d{2}$/.test(time) && tz.trim().length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setErr("");
    const body = { name: name.trim(), prompt, days_mask: mask, time_of_day: time, timezone: tz, agent, permission_mode: permissionMode };
    try {
      if (initial) await jsend(`/api/schedules/${initial.id}`, "PATCH", body);
      else await jsend(`/api/projects/${projectId}/schedules`, "POST", body);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div className="sched-form">
      <div className="field">
        <label className="lab" htmlFor={`${uid}-name`}>Name</label>
        <input id={`${uid}-name`} type="text" value={name} placeholder="e.g. Morning triage"
          onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label className="lab" htmlFor={`${uid}-prompt`}>Prompt</label>
        <textarea id={`${uid}-prompt`} value={prompt} placeholder="/jira-tasks, or plain instructions"
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => void validate(prompt, agent)} />
        {checking && <div className="hlp">Checking this project&rsquo;s slash commands…</div>}
        {check && !check.ok && (
          <div className="sched-check bad" role="alert">
            <div>{check.error}</div>
            {check.suggestions && check.suggestions.length > 0 && (
              <div className="sched-suggestions">
                Did you mean:
                {check.suggestions.map((s) => (
                  <button key={s} type="button" className="btn btn-line btn-sm" onClick={() => applySuggestion(s)}>/{s}</button>
                ))}
              </div>
            )}
            <div className="sched-note">
              Save still works — the check reads one session&rsquo;s command list and can be wrong. If it
              isn&rsquo;t, the run will fail rather than report success having done nothing.
            </div>
          </div>
        )}
        {check?.ok && check.unchecked && (
          <div className="hlp">
            {check.note ?? "Couldn’t reach this project’s command registry to check — saving without verifying."}
          </div>
        )}
        {check?.ok && !check.unchecked && !!prompt.trim().startsWith("/") && (
          <div className="hlp">{Icon.check()} recognized command</div>
        )}
      </div>
      <div className="field">
        <label className="lab" id={`${uid}-days-lab`}>Days</label>
        <div className="sched-days" role="group" aria-labelledby={`${uid}-days-lab`}>
          {DAYS.map((d, i) => (
            <label key={d} className="sched-day">
              <input type="checkbox" checked={!!(mask & (1 << i))} onChange={() => toggleDay(i)} />
              {d}
            </label>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 14 }}>
        <div className="field" style={{ flex: "0 0 150px" }}>
          <label className="lab" htmlFor={`${uid}-time`}>Time</label>
          <input id={`${uid}-time`} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          {/* Not "Timezone" — Playwright's getByLabel does a substring match,
              and "Time" (the field beside it) would then match both. */}
          <label className="lab" htmlFor={`${uid}-tz`}>Zone</label>
          <input id={`${uid}-tz`} type="text" className="ctx-mono" value={tz} onChange={(e) => setTz(e.target.value)} />
        </div>
      </div>
      <div className="sched-preview">
        {preview.length === 0 ? (
          <div className="sched-note">Enter a valid time, day and timezone to preview upcoming runs.</div>
        ) : (
          preview.map((ms, i) => <div key={i} className="sched-note">next {whenLabel(ms, tz)}{zoneSuffix(tz)}</div>)
        )}
      </div>
      <div className="field">
        <label className="lab" htmlFor={`${uid}-agent`}>Agent</label>
        <select id={`${uid}-agent`} value={agent} onChange={(e) => { setAgent(e.target.value); void validate(prompt, e.target.value); }}>
          {agents.agents.map((a) => (
            <option key={a.id} value={a.id}>{a.label}{a.authenticated ? "" : " (not connected)"}</option>
          ))}
        </select>
      </div>
      {/* A scheduled run cannot answer a permission prompt: nobody is there, so
          the gate declines and the turn degrades. Saying so beside the picker
          is the difference between a considered choice and a surprise. The
          options themselves come from the SELECTED agent's own capability
          descriptor (scheduleModesFor, above) rather than a fixed list — a
          Codex schedule never even sees "acceptEdits", because Codex's driver
          has no such mode and would otherwise silently run it as full
          auto-run despite the label promising otherwise. */}
      <div className="field">
        <label className="lab" htmlFor={`${uid}-perm`}>Permission mode</label>
        {modeCaps.length > 0 ? (
          <select id={`${uid}-perm`} value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
            {modeCaps.map((m) => <option key={m.value} value={m.value} title={m.sub}>{m.label}</option>)}
          </select>
        ) : (
          <div className="hlp">{agentLabel(agents, agent)} has no configurable permission mode.</div>
        )}
        <p className="sched-note">{permissionConsequence(permissionMode, modeCaps, agentLabel(agents, agent))}</p>
      </div>
      {err && <ErrNote>{err}</ErrNote>}
      <div className="sched-actions">
        <button className="btn btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="btn btn-accent" disabled={!canSave} onClick={save}>
          {Icon.check()} {saving ? "Saving…" : initial ? "Save changes" : "Create schedule"}
        </button>
      </div>
    </div>
  );
}

// Read/pause/run-now surface for a project's recurring prompts (lib/scheduler.ts
// runs them unattended), plus the create/edit form above. This is what decides
// whether a user trusts the feature, so it leads with the outcomes that matter
// most: a dead ticker, a missed or overlap-skipped run, and a wedged run
// blocking future occurrences.
export function Schedules({ project, agents }: { project: ProjectRow; agents: AgentsBundle }) {
  const projectId = project.id;
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await jget<SchedulesResponse>(`/api/projects/${projectId}/schedules`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // Re-poll while the card is on screen. Two things here are TIME-dependent
  // rather than action-dependent: a run that finishes after this card loaded,
  // and — the reason this exists — the wedged-ticker warning, which is derived
  // from how long ago the last sweep completed. Rendered once at mount, that
  // warning could only ever appear if the user happened to reload the page,
  // which is the one thing someone who thinks their schedules are fine will
  // never do. Cheap: a couple of SQLite reads against a card that's only
  // mounted on the project landing pane.
  useEffect(() => {
    const t = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(t);
  }, [load]);

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

  // Recomputed every render (and every 30s poll above), because "stuck" is a
  // function of elapsed time, not of anything the server pushed.
  const alert = data ? schedulerAlert(data.scheduler) : null;

  if (!data) return null;

  return (
    <section className="sched-card">
      <div className="sched-header">
        <h3>Schedules</h3>
        <span className="spacer" />
        {!creating && (
          <button className="btn btn-line btn-sm" onClick={() => { setCreating(true); setEditingId(null); }}>
            {Icon.plus()} New schedule
          </button>
        )}
      </div>
      {/* A dead ticker is worse than no schedule, so say so rather than showing
          a next-run time that will never arrive. schedulerAlert() ranks the
          three ways that happens — never started, sweeps no longer completing,
          one schedule throwing — because they need different actions and only
          the middle one is invisible without it. */}
      {alert ? <div className="sched-alert">{Icon.cloudOff()} {alert}</div> : null}
      {error ? <div className="sched-alert sched-alert-bad">{error}</div> : null}
      {creating && (
        <ScheduleForm
          projectId={projectId}
          project={project}
          agents={agents}
          onCancel={() => setCreating(false)}
          onSaved={() => { setCreating(false); void load(); }}
        />
      )}
      {data.schedules.length === 0 && !creating ? (
        <div className="sched-note">No schedules yet — run a saved prompt on a recurring time even when nobody is logged in.</div>
      ) : null}
      {data.schedules.map((s: ScheduleRow) => {
        if (editingId === s.id) {
          return (
            <ScheduleForm
              key={s.id}
              projectId={projectId}
              project={project}
              agents={agents}
              initial={s}
              onCancel={() => setEditingId(null)}
              onSaved={() => { setEditingId(null); void load(); }}
            />
          );
        }
        // `runs` is a truncated history window — the run actually blocking
        // future occurrences can age out of it after enough skips pile up on
        // top. `active_run` is served explicitly by the API for exactly this.
        const blocking = s.last_run?.status === "skipped_overlap" ? s.active_run : null;
        return (
          <div key={s.id} className={`sched-row${s.enabled ? "" : " sched-paused"}`}>
            <div className="sched-head">
              <strong>{s.name}</strong>
              <span className="sched-spec">{maskLabel(s.days_mask)} at {s.time_of_day}</span>
              <span className="sched-next">
                {s.enabled ? `next ${whenLabel(s.next_fire_at, s.timezone)}${zoneSuffix(s.timezone)}` : "paused"}
              </span>
              <button
                className="btn btn-line btn-sm"
                disabled={busy === s.id}
                onClick={() => { setEditingId(s.id); setCreating(false); }}
              >
                {Icon.edit()} Edit
              </button>
              <button
                className="btn btn-line btn-sm"
                disabled={busy === s.id}
                onClick={() => act(s.id, () => jsend(`/api/schedules/${s.id}`, "PATCH", { enabled: !s.enabled }))}
              >
                {s.enabled ? "Pause" : "Resume"}
              </button>
              <button
                className="btn btn-line btn-sm"
                disabled={busy === s.id}
                onClick={() => act(s.id, () => jsend(`/api/schedules/${s.id}/run`, "POST"))}
              >
                {Icon.play()} Run now
              </button>
            </div>
            {s.last_run ? <RunLine run={s.last_run} timezone={s.timezone} /> : <div className="sched-run sched-note">no runs yet</div>}
            {/* A wedged turn skips every future occurrence, so the blocking run is
                named and stoppable from here — otherwise the schedule just goes
                quiet and the user has no idea why. */}
            {blocking?.task_id ? (
              <div className="sched-run">
                <span className="sched-note">blocked by a run still going</span>
                <button
                  className="btn btn-line btn-sm"
                  disabled={busy === s.id}
                  onClick={() => act(s.id, () => jsend(`/api/tasks/${blocking.task_id}/abort`, "POST"))}
                >
                  {Icon.stop()} Stop it
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
