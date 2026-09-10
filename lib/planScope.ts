import { listProjectsPlain } from "@/lib/store";
import { parseAgentEnv, planLoginBills } from "@/lib/agentEnv";
import type { PlanScope, Project } from "@/lib/types";

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
export function agentPlanScope(agent: string, projects?: Pick<Project, "agent_env" | "deprecated">[]): PlanScope {
  const rows = (projects ?? listProjectsPlain()).filter((p) => !p.deprecated);
  let onPlan = 0;
  let redirected = 0;
  for (const p of rows) {
    if (planLoginBills(parseAgentEnv(p.agent_env), agent)) onPlan++;
    else redirected++;
  }
  const kind = redirected === 0 ? "all" : onPlan === 0 ? "none" : "some";
  return { kind, onPlan, redirected };
}
