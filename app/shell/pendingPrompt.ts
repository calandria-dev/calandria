import type { ToolData } from "@/lib/types";
import type { Msg, TaskRow } from "./types";
import { isTerminal } from "./format";

/**
 * Which transcript rows are questions the turn is parked on RIGHT NOW.
 *
 * An AskUserQuestion (and the canUseTool permission card, same machinery) is an
 * ordinary `tool` row, so it renders in chronological order like everything
 * else. That is wrong for the one row the turn is waiting on: a subagent that
 * returns a screenful of output after the question was asked pushes the card
 * off the top of the viewport, and nothing on screen says an answer is owed.
 * SessionView therefore lifts these rows out of the flow into a dock pinned
 * below the transcript, which is what this picks out.
 *
 * Liveness is the whole difficulty, because "the row has no answer" is NOT the
 * same as "the turn is waiting". Nothing ever backfills an ask row that a Stop
 * or a crash tore down (`lib/agentTools.ts` says so where it creates the card,
 * and `recoverFromCrash` only backfills PERMISSION rows), and
 * `tasks.awaiting_input` is zeroed by the next turn start regardless. So a dead
 * question can sit unanswered in the transcript forever, and pinning one of
 * those would put a card nobody can usefully answer permanently on screen.
 * Three cuts, none of which can be dropped:
 *
 * - `live` — the caller's read of whether the ball is in the user's court at
 *   all (see `promptsAreLive`).
 * - The CURRENT generation only. A question from before a `/clear` belongs to a
 *   session that no longer exists; its answer would have nowhere to go.
 * - Nothing after it from the user. Answering a card whose turn has already
 *   ended sends the answer as an ordinary message, so a question the user has
 *   already typed past was answered in prose or abandoned either way.
 *
 * Returns ids in transcript order. It is a LIST because a parallel tool batch
 * really can park on several cards at once, and docking one while its siblings
 * stayed inline would be a worse version of the bug being fixed.
 */
export function pendingPromptIds(messages: Msg[], live: boolean): string[] {
  if (!live) return [];
  const committed = messages.filter((m) => m.role !== "queued" && m.role !== "session_break");
  if (!committed.length) return [];
  const gen = Math.max(...committed.map((m) => m.generation));
  const current = committed.filter((m) => m.generation === gen);
  const out: string[] = [];
  // Backwards, so the user's most recent message is the floor: anything above
  // it predates a turn they have already moved on from.
  for (let i = current.length - 1; i >= 0; i--) {
    const m = current[i];
    if (m.role === "user") break;
    if (isPendingPrompt(m)) out.unshift(m.id);
  }
  return out;
}

/** True for a `tool` row that is an unanswered question or an undecided permission card. */
export function isPendingPrompt(m: Msg): boolean {
  if (m.role !== "tool") return false;
  let d: ToolData;
  try { d = JSON.parse(m.content) as ToolData; } catch { return false; }
  if (d.ask) return !d.ask.answers;
  if (d.permission) return !d.permission.outcome;
  return false;
}

/**
 * The `live` argument above, from the task row. A running turn is parked on the
 * user by definition; a turn that has ENDED on a question still leaves an
 * answerable card (the answer resumes the session as an ordinary message), so
 * `awaiting_input` counts too — but not once the task itself is terminal,
 * which is the point where "somebody owes an answer" stops being true.
 */
export function promptsAreLive(task: { status: TaskRow["status"]; awaiting_input: number }, running: boolean): boolean {
  if (running) return true;
  return !isTerminal(task) && !!task.awaiting_input;
}
