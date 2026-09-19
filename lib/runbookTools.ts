// The agent-facing half of runbooks: create, list, and a narrow update.
// Policy lives here instead of in either caller so the in-process Claude MCP
// server and the stdio bridge cannot drift, the same reason
// updateTaskForAgent() is shared.
//
// A separate module from lib/agentTools.ts, which is already large and is
// about tasks. DB only, no runner, no SDK (pinned by tests/importGraph.test.ts).
//
// What an agent may not do, and why:
//
//   Delete. Delete is hard delete throughout this repo with no undo, and the
//   user's own Delete button at least confirms and names what breaks. The
//   analogous verb for tasks (withdraw_suggestion) exists so an agent retracts
//   instead of destroying; a runbook has nothing to retract, since it is inert
//   until someone runs it, so there is no verb at all.
//
//   Edit a runbook a schedule fires. Linking a schedule to a runbook aims
//   unattended automation at a mutable row. That is a trade the user makes
//   knowingly (both editors say so on screen), but a model rewriting the
//   recipe behind an 08:30 job is the same hazard with nobody in the loop.
//   This is the runbook analogue of isInertSuggestion(): touch what nothing
//   has committed to, never what someone has already built on.

import { getProject } from "@/lib/store";
import { resolveTargetProject } from "@/lib/agentTools";
import { resolveConnectedAgent } from "@/lib/agents/connections";
import { getCapabilities, listAgentIds } from "@/lib/agents/capabilities";
import {
  createRunbook, getRunbook, listRunbooks, schedulesUsing, updateRunbook,
} from "@/lib/runbooks/store";
import type { Priority, Project, Runbook } from "@/lib/types";
import { checkEnvironmentModel, resolveEnvironmentRef } from "@/lib/agents/environmentRef";
import { checkProviderModel, resolveProviderRef } from "@/lib/providers/agentRef";
import { getProvider } from "@/lib/providers/store";
import type { ModelProvider } from "@/lib/providers/rows";
import type { EnvironmentId } from "@/lib/providers/types";

// Every permission_mode value any registered driver honors: the same
// capability data GET /api/agents renders into the human picker
// (lib/agents/*/capabilities.ts, SDK-free by design; see tests/importGraph.test.ts).
// Not scoped to the runbook's own agent: resolveConnectedAgent can pick a
// different one than whatever created the row, so a mode valid for either
// driver is accepted regardless of which one ends up running it.
function knownPermissionModes(): Set<string> {
  return new Set(listAgentIds().flatMap((id) => getCapabilities(id).permissionModes.map((m) => m.value)));
}

/**
 * The one field these tools must never pass through unchecked. bypassPermissions
 * (the never-asks mode) skips every permission card, and the ⌘K palette dispatches a
 * runbook with no preview step, so a model that can write this value into a
 * saved runbook (e.g. steered by injected instructions in something it read)
 * has planted unattended, full-auto execution for whenever a human next clicks
 * Run. It's a recognized mode, so the driver's forgiving resolution
 * (permissionModeFor in lib/agents/claude/driver.ts) would honor it instead of
 * degrading it to a safe default, so the refusal has to happen here, before
 * it's ever written. Only a human, from the UI, may set it.
 *
 * Any other unrecognized string is refused too, for a duller reason: coercing
 * a typo to the default without a trace would hide the mistake from the one
 * place (this tool call) that could report it.
 */
function refuseUnsafePermissionMode(mode: string, verb: "created" | "changed"): string | null {
  if (mode === "bypassPermissions") {
    return (
      `permission_mode "bypassPermissions" runs unattended with no permission card to stop it. Only a human can turn that ` +
      `on, from the UI. Nothing was ${verb}.`
    );
  }
  if (!knownPermissionModes().has(mode)) {
    return `"${mode}" isn't a permission mode this app recognizes. Nothing was ${verb}.`;
  }
  return null;
}

