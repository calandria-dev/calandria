// In-process registry of pending AskUserQuestion prompts.
//
// When Claude calls AskUserQuestion, a PreToolUse hook (lib/agents/claude/driver.ts) parks
// here awaiting the user's answer; the /answer route resolves it and the
// held-open turn continues with the answer as the tool result. Single Node
// process, so an in-memory map is enough — kept on globalThis so it survives
// dev HMR module reloads (same pattern as lib/abort.ts).

import type { AskQuestion, AskAnswers } from "./types";

interface PendingAsk {
  id: string; // the AskUserQuestion tool_use id
  questions: AskQuestion[];
  resolve: (answers: AskAnswers) => void;
  reject: (err: Error) => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaAsks: Map<string, Map<string, PendingAsk>> | undefined;
}

// taskId → (askId → pending). A task can have several asks parked at once:
// one assistant message may carry multiple AskUserQuestion tool_uses, and the
// SDK fires the PreToolUse hook for each. Keying by ask id keeps every hook's
// promise resolvable — a flat one-per-task entry would orphan all but the
// latest, deadlocking the turn until the hook timeout.
function registry(): Map<string, Map<string, PendingAsk>> {
  if (!global.__calandriaAsks) global.__calandriaAsks = new Map();
  return global.__calandriaAsks;
}

function remove(taskId: string, askId: string): PendingAsk | undefined {
  const byAsk = registry().get(taskId);
  const pending = byAsk?.get(askId);
  if (!byAsk || !pending) return undefined;
  byAsk.delete(askId);
  if (byAsk.size === 0) registry().delete(taskId);
  return pending;
}

/**
 * Park until the user answers this question (or `signal` aborts — the explicit
 * Stop button; turns are detached from connections, so a page reload or dropped
 * stream leaves the ask parked and answerable). Resolves with the chosen
 * answers; rejects if the turn is torn down while waiting.
 */
export function waitForAnswer(
  taskId: string,
  id: string,
  questions: AskQuestion[],
  signal?: AbortSignal
): Promise<AskAnswers> {
  return new Promise<AskAnswers>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    let byAsk = registry().get(taskId);
    if (!byAsk) {
      byAsk = new Map();
      registry().set(taskId, byAsk);
    }
    // An ask id should be unique per tool_use; if one collides (e.g. a hook
    // retry), settle the old promise instead of orphaning it.
    byAsk.get(id)?.reject(new Error("superseded"));
    byAsk.set(id, { id, questions, resolve, reject });
    signal?.addEventListener(
      "abort",
      () => {
        // Every pending ask for the turn registers its own listener on the
        // turn's signal, so a single abort rejects them all.
        remove(taskId, id);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

/**
 * Resolve a parked ask with the user's answers. Returns false when nothing is
 * waiting under that id (e.g. the turn was torn down by a page reload) — the
 * caller then falls back to resuming the session with the answer as a normal
 * reply.
 */
export function submitAnswer(taskId: string, id: string, answers: AskAnswers): boolean {
  const pending = remove(taskId, id);
  if (!pending) return false;
  pending.resolve(answers);
  return true;
}

/**
 * Whether anything is parked on the user for this task right now — a question
 * card or a tool-permission prompt, both of which park here. `awaiting_input`
 * on the task row says the same thing and is what every UI reads, but this is
 * the registry the waiter actually lives in, so it is true for the instant
 * between a gate parking and the runner persisting the flag. The idle sweep
 * (lib/turnActivity.ts) checks both, because a waiting-on-you turn produces no
 * transcript activity either and must never be marked idle for it.
 */
export function hasOpenAsk(taskId: string): boolean {
  return (registry().get(taskId)?.size ?? 0) > 0;
}

/**
 * Settle a parked ask WITHOUT an answer — the waiter's promise rejects with
 * `reason` and the entry is removed, so a late submitAnswer reports nothing
 * waiting. Used by the permission gate to expire a prompt nobody answered
 * (lib/permissions.ts); an ordinary question has no deadline and never needs it.
 * Returns false when nothing was parked under that id.
 */
export function cancelAsk(taskId: string, id: string, reason: string): boolean {
  const pending = remove(taskId, id);
  if (!pending) return false;
  pending.reject(new Error(reason));
  return true;
}

// ---------- ask outcomes (the ask_user MCP bridge's poll target) ----------
//
// The Claude driver delivers an answered ask back to the model in-process (the
// PreToolUse hook returns it as the tool result). The stdio MCP bridge can't
// hold a promise across processes, so it POLLS instead: startAskUser
// (lib/agentTools.ts) settles the outcome here when the user answers (or the
// turn is torn down), and the bridge's wait endpoint takes it exactly once.
// Same globalThis pattern as the pending-ask registry above.

declare global {
  // eslint-disable-next-line no-var
  var __calandriaAskOutcomes: Map<string, string> | undefined;
}

function outcomes(): Map<string, string> {
  if (!global.__calandriaAskOutcomes) global.__calandriaAskOutcomes = new Map();
  return global.__calandriaAskOutcomes;
}

/** Record the final text of an ask (the formatted answers, or a dismissal note). */
export function settleAsk(taskId: string, id: string, text: string): void {
  outcomes().set(`${taskId}:${id}`, text);
}

/** Take (and clear) an ask's settled outcome; null while still unanswered. */
export function takeAskOutcome(taskId: string, id: string): string | null {
  const key = `${taskId}:${id}`;
  const text = outcomes().get(key);
  if (text === undefined) return null;
  outcomes().delete(key);
  return text;
}

// A question that will never be answered, and the wording each of the three
// settle paths writes. An ask row is the twin of a permission row: `answers` is
// its `outcome`, and until something writes one of them the card renders live
// option buttons. So the ask needs the same three backstops the permission card
// has — the waiter's own catch, the runner's turn-end finally, and the crash
// recovery pass — or a question torn down mid-turn stays answerable forever.
//
// The marker is deliberately NOT an answer: the transcript must not claim the
// user picked something they never picked.
export const ASK_INTERRUPTED_NOTE = "Not answered — the turn was stopped before an answer arrived.";
export const ASK_RESTARTED_NOTE = "Not answered — the app restarted before an answer arrived.";
/** What the MODEL is told when its question was torn down (a tool result, not a card). */
export const ASK_DISMISSED_REPLY = "The user dismissed the question without answering.";
