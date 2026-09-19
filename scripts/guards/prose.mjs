// Pins the plain-prose register the docs-cleanup pass rewrote every Markdown
// file into (CLAUDE.md, "Prose and comments are plain technical writing"), so
// the next PR can't grow the LLM-generated register back one file at a time.
//
// Four things fail this guard:
//
//   - an em dash (U+2014) outside a fenced code block or inline code span
//   - a line beginning "Measured" or "That is why"
//   - "the whole point", "is what makes", "load-bearing", "deliberately"
//     (anywhere in the line, case-insensitive)
//   - (a separate, narrower check) an em dash in a `.env.example` comment line
//
// "rather than" and "instead of" are not banned: they have ordinary,
// non-slop uses, and banning them produced worse rewrites than leaving them.
//
// A hit is legitimate for exactly one reason: it is a verbatim quote of a
// program string or an external UI label, not prose the author chose. That
// case goes on ALLOWLIST below with the file:line it was copied from (or a
// note that no in-repo file:line exists, for a third-party string) — never
// resolved by editing or paraphrasing the quote, which would silently corrupt
// the doc into describing a message nothing actually emits. Anything else
// reported here is prose, and gets rewritten.

import fs from "node:fs";
import path from "node:path";
import { ROOT, trackedFiles as gitTrackedFiles } from "./files.mjs";

export const EM_DASH = "—";
export const LINE_START_PATTERNS = [/^Measured\b/, /^That is why\b/];
export const BANNED_PHRASES = [/the whole point/i, /is what makes/i, /load-bearing/i, /deliberately/i];

/** Markdown files this guard doesn't cover. */
export const EXCLUDED_MD = new Set(["CHANGELOG.md"]);

/**
 * Path prefixes this guard doesn't cover. docs/design/ holds design records and
 * specs, the work-log format this whole cleanup moves out of the repo over
 * time; they aren't the published, how-to documentation this guard pins.
 */
export const EXCLUDED_MD_PREFIXES = ["docs/design/"];

// file:line -> why the hit there is a verbatim quote, not prose.
export const ALLOWLIST = {
  ".github/CLAUDE.md:36": {
    reason:
      'Quotes GitHub\'s own PR-checks UI text ("Expected — waiting for status") verbatim; ' +
      "it's GitHub's copy, not this repo's code, so there is no in-repo file:line to check it against.",
  },
};

/**
 * Tracked Markdown files, or `null` when git can't answer: a task worktree's
 * `.git` is a FILE pointing outside the mount, so `git ls-files` fails under
 * `npm run test:docker` (same red herring `tests/naming.test.ts` documents).
 * CI checks out a real clone, which is the run that gates a merge.
 */
export function trackedMarkdownFiles() {
  const files = gitTrackedFiles();
  if (!files) return null;
  return files
    .filter((f) => f.endsWith(".md"))
    .filter((f) => !EXCLUDED_MD.has(f))
    .filter((f) => !EXCLUDED_MD_PREFIXES.some((prefix) => f.startsWith(prefix)))
    .filter((f) => !f.includes("node_modules"))
    .filter((f) => !/generated/i.test(f));
}

/** A table separator row (`|-|-|`, `| --- | --- |`, ...): dashes, not prose. */
export function isTableSeparatorRow(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

/** Blank out inline code spans so a glyph or phrase inside one can't fire. */
export function maskInlineCode(line) {
  return line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
}

export function scanMarkdownFile(file) {
  const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
  const hits = [];
  let inFence = false;
  let inFrontMatter = false;
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    if (lineNo === 1 && rawLine.trim() === "---") {
      inFrontMatter = true;
      return;
    }
    if (inFrontMatter) {
      if (rawLine.trim() === "---") inFrontMatter = false;
      return;
    }
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (isTableSeparatorRow(rawLine)) return;

    const masked = maskInlineCode(rawLine);
    const text = rawLine.trim().slice(0, 160);

    if (masked.includes(EM_DASH)) {
      hits.push({ file, line: lineNo, rule: "em dash", text });
    }
    const trimmed = rawLine.trim();
    if (LINE_START_PATTERNS.some((p) => p.test(trimmed))) {
      hits.push({ file, line: lineNo, rule: "work-log line start", text });
    }
    for (const phrase of BANNED_PHRASES) {
      if (phrase.test(masked)) {
        hits.push({ file, line: lineNo, rule: `phrase: ${phrase.source}`, text });
      }
    }
  });
  return hits;
}

export function reportHits(hits) {
  return hits
    .filter((h) => !ALLOWLIST[`${h.file}:${h.line}`])
    .map((h) => `${h.file}:${h.line} [${h.rule}]: ${h.text}`);
}
