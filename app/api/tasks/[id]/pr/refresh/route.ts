import { NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import { prView, schedulePrRefresh, startPrPolling } from "@/lib/prState";

export const dynamic = "force-dynamic";

// The explicit "Refresh" click on the PR chip. It kicks off a re-read and
// returns the state already on hand, since the gh call is a network round
// trip and holding a request open across it is exactly what CLAUDE.md rules
// out. The button's payoff arrives over /api/events (task_edited) a moment
// later, so a refresh started in one tab lands in all of them.
//
// `force` is set because the user asking again beats the freshness window
// that makes opening a task cheap.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!task.pr_url) return NextResponse.json({ error: "this task has no pull request" }, { status: 400 });
  schedulePrRefresh(id, { force: true });
  startPrPolling();
  return NextResponse.json({ ok: true, pr: prView(task) });
}
