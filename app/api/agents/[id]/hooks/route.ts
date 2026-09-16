import { NextResponse } from "next/server";
import { z } from "zod";

import { getDriverStrict } from "@/lib/agents/registry";
import { getTask, getProject } from "@/lib/store";
import { skippedHooks } from "@/lib/agents/codex/hooks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

// Resolve which working directory the caller means: a task's worktree (or its
// project's repo_path when the task has none checked out yet), or a project's
// repo_path directly. Hook configuration is cwd-scoped, so this is the one
// question both GET and POST must answer before calling the driver.
function resolveCwd(taskId: string | null, projectId: string | null): { cwd?: string; error?: string } {
  if (taskId) {
    const task = getTask(taskId);
    if (!task) return { error: "no such task" };
    if (task.worktree_path) return { cwd: task.worktree_path };
    const project = getProject(task.project_id);
    if (!project) return { error: "no such project" };
    return { cwd: project.repo_path || undefined };
  }
  if (projectId) {
    const project = getProject(projectId);
    if (!project) return { error: "no such project" };
    return { cwd: project.repo_path || undefined };
  }
  return { error: "taskId or projectId is required" };
}

// GET: the hook inventory for an agent's cwd, plus which of those hooks it
// will actually skip and why. An agent with no listHooks (every agent but
// Codex) reports unsupported instead of a 404 or 500, so one generic card can
// call this for any agent.
export async function GET(req: Request, { params }: RouteContext) {
  const { id } = await params;
  const driver = getDriverStrict(id);
  if (!driver) return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  if (!driver.listHooks) return NextResponse.json({ supported: false });

  const url = new URL(req.url);
  const { cwd, error } = resolveCwd(url.searchParams.get("taskId"), url.searchParams.get("projectId"));
  if (error) return NextResponse.json({ error }, { status: 400 });

  const result = await driver.listHooks(cwd!);
  if (result.error) return NextResponse.json({ supported: true, error: result.error }, { status: 502 });
  return NextResponse.json({
    supported: true,
    inventory: result.inventory,
    skippedHooks: skippedHooks(result.inventory ?? { scopes: [] }),
  });
}

const postSchema = z
  .object({
    taskId: z.string().optional(),
    projectId: z.string().optional(),
    reviews: z.array(z.object({ key: z.string(), action: z.enum(["trust", "untrust", "enable", "disable"]) })),
  })
  .strict();

// POST: apply a batch of trust/enabled reviews for an agent's cwd.
export async function POST(req: Request, { params }: RouteContext) {
  const { id } = await params;
  const driver = getDriverStrict(id);
  if (!driver) return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  if (!driver.reviewHooks) return NextResponse.json({ error: `${id} has no hooks to review` }, { status: 400 });

  const parsed = postSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, { status: 400 });
  }
  const body = parsed.data;
  const { cwd, error } = resolveCwd(body.taskId ?? null, body.projectId ?? null);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const result = await driver.reviewHooks(cwd!, body.reviews);
  if (!result.ok) return NextResponse.json({ error: result.error ?? "review failed" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
