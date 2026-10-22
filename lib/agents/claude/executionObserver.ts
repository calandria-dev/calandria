// Turns the Claude SDK's native background-task events into the driver-neutral
// ExecutionObservation (lib/workCenter/types.ts). Pure and SDK-free so the
// state machine is tested without a CLI.
//
// Sources, all structured: `task_started` (carries whether the task was
// registered in the background), `task_updated` (a foreground task moved to the
// background, or a status change), `task_notification` (a task settled), and the
// Stop hook's authoritative `background_tasks` list. Nothing is read from prose.
// Tasks flagged `ambient` are not activity and are never counted.

import type { ExecutionObservation } from "@/lib/workCenter/types";

type Kind = "command" | "agent";
type Tracked = { kind: Kind; startedAt: number | null; background: boolean };

function kindOf(taskType: string | undefined): Kind {
  return taskType && /agent|workflow/i.test(taskType) ? "agent" : "command";
}

export class ClaudeExecutionTracker {
  private tasks = new Map<string, Tracked>();
  private wakeups: Array<{ id: string; at: number }> = [];
  private foreground: ExecutionObservation["foreground"] = "executing";
  private last = "";

  taskStarted(m: { task_id: string; is_backgrounded?: boolean; ambient?: boolean; skip_transcript?: boolean; task_type?: string }, now: number): void {
    if (m.ambient || m.skip_transcript) return;
    this.tasks.set(m.task_id, { kind: kindOf(m.task_type), startedAt: now, background: m.is_backgrounded === true });
  }

  taskUpdated(m: { task_id: string; patch: { status?: string; is_backgrounded?: boolean } }): void {
    const t = this.tasks.get(m.task_id);
    if (!t) return;
    if (m.patch.is_backgrounded === true) t.background = true;
    const s = m.patch.status;
    if (s === "completed" || s === "failed" || s === "killed") this.tasks.delete(m.task_id);
  }

  taskNotification(taskId: string): void {
    this.tasks.delete(taskId);
  }

  /**
   * The Stop hook reports every in-flight background task, so it replaces the
   * incrementally tracked set. A task known from `task_started` keeps its
   * start time; one the hook names that was never announced has an unknown one.
   */
  stopSnapshot(bg: Array<{ id: string; type?: string }>): void {
    const next = new Map<string, Tracked>();
    for (const b of bg) {
      const known = this.tasks.get(b.id);
      next.set(b.id, { kind: known?.kind ?? kindOf(b.type), startedAt: known?.startedAt ?? null, background: true });
    }
    this.tasks = next;
  }

  setWakeups(crons: Array<{ id: string; fireAt: number | null }>): void {
    this.wakeups = crons.filter((c): c is { id: string; fireAt: number } => c.fireAt !== null).map((c) => ({ id: c.id, at: c.fireAt }));
  }

  setForeground(f: ExecutionObservation["foreground"]): void {
    this.foreground = f;
  }

  snapshot(): ExecutionObservation {
    return {
      type: "execution_observation",
      foreground: this.foreground,
      background: [...this.tasks.entries()]
        .filter(([, t]) => t.background)
        .map(([id, t]) => ({ id, kind: t.kind, startedAt: t.startedAt })),
      backgroundCoverage: "complete",
      wakeups: this.wakeups.map((w) => ({ ...w })),
      externalWait: null,
    };
  }

  /** The current observation when it differs from the last one returned, else null. */
  changed(): ExecutionObservation | null {
    const snap = this.snapshot();
    const key = JSON.stringify({ ...snap, type: undefined });
    if (key === this.last) return null;
    this.last = key;
    return snap;
  }
}
