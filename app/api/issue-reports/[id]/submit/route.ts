import { NextResponse } from "next/server";
import { submitIssueReport, issueReportCard } from "@/lib/issueReports";

export const dynamic = "force-dynamic";

// The card's own File / Add-to-existing button (app/shell/Transcript.tsx).
// `title`/`body` are the user's edits, saved whether or not GitHub accepts
// them; `issueNumber` present means "comment on this issue instead of opening
// a new one." The card is returned even on failure so the UI can render the
// recorded error without a second fetch.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { title?: string; body?: string; issueNumber?: number | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { ok, report, error } = await submitIssueReport(id, body);
  if (!report) return NextResponse.json({ error: error ?? "not found" }, { status: 404 });
  if (!ok) return NextResponse.json({ error, card: issueReportCard(id) }, { status: 400 });
  return NextResponse.json({ ok: true, card: issueReportCard(id) });
}
