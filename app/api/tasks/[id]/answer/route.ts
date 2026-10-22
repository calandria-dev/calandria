import { findCardMessage, getTask, sessionRowId } from "@/lib/store";
import { openAskIds, submitAnswer } from "@/lib/asks";
import type { AskAnswers } from "@/lib/types";

export const dynamic = "force-dynamic";

// Deliver the user's answer to a Claude turn parked on an AskUserQuestion.
// `resolved: true`  → the live turn was waiting and will continue in its stream.
// `resolved: false` → nothing was waiting (e.g. the turn was torn down by a page
//   reload); the client resumes the session with the answer as a normal reply.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });

  const { askId, answers, sessionId, messageId, requestId } = (await req.json()) as {
    askId?: string;
    answers?: AskAnswers;
    sessionId?: string;
    messageId?: string;
    requestId?: string;
  };
  if (!askId || !Array.isArray(answers)) {
    return new Response(JSON.stringify({ error: "askId and answers are required" }), { status: 400 });
  }

  // Work Center clients pass the exact request they were shown. Older clients
  // omit all three and keep the existing behavior. A mismatch is never
  // answered against the newest request: it is a 409 the client resolves by
  // refetching.
  if (sessionId !== undefined || messageId !== undefined || requestId !== undefined) {
    const card = findCardMessage(id, askId);
    // Live means still parked in the registry: a request settled in another
    // tab, expired, or lost to a restart is expired here, not silently answered.
    const matches =
      requestId === askId &&
      !!card &&
      card.id === messageId &&
      (sessionRowId(id, card.generation) ?? null) === (sessionId ?? null) &&
      openAskIds(id).includes(askId);
    if (!matches) {
      return Response.json({ error: { code: "request_expired", message: "that request is no longer the one on screen", retryable: false } }, { status: 409 });
    }
  }

  const resolved = submitAnswer(id, askId, answers);
  return Response.json({ resolved });
}