/**
 * "" (or whitespace) reads as omitted, not as an unrecognized mode. The schema
 * only types permission_mode `optional()`, so a model meaning "leave the
 * default" has no way to express that other than omitting the key or sending
 * an empty string, and `createRunbook`/`updateRunbook` already treat a blank
 * value as "inherit" (`?? null`). Rejecting "" here would refuse the one
 * input that's least dangerous, not most.
 */
function normalizeMode(mode: string | undefined): string | undefined {
  const trimmed = mode?.trim();
  return trimmed ? trimmed : undefined;
}

export interface CreateRunbookToolInput {
  name: string;
  description: string;
  prompt: string;
  priority?: Priority;
  permission_mode?: string;
  /** An id, or an exact (case-insensitive) name from list_projects. */
  project?: string;
  /** Coding environment id (resolveEnvironmentRef). Omit to inherit the project's default. */
  environment?: string;
  /** Provider id/label, or "local"/"cloud". Omit to inherit the project's default. */
  provider?: string;
  /** Model id, checked against the provider named above or the environment's own catalog. */
  model?: string;
}

/**
 * `create_runbook`. Files into the calling project by default, or any project
 * by the same strict resolution suggest_task uses: no fallback on an
 * unrecognized value, because a recipe saved into the wrong repo without a
 * trace is worse than an error the agent can retry.
 *
 * The agent it will run under is resolved connected-first, or named outright
 * by `environment` when the model the call wants belongs to a different CLI
 * than the project's default. That agent is what the model id is checked
 * against, since every task the runbook dispatches runs under it.
 */
