"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import { jsend, jget } from "./api";
import { prChecksLabel, prReviewLabel, prStateLabel, prTooltip } from "./format";
import type { TaskRow } from "./types";

/** The task fields the chip draws. A Pick rather than the whole TaskRow so
 *  TaskChanges can accept it alongside lib/prMerge's PrMergeFacts without
 *  taking a dependency on the shell's task shape. */
export type PrChipTask = Pick<
  TaskRow,
  "id" | "pr_url" | "pr_number" | "pr_state" | "pr_checks" | "pr_review" | "pr_synced_at" | "pr_failing"
>;

/**
 * Trigger: opening a task. A plain GET the server answers from the row while
 * kicking a background re-read if the snapshot is older than PR_STALE_MS, so
 * the fresher answer arrives over /api/events like every other lifecycle fact.
 * Fire-and-forget, keyed on the task so switching sessions re-checks the one
 * now on screen.
 *
 * It is a hook rather than an effect inside the chip because the chip now lives
 * in the DIFF, which a collapsed rail or the mobile chat view doesn't render —
 * and "the user opened this task" is still the moment worth asking GitHub. The
 * session header calls it headlessly for exactly that reason, and the duplicate
 * when both are mounted costs nothing: the server's freshness window and its
 * in-flight set collapse the second call to a row read.
 */
export function usePrOpenRefresh(taskId: string, hasPr: boolean) {
  useEffect(() => {
    if (!hasPr) return;
    void jget(`/api/tasks/${taskId}/pr`).catch(() => {});
  }, [taskId, hasPr]);
}

/**
 * The live PR chip in the diff toolbar: number, state, check rollup and
 * review decision, all read off the task row.
 *
 * It sits with the diff rather than up among the session header's chips
 * because that is where the actions it reports on already are — Create PR,
 * Update PR, Squash & merge PR. On a phone the header and the diff are
 * different views, so a chip in the header meant switching back to chat to
 * read what the PR was doing and switching forward again to act on it.
 *
 * Nothing here polls. The row's pr_* columns arrive with the task list and are
 * refreshed by `task_edited` on /api/events whenever the server hears something
 * new from GitHub, exactly like every other lifecycle fact. This component owns
 * two of the four refresh TRIGGERS:
 *
 *   - opening the task (usePrOpenRefresh above); and
 *   - the explicit Refresh button, which forces one.
 *
 * The other two — creating the PR, and the server's bounded sweep over open
 * PRs — are server-side (lib/prState.ts).
 */
export function PrChip({ task }: { task: PrChipTask }) {
  const [pending, setPending] = useState(false);
  const taskId = task.id;
  const hasPr = !!task.pr_url;

  usePrOpenRefresh(taskId, hasPr);

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
