/**
 * Suggestions, rendered where they were made.
 *
 * `suggest_task` files a task into the Suggested tray. This module settles a
 * SUGGESTION CARD onto the tool call that filed it, the way an
 * already-decided permission card settles onto its call (lib/runner.ts,
 * `permission_denied`).
 *
 * Only the pair of ids is persisted on the row; everything the card shows
 * (title, priority, blockers, project, startability) is re-read from the
 * task row on every render (GET /api/tasks/[id]/suggestion), so it can't show
 * a stale "Start" after the task changes state.
 *
 * SDK-free (store + types only), pinned by tests/importGraph.test.ts.
 */

import { recentToolMessages, updateMessage } from "@/lib/store";
import type { ToolData } from "@/lib/types";

/** The two ids a suggestion card needs. */
export interface SuggestionRef {
  taskId: string;
  /** The project the task was filed into; suggest_task can target any project. */
  projectId: string;
}

/**
 * Whether `name` is a driver's spelling of the suggest_task tool.
 *
 * Matched as a substring because each driver prefixes the tool differently:
 * the Claude driver mounts it in-process as `mcp__calandria__suggest_task`,
 * the stdio bridge arrives as `calandria__suggest_task`. The name is matched
 * instead of the title, which is human-written prose free to be reworded.
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
 * `taskId`, returning the message id it landed on (null if there is no such
 * row).
 *
 * Only the stdio-bridge path needs this. A turn running through the runner
 * keeps its own tool rows in memory and settles there directly. A Codex
 * session's MCP client calls the internal endpoint out of band, with no
 * tool_use id, so the only correlation available is the newest suggest_task
 * call on this task without a card yet.
 *
 * Newest-first with a claimed-row skip lands a parallel batch of suggestions
 * one card each instead of stacking them on the first row.
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
