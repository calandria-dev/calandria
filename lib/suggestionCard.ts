/**
 * Suggestions, rendered where they were made.
 *
 * `suggest_task` files a task into the Suggested tray, and until now that tray
 * was the only place it appeared: the user watching the transcript saw a tool
 * call go by with no artifact, and had to leave the session to find out what
 * had been proposed. This module is the small amount of shared policy that lets
 * the transcript settle a SUGGESTION CARD onto the call that filed it — exactly
 * how an already-decided permission card settles onto the row of the call it
 * killed (lib/runner.ts, `permission_denied`), rather than floating a notice
 * beside it.
 *
 * What is persisted onto the row is only the pair of ids. Everything the card
 * SHOWS — title, priority, blockers, the project it landed in, and above all
 * whether it is still startable — is re-read from the task row on every render
 * (GET /api/tasks/[id]/suggestion). That is the whole reason the payload is
 * this thin: a transcript is durable, the task it points at is not, and a card
 * that froze "Start" into the transcript would still be offering it after the
 * task had been started, accepted, withdrawn or hard-deleted.
 *
 * SDK-free (store + types only) and pinned as such by tests/importGraph.test.ts:
 * it is reached from the internal agent-tools route, which is a sync-compiled
 * route entry.
 */

import { recentToolMessages, updateMessage } from "@/lib/store";
import type { ToolData } from "@/lib/types";

/** Which ids the card needs; see the note above on why it's only these two. */
export interface SuggestionRef {
  taskId: string;
  /** The project the task was FILED INTO — suggest_task can target any project. */
  projectId: string;
}

/**
 * Is this the agent's name for a suggest_task call?
 *
 * Matched as a substring because every driver spells the same tool differently
 * and all of them are correct: the Claude driver mounts it in-process as
 * `mcp__calandria__suggest_task`, the stdio bridge arrives as
 * `calandria__suggest_task`, and a future driver may prefix it again. The name
 * is matched rather than the title, which is written for a human and is free to
 * be re-worded.
 */
export function isSuggestTaskTool(name: string | undefined): boolean {
  return !!name && name.includes("suggest_task");
}

/** Attach `ref` to a tool row's persisted payload. Returns the new JSON. */
export function withSuggestion(data: ToolData, ref: SuggestionRef): ToolData {
  return { ...data, suggestion: { taskId: ref.taskId, projectId: ref.projectId } };
}

/**
 * Settle a suggestion onto the most recent unclaimed suggest_task tool row of
 * `taskId`, returning the message id it landed on (null = no such row).
 *
 * Only the stdio-bridge path needs this. A turn running through the runner has
 * its own tool rows in memory and settles there, which also keeps the runner's
 * later `tool_result` write from clobbering a row this function had patched
 * behind its back. The bridge has no such handle: a Codex session's MCP client
 * calls the internal endpoint directly, so the only correlation available is
 * "the newest suggest_task call on this task that hasn't got a card yet".
 *
 * Newest-first with a claimed-row skip is what makes a parallel batch of
 * suggestions land one card each rather than stacking on the first row.
 */
export function attachSuggestionToCall(taskId: string, ref: SuggestionRef): string | null {
  for (const m of recentToolMessages(taskId)) {
    let data: ToolData;
    try {
      data = JSON.parse(m.content) as ToolData;
    } catch {
      continue;
    }
    if (!isSuggestTaskTool(data.name) || data.suggestion) continue;
    updateMessage(m.id, JSON.stringify(withSuggestion(data, ref)));
    return m.id;
  }
  return null;
}
