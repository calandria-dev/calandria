"use client";

import type { TaskRow } from "./types";

// Board-card / task-row footer: worktree branch, live diff totals, and a
// sparkline of diff_add+diff_del sampled over the last ~30 task-list updates
// (see useShell's sparklines map). Renders nothing until the server has
// attached diff stats — i.e. only for in_progress tasks with a worktree (see
// withDiffStats in app/api/projects/[id]/route.ts).
export function DiffFooter({ task, points, projectBranch }: { task: TaskRow; points?: number[]; projectBranch?: string }) {
  if (!task.work_branch || typeof task.diff_add !== "number" || typeof task.diff_del !== "number") return null;
  // The base only when it ISN'T the project's default (lib/baseBranch.ts). Every
  // card saying "main" is noise on a row this narrow; the one saying
  // "feature/auth" is the whole point of the feature.
  const base = task.base_branch && task.base_branch !== projectBranch ? task.base_branch : "";
  return (
    <div className="diff-foot" title={base ? `${task.work_branch} → ${base}` : task.work_branch}>
      <span className="diff-branch">{task.work_branch}</span>
      {base && <span className="diff-base">→ {base}</span>}
      <span className="diff-stat">
        <span className="a">+{task.diff_add}</span> <span className="d">−{task.diff_del}</span>
      </span>
      {points && points.length >= 2 && <Sparkline points={points} />}
    </div>
  );
}

// Normalized to the ring buffer's own min/max rather than an absolute scale —
// a task with a huge diff elsewhere would otherwise flatten a quiet task's
// wobble to a hairline.
function Sparkline({ points }: { points: number[] }) {
  const w = 60, h = 16, pad = 1;
  const lo = Math.min(...points), hi = Math.max(...points);
  const span = hi - lo || 1;
  const step = (w - pad * 2) / (points.length - 1);
  const coords = points
    .map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((v - lo) / span) * (h - pad * 2)).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="diff-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={coords} fill="none" stroke="var(--accent)" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
