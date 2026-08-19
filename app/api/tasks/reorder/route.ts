import { NextResponse } from "next/server";
import { reorderTasks } from "@/lib/store";
import { publishGlobal } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();
  if (!Array.isArray(body?.ids) || !body.ids.every((id: unknown) => typeof id === "string")) {
    return NextResponse.json({ error: "ids (string[]) required" }, { status: 400 });
  }
  const ids: string[] = body.ids;
  // One event per project whose order actually moved — reorderTasks does the
  // comparing (see there for why a rewritten position isn't the same thing as a
  // moved card). Publishing here rather than in the store keeps lib/store.ts a
  // set of typed queries with no side effects, matching PATCH /api/tasks/[id].
  //
  // The UI can only ever submit one project's tasks (the board drags the
  // selected project's list, and dragging is disabled while a search filter
  // hides cards), so the loop is really about not TRUSTING that: a hand-crafted
  // call spanning projects gets one event each instead of a wrong single guess
  // from ids[0]. The bus key is an arbitrary member of the set — the fact is
  // project-wide and the relay ignores it.
  for (const projectId of reorderTasks(ids)) {
    publishGlobal(ids[0], { type: "tasks_reordered", projectId });
  }
  return NextResponse.json({ ok: true });
}
