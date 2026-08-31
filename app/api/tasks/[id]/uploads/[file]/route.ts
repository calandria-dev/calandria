import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { taskUploadsDir } from "@/lib/uploads";
import { parseStagedFile, servedType } from "@/lib/uploadTypes";

export const dynamic = "force-dynamic";

// Server-generated names only — this is the traversal guard, so both segments
// are validated before touching the fs. parseStagedFile() owns the filename
// half (see lib/uploadTypes.ts: a staged name can hold exactly one dot, so
// there is no `..` to hunt for).
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Serve an uploaded chat attachment. Auth: middleware.
 *
 * Uploads accept any file type, so this route decides what a browser is allowed
 * to do with one: images get their real type, known text formats are previewed
 * as text/plain, and everything else is an opaque download. Nothing is ever
 * served as active content — `nosniff` on every response means even an `.html`
 * or `.svg` attachment renders as source rather than executing on this origin.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  const staged = parseStagedFile(file);
  if (!SAFE_SEGMENT.test(id) || !staged) return NextResponse.json({ error: "not found" }, { status: 404 });
  const abs = path.join(taskUploadsDir(id), file);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const { contentType, download } = servedType(staged.ext);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      // Filenames are unique and never rewritten — cache hard.
      "Cache-Control": "private, max-age=31536000, immutable",
      ...(download ? { "Content-Disposition": `attachment; filename="${file}"` } : {}),
    },
  });
}
