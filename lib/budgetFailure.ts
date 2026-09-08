// Detection and recovery constants for the "this LiteLLM key is over budget"
// failure mode. A gateway key's budget is exhausted on LiteLLM's own clock,
// not the app's, and rejects every request identically until it resets or an
// admin raises it, so like a dead login this isn't a work failure and
// burning the pending queue into it would fail every follow-up the same way.
// LiteLLM reports the fact two ways (docs/AGENTS.md): a proxy-level HTTP
// 400/429 with a JSON body containing `"type": "budget_exceeded"`, or the
// end-user budget check's own `ExceededBudget: ...` exception. Classified
// here agent-agnostically so lib/runner.ts can append
// BUDGET_EXCEEDED_NOTICE for a Retry, park the queue, and flag the agent
// instance-wide (lib/agents/connections.ts).
const BUDGET_EXCEEDED_RES = [/"type"\s*:\s*"budget_exceeded"/i, /\bExceededBudget:/i];

/** True when a turn's error text is a LiteLLM budget rejection (the key, its
 *  user or its team has spent its budget) and not a work failure. */
export function isBudgetExceeded(msg: string | null | undefined): boolean {
  return !!msg && BUDGET_EXCEEDED_RES.some((re) => re.test(msg));
}

/** Appended to the persisted error line when a turn dies on a spent gateway
 *  budget. The UI (app/shell/Transcript.tsx) matches this exact string to
 *  render a "Retry" button: the budget resets on LiteLLM's own clock (shown
 *  by the Settings → Agents gateway card's readout), so resending the same
 *  message once it has reset is the recovery; there is nothing to reconnect.
 *  Persisted message content is the durable channel: it survives SSE
 *  reconnects because the snapshot replays from SQLite. */
export const BUDGET_EXCEEDED_NOTICE =
  "This gateway key has exceeded its LiteLLM budget, so no turn can run on it right now. Nothing was " +
  "lost: this session and its worktree are untouched, and any queued messages stay queued. Retry once " +
  "the budget resets (Settings → Agents shows when) or has been raised.";

/** The instance-wide version of the same news, raised through the same
 *  agent_auth relay a dead login uses (lib/agents/connections.ts,
 *  lib/runner.ts) instead of a login-specific reason string, so the
 *  titlebar banner and the agent's Settings card don't read "reconnect" for a
 *  problem reconnecting can't fix. app/shell/AgentConnect.tsx matches this
 *  exact string to swap in budget-specific copy and drop the reconnect CTA. */
export const BUDGET_EXCEEDED_BANNER_REASON =
  "This agent's LiteLLM gateway key has exceeded its budget, so no turn can run until the budget " +
  "resets or is raised (Settings → Agents shows when).";