export function createRunbookForAgent(
  current: Project,
  input: CreateRunbookToolInput,
  agentId: string
): { runbook: Runbook | null; text: string } {
  if (!input.name?.trim()) return { runbook: null, text: "A runbook needs a name. Nothing was created." };
  if (!input.prompt?.trim()) {
    return { runbook: null, text: "A runbook needs a prompt: the message its first turn sends. Nothing was created." };
  }
  const permissionMode = normalizeMode(input.permission_mode);
  if (permissionMode !== undefined) {
    const refusal = refuseUnsafePermissionMode(permissionMode, "created");
    if (refusal) return { runbook: null, text: refusal };
  }

  const target = resolveTargetProject(current, input.project);
  if ("error" in target) return { runbook: null, text: target.error };

  // The coding environment, resolved BEFORE the provider: it decides which
  // provider "cloud" means and which model ids are valid. Named explicitly it
  // must be a registered, connected agent; omitted it is the target project's
  // default, connected-first.
  //
  // `agent` stays undefined when nothing is connected, leaving createRunbook's
  // own default in place; `environment` still needs a string to check against,
  // so it falls back to the project default.
  let agent = resolveConnectedAgent([target.project.default_agent]) ?? undefined;
  if (input.environment?.trim()) {
    const env = resolveEnvironmentRef(input.environment);
    if ("error" in env) return { runbook: null, text: `Could not save the runbook: ${env.error} Nothing was created.` };
    agent = env.environment;
  }
  const environment = agent ?? target.project.default_agent;

  // Same resolution suggest_task's `provider` uses: an id, an exact label, or
  // the "local"/"cloud" alias. Checked before the insert so a runbook is
  // never saved pointing at a provider or model that doesn't exist.
  let model = input.model?.trim() || null;
  let providerId: string | null = null;
  let resolvedProvider: ModelProvider | null = null;
  if (input.provider?.trim()) {
    const ref = resolveProviderRef(input.provider, environment);
    if ("error" in ref) return { runbook: null, text: `Could not save the runbook: ${ref.error} Nothing was created.` };
    // A provider that doesn't serve this environment saves a recipe whose
    // every dispatched turn fails at once, the same class of failure the
    // model check below catches.
    if (!ref.provider.environments.includes(environment as EnvironmentId)) {
      return {
        runbook: null,
        text:
          `Could not save the runbook: "${ref.provider.label}" doesn't serve ${environment}. It serves ` +
          `${ref.provider.environments.join(", ") || "no environment"}. Nothing was created.`,
      };
    }
    providerId = ref.provider.id;
    resolvedProvider = ref.provider;
  }
  // The model, checked against whichever list actually governs it, the same
  // routing createSuggestedTask makes. A user-added provider (an Ollama box, a
  // gateway) carries its own on-list; a bundled login, or no provider at all,
  // means the environment's own CLI runs it, so the environment's catalog is
  // the list. Without this a runbook could be saved naming a model from
  // another environment, and every task it dispatched would fail on its first
  // turn. The catalog's own spelling is what gets stored.
  if (model) {
    if (resolvedProvider && !resolvedProvider.bundled) {
      const check = checkProviderModel(resolvedProvider, model);
      if ("error" in check) return { runbook: null, text: `Could not save the runbook: ${check.error} Nothing was created.` };
    } else {
      const check = checkEnvironmentModel(environment, model);
      if ("error" in check) return { runbook: null, text: `Could not save the runbook: ${check.error} Nothing was created.` };
      model = check.model;
    }
  }

  const runbook = createRunbook({
    project_id: target.project.id,
    name: input.name.trim(),
    description: input.description ?? "",
    prompt: input.prompt,
    agent,
    permission_mode: permissionMode ?? null,
    priority: input.priority,
    provider_id: providerId,
    model,
    // Provenance, not a review gate: a runbook is inert until someone presses
    // Run, so it needs no suggested-tray equivalent, but the user should be
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
  /** Schedules that fire this runbook; it cannot be edited while any do. */
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
  /** New provider: an id/label, or "local"/"cloud". Pass "" to clear back to inherit. */
  provider?: string;
  /** New model id. Pass "" to clear back to inherit. */
  model?: string;
}

/**
 * `update_runbook`. Any runbook in any project by id, but only one no schedule
 * fires. See the header note: a model must never be the thing that changed what
 * runs unattended at 08:30.
 *
 * The refusal names the schedules, because "you may not edit this" with no
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
        `silently change work that runs unattended. Nothing was changed. Tell the user what you would have changed and ` +
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
  if (fields.permission_mode !== undefined) {
    const permissionMode = normalizeMode(fields.permission_mode);
    if (permissionMode !== undefined) {
      const refusal = refuseUnsafePermissionMode(permissionMode, "changed");
      if (refusal) return { runbook: null, text: refusal };
    }
    patch.permission_mode = permissionMode ?? null;
  }

  let providerForCheck: ModelProvider | null | undefined;
  if (fields.provider !== undefined) {
    const wanted = fields.provider.trim();
    if (!wanted) {
      patch.provider_id = null;
      providerForCheck = null;
    } else {
      const ref = resolveProviderRef(wanted, cur.agent);
      if ("error" in ref) return { runbook: null, text: `Could not update "${cur.name}": ${ref.error} Nothing was changed.` };
      patch.provider_id = ref.provider.id;
      providerForCheck = ref.provider;
    }
  }
  // Routed the same way create_runbook's is. The environment here is the
  // runbook's stored agent, since update_runbook never changes it: a model
  // belonging to another CLI would fail every turn the recipe ever dispatches.
  if (fields.model !== undefined) {
    let model = fields.model.trim() || null;
    if (model) {
      const provider = providerForCheck !== undefined ? providerForCheck : (cur.provider_id ? getProvider(cur.provider_id) : null);
      if (provider && !provider.bundled) {
        const check = checkProviderModel(provider, model);
        if ("error" in check) return { runbook: null, text: `Could not update "${cur.name}": ${check.error} Nothing was changed.` };
      } else {
        const check = checkEnvironmentModel(cur.agent, model);
        if ("error" in check) return { runbook: null, text: `Could not update "${cur.name}": ${check.error} Nothing was changed.` };
        model = check.model;
      }
    }
    patch.model = model;
  }

  const runbook = updateRunbook(cur.id, patch)!;
  const project = getProject(runbook.project_id);
  return { runbook, text: `Updated runbook "${runbook.name}"${project ? ` in ${project.name}` : ""}.` };
}
