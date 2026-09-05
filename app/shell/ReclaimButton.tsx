"use client";
import { useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import type { TaskRow } from "./types";

/**
 * "Reclaim" in the session header: one click that ends a landed task's life
 * on disk by fast-forwarding the local base branch from origin, removing the
 * worktree, deleting the local branch and marking the task done
 * (lib/reclaim.ts). Shown only once the work has landed (merged PR or local
 * merge, a definitive disposal signal), and doubles as the only place the
 * unsafe acknowledgement can be given for projects without `auto_reclaim`.
 *
 * The first click fetches a preview (several git subprocesses) and either
 * finishes the job directly on a clean checkout or arms an acknowledgement
 * naming what would be destroyed. reclaimTask publishes `task_edited`, so the
 * row refreshes itself over /api/events.
 */

interface Preview {
  landing: "pr" | "merge" | null;
  hasWorktree: boolean;
  branch: string;
  baseBranch: string;
  bytes: number;
  running: boolean;
  unsafe: boolean;
  unsafeReason: string | null;
}

export function ReclaimButton({ task }: { task: TaskRow }) {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Landed, and still holding something. Both halves matter: `pr_state` is
  // GitHub's word and `merged_at` is ours, and a task with neither a checkout
  // nor a branch left has already been reclaimed.
  const landed = task.pr_state === "merged" || task.merged_at > 0;
  const holds = !!task.worktree_path || !!task.work_branch;
  if (!landed || !holds) return null;

  // A refusal answers 4xx with its reason in `error`, which jsend throws as
  // the message, including the safety gate's, which names the work it
  // protected.
  const run = async (discardUnsafe: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await jsend(`/api/tasks/${task.id}/reclaim`, "POST", { discardUnsafe });
      setArmed(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // First click: price it, then either finish the job or ask.
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const preview = await jget<Preview>(`/api/tasks/${task.id}/reclaim`);
      if (preview.running) {
        setErr("a turn is running in this task");
        return;
      }
      if (preview.unsafe) {
        setArmed(preview);
        return;
      }
      await run(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (armed)
    return (
      <span className="reclaim-wrap">
        <span className="reclaim-warn">
          Discarding {armed.unsafeReason}. This cannot be undone.
        </span>
        <button className="reclaim-btn danger" onClick={() => run(true)} disabled={busy}>
          {busy ? "Discarding…" : "Discard & reclaim"}
        </button>
        <button className="reclaim-btn" onClick={() => setArmed(null)} disabled={busy}>
          Cancel
        </button>
      </span>
    );

  return (
    <span className="reclaim-wrap">
      <button
        className="reclaim-btn"
        onClick={start}
        disabled={busy}
        title={`This work has landed${task.pr_state === "merged" ? " (its pull request is merged)" : ""}. Catch the local base branch up with origin, remove this task's checkout, delete its local branch and mark it done.`}
      >
        {Icon.archive()} {busy ? "Reclaiming…" : "Reclaim"}
      </button>
      {err && <span className="reclaim-err">{err}</span>}
    </span>
  );
}
