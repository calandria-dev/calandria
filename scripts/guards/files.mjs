// Shared tracked-file listing for the guard scans (naming, commentStyle, prose)
// and the pre-commit hook that runs them without node_modules or Docker.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Tracked file paths, repo-relative, or `null` when the list can't be
 * produced: a task worktree's `.git` is a FILE pointing outside the mount, so
 * `git ls-files` fails under `npm run test:docker`.
 *
 * When `CALANDRIA_TRACKED_FILES` is set, it names a file holding a
 * NUL-separated list of paths; read that instead of shelling out to git. The
 * pre-commit hook and a Docker run use this to supply the list when git is
 * unavailable in-process.
 */
export function trackedFiles() {
  const listFile = process.env.CALANDRIA_TRACKED_FILES;
  if (listFile) {
    let out;
    try {
      out = fs.readFileSync(listFile);
    } catch {
      return null;
    }
    return out.toString("utf8").split("\0").filter(Boolean);
  }
  let out;
  try {
    out = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      maxBuffer: 32 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  return out.toString("utf8").split("\0").filter(Boolean);
}
