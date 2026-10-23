import { NextResponse } from "next/server";
import { listProjects, createProject } from "@/lib/store";
import { awaitingCounts } from "@/lib/workCenter/compat";
import { resolvedTaskProvider } from "@/lib/providers/resolve";

export const dynamic = "force-dynamic";

export async function GET() {
  // The badge is the Work Center's visible needs-you count (unsnoozed tasks
  // with an unresolved item), the same number the title-bar pill sums.
  const awaiting = awaitingCounts();
  return NextResponse.json(
    listProjects().map((project) => ({
      ...project,
      awaiting_count: awaiting.get(project.id) ?? 0,
      provider: resolvedTaskProvider(project, null, project.default_agent),
    })),
  );
}

export async function POST(req: Request) {
  const body = await req.json();
  if (!body?.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  const project = createProject({
    name: body.name.trim(),
    icon: body.icon,
    sub: body.sub,
    color: body.color,
    context: body.context,
    repo_path: body.repo_path,
    branch: body.branch,
    // Validated in createProject (isLandingMode); anything else falls back to "merge".
    landing_mode: body.landing_mode,
  });
  return NextResponse.json(project, { status: 201 });
}
