// The tag context block: what a MEMBER session is told about each feature it is
// part of (design: docs/superpowers/specs/2026-08-27-tags-design.md). Appended
// to buildProjectContext(), so it reaches every driver through one seam.
//
// This is the half of tagging that Jira can't do. The chip bar and the strip
// tell the USER a plan exists; without this, the session running step 3 has no
// idea it is step 3 — it sees its own brief and nothing else, and re-derives
// (or contradicts) decisions the neighbouring tasks already made.
//
// A task carries as many tags as it has reasons to, and gets a block for EACH,
// in tag order (task_tags.position — the same order its badges render in). A
// task that is step 3 of the auth migration and also one of the "flaky-tests"
// sweep needs both facts: they were filed by different plans and neither one
// implies the other.
//
// What it deliberately does NOT carry: sibling DESCRIPTIONS. A seven-task
// tag's briefs would spend a fifth of the session's starting context on work
// this task isn't doing; the titles + statuses are what place it in the plan,
// and `get_task` is one call away when a sibling's brief actually matters.
//
// SDK-free (store + types only) and pinned that way in tests/importGraph.test.ts:
// lib/agents/shared.ts is imported by every driver, so a heavy edge here would
// travel everywhere.

import { getTask, getTaskTags, listTasks } from "./store";
import type { Status, Tag, Task } from "./types";

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
 * restricted to the tag, ties broken by `position` — the project's filing
 * sequence. Filing order rather than the caller's: listTasks sorts by recency,
 * and a plan's steps must not renumber themselves every time one of them runs.
 * (`created_at` can't do it: a planning turn files its whole batch inside one
 * millisecond.) That's deliberately the SAME order the tag strip renders
 * (topoMembers in app/shell/TagStrip.tsx — which is why `position` is on the
 * client's TaskRow at all), so "step 3 of 7" in a session's context and "3" on
 * the user's screen name the same task. The two implementations are separate
 * because the strip runs on the client over TaskRow; keep them in step.
 *
 * Edges pointing at tasks WITHOUT this tag are ignored rather than treated as
 * blockers: tags and dependencies are orthogonal, and a member legitimately
 * waiting on another feature's task must not reorder a list that doesn't show it.
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

/** One tag's block, given the project's tasks (read once for all of them). */
function blockFor(tag: Tag, task: Task, projectTasks: (Task & { depends_on: string[]; tag_ids: string[] })[]): string {
  const members = topoMembers(projectTasks.filter((t) => t.tag_ids.includes(tag.id)));
  const step = members.findIndex((m) => m.id === task.id) + 1;
  // step 0 = the row isn't in the list its own membership points at. Only
  // reachable if the task was deleted mid-turn; the header just drops the
  // fraction rather than claiming "step 0".
  const where = step > 0 ? ` (step ${step} of ${members.length})` : "";
  const lines = [`\n--- This task is tagged "${tag.name}"${where} ---`];
  if (tag.description) lines.push(tag.description);

  if (members.length > 1) {
    lines.push(`Other tasks with this tag:`);
    for (const m of members) lines.push(memberLine(m, task.id));
    lines.push(
      `Their descriptions are not included here — call \`get_task\` with an id above when you need one. ` +
        `Don't start a sibling's work: each is its own session.`
    );
  } else {
    lines.push(`Nothing else carries this tag yet.`);
  }

  // Where the plan came from. The planning session's transcript is the tag's
  // rationale, and a member that can read it can settle "why is it split this
  // way" without asking the user.
  const origin = tag.origin_task_id ? getTask(tag.origin_task_id) : undefined;
  if (origin && origin.id !== task.id) {
    lines.push(`Planned in task "${origin.title}" (id ${origin.id}); use get_task to read the brief.`);
  }
  return lines.join("\n");
}

/**
 * Every tag's block for `task`, or "" when there is nothing to say: the task
 * carries no tags, or it opted out of context.
 *
 * `send_context = 0` suppresses this the way it suppresses the project context
 * block. Both are "here is the wider picture" material, and a task the user
 * deliberately ran context-free must not have the plans it belongs to smuggled
 * back in under a different heading.
 */
export function tagContextBlock(task: Task): string {
  if (task.send_context === 0) return "";
  const tags = getTaskTags(task.id);
  if (!tags.length) return "";
  // One read of the project's tasks for every block: a task with four tags
  // would otherwise pay for four identical listTasks calls, each of which
  // carries the usage subqueries.
  const projectTasks = listTasks(task.project_id);
  return tags.map((tag) => blockFor(tag, task, projectTasks)).join("\n");
}
