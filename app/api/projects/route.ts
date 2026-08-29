import { NextResponse } from "next/server";
import { listProjects, createProject } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listProjects());
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
