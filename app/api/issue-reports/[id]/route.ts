import { NextResponse } from "next/server";
import { issueReportCard } from "@/lib/issueReports";

export const dynamic = "force-dynamic";

// What an issue-report card in the transcript reads (app/shell/Transcript.tsx).
// Re-read per render for the reason lib/issueReportCard.ts gives: the card's
// buttons change what a reload should show (draft / filed / commented /
// dismissed), so a transcript reopened next week must not still offer to file
// something that already was.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const card = issueReportCard(id);
  if (!card) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(card);
}
