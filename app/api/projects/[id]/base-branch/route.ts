import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { fetchBase, remoteBaseStatus, advanceBaseBranch, pushBaseBranch } from "@/lib/git";
import { jsonGuard } from "@/lib/apiGuard";
import { buildDivergencePrompt, divergenceTaskTitle } from "@/lib/baseDivergence";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GET: how the project's local base branch stands against its remote, for the
// banner above the task list. Refreshes the remote-tracking ref first: this is
// the only place the app reaches the network without the user asking. Every
// failure (no remote, no network, dead credential) comes back as a status the
// banner can render, not an error the UI has to special-case.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`base-branch status ${id}`, async () => {
    const project = getProject(id);
    if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!project.repo_path.trim()) return NextResponse.json({ hasRemote: false });

    const fetched = await fetchBase(project.repo_path, project.branch);
    const status = await remoteBaseStatus(project.repo_path, project.branch);
    return NextResponse.json({
      ...status,
      baseBranch: project.branch,
      fetchedAt: fetched.fetchedAt,
      ...(fetched.error ? { fetchError: fetched.error } : {}),
    });
  });
}

// POST: the banner's one-click actions.
//   fast-forward: move local <base> up to the fetched remote tip
//   push: publish local <base> commits to the remote
//   fix-with-ai: mint a task on the utility agent that reconciles a diverged
//     <base> with its remote, and launch its first turn
// The first two are forward-only and refuse when that isn't possible; see
// lib/git.ts. The third changes nothing itself; the session it starts asks
// before anything it can't prove is safe (lib/baseDivergence.ts).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`base-branch action ${id}`, async () => {
    const project = getProject(id);
    if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
    const { action } = (await req.json().catch(() => ({}))) as { action?: string };

    if (action === "push") {
      // Under a PR landing policy this push is refused by the forge, so it is
      // refused here first, in words that name the way forward. The client hides
      // the button in that mode; this is the half that holds for a stale tab.
      const res = await pushBaseBranch(project.repo_path, project.branch, {
        prRequired: project.landing_mode === "pr",
      });
      return NextResponse.json(res, { status: res.ok ? 200 : 409 });
    }

    if (action === "fast-forward") {
      // Re-reads the remote tip for this request: the client's copy may be
      // stale if the banner has been on screen for a while.
      await fetchBase(project.repo_path, project.branch);
      const status = await remoteBaseStatus(project.repo_path, project.branch);
      if (!status.remoteTip) return NextResponse.json({ ok: false, error: "no remote branch to catch up to" }, { status: 409 });
      // Checked before the behind === 0 case below: a missing base branch
      // reports an all-zero status, so this must run first or the
      // missing-branch case would read as already up to date.
      if (status.baseMissing)
        return NextResponse.json({ ok: false, error: `base branch ${project.branch} not found in this repository` }, { status: 409 });
      if (status.behind === 0) return NextResponse.json({ ok: true, upToDate: true });
      const res = await advanceBaseBranch(project.repo_path, project.branch, status.remoteTip);
      return NextResponse.json({ ...res, behind: status.behind }, { status: res.ok ? 200 : 409 });
    }

    if (action === "fix-with-ai") {
      await fetchBase(project.repo_path, project.branch);
      const status = await remoteBaseStatus(project.repo_path, project.branch);
      if (!(status.ahead > 0 && status.behind > 0))
        return NextResponse.json({ ok: false, error: `${project.branch} has not diverged from ${status.label || "its remote"}` }, { status: 409 });
      // Both modules reach the agent registry or the runner, so they load
      // dynamically to keep this route entry free of the SDK's async graph.
      const { resolveUtilityAgent } = await import("@/lib/agents/oneshots");
      const agent = resolveUtilityAgent().id;
      if (!agent) return NextResponse.json({ ok: false, error: "no agent is connected. Connect one in Settings" }, { status: 409 });
      const facts = {
        label: status.label || `origin/${project.branch}`,
        ahead: status.ahead,
        behind: status.behind,
        localTip: status.localTip,
        remoteTip: status.remoteTip,
      };
      const { dispatchPromptTask } = await import("@/lib/dispatch");
      const result = await dispatchPromptTask({
        project_id: project.id,
        title: divergenceTaskTitle(project, facts),
        description: `Started from the base-branch banner: local ${project.branch} and ${facts.label} had diverged (${facts.ahead} here, ${facts.behind} there).`,
        prompt: buildDivergencePrompt(project, facts),
        agent,
        permission_mode: null,
        send_context: project.send_context !== 0,
        priority: "hi",
        note: `▶ Fix with AI: ${project.branch} diverged from ${facts.label}.`,
      });
      if (!result.ok) return NextResponse.json({ ok: false, error: result.error, task: result.task ?? null }, { status: 400 });
      return NextResponse.json({ ok: true, task: result.task }, { status: 201 });
    }

    return NextResponse.json({ error: `unknown action ${action ?? "(none)"}` }, { status: 400 });
  });
}
