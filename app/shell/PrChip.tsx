"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import { jsend, jget } from "./api";
import { prChecksLabel, prReviewLabel, prStateLabel, prTooltip } from "./format";
import type { TaskRow } from "./types";

/**
 * The live PR chip in the session header: number, state, check rollup and
 * review decision, all read off the task row.
 *
 * Nothing here polls. The row's pr_* columns arrive with the task list and are
 * refreshed by `task_edited` on /api/events whenever the server hears something
 * new from GitHub, exactly like every other lifecycle fact. This component owns
 * two of the four refresh TRIGGERS:
 *
 *   - opening the task (the mount effect below), which is a plain GET the
 *     server answers from the row while kicking a background re-read if the
 *     snapshot is stale; and
 *   - the explicit Refresh button, which forces one.
 *
 * The other two — creating the PR, and the server's bounded sweep over open
 * PRs — are server-side (lib/prState.ts).
 */
export function PrChip({ task }: { task: TaskRow }) {
  const [pending, setPending] = useState(false);
  const taskId = task.id;
  const hasPr = !!task.pr_url;

  // Trigger: opening the task. Fire-and-forget — the response is the state we
  // already have, and the fresher one arrives over the event stream. Keyed on
  // the task so switching sessions re-checks the one now on screen.
  useEffect(() => {
    if (!hasPr) return;
    void jget(`/api/tasks/${taskId}/pr`).catch(() => {});
  }, [taskId, hasPr]);

  const refresh = useCallback(async () => {
    setPending(true);
    try {
      await jsend(`/api/tasks/${taskId}/pr/refresh`, "POST");
    } catch {
      // The button is a nicety; a failed kick shows up as an unchanged chip
      // rather than an error banner over a session.
    } finally {
      setPending(false);
    }
  }, [taskId]);

  if (!hasPr) return null;
  const state = prStateLabel(task.pr_state);
  const checks = prChecksLabel(task.pr_checks);
  const review = prReviewLabel(task.pr_review);

  return (
    <span className="pr-chip-wrap">
      <a
        className={`pr-chip pr-chip--${state.tone}`}
        href={task.pr_url}
        target="_blank"
        rel="noreferrer"
        title={prTooltip(task)}
      >
        {Icon.github()} PR{task.pr_number ? ` #${task.pr_number}` : ""}
        <span className="pr-dot" aria-hidden />
        <span className="pr-state">{state.label}</span>
        {checks && <span className={`pr-flag pr-flag--${checks.tone}`}>{checks.label}</span>}
        {review && <span className={`pr-flag pr-flag--${review.tone}`}>{review.label}</span>}
        {Icon.external()}
      </a>
      <button
        type="button"
        className="pr-refresh"
        onClick={refresh}
        disabled={pending}
        title="Ask GitHub for this pull request's current state"
        aria-label="Refresh pull request state"
      >
        {Icon.clear()}
      </button>
    </span>
  );
}
