// The worktree read behind the document collaboration modal
// (GET /api/tasks/[id]/file). Split from lib/collab.ts because that module is
// bundled for the client and this one needs fs.

import fs from "node:fs";
import path from "node:path";

// Files larger than this never open in the modal — a document someone reads
// end to end is kilobytes, and the whole text rides in one POST body.
export const MAX_COLLAB_BYTES = 1024 * 1024;

// Resolve a repo-relative path inside a worktree, refusing anything that
// would read outside it. Rejects absolute paths and `..` segments up front,
// then re-checks the REAL path (symlink targets are what `..` filtering can't
// see: `docs/link -> /etc` normalizes clean and still escapes). Returns null
// rather than throwing so the route can answer 400 without parsing errors.
export function resolveWorktreeFile(worktree: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || rel.includes("\0")) return null;
  // Raw segments, before normalize() folds `docs/../docs/x` into `docs/x`: a
  // repo-relative path from the diff never contains `..`, so its presence is
  // a probe, not a spelling.
  if (rel.split(/[\\/]/).some((seg) => seg === "..")) return null;
  const normalized = path.normalize(rel);
  const root = path.resolve(worktree);
  const abs = path.resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return null; // doesn't exist (or unreadable) — the route reports 404 either way
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
