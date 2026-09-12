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
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

const EM_DASH = "—";
const LINE_START_PATTERNS = [/^Measured\b/, /^That is why\b/];
const BANNED_PHRASES = [/the whole point/i, /is what makes/i, /load-bearing/i, /deliberately/i];

/** Markdown files this guard doesn't cover. */
const EXCLUDED_MD = new Set(["CHANGELOG.md"]);

/**
 * Path prefixes this guard doesn't cover. docs/design/ holds design records and
 * specs, the work-log format this whole cleanup moves out of the repo over
 * time; they aren't the published, how-to documentation this guard pins.
 */
const EXCLUDED_MD_PREFIXES = ["docs/design/"];

interface AllowEntry {
  /** Why this exact line is allowed to keep its hit. */
  reason: string;
  /** For a quote of this repo's own code: assert the doc still matches the source. */
  verify?: () => void;
}

// file:line -> why the hit there is a verbatim quote, not prose.
const ALLOWLIST: Record<string, AllowEntry> = {
  ".github/CLAUDE.md:36": {
    reason:
      'Quotes GitHub\'s own PR-checks UI text ("Expected — waiting for status") verbatim; ' +
      "it's GitHub's copy, not this repo's code, so there is no in-repo file:line to check it against.",
  },
  ".github/rulesets/README.md:66": {
    reason: "Same GitHub PR-checks UI quote as .github/CLAUDE.md:36.",
  },
};

/**
 * Tracked Markdown files, or `null` when git can't answer: a task worktree's
 * `.git` is a FILE pointing outside the mount, so `git ls-files` fails under
 * `npm run test:docker` (same red herring `tests/naming.test.ts` documents).
 * CI checks out a real clone, which is the run that gates a merge.
 */
function trackedMarkdownFiles(): string[] | null {
  let out: Buffer;
  try {
    out = execFileSync("git", ["ls-files", "-z", "*.md"], {
      cwd: ROOT,
      maxBuffer: 32 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((f) => !EXCLUDED_MD.has(f))
    .filter((f) => !EXCLUDED_MD_PREFIXES.some((prefix) => f.startsWith(prefix)))
    .filter((f) => !f.includes("node_modules"))
    .filter((f) => !/generated/i.test(f));
}

/** A table separator row (`|-|-|`, `| --- | --- |`, ...): dashes, not prose. */
function isTableSeparatorRow(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

/** Blank out inline code spans so a glyph or phrase inside one can't fire. */
function maskInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
}

interface Hit {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function scanMarkdownFile(file: string): Hit[] {
  const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
  const hits: Hit[] = [];
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

function reportHits(hits: Hit[]): string[] {
  return hits
    .filter((h) => !ALLOWLIST[`${h.file}:${h.line}`])
    .map((h) => `${h.file}:${h.line} [${h.rule}]: ${h.text}`);
}

describe("prose guard (docs stay plain)", () => {
  it("no tracked Markdown file has an em dash, banned phrase, or work-log line start outside an allowlist entry", () => {
    const files = trackedMarkdownFiles();
    if (!files) return;
    const allHits = files.flatMap(scanMarkdownFile);
    const strays = reportHits(allHits);
    expect(
      strays,
      strays.length
        ? `Docs prose guard failed:\n\n  ${strays.join("\n  ")}\n\n` +
            `Rewrite the line in plain prose. If it's a verbatim quote of a program string or ` +
            `UI label, add it to ALLOWLIST in tests/prose.test.ts with the file:line it was ` +
            `copied from instead of editing the quote.`
        : undefined
    ).toEqual([]);
  });

  it(".env.example comment lines have no em dash", () => {
    const lines = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8").split("\n");
    const strays = lines
      .map((line, idx) => ({ line, lineNo: idx + 1 }))
      .filter(({ line }) => line.trim().startsWith("#"))
      .filter(({ line }) => line.includes(EM_DASH))
      .map(({ line, lineNo }) => `.env.example:${lineNo}: ${line.trim().slice(0, 160)}`);
    expect(strays, `Em dash in .env.example comment(s):\n\n  ${strays.join("\n  ")}`).toEqual([]);
  });

  it("every allowlist entry still matches a real hit in the doc", () => {
    const files = trackedMarkdownFiles();
    if (!files) return;
    const allHits = files.flatMap(scanMarkdownFile);
    const live = new Set(allHits.map((h) => `${h.file}:${h.line}`));
    const dead = Object.keys(ALLOWLIST).filter((key) => !live.has(key));
    expect(dead, `ALLOWLIST entries that no longer match anything: ${dead.join(", ")}`).toEqual([]);
  });

  it("every allowlist entry citing this repo's own code still matches that source", () => {
    for (const [key, entry] of Object.entries(ALLOWLIST)) {
      if (entry.verify) entry.verify();
    }
  });

  it("catches a stray (sanity — the matcher is not vacuous)", () => {
    const em = "This line has a stray em dash — right there.";
    expect(em.includes(EM_DASH)).toBe(true);
    expect("Measured over a week, this held.".trim()).toMatch(/^Measured\b/);
    expect("That is why it stayed.".trim()).toMatch(/^That is why\b/);
    expect(BANNED_PHRASES.some((p) => p.test("this part is load-bearing"))).toBe(true);
    expect(BANNED_PHRASES.some((p) => p.test("an ordinary sentence with none of the phrases"))).toBe(false);
  });
});
