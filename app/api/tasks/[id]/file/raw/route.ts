import fs from "node:fs";
import { NextResponse } from "next/server";
import { getTask } from "@/lib/store";
import { locateWorktreeFile, MAX_RAW_FILE_BYTES } from "@/lib/worktreeFile";
import { servedType } from "@/lib/uploadTypes";
import { extensionOf } from "@/lib/localLink";

export const dynamic = "force-dynamic";

/**
 * Serve a worktree file's bytes to the browser. Auth: middleware.
 *
 * The collaboration file route is JSON and text-only; this is what a
 * transcript link to an image or an archive opens in a new tab. The path is
 * repo-relative and confined to the worktree by the same locator, and the
 * browser is told what it may do with the bytes the way the uploads route
 * decides for attachments: images get their real type, known text formats are
 * previewed as text/plain, everything else is an opaque download. `nosniff` on
 * every response keeps an `.html` or `.svg` in the checkout from executing on
 * this origin. Never cached: the file changes under the agent.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rel = new URL(req.url).searchParams.get("path") ?? "";
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const hit = locateWorktreeFile(task.worktree_path, rel, MAX_RAW_FILE_BYTES);
  if (!hit.ok) return NextResponse.json({ error: hit.error }, { status: hit.status });
  let buf: Buffer;
  try {
    buf = fs.readFileSync(hit.abs);
  } catch {
    return NextResponse.json({ error: "file not found" }, { status: 404 });
  }
  const { contentType, download } = servedType(extensionOf(rel));
  const name = (rel.split("/").pop() ?? "file").replace(/[^A-Za-z0-9._-]+/g, "_");
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      ...(download ? { "Content-Disposition": `attachment; filename="${name}"` } : {}),
    },
  });
}
