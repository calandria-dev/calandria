import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/lib/store";
import { draftIssueReport } from "@/lib/issueReports";
import { publish } from "@/lib/events";
import { addStandaloneIssueReport, attachIssueReportToCall } from "@/lib/issueReportCard";

export const dynamic = "force-dynamic";

// Internal endpoint the stdio MCP bridge (scripts/calandria-mcp.mjs) proxies the
// `report_issue` tool call to, so non-Claude agents (Codex, future CLIs) get the
// same tool the Claude driver mounts in-process. Auth is the per-instance
// SERVICE_TOKEN, enforced in middleware.ts (isAgentToolPath).
//
// Unlike suggest-task, `taskId` is REQUIRED rather than optional: a report is a
// fact about a session's own turn, not something that can be filed into another
// project, and the card has to land on a real transcript row.
export async function POST(req: NextRequest) {
  let body: {
    projectId?: string;
    taskId?: string;
    kind?: string;
    title?: string;
    body?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const task = body.taskId ? getTask(body.taskId) : undefined;
  if (!task) return NextResponse.json({ error: "unknown task" }, { status: 404 });
  if (!body.title?.trim()) return NextResponse.json({ error: "title is required" }, { status: 400 });

  const { report, text } = await draftIssueReport(task, { kind: body.kind, title: body.title, body: body.body ?? "" });
  if (!report) return NextResponse.json({ error: text }, { status: 400 });

  // Same move as suggest-task's endpoint: the runner settles a card onto the
  // report_issue tool row for a driver whose calls ride its event stream, but
  // this endpoint is reached out-of-band by a Codex session's MCP client and
  // never passes through that loop, so the row is found and patched here
  // instead. A call nested inside another tool (Codex's `functions.exec`) may
  // leave no row to find, so the card gets a row of its own. `msgId` rides
  // along so an open transcript patches the card in without refetching.
  let msgId: string | null = null;
  let standalone = false;
  try {
    msgId = attachIssueReportToCall(task.id, report.id);
    if (!msgId) {
      const row = addStandaloneIssueReport(task, report.id);
      msgId = row.msgId;
      standalone = true;
      publish(task.id, { type: "tool", id: `issue-report-${report.id}`, name: row.data.name, title: row.data.title, detail: "", msgId, generation: task.generation, ts: row.ts });
    }
  } catch (err) {
    console.error("[report_issue] could not surface the card:", err);
  }
  if (!msgId) {
    return NextResponse.json({
      ok: true,
      id: report.id,
      text: `Drafted report ${report.id}, but its card could not be added to the transcript, so the user cannot see it yet. NOTHING HAS BEEN FILED. Tell the user the draft exists and that the card failed to appear; don't try to file it yourself.`,
    });
  }
  publish(task.id, { type: "issue_report", reportId: report.id, msgId, ...(standalone ? { standalone: true as const } : {}) });

  return NextResponse.json({ ok: true, id: report.id, text });
}
