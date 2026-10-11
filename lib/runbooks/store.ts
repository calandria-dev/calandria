// Typed queries for runbooks. DB only, no runner, no SDK (pinned by
// tests/importGraph.test.ts), so the delete policy below can be tested without
// launching anything.

import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import type { Priority, Runbook, RunbookAgentEdit, RunbookAgentEditChange, Task } from "@/lib/types";

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
  /** The model provider a dispatch carries into the task it mints; null/undefined = the project's default. */
  provider_id?: string | null;
  /** The model that task starts on; null/undefined = the project's default. */
  model?: string | null;
}

export function createRunbook(input: CreateRunbookInput): Runbook {
  const now = Date.now();
  const id = nanoid();
  const position = (
    getDb().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM runbooks WHERE project_id = ?").get(input.project_id) as { n: number }
  ).n;
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO runbooks (id, project_id, name, description, prompt, agent, permission_mode,
                             send_context, priority, position, created_by, provider_id, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, input.project_id, input.name, input.description ?? "", input.prompt,
      input.agent || "claude", input.permission_mode ?? null,
      input.send_context === false ? 0 : 1, input.priority ?? "med",
      position, input.created_by ?? "", input.provider_id ?? null, input.model ?? null, now, now
    );
    if (input.created_by) {
      // Agent-created recipes are inert but need the same human confirmation
      // before their first dispatch as an agent-edited recipe.
      db.prepare("UPDATE runbooks SET recipe_revision = 1, agent_edit_revision = 1 WHERE id = ?").run(id);
    }
  })();
  return getRunbook(id)!;
}

export function updateRunbook(
  id: string,
  fields: Partial<Pick<Runbook, "name" | "description" | "prompt" | "agent" | "permission_mode" | "send_context" | "priority" | "position" | "provider_id" | "model">>
): Runbook | null {
  if (!getRunbook(id)) return null;
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return getRunbook(id);
  getDb()
    .prepare(`UPDATE runbooks SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, recipe_revision = recipe_revision + 1, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, v]) => v as string | number | null), Date.now(), id);
  return getRunbook(id)!;
}

export interface RunbookEditActor {
  id: string;
  title: string;
  agent: string;
}

/** Atomically write an agent recipe change, its audit row and its review revision. */
export function updateRunbookWithAgentEdit(
  id: string,
  fields: Partial<Pick<Runbook, "name" | "description" | "prompt" | "permission_mode" | "priority" | "provider_id" | "model" | "send_context">>,
  actor: RunbookEditActor,
  changes: RunbookAgentEditChange[]
): Runbook | null {
  const db = getDb();
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length || !changes.length) return getRunbook(id);
  const editId = nanoid();
  const now = Date.now();
  db.transaction(() => {
    const current = getRunbook(id);
    if (!current) throw new Error("runbook no longer exists");
    db.prepare(
      `UPDATE runbooks SET ${entries.map(([key]) => `${key} = ?`).join(", ")},
         recipe_revision = recipe_revision + 1, agent_edit_revision = agent_edit_revision + 1,
         agent_edited_at = ?, updated_at = ? WHERE id = ?`
    ).run(...entries.map(([, value]) => value as string | number | null), now, now, id);
    const updated = getRunbook(id)!;
    db.prepare(
      `INSERT INTO runbook_agent_edits (id, runbook_id, project_id, actor_task_id, actor_title, actor_agent, changes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(editId, id, updated.project_id, actor.id, actor.title, actor.agent, JSON.stringify(changes), now);
  })();
  return getRunbook(id);
}

function parseRunbookEdit(row: Omit<RunbookAgentEdit, "changes"> & { changes: string }): RunbookAgentEdit {
  let changes: RunbookAgentEditChange[] = [];
  try { changes = JSON.parse(row.changes); } catch { /* Keep a readable empty audit row if stored JSON is corrupt. */ }
  return { ...row, changes };
}

export function listRunbookAgentEdits(runbookId: string): RunbookAgentEdit[] {
  const rows = getDb().prepare("SELECT * FROM runbook_agent_edits WHERE runbook_id = ? ORDER BY created_at DESC, rowid DESC").all(runbookId);
  return (rows as (Omit<RunbookAgentEdit, "changes"> & { changes: string })[]).map(parseRunbookEdit);
}

export function getRunbookAgentEdit(id: string): RunbookAgentEdit | undefined {
  const row = getDb().prepare("SELECT * FROM runbook_agent_edits WHERE id = ?").get(id) as (Omit<RunbookAgentEdit, "changes"> & { changes: string }) | undefined;
  return row ? parseRunbookEdit(row) : undefined;
}

export function markRunbookAgentEditReverted(id: string): void {
  getDb().prepare("UPDATE runbook_agent_edits SET reverted_at = ? WHERE id = ?").run(Date.now(), id);
}

export function hasOutstandingRunbookAgentEdits(runbookId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM runbook_agent_edits WHERE runbook_id = ? AND reverted_at = 0 AND acknowledged_at = 0 LIMIT 1").get(runbookId);
}

