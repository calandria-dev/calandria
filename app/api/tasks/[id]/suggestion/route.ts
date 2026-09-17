import { NextResponse } from "next/server";
import { getProject, getTask, getTaskDeps } from "@/lib/store";
import type { SuggestionCard } from "@/lib/types";

export const dynamic = "force-dynamic";

// What a suggestion card in the transcript reads (app/shell/Transcript.tsx).
// `id` is the suggested task, the row `suggest_task` filed, not the session
// the card is rendered in; a suggestion can be filed into any project, so this
// route is project-agnostic and names the project it landed in.
//
// It exists instead of reusing GET /api/tasks/[id] for two reasons. That route
// returns the whole transcript, which is a lot of bytes for a card that wants
// six fields; and the card needs two things no task row carries: the target
// project's name (the card has to say where the task went, and the user may
// never have that project on screen) and the titles of its blockers, since
// "Blocked by 2 tasks" that won't say which is not worth rendering.
//
// A 404 is a real answer, not an error to swallow: Dismiss is a hard delete, so
// a transcript re-read after one has to render the card as gone instead of as
// a live button that 404s on click.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(task.project_id);
  const card: SuggestionCard = {
    id: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    status: task.status,
    // The three flags the card's state machine reads. `suggested` alone doesn't
    // separate "still in the tray" from "accepted onto the board", and neither
    // says whether a session has been minted; that's `started`.
    suggested: task.suggested,
    started: task.started,
    withdrawn_reason: task.withdrawn_reason,
    project_id: task.project_id,
    // A project deleted out from under a suggestion is possible (the task row
    // cascades with it, so in practice this is the belt-and-braces arm).
    project_name: project?.name ?? "another project",
    blocked_by: getTaskDeps(task.id).map((depId) => {
      const dep = getTask(depId);
      return { id: depId, title: dep?.title ?? "(deleted task)", status: dep?.status ?? "cancelled" };
    }),
  };
  return NextResponse.json(card);
}
