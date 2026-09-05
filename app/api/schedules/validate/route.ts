import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";

export const dynamic = "force-dynamic";

// Check a schedule's prompt before it is saved. An unknown slash command does
// not fail: it returns "Unknown command: /x" with a SUCCESS result, so the run
// would report success having done nothing.
export async function POST(req: Request) {
  const body = await req.json();
  const project = getProject(String(body?.project_id ?? ""));
  if (!project) return NextResponse.json({ error: "valid project_id required" }, { status: 400 });
  const { validatePrompt } = await import("@/lib/schedule/commands");
  const result = await validatePrompt(String(body?.prompt ?? ""), project, String(body?.agent || project.default_agent));
  return NextResponse.json(result);
}