export function acknowledgeRunbookAgentEdits(runbookId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE runbook_agent_edits SET acknowledged_at = ? WHERE runbook_id = ? AND reverted_at = 0 AND acknowledged_at = 0").run(Date.now(), runbookId);
    db.prepare("UPDATE runbooks SET agent_edited_at = 0 WHERE id = ?").run(runbookId);
  })();
}

/** Mark only the exact agent recipe revision that the confirmed dispatch used. */
export function markRunbookRecipeReviewed(id: string, recipeRevision: number, agentEditRevision: number): boolean {
  const result = getDb().prepare(
    `UPDATE runbooks SET reviewed_agent_edit_revision = ?
      WHERE id = ? AND recipe_revision = ? AND agent_edit_revision = ?`
  ).run(agentEditRevision, id, recipeRevision, agentEditRevision);
  return result.changes === 1;
}

/**
 * Hard delete, like everything else here, but a linked schedule is detached
 * instead of orphaned.
 *
 * `schedules.runbook_id` is ON DELETE SET NULL: alone, a schedule reading its
 * prompt from a runbook that just vanished would fire an empty prompt every
 * morning, reporting green having done nothing. So the recipe is copied back
 * into every linked schedule first, in one transaction with the delete: the
 * schedule keeps firing exactly what it fired yesterday, frozen as of the
 * deletion, and the user can see the whole prompt in its editor again.
 *
 * The tasks it dispatched are untouched (tasks.runbook_id is SET NULL too):
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
              provider_id = ?, model = ?, runbook_id = NULL, updated_at = ?
        WHERE runbook_id = ?`
    ).run(rb.prompt, rb.agent, rb.permission_mode, rb.send_context, rb.priority, rb.provider_id, rb.model, Date.now(), id);
    db.prepare("DELETE FROM runbooks WHERE id = ?").run(id);
  })();
}

/**
 * Duplicate into another project. An independent row, not a reference: projects
 * have different repos, different agents connected and different command
 * registries, so a shared recipe would be a link that means something else at
 * the other end.
 */
export function copyRunbook(id: string, targetProjectId: string): Runbook | null {
  const src = getRunbook(id);
  if (!src) return null;
  const copy = createRunbook({
    project_id: targetProjectId,
    name: src.name,
    description: src.description,
    prompt: src.prompt,
    agent: src.agent,
    permission_mode: src.permission_mode,
    send_context: src.send_context !== 0,
    priority: src.priority,
    provider_id: src.provider_id,
    model: src.model,
    // created_by is "who wrote this row", and this row was written by whoever
    // pressed Copy, not by the original's author.
    created_by: "",
  });
  if (src.agent_edit_revision > src.reviewed_agent_edit_revision) {
    const db = getDb();
    db.transaction(() => {
      db.prepare("UPDATE runbooks SET recipe_revision = 1, agent_edit_revision = 1 WHERE id = ?").run(copy.id);
      const outstanding = listRunbookAgentEdits(id).filter((edit) => edit.reverted_at === 0 && edit.acknowledged_at === 0);
      for (const edit of outstanding) {
        db.prepare(
          `INSERT INTO runbook_agent_edits (id, runbook_id, project_id, actor_task_id, actor_title, actor_agent, changes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(nanoid(), copy.id, targetProjectId, edit.actor_task_id, edit.actor_title, edit.actor_agent, JSON.stringify(edit.changes), edit.created_at);
      }
      if (outstanding.length) db.prepare("UPDATE runbooks SET agent_edited_at = ? WHERE id = ?").run(Date.now(), copy.id);
    })();
  }
  return getRunbook(copy.id);
}

/**
 * The most recent task this runbook dispatched, for the card's "last run" line.
 *
 * `rowid` breaks the tie, and it is not decoration: created_at is milliseconds,
 * and dispatching the same runbook twice in quick succession (a double-click, a
 * palette row pressed twice) really does land two rows on the same value, so
 * `ORDER BY created_at DESC` alone returns either one arbitrarily, and the card
 * can show the older of the two runs as the latest. rowid is insertion order,
 * which is exactly the question being asked.
 */
export function lastRunOf(runbookId: string): Task | null {
  return (
    (getDb()
      .prepare("SELECT * FROM tasks WHERE runbook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(runbookId) as Task) ?? null
  );
}

/**
 * The schedules firing this runbook. Two callers, both of which need the
 * names instead of a count: the card ("also fired by Morning sweep"), and
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
 * Not a `{{template}}` language. A brace syntax pulls in declarations,
 * defaults, escaping, types, optional values and validation, and has no
 * answer at all for a schedule, which cannot prompt anyone for a value. One
 * appended paragraph handles "…and focus on CEAP-1234" and costs nothing.
 *
 * When the recipe is a slash command the extras become part of the command's
 * arguments, which is the desired behavior: the same shape the schedules form
 * already invites with its "/jira-tasks, or plain instructions" placeholder.
 */
export function composeRunbookPrompt(prompt: string, extra: string): string {
  const note = extra.trim();
  return note ? `${prompt}\n\nInstructions for this run:\n${note}` : prompt;
}
