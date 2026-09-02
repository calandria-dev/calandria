import { NextResponse } from "next/server";
import { getTag } from "@/lib/store";
import { startTagRefreshJob, getTagRefreshState, clearTagRefresh } from "@/lib/tagRefresh";

export const dynamic = "force-dynamic";

// "Refresh tag" runs as a DETACHED background job (see lib/tagRefresh.ts): the
// agent reads the repo, judges the plan's tasks against it, and this process
// applies what it may. The state lives on the tags row, so the bar survives
// lighting a different chip, switching project, or reloading the tab — the
// client polls GET while it runs and reconnects to a job it never started.
//
// Unlike the project context draft there is nothing to accept: the edits are
// already on the tasks, where the "Changed by agent" chip owns their review.
// DELETE only dismisses the report.
//
//   POST   start the job, return its (running) state immediately
//   GET    poll { status, stage, summary, error, started_at }
//   DELETE acknowledge a finished run (clear it back to idle)

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTag(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    return NextResponse.json(startTagRefreshJob(id), { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const state = getTagRefreshState(id);
  if (!state) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(state);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const state = clearTagRefresh(id);
  if (!state) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(state);
}
