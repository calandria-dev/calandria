import { NextResponse } from "next/server";
import { getTask, getProject } from "@/lib/store";
import { fetchCheckLog } from "@/lib/github";
import { buildCiFixPrompt, type CiFailure } from "@/lib/agents/shared";
import { parseFailingChecks, refreshPrState } from "@/lib/prState";
import { CI_LOG_TAIL_LINES } from "@/lib/config";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

// The "Fix CI" button behind a red PR chip. It COMPOSES the prompt and hands it
// back; the client sends it as an ordinary message on the task's own session,
// exactly as "Fix with AI" does with /merge/prepare's conflict prompt. Two
// reasons that split is worth keeping rather than starting the turn here:
// the transcript should show the user's message the way any other turn does,
// and the client is what switches the view to the chat so the fix streams in
// live rather than behind a spinner on the chip.
//
// This one DOES hold its request across the network, unlike the refresh
// triggers. It is a click on a button labelled with what it's about to do, the
// gh calls are bounded (one `pr view`, one `run view --log-failed` per red
// check, each with a timeout), and the alternative — a detached job the client
// polls for a prompt it needs before it can do anything — is machinery for a
// wait the user is already expecting.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (task.running)
    return NextResponse.json({ error: "a turn is already running in this task" }, { status: 409 });
  if (!task.pr_url || !task.pr_number)
    return NextResponse.json({ error: "this task has no pull request" }, { status: 400 });

  // Ask GitHub before spending a turn. The chip can be up to one sweep stale,
  // and seeding a session with a failure somebody already fixed is worse than a
  // second of latency on a click. A refresh we can't do (no network, dead gh)
  // is not fatal — we fall through to the stored snapshot, which is the same
  // thing the user is looking at.
  await refreshPrState(id, { force: true }).catch(() => {});
  const fresh = getTask(id) ?? task;

  if (fresh.pr_checks !== "failing")
    return NextResponse.json(
      { error: "this pull request's checks are no longer failing", checks: fresh.pr_checks },
      { status: 409 }
    );

  const red = parseFailingChecks(fresh.pr_failing);
  if (red.length === 0)
    return NextResponse.json(
      { error: "GitHub reports failing checks but didn't name any. Open the PR to see them" },
      { status: 409 }
    );

  // gh resolves the repo from the origin remote, so the PROJECT's checkout is
  // the right cwd — the same choice lib/prState.ts makes, and for the same
  // reason: a task's worktree is reclaimable while its PR still matters.
  const project = getProject(fresh.project_id);
  const cwd = project?.repo_path || fresh.worktree_path;
  if (!cwd) return NextResponse.json({ error: "no repository to read the run log from" }, { status: 400 });

  // Sequential: each is a subprocess and a network call, and a matrix that went
  // red eight ways should not fork eight gh processes at once. Failures are
  // recorded, never thrown — the prompt is still worth sending with the job
  // NAME alone, which is more than the user had before.
  const failures: CiFailure[] = [];
  for (const check of red) {
    const log = await fetchCheckLog(cwd, check.url, CI_LOG_TAIL_LINES);
    failures.push({
      name: check.name,
      url: check.url,
      workflow: check.workflow,
      log: log.ok ? log.log : "",
      logError: log.ok ? "" : log.error,
    });
  }

  return NextResponse.json({
    ok: true,
    prompt: buildCiFixPrompt(fresh.pr_number, failures),
    checks: failures.map((f) => ({ name: f.name, url: f.url, workflow: f.workflow, log: !!f.log })),
  });
}
