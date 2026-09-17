import fs from "node:fs";
import { NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import { hasTurn } from "@/lib/abort";
import { locateWorktreeFile, blobSha, MAX_COLLAB_BYTES } from "@/lib/worktreeFile";

export const dynamic = "force-dynamic";

// Resolve the request's repo-relative path inside the task's worktree, or the
// error response to send instead. Shared by GET and POST so the two can never
// disagree about which paths are reachable; the path rules themselves live in
// locateWorktreeFile, shared with the raw route.
function locate(taskId: string, rel: string): { abs: string } | NextResponse {
  const task = getTask(taskId);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const hit = locateWorktreeFile(task.worktree_path, rel, MAX_COLLAB_BYTES);
  if (!hit.ok) {
    const error = hit.status === 413 ? `file too large for collaboration mode (max ${MAX_COLLAB_BYTES / 1024} KB)` : hit.error;
    return NextResponse.json({ error }, { status: hit.status });
  }
  return { abs: hit.abs };
}

// Read one text file out of a task's worktree, for the document collaboration
// modal (the diff only carries hunks; the modal renders the whole document).
// The path is repo-relative and confined to the worktree by
// resolveWorktreeFile, symlinks included. Size-capped and text-only: the
// whole content rides back in the collaboration POST, and a binary would
// never render as a document anyway. `sha` is the content's git blob id, the
// anchor a document comment is stamped with (see TaskDocComment).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rel = new URL(req.url).searchParams.get("path") ?? "";
  const hit = locate(id, rel);
  if (hit instanceof NextResponse) return hit;
  const buf = fs.readFileSync(hit.abs);
  if (buf.subarray(0, 8192).includes(0)) return NextResponse.json({ error: "binary file" }, { status: 415 });
  return NextResponse.json({ path: rel, content: buf.toString("utf8"), size: buf.length, sha: blobSha(buf) });
}

// Write the modal's edited text straight into the worktree: the "direct"
// edit mode, GET's twin. Same path guard; the file must already exist (the
// modal only opens files the diff lists, and creating files is the agent's
// job). Two refusals, both 409, both about the worktree having another
// writer: a running turn (the agent may be mid-edit on this file, and a
// write under it could clobber the write or be clobbered by it), and a file
// that no longer matches the `original` the modal loaded (the agent's last
// turn or a terminal wrote it since, so the user's edits were made against
// text that is no longer there). The stale check is a byte comparison, not
// a hash: the modal already holds the whole original, and the cap keeps it
// small. The current text rides back on that refusal so the client can show
// what happened instead of guessing.
//
// hasTurn() and the write share one synchronous block after the body has
// been parsed, so a turn can't start between the check and the write.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { path?: unknown; original?: unknown; content?: unknown } | null;
  if (!body || typeof body.path !== "string" || typeof body.original !== "string" || typeof body.content !== "string") {
    return NextResponse.json({ error: "path, original and content are required" }, { status: 400 });
  }
  if (Buffer.byteLength(body.content, "utf8") > MAX_COLLAB_BYTES) {
    return NextResponse.json({ error: `content too large (max ${MAX_COLLAB_BYTES / 1024} KB)` }, { status: 413 });
  }
  const hit = locate(id, body.path);
  if (hit instanceof NextResponse) return hit;
  if (hasTurn(id)) {
    return NextResponse.json({ error: "a turn is running. The agent owns the worktree until it finishes; send your edits as a patch instead" }, { status: 409 });
  }
  const current = fs.readFileSync(hit.abs, "utf8");
  if (current !== body.original) {
    return NextResponse.json({ error: "file changed since it was loaded", current }, { status: 409 });
  }
  fs.writeFileSync(hit.abs, body.content, "utf8");
  return NextResponse.json({ path: body.path, size: Buffer.byteLength(body.content, "utf8") });
}
