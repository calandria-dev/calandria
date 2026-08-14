"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import type { ScheduleRow, ScheduleRunRow, SchedulesResponse } from "./types";

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

// Read/pause/run-now surface for a project's recurring prompts (lib/scheduler.ts
// runs them unattended). This is what decides whether a user trusts the
// feature, so it leads with the outcomes that matter most: a dead ticker, a
// missed or overlap-skipped run, and a wedged run blocking future occurrences.
// The create/edit form is a separate surface (Task 12).
export function Schedules({ projectId }: { projectId: string }) {
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await jget<SchedulesResponse>(`/api/projects/${projectId}/schedules`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

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

  if (!data) return null;
  if (!data.schedules.length) return null; // the editor lives in project settings (Task 12); nothing to show yet

  return (
    <section className="sched-card">
      <h3>Schedules</h3>
      {/* A dead ticker is worse than no schedule, so say so rather than showing
          a next-run time that will never arrive. */}
      {!data.scheduler.started ? (
        <div className="sched-alert">{Icon.cloudOff()} The scheduler is not running on this instance — nothing will fire.</div>
      ) : null}
      {error ? <div className="sched-alert sched-alert-bad">{error}</div> : null}
      {data.schedules.map((s: ScheduleRow) => {
        const blocking = s.last_run?.status === "skipped_overlap" ? s.runs.find((r) => r.status === "running") : undefined;
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
