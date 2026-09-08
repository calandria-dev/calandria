// Which of an agent's slash commands the composer's "/" menu offers, as a pure
// function of the list the driver reported.
//
// SDK-free (pinned by tests/importGraph.test.ts): this is policy the UI and the
// route both need, and dragging lib/agents/registry.ts in to get it would pull
// an async external into a sync route entry, per the import-graph note in
// lib/agents/capabilities.ts.
//
// Default is SHOW: a command the user installed is a command the user wants.
// Only two narrow categories are withheld below, and each has to earn it.

import type { AgentCommand } from "./agents/types";

/**
 * Commands the agent's CLI keeps for its own machinery. Not user-facing in the
 * CLI either, so offering them here would just be noise that can misfire.
 * `__`-prefixed names are hidden by the same convention.
 */
const INTERNAL = new Set(["workflow-launch-exec"]);

/**
 * Commands that would conflict with app behavior. Two kinds:
 *
 *  - `clear`: Calandria owns /clear. Its version summarizes the transcript
 *    into a handoff note and starts generation N+1 of the task's session
 *    lineage (lib/runner.ts, docs/ARCHITECTURE.md), which differs from the
 *    CLI's own /clear, so offering the CLI's would put two behaviors behind
 *    one name.
 *  - the run-control knobs: model, effort/thinking and permission mode are
 *    per-task fields the UI owns and badges (tasks.model / tasks.reasoning /
 *    tasks.permission_mode). Changing them CLI-side inside the session would
 *    desync the session from the picker that is supposed to control it.
 *
 * Everything else, including session-local trivia like /color or /rename that
 * has no effect here, is left in: a command that does nothing is a smaller
 * failure than a working command the user can't find.
 */
const CONFLICTS = new Set(["clear", "model", "effort", "fast"]);

/** Hidden because the CLI hides it, not because we judged it. */
function isInternal(name: string): boolean {
  return name.startsWith("__") || INTERNAL.has(name);
}

/**
 * The long tail: a plugin's `plugin:command` and an MCP server's
 * `mcp__server__prompt`. Both arrive in bulk under one prefix and sort below
 * the commands a user typed from memory.
 */
function namespaced(name: string): number {
  return name.includes(":") || name.startsWith("mcp__") ? 1 : 0;
}

/**
 * The agent's commands, filtered to what makes sense inside a task chat and
 * sorted for a scannable menu: plain commands first, then the namespaced ones
 * (a plugin's `plugin:command`, an MCP server's `mcp__server__prompt`)
 * alphabetically within each group. Namespaced entries sort last so a user
 * hunting a specific command doesn't scroll past a plugin or MCP fleet's bulk
 * entries to reach it.
 */
export function visibleAgentCommands(commands: AgentCommand[]): AgentCommand[] {
  const seen = new Set<string>();
  return commands
    .filter((c) => {
      const name = c.name.replace(/^\//, "").trim();
      if (!name || isInternal(name) || CONFLICTS.has(name)) return false;
      // Keep the first: a driver reporting the same name twice would otherwise
      // render two identical rows keyed alike.
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .map((c) => ({ ...c, name: c.name.replace(/^\//, "").trim() }))
    .sort((a, b) => namespaced(a.name) - namespaced(b.name) || a.name.localeCompare(b.name));
}
