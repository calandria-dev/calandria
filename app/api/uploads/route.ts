import { NextResponse } from "next/server";
import { draftIdOf, MAX_UPLOAD_BYTES, stageDraftUpload, sweepStaleDrafts } from "@/lib/uploads";
import { MAX_UPLOAD_MB } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Stage an attachment for a task that doesn't exist yet: the New-task dialog
 * uploads on attach, the way the composer does, and hands the returned path
 * to POST /api/tasks as `attachments`, which moves the file into the new
 * task's own dir. Files land under DB_DIR/uploads/_drafts/<draft>/ (see
 * lib/uploads.ts); `draft` groups one dialog's files so its cancel can remove
 * them together, and a draft left behind is swept after a day. Auth:
 * middleware. Same size rule as the per-task route: the declared length is
 * refused before a byte is buffered, then the parsed file is measured.
 */
export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_UPLOAD_BYTES + 4096) return tooLarge();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 });
  }
  const entry = form.get("file");
  if (!entry || typeof entry === "string") return NextResponse.json({ error: "missing file" }, { status: 400 });
  if (entry.size > MAX_UPLOAD_BYTES) return tooLarge();

  sweepStaleDrafts();
  const draft = draftIdOf(form.get("draft"));
  const abs = stageDraftUpload(draft, entry.name || "", entry.type || "", Buffer.from(await entry.arrayBuffer()));
  return NextResponse.json({ ok: true, path: abs, name: entry.name || abs.split(/[\\/]/).pop(), draft });
}

function tooLarge() {
  return NextResponse.json({ error: `Attachment too large (max ${MAX_UPLOAD_MB} MB).` }, { status: 413 });
}
