import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getTask } from "@/lib/store";
import { taskUploadsDir, MAX_UPLOAD_BYTES } from "@/lib/uploads";
import { MAX_UPLOAD_MB } from "@/lib/config";
import { stagedFileName } from "@/lib/uploadTypes";

export const dynamic = "force-dynamic";

/**
 * Attach a file of any type to a task's chat. Saves it under
 * DB_DIR/uploads/<task>/ (outside the worktree, see lib/uploads.ts) and
 * returns both the absolute path (embedded in the message as a marker line, for
 * the agent to open however suits the format) and the serving URL (transcript
 * thumbnail or download chip). The composer uploads eagerly on attach; the file
 * only enters the conversation when the message referencing it is sent.
 *
 * There is no type allowlist. Nothing here reads or interprets the bytes, and
 * the serving route hands anything it doesn't recognize back as an opaque
 * download, so the only bound that matters is the size cap, which is checked
 * twice: on the declared Content-Length before a byte is buffered, and on the
 * parsed file, since Content-Length is the client's word for it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Reject oversized bodies before parsing: formData() throws unhelpfully on
  // huge payloads, and this saves buffering them at all. (+4KB multipart slack.)
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_UPLOAD_BYTES + 4096) return tooLarge();

  let entry: FormDataEntryValue | null;
  try {
    entry = (await req.formData()).get("file");
  } catch {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 });
  }
  // Duck-typed instead of `instanceof File`: a FormData entry is either a
  // string or a file-like, and narrowing on the string is enough. It needs no
  // global either way.
  if (!entry || typeof entry === "string") return NextResponse.json({ error: "missing file" }, { status: 400 });
  const file = entry;
  if (file.size > MAX_UPLOAD_BYTES) return tooLarge();

  const dir = taskUploadsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  // The staged name keeps the user's own basename after a unique prefix: it is
  // what the transcript chip shows, and it is the only clue the agent gets
  // about the format when it reads the path out of the message.
  const name = stagedFileName(nanoid(), file.name || "", file.type || "");
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ ok: true, path: abs, url: `/api/tasks/${id}/uploads/${name}`, name: file.name || name });
}

function tooLarge() {
  return NextResponse.json({ error: `Attachment too large (max ${MAX_UPLOAD_MB} MB).` }, { status: 413 });
}
