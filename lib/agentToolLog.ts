// One log line per Calandria agent-tool call, written the moment it arrives
// and again when it settles, so "did the call land?" is answered with a
// grep, not a manual GET. Shared by the in-process Claude server (lib/agents/claude/driver.ts,
// via guardToolHandler's onCall hook) and the stdio bridge's endpoints
// (app/api/internal/agent-tools/*), which log the arrival only, since their
// outcome is the HTTP response. The third line, logAgentToolCutoff, is written
// when the agent CLI answers a call itself, from whichever side saw it happen.
// Kept SDK-free and pinned in tests/importGraph.test.ts.
import { createLogger } from "./log.mjs";

const log = createLogger("agent-tools");

export type AgentToolTransport = "in-process" | "bridge";
/** The guard's word for how a call settled (guardToolHandler's onSettle). */
export type AgentToolOutcome = "ok" | "error" | "timeout" | "blank";

/** Log that a Calandria tool call reached the server. */
export function logAgentToolArrival(tool: string, transport: AgentToolTransport, taskId?: string | null): void {
  log.info("agent tool call received", { tool, transport, task: taskId || undefined });
}

/** Log how a Calandria tool call settled. `outcome` is the guard's word for it. */
export function logAgentToolOutcome(
  tool: string,
  transport: AgentToolTransport,
  outcome: AgentToolOutcome,
  ms: number,
  taskId?: string | null,
): void {
  log[outcome === "ok" ? "info" : "warn"]("agent tool call settled", { tool, transport, outcome, ms, task: taskId || undefined });
}

/**
 * Log that the agent CLI cut a Calandria tool call off, so the model is holding
 * an answer Calandria never wrote. One wording for both transports, since
 * neither of the two places that detect it (the Claude driver's stream pump,
 * the stdio bridge's cancellation watch) is the only one an operator greps.
 *
 * `detail` carries whatever else the detecting side knows, and the two sides
 * know different things: the stream pump has the tool_use id and a running
 * per-turn count, the bridge has whether the handler had already finished and
 * the cancellation's own reason. Neither is required, so neither side has to
 * invent a field to match the other.
 */
export function logAgentToolCutoff(
  tool: string,
  transport: AgentToolTransport,
  taskId?: string | null,
  detail?: Record<string, unknown>,
): void {
  log.warn("agent tool call cut off before Calandria answered", {
    tool,
    transport,
    task: taskId || undefined,
    ...(detail || {}),
  });
}
