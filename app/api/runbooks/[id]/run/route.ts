import { NextResponse } from "next/server";
import { composeRunbookPrompt, getRunbook } from "@/lib/runbooks/store";
import { createTask } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** e.g. "Sweep: Aug 20, 14:32", enough to tell two runs of one recipe apart. */
function defaultTitle(name: string): string {
  const stamp = new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date());
  return `${name}: ${stamp}`;
}

/**
 * Dispatch a runbook: mint a fresh task carrying the recipe's config and launch
 * its first turn. Uses the same path a schedule firing takes (lib/dispatch.ts),
 * without the ledger and without the unattended RunContext, since a human
 * pressed this button and the turn may legitimately park on a permission card.
 *
 * `start: false` creates the task without launching, for queueing one up to
 * start later.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runbook = getRunbook(id);
  if (!runbook) return NextResponse.json({ error: "no such runbook" }, { status: 404 });

  let body: { title?: string; extra?: string; start?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // An empty body is a legitimate "run it as saved"; the ⌘K path sends one.
  }
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : defaultTitle(runbook.name);
  const prompt = composeRunbookPrompt(runbook.prompt, typeof body.extra === "string" ? body.extra : "");

  // Not starting: this is an ordinary unstarted task that remembers where it
  // came from. It does not go through the dispatcher: there is no turn to
  // launch, and the dispatcher's preflight exists to avoid minting a task that
  // cannot run.
  if (body.start === false) {
    const task = createTask({
      project_id: runbook.project_id,
      title,
      // The composed prompt becomes the brief, because nothing sends it as a
      // turn yet; without this the extras typed for this run would be lost
      // between here and whenever someone presses Start.
      description: runbook.description ? `${runbook.description}\n\n${prompt}` : prompt,
      priority: runbook.priority,
      agent: runbook.agent,
      send_context: runbook.send_context !== 0,
      permission_mode: runbook.permission_mode,
      runbook_id: runbook.id,
    });
    return NextResponse.json({ task }, { status: 201 });
  }

  const { dispatchPromptTask } = await import("@/lib/dispatch");
  const result = await dispatchPromptTask({
    project_id: runbook.project_id,
    title,
    description: runbook.description || `Dispatched from the "${runbook.name}" runbook.`,
    prompt,
    agent: runbook.agent,
    permission_mode: runbook.permission_mode,
    send_context: runbook.send_context !== 0,
    priority: runbook.priority,
    note: `▶ Runbook: ${runbook.name}.`,
    runbook_id: runbook.id,
  });

  if (!result.ok) {
    // 400: every failure the dispatcher reports is something the user can fix
    // (no working directory, a disconnected agent, an unknown slash command).
    // `task` is present when the row was minted and only the launch failed, so
    // pass it through so the client can select the retryable task instead of
    // leaving it stranded in the tray with no explanation.
    return NextResponse.json({ error: result.error, task: result.task ?? null }, { status: 400 });
  }
  return NextResponse.json({ task: result.task }, { status: 201 });
}
