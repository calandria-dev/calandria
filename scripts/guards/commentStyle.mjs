// Pins the result of the comment-style cleanup (CLAUDE.md, "code-deslop" tag):
// no em dash anywhere in tracked source, and no comment written as a work log
// ("deliberately", "the whole point", dated "Measured" notes, and similar) in
// place of stating the invariant a maintainer has to keep.
//
// A simple line rule, not a parser: a line is a "comment line" if it starts
// with `//`, `/*`, `*` or `{/*` after optional whitespace. A false positive
// inside a string literal is acceptable as long as it names a real hit; the
// em-dash check applies to every line regardless, since a user-visible string
// with an em dash is a UI copy problem too.
//
// Markdown is out of scope: tests/prose.test.ts (integration/docs-cleanup)
// covers docs, and the two guards must not overlap so the branches don't
// conflict on the same file.

import fs from "node:fs";
import path from "node:path";
import { ROOT, trackedFiles as gitTrackedFiles } from "./files.mjs";

export const EM_DASH = /—/;

export const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|\{\/\*)/;

export const WORK_LOG_PHRASES = [
  /\bdeliberately\b/i,
  /\bthe whole point\b/i,
  /\bload-bearing\b/i,
  /\bis what makes\b/i,
  /\bthis has bitten\b/i,
];

export const MEASURED_OPENER = /^\s*(\/\/|\/\*|\*|\{\/\*)\s*Measured\b/;

/**
 * file -> lines that may keep a hit, and why. Every entry here is a real
 * exception, named in the PR body that adds it.
 */
export const ALLOWED = {
  // This guard has to spell out and demonstrate everything it forbids: the
  // em-dash regex literal, the banned-phrase list, and the sanity-check
  // examples all necessarily contain the exact patterns being guarded
  // against. Same precedent as tests/naming.test.ts's own entry below.
  "tests/commentStyle.test.ts": [/./],
  // tests/prose.test.ts is the same guard for Markdown, and needs the same
  // self-exemption for the same reason: its own literals and examples
  // necessarily contain the patterns it guards against.
  "tests/prose.test.ts": [/./],
  // The rule tables this guard and the prose guard scan against now live
  // here, in files this same guard covers (scripts/ is in DIRS below), and
  // the em-dash regex literal necessarily contains the glyph it guards.
  "scripts/guards/commentStyle.mjs": [/./],
  "scripts/guards/prose.mjs": [/./],
};

export const DIRS = ["lib/", "app/", "desktop/", "scripts/", "tests/", "e2e/"];
export const EXTRA_FILES = new Set(["server.js", "pty-server.js", "middleware.ts", "next.config.mjs"]);
export const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".css"];

export function isTargetFile(file) {
  if (EXTRA_FILES.has(file)) return true;
  if (!DIRS.some((d) => file.startsWith(d))) return false;
  return EXTENSIONS.some((ext) => file.endsWith(ext));
}

/**
 * Tracked text files under the covered directories. `null` when git can't
 * answer: a task worktree's `.git` is a file pointing outside the mount, so
 * `git ls-files` fails under `npm run test:docker` (tests/naming.test.ts hits
 * the same case). CI runs against a real clone, which is the run that gates a
 * merge, so the guard skips rather than walking the filesystem by hand.
 */
export function trackedTargetFiles() {
  const files = gitTrackedFiles();
  if (!files) return null;
  return files
    .filter(isTargetFile)
    .filter((f) => {
      const abs = path.join(ROOT, f);
      return fs.existsSync(abs) && fs.statSync(abs).isFile();
    });
}

export function scan(files) {
  const emDashHits = [];
  const phraseHits = [];
  for (const file of files) {
    const allowed = ALLOWED[file] ?? [];
    const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (allowed.some((p) => p.test(line))) return;
      const at = `${file}:${i + 1}: ${line.trim().slice(0, 160)}`;
      if (EM_DASH.test(line)) emDashHits.push(at);
      if (COMMENT_LINE.test(line) && (WORK_LOG_PHRASES.some((p) => p.test(line)) || MEASURED_OPENER.test(line))) {
        phraseHits.push(at);
      }
    });
  }
  return { emDashHits, phraseHits };
}
