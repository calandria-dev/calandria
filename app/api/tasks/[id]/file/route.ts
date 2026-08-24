import fs from "node:fs";
import { NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import { resolveWorktreeFile, blobSha, MAX_COLLAB_BYTES } from "@/lib/worktreeFile";

export const dynamic = "force-dynamic";

// Read one text file out of a task's worktree, for the document collaboration
// modal (the diff only carries hunks; the modal renders the whole document).
// The path is repo-relative and confined to the worktree by
// resolveWorktreeFile — symlinks included. Size-capped and text-only: the
// whole content rides back in the collaboration POST, and a binary would
// never render as a document anyway. `sha` is the content's git blob id — the
// anchor a document comment is stamped with (see TaskDocComment).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!task.worktree_path) return NextResponse.json({ error: "task has no worktree" }, { status: 409 });

  const rel = new URL(req.url).searchParams.get("path") ?? "";
  const abs = resolveWorktreeFile(task.worktree_path, rel);
  if (!abs) {
    // Either outside the worktree or nonexistent; the guard can't tell the
    // route which without leaking which paths exist, so both are "not found"
    // unless the request was malformed on its face.
    const malformed = !rel || rel.startsWith("/") || rel.split("/").includes("..");
    return NextResponse.json({ error: malformed ? "bad path" : "file not found" }, { status: malformed ? 400 : 404 });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return NextResponse.json({ error: "file not found" }, { status: 404 });
  }
  if (!stat.isFile()) return NextResponse.json({ error: "not a file" }, { status: 400 });
  if (stat.size > MAX_COLLAB_BYTES) {
    return NextResponse.json({ error: `file too large for collaboration mode (max ${MAX_COLLAB_BYTES / 1024} KB)` }, { status: 413 });
  }
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) return NextResponse.json({ error: "binary file" }, { status: 415 });
  return NextResponse.json({ path: rel, content: buf.toString("utf8"), size: stat.size, sha: blobSha(buf) });
}
