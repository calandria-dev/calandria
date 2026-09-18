import { NextResponse } from "next/server";
import { dismissIssueReport, issueReportCard } from "@/lib/issueReports";

export const dynamic = "force-dynamic";

// The card's Dismiss button. Drops a still-draft report; a no-op (not a 400)
// on one already settled, mirroring dismissIssueReport's own leniency.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = dismissIssueReport(id);
  if (!report) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, card: issueReportCard(id) });
}
