"use client";
import { useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import type { TaskRow } from "./types";

/**
 * "Reclaim" in the session header: one click that ends a landed task's life on
 * disk — fast-forward the local base branch from origin, remove the worktree,
 * delete the local branch, mark the task done (lib/reclaim.ts).
 *
 * It appears only once the work has LANDED, which is the whole premise: a
 * merged PR (or a local merge) is a definitive disposal signal in a way the
 * scheduled sweep's fourteen-day clock is not. Behind a project's `auto_reclaim`
 * the server does this by itself; this button is both the offer for projects
 * that didn't opt in and the only place the unsafe acknowledgement can be given,
 * since an unattended reclaim never forces past the safety gate.
 *
 * Nothing is fetched when a task is merely selected. The preview costs several
 * git subprocesses, so the FIRST click buys it — and then either finishes the
 * job (the ordinary case: the checkout is clean and the reclaim is genuinely one
 * click) or arms an acknowledgement naming exactly what would be destroyed.
 * That is the same shape the Storage prune uses, and it never destroys work on
 * a click that hadn't yet been told there was any.
 *
 * The row refreshes itself: reclaimTask publishes `task_edited`, so the cleared
 * worktree and the new status arrive over /api/events like every other fact.
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

  // A refusal answers 4xx with its reason in `error`, which jsend throws as the
  // message — including the safety gate's, which names the work it protected.
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
