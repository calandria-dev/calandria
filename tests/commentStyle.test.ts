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
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

const EM_DASH = /—/;

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|\{\/\*)/;

const WORK_LOG_PHRASES = [
  /\bdeliberately\b/i,
  /\bthe whole point\b/i,
  /\bload-bearing\b/i,
  /\bis what makes\b/i,
  /\bthis has bitten\b/i,
];

const MEASURED_OPENER = /^\s*(\/\/|\/\*|\*|\{\/\*)\s*Measured\b/;

/**
 * file -> lines that may keep a hit, and why. Start empty: every entry here
 * is a real exception (an error string matched against upstream output, a
 * fixture reproducing upstream text), named in the PR body that adds it.
 */
const ALLOWED: Record<string, RegExp[]> = {};

const DIRS = ["lib/", "app/", "desktop/", "scripts/", "tests/", "e2e/"];
const EXTRA_FILES = new Set(["server.js", "pty-server.js", "middleware.ts", "next.config.mjs"]);
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".css"];

function isTargetFile(file: string): boolean {
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
function trackedFiles(): string[] | null {
  let out: Buffer;
  try {
    out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 32 << 20, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter(isTargetFile)
    .filter((f) => {
      const abs = path.join(ROOT, f);
      return fs.existsSync(abs) && fs.statSync(abs).isFile();
    });
}

function scan(files: string[]) {
  const emDashHits: string[] = [];
  const phraseHits: string[] = [];
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

describe("comment style guard (plain source, no em dashes or work-log phrasing)", () => {
  it("no tracked source file contains an em dash", (ctx) => {
    const files = trackedFiles();
    if (!files) return ctx.skip("git ls-files unavailable (worktree .git is outside the mount)");
    const { emDashHits } = scan(files);
    expect(
      emDashHits,
      emDashHits.length
        ? `Em dash (U+2014) found:\n\n  ${emDashHits.join("\n  ")}\n\nUse a comma, period, or parentheses instead.`
        : undefined
    ).toEqual([]);
  });

  it("no comment reads as a work log instead of an invariant", (ctx) => {
    const files = trackedFiles();
    if (!files) return ctx.skip("git ls-files unavailable (worktree .git is outside the mount)");
    const { phraseHits } = scan(files);
    expect(
      phraseHits,
      phraseHits.length
        ? `Work-log-style comment found:\n\n  ${phraseHits.join("\n  ")}\n\n` +
            `A comment says what the code does and the invariant to keep, not a measurement, ` +
            `a history, or an emphasis word standing in for one.`
        : undefined
    ).toEqual([]);
  });

  it("the allowlist has no dead entries", () => {
    const dead = Object.keys(ALLOWED).filter((file) => !fs.existsSync(path.join(ROOT, file)));
    expect(dead, `ALLOWED entries that no longer match anything: ${dead.join(", ")}`).toEqual([]);
  });

  it("catches a stray (sanity, the matcher is not vacuous)", () => {
    expect(EM_DASH.test("// two paths — pick one")).toBe(true);
    expect(COMMENT_LINE.test("  // this is deliberately left blank")).toBe(true);
    expect(WORK_LOG_PHRASES.some((p) => p.test("// this is deliberately left blank"))).toBe(true);
    expect(MEASURED_OPENER.test("// Measured across 200 runs, this saved 40%")).toBe(true);
    // Ordinary prose about orchestrating work is untouched.
    expect(WORK_LOG_PHRASES.some((p) => p.test("// runs the turn to completion"))).toBe(false);
  });
});
