import fs from "node:fs";
import path from "node:path";
import { DB_DIR, MAX_UPLOAD_MB } from "@/lib/config";

// Chat attachments. Uploaded files live under the DB dir, outside the task's
// git worktree, so a pasted screenshot, a 500 KB log dump or a vendor PDF
// never shows up in the task's diff or gets swept into a merge. The message
// text carries a marker line with the absolute path (see attachmentMarker /
// fileAttachmentMarker in app/shell/format.ts), so the bytes never enter the
// prompt: the agent is told a file is staged at a path and decides for itself
// how to open it, Read for text and images, a shell tool for anything else.
// That also keeps queued/pending messages working as plain text, with no SDK
// content-block plumbing anywhere.
//
// Any file type is accepted. What a file is lives in lib/uploadTypes.ts
// (shared with the client); what it costs is bounded by MAX_UPLOAD_BYTES below.

export const UPLOADS_DIR = path.join(DB_DIR, "uploads");

/** Hard cap on a single attachment, from CALANDRIA_MAX_UPLOAD_MB (default 25 MB). */
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

export function taskUploadsDir(taskId: string): string {
  return path.join(UPLOADS_DIR, taskId);
}

/**
 * Best-effort removal of a task's attachment dir. Fires on task/project hard
 * delete; on the retention sweep (lib/retention.ts) for a finished task whose
 * transcript has aged out, since the marker lines that pointed at these files
 * live in those messages, so the two go together; and on the worktree sweep
 * (lib/worktreeSweep.ts), which reclaims the disk of a long-dead task and has
 * no reason to keep its staged uploads once the checkout they were staged for
 * is gone.
 *
 * Returns whether a directory was actually there to remove, so the sweep can
 * count what it reclaimed instead of reporting every task it considered.
 */
export function removeTaskUploads(taskId: string): boolean {
  const dir = taskUploadsDir(taskId);
  try {
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    // best-effort: orphaned files are harmless
    return false;
  }
}
