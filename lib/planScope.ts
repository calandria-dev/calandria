import { listProjectsPlain } from "@/lib/store";
import { bundledProviderFor, getProvider } from "@/lib/providers/store";
import type { PlanScope, Project } from "@/lib/types";
import type { ModelProvider } from "@/lib/providers/rows";
import type { EnvironmentId } from "@/lib/providers/types";

function providerBillsPlan(provider: ModelProvider | null, agent: string): boolean {
  // A missing provider means the environment's own login, including an
  // unconnected environment whose bundled row has not been created yet.
  if (!provider) return true;
  // A project-level provider can serve only the environments declared by its
  // type. Other environments continue to use their bundled login.
  if (!provider.environments.includes(agent as EnvironmentId)) return true;
  if (provider.bundled === agent) return true;
  // Claude can forward its subscription login through a LiteLLM provider.
  // Codex and Gemini always use the gateway key, even when the row says
  // subscription.
  return provider.type === "litellm" && agent === "claude" && provider.config.billing === "subscription";
}

/**
 * How many of this instance's projects still run one agent's turns on that
 * agent's own login.
 *
 * `AgentDriver.planUsage()` takes no arguments and `codexStatus()` reads
 * ~/.codex/auth.json, so both describe a login with no idea which projects aim
 * at it. A project that sets OPENAI_BASE_URL sends its Codex turns to a local
 * endpoint, and the ChatGPT session and week percentages stay true about the
 * plan while saying nothing about what this instance bills. This is the missing
 * half: the instance-wide count that GET /api/plan-usage and GET /api/agents
 * layer onto the driver's answer.
 *
 * Deprecated projects are left out. They are hidden from the sidebar and not
 * built on, so one of them should neither keep a meter alive that nothing else
 * on the instance uses nor put a note on a meter that is otherwise exact. The
 * cost is that a task in a deprecated project that does still run on the login
 * loses the meter, and with it the usage-window resume offer keyed off the same
 * snapshot (app/shell/SessionView.tsx). The turn itself is unaffected.
 *
 * An instance with no projects at all reads `all`: there is nothing to
 * contradict the plan, and a fresh install must still show its meter.
 *
 * Counts projects, not tasks. A task can carry its own override too, and one
 * task is the wrong grain for a pill about the whole instance: it would flip
 * the note on and off as tasks are created and reclaimed.
 */
export function agentPlanScope(
  agent: string,
  projects?: Pick<Project, "default_provider_id" | "deprecated">[],
): PlanScope {
  const rows = (projects ?? listProjectsPlain()).filter((p) => !p.deprecated);
  let onPlan = 0;
  let redirected = 0;
  for (const p of rows) {
    const provider = p.default_provider_id ? getProvider(p.default_provider_id) : bundledProviderFor(agent);
    if (providerBillsPlan(provider, agent)) onPlan++;
    else redirected++;
  }
  const kind = redirected === 0 ? "all" : onPlan === 0 ? "none" : "some";
  return { kind, onPlan, redirected };
}
