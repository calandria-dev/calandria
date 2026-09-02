import { NextResponse } from "next/server";
import { baseStartPoint, branchDriftStatus, fetchBase, syncBranchFrom } from "@/lib/git";
import { getTag, getProject } from "@/lib/store";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * A tag's base branch against the project's default: how far behind it is, and
 * the one click that fixes it.
 *
 * Deliberately NOT folded into `listTags`. That read is synchronous (better-
 * sqlite3, straight off the row) and runs on every project open, every
 * `tags_changed` echo and every board refresh, while this answer costs three git
 * subprocesses AND a fetch per tag that sets a base. Measured on this repo: the
 * local reads are 14ms together, the fetch is 1.04s — and `fetchBase` is keyed
 * per branch, so five tags on five integration branches is five sequential
 * network round trips, on a read that today returns instantly. Paid here it is
 * one call when the user opens the tag whose branch they're asking about.
 * `base_branch` is still on the row, so the list still knows which tags HAVE an
 * answer to fetch.
 *
 * A tag with no base of its own follows the project default and cannot drift
 * from it, so it is answered without touching git at all.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tag = getTag(id);
  if (!tag) return NextResponse.json({ error: "no such tag" }, { status: 404 });
  const project = getProject(tag.project_id);
  if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });
  if (!tag.base_branch) return NextResponse.json({ inherited: true, projectBranch: project.branch });
  if (tag.base_branch === project.branch)
    return NextResponse.json({ inherited: false, sameAsProject: true, projectBranch: project.branch, branch: tag.base_branch });

  // Fetched first because `branchDriftStatus` is read-only by contract, and a
  // stale local default UNDERSTATES the drift — the one direction this reading
  // must not be wrong in. Measured at `baseStartPoint`, the commit
  // `ensureWorktree` would actually cut a new task from, so a stale checkout of
  // the user's own can't hide a stale integration branch.
  await fetchBase(project.repo_path, project.branch).catch(() => {});
  const againstTip = await baseStartPoint(project.repo_path, project.branch);
  // `branchDriftStatus` folds a missing `against` into `unknown`; the tip is in
  // hand here, so the two are reported apart and the strip can name which.
  const drift = againstTip
    ? await branchDriftStatus(project.repo_path, tag.base_branch, againstTip)
    : { exists: true, ahead: 0, behind: 0, diverged: false, unknown: true };
  return NextResponse.json({
    inherited: false,
    projectBranch: project.branch,
    branch: tag.base_branch,
    against: project.branch,
    againstExists: !!againstTip,
    ...drift,
  });
}

/**
 * Merge the project default INTO the tag's base branch — Sync, one level up from
 * the per-task one. Never a reset: `lib/git.ts`'s `syncBranchFrom` carries the
 * why, and the refusal when a live worktree is holding the branch over unsaved
 * work comes from there too, in `worktreePruneSafety`'s words.
 *
 * Nothing in the database changes, so no event is published: the tag row is
 * untouched and the drift number the strip re-reads is a fact about git.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`tag sync ${id}`, async () => {
    const tag = getTag(id);
    if (!tag) return NextResponse.json({ error: "no such tag" }, { status: 404 });
    const project = getProject(tag.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });
    if (!tag.base_branch)
      return NextResponse.json({ error: "this tag follows the project's default branch — there is nothing to sync" }, { status: 400 });
    if (!project.branch)
      return NextResponse.json({ error: "this project has no default branch to sync from" }, { status: 400 });

    const res = await syncBranchFrom({ repoPath: project.repo_path, branch: tag.base_branch, from: project.branch });
    return NextResponse.json(res, { status: res.ok ? 200 : 409 });
  });
}
