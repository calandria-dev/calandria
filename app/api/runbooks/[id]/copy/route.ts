import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { publishGlobal } from "@/lib/events";
import { copyRunbook, getRunbook } from "@/lib/runbooks/store";

export const dynamic = "force-dynamic";

/**
 * Duplicate a runbook into another project as an independent row. Projects
 * have different repos, different connected agents and different command
 * registries, so a shared reference would resolve differently in the other
 * project.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRunbook(id)) return NextResponse.json({ error: "no such runbook" }, { status: 404 });
  const body = await req.json();
  if (typeof body?.project_id !== "string" || !getProject(body.project_id)) {
    return NextResponse.json({ error: "valid project_id required" }, { status: 400 });
  }
  const copy = copyRunbook(id, body.project_id)!;
  publishGlobal("", { type: "runbooks_changed", projectId: body.project_id });
  return NextResponse.json(copy, { status: 201 });
}
