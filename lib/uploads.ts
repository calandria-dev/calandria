import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { DB_DIR, MAX_UPLOAD_MB } from "@/lib/config";
import { parseStagedFile, stagedFileName } from "@/lib/uploadTypes";

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

// ---------- task attachments ----------
// A task's description carries the same marker lines a chat message does (see
// lib/uploadTypes.ts), staged in the same per-task dir. The New-task dialog
// has no task id yet when the user drops a file, so it stages into a DRAFT dir
// first; POST /api/tasks adopts the draft's files into the new task's dir and
// writes the final paths into the description. A draft the user abandons is
// removed by the dialog's cancel, and otherwise by the sweep below.

export const DRAFTS_DIR = path.join(UPLOADS_DIR, "_drafts");

/** How long an unadopted draft dir is kept before the sweep removes it. */
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

export function draftUploadsDir(draftId: string): string {
  return path.join(DRAFTS_DIR, draftId);
}

/** A draft id the client minted, or a fresh one. Only the safe charset is honored. */
export function draftIdOf(requested: unknown): string {
  return typeof requested === "string" && SAFE_SEGMENT.test(requested) && requested.length <= 64 ? requested : nanoid();
}

/**
 * Stage bytes into a draft dir under a server-generated name. Returns the
 * absolute path, which is what the dialog hands back to POST /api/tasks.
 */
export function stageDraftUpload(draftId: string, fileName: string, mimeType: string, bytes: Buffer): string {
  const dir = draftUploadsDir(draftId);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, stagedFileName(nanoid(), fileName, mimeType));
  fs.writeFileSync(abs, bytes);
  return abs;
}

/**
 * Parse an absolute path as a staged draft file. Both segments are validated
 * against the server-generated charset, so a path from a request body can
 * never name anything outside DRAFTS_DIR.
 */
export function parseDraftPath(abs: unknown): { draftId: string; file: string; abs: string } | null {
  if (typeof abs !== "string") return null;
  const rel = path.relative(DRAFTS_DIR, abs);
  const parts = rel.split(path.sep);
  if (parts.length !== 2 || !SAFE_SEGMENT.test(parts[0]) || !parseStagedFile(parts[1])) return null;
  return { draftId: parts[0], file: parts[1], abs: path.join(DRAFTS_DIR, parts[0], parts[1]) };
}

/**
 * Move staged draft files into a task's dir and return their final paths, in
 * the order given. Refuses (throws) on any path that isn't a staged draft
 * file that still exists, before moving anything, so a request naming one
 * bad path adopts nothing. The draft dir is removed once it's empty.
 */
export function adoptDraftUploads(taskId: string, paths: readonly unknown[]): string[] {
  const parsed = paths.map((p) => {
    const d = parseDraftPath(p);
    if (!d || !fs.existsSync(d.abs)) throw new Error(`unknown attachment: ${typeof p === "string" ? p : String(p)}`);
    return d;
  });
  const dir = taskUploadsDir(taskId);
  if (parsed.length) fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const d of parsed) {
    const dest = path.join(dir, d.file);
    // Siblings under UPLOADS_DIR, so a rename is atomic and never copies.
    fs.renameSync(d.abs, dest);
    out.push(dest);
  }
  for (const draftId of new Set(parsed.map((d) => d.draftId))) {
    try { fs.rmdirSync(draftUploadsDir(draftId)); } catch { /* not empty: another upload still in flight */ }
  }
  return out;
}

/** Best-effort removal of a whole draft dir (the dialog's cancel). */
export function removeDraftUploads(draftId: string): boolean {
  if (!SAFE_SEGMENT.test(draftId)) return false;
  const dir = draftUploadsDir(draftId);
  try {
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove draft dirs untouched for longer than `maxAgeMs`. Runs on every draft
 * upload, so the dir can't grow past what one day of abandoned dialogs
 * leaves behind; a dialog left open longer than that loses its files, which
 * the create step reports as an unknown attachment. Returns how many went.
 */
export function sweepStaleDrafts(maxAgeMs = DRAFT_MAX_AGE_MS, now = Date.now()): number {
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(DRAFTS_DIR, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(DRAFTS_DIR, e.name);
    try {
      if (now - fs.statSync(dir).mtimeMs > maxAgeMs) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch { /* raced with an adoption or a cancel */ }
  }
  return removed;
}

/**
 * Remove one staged file from a task's dir: the edit dialog dropping an
 * attachment off the description. Only a server-generated name is honored.
 */
export function removeTaskUpload(taskId: string, file: string): boolean {
  if (!SAFE_SEGMENT.test(taskId) || !parseStagedFile(file)) return false;
  try {
    fs.unlinkSync(path.join(taskUploadsDir(taskId), file));
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a copy of `sourceAbs` would be staged in a task's dir: a fresh
 * staged name under the source's own basename. Split from the copy so the
 * agent tools can write the final path into a description they are still
 * validating, and copy only once every other field has passed.
 */
export function plannedTaskUpload(taskId: string, sourceAbs: string): string {
  return path.join(taskUploadsDir(taskId), stagedFileName(nanoid(), path.basename(sourceAbs), ""));
}

/**
 * Copy a file to a path plannedTaskUpload() returned: the agent tools'
 * `attachments`. The caller has already decided the source is one the agent
 * may hand over (lib/agentTools.ts confines it to the session's worktree or
 * its own staged uploads).
 */
export function copyIntoTaskUploads(sourceAbs: string, destAbs: string): void {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(sourceAbs, destAbs);
}
