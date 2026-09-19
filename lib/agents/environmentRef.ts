/*
 * Resolves the `environment` and `model` parameters of suggest_task
 * (lib/agentTools.ts): which coding environment (Claude Code, Codex, Gemini)
 * runs the new task, and whether the model id named for it is one that
 * environment actually offers.
 *
 * A task's agent is fixed for its whole life and its model is passed to that
 * agent's CLI verbatim, so a model from the wrong environment is a task whose
 * every turn fails at once. The check happens here, before the insert, instead
 * of at turn time.
 *
 * Capability data and connection state only, no SDK and no driver import, so
 * lib/agentTools.ts stays pinned SDK-free (tests/importGraph.test.ts).
 */

import { getCapabilities, isAgentId, listAgentIds } from "./capabilities";
import { isAgentConnected } from "./connections";

export type EnvironmentRefResult = { environment: string } | { error: string };

/**
 * An environment id as `list_providers` reports it (its `bundled` and
 * `environments` fields). Matched case-insensitively against the registered
 * ids. An unregistered id, or one nothing is signed in to, is refused. It is
 * never swapped for a connected one: a suggestion that silently lands on a
 * different agent than the plan named is the failure this parameter exists to
 * prevent.
 */
export function resolveEnvironmentRef(ref: string): EnvironmentRefResult {
  const wanted = ref.trim().toLowerCase();
  const known = listAgentIds();
  if (!isAgentId(wanted)) {
    return { error: `"${ref.trim()}" isn't a coding environment. Known environments: ${known.join(", ")}.` };
  }
  if (!isAgentConnected(wanted)) {
    const connected = known.filter((id) => isAgentConnected(id));
    return {
      error:
        `${wanted} isn't connected on this instance. Sign in from Settings → Agents, or pick one that is` +
        (connected.length ? `: ${connected.join(", ")}.` : `. Nothing is connected right now.`),
    };
  }
  return { environment: wanted };
}

export type EnvironmentModelResult = { model: string } | { error: string };

/**
 * A model id checked against the environment's own catalog, the same list the
 * task dialog's picker offers (lib/agents/<id>/capabilities.ts). Matched
 * case-insensitively and returned in the catalog's spelling, which is what the
 * CLI is handed.
 *
 * Only for a model that runs on the environment's own login. A model belonging
 * to a user-added provider (an Ollama box, a gateway) is checked against that
 * provider's policy instead (checkProviderModel in lib/providers/agentRef.ts);
 * this catalog knows nothing about it.
 */
export function checkEnvironmentModel(environment: string, model: string): EnvironmentModelResult {
  const models = getCapabilities(environment).models;
  // An environment that lists no models runs whatever its CLI defaults to,
  // so there is nothing here to check a spelling against.
  if (!models.length) return { model };
  const wanted = model.trim().toLowerCase();
  const hit = models.find((m) => m.value.toLowerCase() === wanted);
  if (hit) return { model: hit.value };
  return {
    error:
      `"${model.trim()}" isn't a model ${environment} runs. Models for ${environment}: ` +
      `${models.map((m) => m.value).join(", ")}. Pass the \`environment\` that owns the model you meant, ` +
      `or a provider from list_providers to run a model of your own.`,
  };
}
