// The agent-facing half of runbooks: create, list, and a deliberately narrow
// update. Policy lives here rather than in either caller so the in-process
// Claude MCP server and the stdio bridge cannot drift — the same reason
// updateTaskForAgent() is shared.
//
// A separate module from lib/agentTools.ts, which is already large and is about
// TASKS. DB only — no runner, no SDK (pinned by tests/importGraph.test.ts).
//
// What an agent may NOT do, and why:
//
//   Delete. Delete is hard delete throughout this repo with no undo, and the
//   user's own Delete button at least confirms and names what breaks. The
//   analogous verb for tasks (withdraw_suggestion) exists precisely so an agent
//   retracts rather than destroys; a runbook has nothing to retract — it is
//   inert until someone runs it — so there is no verb at all.
//
//   Edit a runbook a schedule fires. Linking a schedule to a runbook aims
//   unattended automation at a mutable row. That is a trade the USER makes
//   knowingly — both editors say so on screen — but a model rewriting the
//   recipe behind an 08:30 job is the same hazard with nobody in the loop. This
//   is the runbook analogue of isInertSuggestion(): touch what nothing has
//   committed to, never what someone has already built on.

import { getProject } from "@/lib/store";
import { resolveTargetProject } from "@/lib/agentTools";
import { resolveConnectedAgent } from "@/lib/agents/connections";
import {
  createRunbook, getRunbook, listRunbooks, schedulesUsing, updateRunbook,
} from "@/lib/runbooks/store";
import type { Priority, Project, Runbook } from "@/lib/types";

export interface CreateRunbookToolInput {
  name: string;
  description: string;
  prompt: string;
  priority?: Priority;
  permission_mode?: string;
  /** An id, or an exact (case-insensitive) name from list_projects. */
  project?: string;
}

/**
 * `create_runbook`. Files into the calling project by default, or any project
 * by the same strict resolution suggest_task uses — no fallback on an
 * unrecognized value, because a recipe quietly saved into the wrong repo is
 * worse than an error the agent can retry.
 *
 * The agent it will RUN under is resolved connected-first rather than taken
 * from the model: which CLI a saved recipe should use is a property of the
 * user's setup, not something worth spending a tool parameter on.
 */
export function createRunbookForAgent(
  current: Project,
  input: CreateRunbookToolInput,
  agentId: string
): { runbook: Runbook | null; text: string } {
  if (!input.name?.trim()) return { runbook: null, text: "A runbook needs a name. Nothing was created." };
  if (!input.prompt?.trim()) {
    return { runbook: null, text: "A runbook needs a prompt — the message its first turn sends. Nothing was created." };
  }

  const target = resolveTargetProject(current, input.project);
  if ("error" in target) return { runbook: null, text: target.error };

  const runbook = createRunbook({
    project_id: target.project.id,
    name: input.name.trim(),
    description: input.description ?? "",
    prompt: input.prompt,
    agent: resolveConnectedAgent([target.project.default_agent]) ?? undefined,
    permission_mode: input.permission_mode ?? null,
    priority: input.priority,
    // Provenance, not a review gate: a runbook is inert until someone presses
    // Run, so it needs no suggested-tray equivalent — but the user should be
    // able to see at a glance which recipes they didn't write.
    created_by: agentId,
  });
  return {
    runbook,
    text:
      `Saved runbook "${runbook.name}" in ${target.project.name} (id: ${runbook.id}). ` +
      `It runs nothing until the user dispatches it from the Runbooks card.`,
  };
}

export interface AgentRunbookInfo {
  id: string;
  name: string;
  description: string;
  prompt: string;
  agent: string;
  priority: Priority;
  /** Schedules that fire this runbook — it cannot be edited while any do. */
  used_by: string[];
}

/** `list_runbooks`. Read-only. */
export function listRunbooksForAgent(
  current: Project,
  ref?: string
): { runbooks: AgentRunbookInfo[]; project: string } | { error: string } {
  const target = resolveTargetProject(current, ref);
  if ("error" in target) return { error: target.error };
  return {
    project: target.project.name,
    runbooks: listRunbooks(target.project.id).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      prompt: r.prompt,
      agent: r.agent,
      priority: r.priority,
      // Carried so the agent can see, before it tries, which rows
      // update_runbook will refuse and why.
      used_by: schedulesUsing(r.id).map((s) => s.name),
    })),
  };
}

export interface UpdateRunbookToolInput {
  name?: string;
  description?: string;
  prompt?: string;
  priority?: Priority;
  permission_mode?: string;
}

/**
 * `update_runbook`. Any runbook in any project by id — but only one no schedule
 * fires. See the header note: a model must never be the thing that changed what
 * runs unattended at 08:30.
 *
 * The refusal NAMES the schedules, because "you may not edit this" with no
 * reason leaves the agent nothing to tell the user and nothing to try instead.
 */
export function updateRunbookForAgent(
  _current: Project,
  runbookRef: string,
  fields: UpdateRunbookToolInput
): { runbook: Runbook | null; text: string } {
  const cur = getRunbook(runbookRef);
  if (!cur) {
    return { runbook: null, text: `No runbook with id "${runbookRef}". Call list_runbooks for the ids. Nothing was changed.` };
  }
  const used = schedulesUsing(cur.id);
  if (used.length) {
    const names = used.map((s) => `"${s.name}"`).join(", ");
    return {
      runbook: null,
      text:
        `"${cur.name}" is fired by ${used.length === 1 ? "the schedule" : "the schedules"} ${names}, so editing it would ` +
        `silently change work that runs unattended. Nothing was changed — tell the user what you would have changed and ` +
        `let them edit it, or save a new runbook with create_runbook instead.`,
    };
  }

  // Validated BEFORE any write, so a blank name in a two-field call can't land
  // half of it and then report a refusal.
  const patch: Parameters<typeof updateRunbook>[1] = {};
  if (fields.name !== undefined) {
    if (!fields.name.trim()) return { runbook: null, text: "A runbook's name cannot be blank. Nothing was changed." };
    patch.name = fields.name.trim();
  }
  if (fields.prompt !== undefined) {
    if (!fields.prompt.trim()) return { runbook: null, text: "A runbook's prompt cannot be blank. Nothing was changed." };
    patch.prompt = fields.prompt;
  }
  if (fields.description !== undefined) patch.description = fields.description;
  if (fields.priority !== undefined) patch.priority = fields.priority;
  if (fields.permission_mode !== undefined) patch.permission_mode = fields.permission_mode;

  const runbook = updateRunbook(cur.id, patch)!;
  const project = getProject(runbook.project_id);
  return { runbook, text: `Updated runbook "${runbook.name}"${project ? ` in ${project.name}` : ""}.` };
}
