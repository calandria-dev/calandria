/**
 * Bug reports and feature requests, rendered where they were raised.
 *
 * Sibling of `lib/suggestionCard.ts`, and deliberately a separate module rather
 * than a generalization of it: the two settle the same way but point at very
 * different things. A suggestion stores a pair of ids and re-reads a TASK row,
 * which anyone may start, accept or hard-delete underneath it. An issue report
 * stores one id and re-reads a row THIS feature owns, whose whole lifecycle is
 * the card's own buttons. Folding them together would mean one policy answering
 * to two sets of rules.
 *
 * What is persisted onto the tool row is only the report id. Everything the
 * card shows — the editable title and body, the possible duplicates, whether it
 * has been filed yet and at what number — is re-read per render
 * (GET /api/issue-reports/[id]), for the reason the suggestion card gives: a
 * transcript is durable and a card that froze "File issue" into it would still
 * be offering to file something that had already been filed.
 *
 * SDK-free (store + types only) and pinned as such by tests/importGraph.test.ts:
 * it is reached from the internal agent-tools route, a sync-compiled route entry.
 */

import { recentToolMessages, updateMessage } from "@/lib/store";
import type { ToolData } from "@/lib/types";

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
 * Settle a report onto the most recent unclaimed report_issue tool row of
 * `taskId`, returning the message id it landed on (null = no such row).
 *
 * Only the stdio-bridge path needs this; a turn running through the runner
 * holds its own tool rows in memory and settles there. Newest-first with a
 * claimed-row skip is what makes two reports raised in one turn land one card
 * each rather than stacking on the first row.
 */
export function attachIssueReportToCall(taskId: string, reportId: string): string | null {
  for (const m of recentToolMessages(taskId)) {
    let data: ToolData;
    try {
      data = JSON.parse(m.content) as ToolData;
    } catch {
      continue;
    }
    if (!isReportIssueTool(data.name) || data.issueReport) continue;
    updateMessage(m.id, JSON.stringify(withIssueReport(data, reportId)));
    return m.id;
  }
  return null;
}
