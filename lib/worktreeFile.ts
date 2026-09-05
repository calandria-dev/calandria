// The worktree read behind the document collaboration modal
// (GET /api/tasks/[id]/file). Split from lib/collab.ts because that module is
// bundled for the client and this one needs fs.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Files larger than this never open in the modal: a document someone reads
// end to end is kilobytes, and the whole text rides in one POST body.
export const MAX_COLLAB_BYTES = 1024 * 1024;

// Resolve a repo-relative path inside a worktree, refusing anything that
// would read outside it. Rejects absolute paths and `..` segments up front,
// then re-checks the real path, since symlink targets are what `..` filtering
// can't see: `docs/link -> /etc` normalizes clean and still escapes. Returns
// null instead of throwing so the route can answer 400 without parsing errors.
export function resolveWorktreeFile(worktree: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || rel.includes("\0")) return null;
  // Raw segments, before normalize() folds `docs/../docs/x` into `docs/x`: a
  // repo-relative path from the diff never contains `..`, so its presence
  // marks a probe, not a legitimate path.
  if (rel.split(/[\\/]/).some((seg) => seg === "..")) return null;
  const normalized = path.normalize(rel);
  const root = path.resolve(worktree);
  const abs = path.resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return null; // doesn't exist (or unreadable); the route reports 404 either way
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  return real;
}

/**
 * Whether a requested path is malformed on its face (absent, absolute, or
 * carrying a `..` segment), as opposed to merely naming something that isn't
 * there. The route answers 400 for the first and 404 for the second, so that a
 * refusal never leaks which paths exist.
 *
 * Exported so it cannot drift from the rejection rules in
 * `resolveWorktreeFile` above. A route that instead inlines the check as
 * `rel.startsWith("/") || rel.split("/").includes("..")` uses two POSIX-only
 * spellings: on Windows `C:\secret.md` is absolute and `docs\..\..\x` is a
 * traversal, both of which `resolveWorktreeFile` refuses while such a route
 * would report them as an ordinary missing file.
 */
export function malformedWorktreePath(rel: string): boolean {
  return !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((seg) => seg === "..");
}

// git's blob id for a file's bytes: what `git hash-object <file>` prints,
// computed in-process (no subprocess, and it's exact for an uncommitted
// file, which HEAD is not). The file route stamps it on every read and a
// document comment records it as its anchor_sha, so "the document has changed
// since this was written" is a string comparison the client can make against
// whatever it just loaded (tests/collab.test.ts pins it against real git).
export function blobSha(buf: Buffer): string {
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}
