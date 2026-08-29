import { NextResponse } from "next/server";
import { detectLandingMode } from "@/lib/github";
import { getProject } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Probe a repository's base branch for a pull-request requirement, so the
 * project settings form can PRESELECT the right landing mode.
 *
 * Deliberately keyed by repo path + branch rather than by project id: the New
 * project dialog needs the same answer before any project row exists. Passing a
 * `project` id instead is the convenience form for the settings dialog, which
 * has one; naming both is fine and the explicit path/branch win.
 *
 * This route never WRITES landing_mode. Detection preselects a control the user
 * still has to save, which is what keeps it from overriding a deliberate choice
 * (a repo can require PRs while the person wants a task's work merged locally
 * into a staging branch, and only they know that).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const project = body?.project ? getProject(String(body.project)) : undefined;
  const repoPath = String(body?.repo_path ?? project?.repo_path ?? "");
  const branch = String(body?.branch ?? project?.branch ?? "");
  return NextResponse.json(await detectLandingMode(repoPath, branch));
}
