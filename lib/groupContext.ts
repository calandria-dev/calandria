// The group context block: what a MEMBER session is told about the feature it
// is one step of (design: docs/superpowers/specs/2026-08-24-task-grouping-design.md,
// "Agent-facing tools"). Appended to buildProjectContext(), so it reaches every
// driver through one seam.
//
// This is the half of grouping that Jira can't do. The chip bar and the strip
// tell the USER a plan exists; without this, the session running step 3 has no
// idea it is step 3 — it sees its own brief and nothing else, and re-derives
// (or contradicts) decisions the neighbouring tasks already made.
//
// What it deliberately does NOT carry: sibling DESCRIPTIONS. A seven-task
// group's briefs would spend a fifth of the session's starting context on work
// this task isn't doing; the titles + statuses are what place it in the plan,
// and `get_task` is one call away when a sibling's brief actually matters.
//
// SDK-free (store + types only) and pinned that way in tests/importGraph.test.ts:
// lib/agents/shared.ts is imported by every driver, so a heavy edge here would
// travel everywhere.

import { getGroup, getTask, listTasks } from "./store";
import type { Status, Task } from "./types";

/** How a status reads in prose. The board's words, not the column names. */
const STATUS_WORDS: Record<Status, string> = {
  not_started: "not started",
  in_progress: "in progress",
  on_hold: "on hold",
  done: "done",
  cancelled: "cancelled",
};

type Member = Task & { depends_on: string[] };

/**
 * Members in dependency order — a topological sort over `depends_on`
 * restricted to the group, ties broken by `position` — the project's filing
 * sequence. Filing order rather than the caller's: listTasks sorts by recency,
 * and a plan's steps must not renumber themselves every time one of them runs.
 * (`created_at` can't do it: a planning turn files its whole batch inside one
 * millisecond.) That's deliberately the SAME order the group strip renders
 * (topoMembers in app/shell/GroupStrip.tsx — which is why `position` is on the
 * client's TaskRow at all), so "step 3 of 7" in a session's context and "3" on
 * the user's screen name the same task. The two implementations are separate
 * because the strip runs on the client over TaskRow; keep them in step.
 *
 * Edges pointing OUTSIDE the group are ignored rather than treated as blockers:
 * groups and dependencies are orthogonal, and a member legitimately waiting on
 * another feature's task must not reorder a list that doesn't show it.
 */
export function topoMembers<T extends { id: string; position: number; depends_on: string[] }>(members: T[]): T[] {
  members = [...members].sort((a, b) => a.position - b.position);
  const ids = new Set(members.map((m) => m.id));
  const deps = new Map(members.map((m) => [m.id, m.depends_on.filter((d) => ids.has(d))]));
  const placed = new Set<string>();
  const out: T[] = [];
  while (out.length < members.length) {
    const ready = members.find((m) => !placed.has(m.id) && deps.get(m.id)!.every((d) => placed.has(d)));
    // setTaskDeps refuses cycles, so `ready` is only ever empty if the graph
    // arrived broken — take the next unplaced member rather than spinning.
    const pick = ready ?? members.find((m) => !placed.has(m.id))!;
    placed.add(pick.id);
    out.push(pick);
  }
  return out;
}

/** "· Port signup route (not started, blocked by this task)" — one sibling line. */
function memberLine(m: Member, selfId: string): string {
  if (m.id === selfId) return `  → ${m.title}   ← this task`;
  const withdrawn = m.status === "cancelled" && !!m.withdrawn_reason;
  const bits = [withdrawn ? "withdrawn" : STATUS_WORDS[m.status]];
  if (m.running === 1) bits.push("running now");
  if (m.merged_at > 0) bits.push("merged");
  // The one relationship worth spelling out: a sibling this task is holding up.
  // It tells the session that finishing here releases work, which is the
  // difference between "mark it done when convenient" and "mark it done".
  if (m.depends_on.includes(selfId)) bits.push("blocked by this task");
  const mark = m.status === "done" ? "✓" : m.status === "cancelled" ? "✗" : "·";
  return `  ${mark} ${m.title} (${bits.join(", ")})`;
}

/**
 * The block for `task`, or "" when there is nothing to say: the task is
 * ungrouped, its group was deleted, or the task opted out of context.
 *
 * `send_context = 0` suppresses this the way it suppresses the project context
 * block. Both are "here is the wider picture" material, and a task the user
 * deliberately ran context-free must not have the plan it belongs to smuggled
 * back in under a different heading.
 */
export function groupContextBlock(task: Task): string {
  if (task.send_context === 0 || !task.group_id) return "";
  const group = getGroup(task.group_id);
  if (!group) return "";

  const members = topoMembers(listTasks(task.project_id).filter((t) => t.group_id === group.id));
  const step = members.findIndex((m) => m.id === task.id) + 1;
  // step 0 = the row isn't in the list its own group_id points at. Only
  // reachable if the task was deleted mid-turn; the header just drops the
  // fraction rather than claiming "step 0".
  const where = step > 0 ? ` (step ${step} of ${members.length})` : "";
  const lines = [`\n--- This task is part of the group "${group.name}"${where} ---`];
  if (group.description) lines.push(group.description);

  if (members.length > 1) {
    lines.push(`Other tasks in this group:`);
    for (const m of members) lines.push(memberLine(m, task.id));
    lines.push(
      `Their descriptions are not included here — call \`get_task\` with an id above when you need one. ` +
        `Don't start a sibling's work: each is its own session.`
    );
  } else {
    lines.push(`Nothing else has been filed under this group yet.`);
  }

  // Where the plan came from. The planning session's transcript is the group's
  // rationale, and a member that can read it can settle "why is it split this
  // way" without asking the user.
  const origin = group.origin_task_id ? getTask(group.origin_task_id) : undefined;
  if (origin && origin.id !== task.id) {
    lines.push(`Planned in task "${origin.title}" (id ${origin.id}); use get_task to read the brief.`);
  }
  return lines.join("\n");
}
