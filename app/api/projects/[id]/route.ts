import { NextResponse } from "next/server";
import { getProject, updateProject, deleteProject, listTasks, listTags, type TaskWithUsage } from "@/lib/store";
import { removeWorktree, taskDiffStat } from "@/lib/git";
import { removeTaskUploads } from "@/lib/uploads";
import { abortTurn } from "@/lib/abort";
import { turnIdleSince } from "@/lib/turnActivity";
import { removeProjectServices } from "@/lib/services";
import type { Project } from "@/lib/types";

export const dynamic = "force-dynamic";

// Board-card diff stats (branch + additions/deletions) are polled with the
// rest of the task list, so a bare TTL cache keeps `git diff --numstat` off
// the hot path without going stale for more than a beat. Module-level, so it
// survives across requests for the life of the server process.
const DIFF_STAT_TTL_MS = 15_000;
const diffStatCache = new Map<string, { at: number; additions: number; deletions: number }>();

// Attach diff_add/diff_del to running tasks with a worktree — the board
// footer's input. A git failure (worktree torn down mid-request, etc.) must
// never break the task list, so it just omits the fields for that task.
async function withDiffStats(project: Project, tasks: TaskWithUsage[]) {
  // The cache only grows via the `set` below — nothing else evicts entries for
  // tasks that finish, get deleted from other projects' requests, etc. Sweep
  // expired ones once the map gets large rather than checking on every call.
  if (diffStatCache.size > 500) {
    const now = Date.now();
    for (const [id, e] of diffStatCache) {
      if (now - e.at >= DIFF_STAT_TTL_MS) diffStatCache.delete(id);
    }
  }
  return Promise.all(
    tasks.map(async (t) => {
      // "Needs review" isn't a separate status — it's in_progress plus the
      // awaiting flag — so this one check covers both board columns.
      if (t.status !== "in_progress" || !t.worktree_path) return t;
      const cached = diffStatCache.get(t.id);
      if (cached && Date.now() - cached.at < DIFF_STAT_TTL_MS) {
        return { ...t, diff_add: cached.additions, diff_del: cached.deletions };
      }
      try {
        const { additions, deletions } = await taskDiffStat(project.repo_path, t.worktree_path, t.base_sha);
        diffStatCache.set(t.id, { at: Date.now(), additions, deletions });
        return { ...t, diff_add: additions, diff_del: deletions };
      } catch {
        return t;
      }
    })
  );
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Tags ride the same read as the tasks that carry them: their counts are
  // derived from these very rows, so one fetch can't show a chip and a list
  // that disagree.
  // idle_since rides this read rather than listTasks, which is DB-only: the
  // mark is in-memory turn state (lib/turnActivity.ts), and this is the one
  // endpoint the shell builds its task rows from. Without it a reload during a
  // wedge would show a plain spinner until the turn did something, which by
  // definition it is not going to.
  const tasks = (await withDiffStats(project, listTasks(id))).map((t) => ({ ...t, idle_since: turnIdleSince(t.id) }));
  return NextResponse.json({ ...project, tasks, tags: listTags(id) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patch = await req.json();
  const project = updateProject(id, patch);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(project);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const tasks = listTasks(id);
  // Stop any in-flight turns BEFORE the cascade drops their task rows. A live
  // turn keeps writing to SQLite (addMessage, updateTask); once its row is gone
  // those writes hit a FOREIGN KEY error, and the second such throw (from the
  // error handler re-persisting) escapes the runner and, unhandled, would take
  // down the whole server process — killing every other tenant's turn. Mirror
  // the task DELETE handler, which aborts before teardown for the same reason.
  for (const t of tasks) abortTurn(t.id);
  // Tear down each task's worktree + uploaded chat images before the DB
  // cascade drops the rows.
  for (const t of tasks) {
    if (project.repo_path && t.worktree_path) await removeWorktree(project.repo_path, t.worktree_path, t.work_branch);
    removeTaskUploads(t.id);
    diffStatCache.delete(t.id);
  }
  // Kill this project's managed dev-server processes and drop their live registry
  // entries BEFORE the cascade drops the services rows — otherwise the detached
  // children leak (holding the project's port) and the public <slug>--<host>
  // router keeps routing to a now-deleted project until the server restarts.
  removeProjectServices(id);
  deleteProject(id);
  return NextResponse.json({ ok: true });
}
