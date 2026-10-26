/**
 * Bug reports and feature requests, rendered where they were raised.
 *
 * Sibling of `lib/suggestionCard.ts`, kept as a separate module on purpose
 * rather than a generalization of it: the two settle the same way but point at very
 * different things. A suggestion stores a pair of ids and re-reads a TASK row,
 * which anyone may start, accept or hard-delete underneath it. An issue report
 * stores one id and re-reads a row THIS feature owns, whose whole lifecycle is
 * the card's own buttons. Folding them together would mean one policy answering
 * to two sets of rules.
 *
 * What is persisted onto the tool row is only the report id. Everything the
 * card shows (the editable title and body, the possible duplicates, whether it
 * has been filed yet and at what number) is re-read per render
 * (GET /api/issue-reports/[id]), for the reason the suggestion card gives: a
 * transcript is durable and a card that froze "File issue" into it would still
 * be offering to file something that had already been filed.
 *
 * SDK-free (store + types only) and pinned as such by tests/importGraph.test.ts:
 * it is reached from the internal agent-tools route, a sync-compiled route entry.
 */

import { addMessage, recentToolMessages, updateMessage } from "@/lib/store";
import type { Task, ToolData } from "@/lib/types";

/**
 * Is this the agent's name for a report_issue call?
 *
 * Substring-matched for the reason `isSuggestTaskTool` gives: the prefix
 * belongs to the driver, not the tool. The Claude driver mounts it in-process
 * as `mcp__calandria__report_issue` and the stdio bridge arrives as
 * `calandria__report_issue`; both are correct spellings of the same call.
 */
export function isReportIssueTool(name: string | undefined): boolean {
  return !!name && name.includes("report_issue");
}

/** Attach a report id to a tool row's persisted payload. */
export function withIssueReport(data: ToolData, reportId: string): ToolData {
  return { ...data, issueReport: { id: reportId } };
}

/**
 * Is this tool row a call that runs report_issue from inside another tool?
 *
 * A Codex session can reach the bridge through a wrapper such as
 * `functions.exec`, whose row carries the wrapper's name and the nested call
 * only in its title or detail text. Only a row still in flight (no result
 * yet) qualifies: the bridge call happens while the wrapper runs, and a
 * finished row that merely mentions the name (a grep, a file read) must not
 * collect a card.
 */
export function isNestedReportIssueCall(data: ToolData): boolean {
  if (data.result !== undefined) return false;
  return [data.title, data.detail].some((t) => typeof t === "string" && t.includes("report_issue"));
}

/** Can a card settle onto this row? The runner's re-read uses the same test. */
export function mayCarryIssueReport(data: ToolData): boolean {
  return isReportIssueTool(data.name) || isNestedReportIssueCall(data);
}

/**
 * Settle a report onto the most recent unclaimed report_issue tool row of
 * `taskId`, returning the message id it landed on (null = no such row).
 *
 * Only the stdio-bridge path needs this; a turn running through the runner
 * holds its own tool rows in memory and settles there. Newest-first with a
 * claimed-row skip makes two reports raised in one turn land one card
 * each rather than stacking on the first row. A row named report_issue wins;
 * failing that, an in-flight wrapper row whose text names the call
 * (`isNestedReportIssueCall`) takes the card.
 */
export function attachIssueReportToCall(taskId: string, reportId: string): string | null {
  const rows: { id: string; data: ToolData }[] = [];
  for (const m of recentToolMessages(taskId)) {
    try {
      rows.push({ id: m.id, data: JSON.parse(m.content) as ToolData });
    } catch {
      continue;
    }
  }
  const unclaimed = rows.filter((r) => !r.data.issueReport);
  const row = unclaimed.find((r) => isReportIssueTool(r.data.name)) ?? unclaimed.find((r) => isNestedReportIssueCall(r.data));
  if (!row) return null;
  updateMessage(row.id, JSON.stringify(withIssueReport(row.data, reportId)));
  return row.id;
}

/** Title of a row written only to carry a report card. */
export const STANDALONE_ISSUE_REPORT_TITLE = "⚑ Issue report draft";

/**
 * Write a transcript row whose only content is the card for `reportId`, for a
 * report with no tool row to settle onto. The draft stays reachable from the
 * session that raised it, and the card's own button is still the only way it
 * gets filed.
 */
export function addStandaloneIssueReport(task: Pick<Task, "id" | "generation">, reportId: string): { msgId: string; data: ToolData; ts: number } {
  const data: ToolData = { title: STANDALONE_ISSUE_REPORT_TITLE, name: "report_issue", issueReport: { id: reportId, standalone: true } };
  const m = addMessage(task.id, task.generation, "tool", JSON.stringify(data));
  return { msgId: m.id, data, ts: m.created_at };
}
