// Typed queries for runbooks. DB only — no runner, no SDK (pinned by
// tests/importGraph.test.ts), so the delete policy below can be tested without
// launching anything.

import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import type { Priority, Runbook, Task } from "@/lib/types";

export function getRunbook(id: string): Runbook | null {
  return (getDb().prepare("SELECT * FROM runbooks WHERE id = ?").get(id) as Runbook) ?? null;
}

export function listRunbooks(projectId: string): Runbook[] {
  return getDb()
    .prepare("SELECT * FROM runbooks WHERE project_id = ? ORDER BY position ASC, created_at ASC")
    .all(projectId) as Runbook[];
}

export interface CreateRunbookInput {
  project_id: string;
  name: string;
  description?: string;
  prompt: string;
  agent?: string;
  permission_mode?: string | null;
  send_context?: boolean;
  priority?: Priority;
  /** The agent id that filed this, or '' when the user wrote it. */
  created_by?: string;
}

export function createRunbook(input: CreateRunbookInput): Runbook {
  const now = Date.now();
  const id = nanoid();
  const position = (
    getDb().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM runbooks WHERE project_id = ?").get(input.project_id) as { n: number }
  ).n;
  getDb()
    .prepare(
      `INSERT INTO runbooks (id, project_id, name, description, prompt, agent, permission_mode,
                             send_context, priority, position, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, input.project_id, input.name, input.description ?? "", input.prompt,
      input.agent || "claude", input.permission_mode ?? null,
      input.send_context === false ? 0 : 1, input.priority ?? "med",
      position, input.created_by ?? "", now, now
    );
  return getRunbook(id)!;
}

export function updateRunbook(
  id: string,
  fields: Partial<Pick<Runbook, "name" | "description" | "prompt" | "agent" | "permission_mode" | "send_context" | "priority" | "position">>
): Runbook | null {
  if (!getRunbook(id)) return null;
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return getRunbook(id);
  getDb()
    .prepare(`UPDATE runbooks SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, v]) => v as string | number | null), Date.now(), id);
  return getRunbook(id)!;
}

/**
 * Hard delete, like everything else here — but a linked schedule is DETACHED
 * rather than orphaned.
 *
 * `schedules.runbook_id` is ON DELETE SET NULL, and that alone is the bug: a
 * schedule reading its prompt from a runbook that just vanished would fire an
 * empty prompt every morning, reporting green having done nothing. That is the
 * precise failure the schedules design was built to rule out. So the recipe is
 * copied BACK into every linked schedule first, in one transaction with the
 * delete: the schedule keeps firing exactly what it fired yesterday, frozen as
 * of the deletion, and the user can see the whole prompt in its editor again.
 *
 * The tasks it dispatched are untouched (tasks.runbook_id is SET NULL too) —
 * deleting a recipe must never delete the work it produced.
 */
export function deleteRunbook(id: string): void {
  const db = getDb();
  const rb = getRunbook(id);
  if (!rb) return;
  db.transaction(() => {
    db.prepare(
      `UPDATE schedules
          SET prompt = ?, agent = ?, permission_mode = ?, send_context = ?, priority = ?,
              runbook_id = NULL, updated_at = ?
        WHERE runbook_id = ?`
    ).run(rb.prompt, rb.agent, rb.permission_mode, rb.send_context, rb.priority, Date.now(), id);
    db.prepare("DELETE FROM runbooks WHERE id = ?").run(id);
  })();
}

/**
 * Duplicate into another project. An independent row, not a reference: projects
 * have different repos, different agents connected and different command
 * registries, so a shared recipe would be a link that silently means something
 * else at the other end.
 */
export function copyRunbook(id: string, targetProjectId: string): Runbook | null {
  const src = getRunbook(id);
  if (!src) return null;
  return createRunbook({
    project_id: targetProjectId,
    name: src.name,
    description: src.description,
    prompt: src.prompt,
    agent: src.agent,
    permission_mode: src.permission_mode,
    send_context: src.send_context !== 0,
    priority: src.priority,
    // created_by is "who wrote this row", and this row was written by whoever
    // pressed Copy — not by the original's author.
    created_by: "",
  });
}

/**
 * The most recent task this runbook dispatched, for the card's "last run" line.
 *
 * `rowid` breaks the tie, and it is not decoration: created_at is milliseconds,
 * and dispatching the same runbook twice in quick succession (a double-click, a
 * palette row pressed twice) really does land two rows on the same value —
 * whereupon `ORDER BY created_at DESC` alone returns whichever SQLite feels
 * like, and the card can show the older of the two runs as the latest. rowid is
 * insertion order, which is exactly the question being asked.
 */
export function lastRunOf(runbookId: string): Task | null {
  return (
    (getDb()
      .prepare("SELECT * FROM tasks WHERE runbook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(runbookId) as Task) ?? null
  );
}

/**
 * The schedules firing this runbook. Two callers, both of which need the NAMES
 * rather than a count: the card ("also fired by Morning sweep"), and
 * update_runbook's refusal, which has to tell an agent what it would have
 * changed.
 */
export function schedulesUsing(runbookId: string): { id: string; name: string }[] {
  return getDb()
    .prepare("SELECT id, name FROM schedules WHERE runbook_id = ? ORDER BY created_at ASC")
    .all(runbookId) as { id: string; name: string }[];
}

/**
 * The prompt actually dispatched: the saved recipe, plus this run's extra
 * instructions when there are any.
 *
 * Deliberately not a `{{template}}` language. A brace syntax pulls in
 * declarations, defaults, escaping, types, optional values and validation — and
 * has no answer at all for a schedule, which cannot prompt anyone for a value.
 * One appended paragraph handles "…and focus on CEAP-1234" and costs nothing.
 *
 * When the recipe is a slash command the extras become part of the command's
 * arguments, which is the desired behavior — the same shape the schedules form
 * already invites with its "/jira-tasks, or plain instructions" placeholder.
 */
export function composeRunbookPrompt(prompt: string, extra: string): string {
  const note = extra.trim();
  return note ? `${prompt}\n\nInstructions for this run:\n${note}` : prompt;
}
