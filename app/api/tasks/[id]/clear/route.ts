import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, listMessages, addMessage, addSummary, clearPendingMessages, getTaskContext } from "@/lib/store";
import { getClearEstimate } from "@/lib/internalUsage";
import { summarizeTranscript } from "@/lib/agents/oneshots";
import { hasTurn, abortTurn, beginClearing, endClearing } from "@/lib/abort";
import { publish, publishGlobal } from "@/lib/events";
import { buildClippedTranscript } from "@/lib/transcript";
import type { Task, Project } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Enough of a discarded follow-up to recognise (and retype) it, on one line.
const DROPPED_PREVIEW_CHARS = 200;
function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > DROPPED_PREVIEW_CHARS ? `${oneLine.slice(0, DROPPED_PREVIEW_CHARS)}…` : oneLine;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ estimate: getClearEstimate(getTaskContext(id).context_tokens, task.agent) });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(task.project_id);
  if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

  const gen = task.generation;

  // Claims the task for the whole retirement, before the abort below frees
  // the turn slot. Without this, hasTurn() reads false across the
  // multi-minute summarize that follows, so a POST /messages or a queue
  // drain could start a turn on the generation this route is retiring: a
  // session about to be summarized away, with a summary covering a
  // generation still being written to (issue #36). The claim makes every
  // launch path park its message instead; the finally below releases it on
  // every exit, including a summarize that throws and a task deleted while
  // this request waited.
  if (!beginClearing(id)) {
    return NextResponse.json({ error: "a /clear is already in progress for this task" }, { status: 409 });
  }
  try {
    return await clearGeneration(id, task, project, gen);
  } finally {
    endClearing(id);
  }
}

async function clearGeneration(id: string, task: Task, project: Project, gen: number) {
  // Stops any turn still streaming before ending this generation. /clear
  // starts a fresh context, so the running turn's work belongs to the old
  // generation and must not bleed into the new one. Aborting trips the
  // runner's unwind; the generation bump below, combined with the runner's
  // generation-guarded settle (lib/runner.ts), stops that turn's finally
  // from resurrecting the session id this route nulls. This does not block
  // on the turn fully settling: whichever order the abort's finally and
  // this write land in, the guard keeps session_id null. The clearing claim
  // taken above keeps the slot the abort frees unusable until this route is
  // done, so the unwinding turn's handoff can't drain into it either.
  if (hasTurn(id)) abortTurn(id);

  // Builds a transcript from the current generation's messages, clipping
  // each message and capping the total so an oversized session (a giant
  // paste, or a conversation that hit the context limit) can still be
  // summarized. Otherwise summarizeTranscript would itself fail "prompt is
  // too long" and the handoff summary would be lost.
  const transcript = buildClippedTranscript(
    listMessages(id).filter(
      (m) => m.generation === gen && (m.role === "user" || m.role === "assistant" || m.role === "tool")
    )
  );

  let summary = "(empty session, nothing to summarize)";
  if (transcript.trim()) {
    try {
      summary = await summarizeTranscript(task, transcript, project);
    } catch (err) {
      summary = `(summary failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  // The summarize above can take minutes, so re-read before writing. The
  // task may have been deleted while this route waited (addSummary would
  // then throw a foreign key error and 500). The generation check is a
  // second safeguard, since the clearing claim already 409s a second
  // /clear: nothing else in the app advances a generation, and bumping
  // twice would skip one and double-record the boundary.
  const cur = getTask(id);
  if (!cur) return NextResponse.json({ error: "task was deleted while summarizing" }, { status: 404 });
  if (cur.generation !== gen) return NextResponse.json({ task: cur, summary, generation: cur.generation });

  addSummary(id, gen, summary);
  // Records the boundary and summary in the message log for continuity in
  // the UI.
  addMessage(id, gen, "session_break", summary);

  // Fresh generation: new context window, session reset. started=0 so the next
  // send opens with the generic start prompt; buildProjectContext supplies the
  // task metadata and now includes the summary.
  const next = updateTask(id, {
    generation: gen + 1,
    session_id: null,
    // The measured occupancy described the window this clear is discarding;
    // the fresh session reports its own on its first request.
    context_measured: null,
    started: 0,
    running: 0,
    awaiting_input: 0,
    status: "in_progress",
  });

  // Discards any follow-ups queued against the old generation. They were
  // lined up behind the context the user just cleared, so auto-draining
  // them into the fresh session would replay stale intent. The aborted
  // turn's finally also clears the queue on its own path; doing it here too
  // covers the no-turn case and any residual rows, and is idempotent.
  const dropped = clearPendingMessages(id);
  for (const p of dropped) publish(id, { type: "dequeued", msgId: p.id });
  // A dequeued bubble disappears from the transcript with nothing said, and
  // the clearing claim above means a message sent during the clear now
  // lands in this queue instead of starting a turn, so the wait is where
  // the user is most likely to type one. States what was dropped, in the
  // fresh generation, with enough of the text to retype it from.
  if (dropped.length) {
    const note =
      `ℹ ${dropped.length} queued message${dropped.length === 1 ? "" : "s"} discarded by /clear — ` +
      `${dropped.length === 1 ? "it was" : "they were"} lined up behind the context that just went away. ` +
      `Send ${dropped.length === 1 ? "it" : "them"} again if still wanted:\n` +
      dropped.map((p) => `• ${clip(p.content)}`).join("\n");
    const m = addMessage(id, gen + 1, "system", note);
    publish(id, { type: "notice", content: note, msgId: m.id, generation: gen + 1, ts: m.created_at });
  }

  // The row just settled (running/awaiting reset, status in_progress)
  // outside any turn, and the `dequeued` publishes above are transcript
  // detail the coarse /api/events filter drops. Announces the settle so
  // every other tab's spinners and "needs you" badges recount.
  publishGlobal(id, { type: "task_updated" });

  return NextResponse.json({ task: next, summary, generation: gen + 1 });
}
