import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { fetchBase, remoteBaseStatus, advanceBaseBranch, pushBaseBranch } from "@/lib/git";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GET: how the project's local base branch stands against its remote, for the
// banner above the task list. Refreshes the remote-tracking ref first — this is
// the "fetch on project open" half of keeping new worktrees off a stale tip, and
// it's the only place the app reaches the network without the user asking. Every
// failure (no remote, no network, dead credential) comes back as a status the
// banner can render, never an error the UI has to special-case.
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
//   fast-forward — move local <base> up to the fetched remote tip
//   push         — publish local <base> commits to the remote
// Both are forward-only and refuse rather than force; see lib/git.ts.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`base-branch action ${id}`, async () => {
    const project = getProject(id);
    if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
    const { action } = (await req.json().catch(() => ({}))) as { action?: string };

    if (action === "push") {
      const res = await pushBaseBranch(project.repo_path, project.branch);
      return NextResponse.json(res, { status: res.ok ? 200 : 409 });
    }

    if (action === "fast-forward") {
      // Re-read the remote tip under this request rather than trusting one the
      // client saw earlier — the banner may have been sitting on screen for a while.
      await fetchBase(project.repo_path, project.branch);
      const status = await remoteBaseStatus(project.repo_path, project.branch);
      if (!status.remoteTip) return NextResponse.json({ ok: false, error: "no remote branch to catch up to" }, { status: 409 });
      if (status.behind === 0) return NextResponse.json({ ok: true, upToDate: true });
      const res = await advanceBaseBranch(project.repo_path, project.branch, status.remoteTip);
      return NextResponse.json({ ...res, behind: status.behind }, { status: res.ok ? 200 : 409 });
    }

    return NextResponse.json({ error: `unknown action ${action ?? "(none)"}` }, { status: 400 });
  });
}
