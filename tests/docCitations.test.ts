// A comment or a string that cites one of this repo's docs by section NUMBER
// ("docs/DESKTOP_APP.md §6.4", "docs/DESKTOP_APP.md section 8") is invisible to
// every other guard: only real Markdown anchors are build-checked, and a number
// inside a comment or an `echo` survives a docs reorganisation pointing at
// whatever now happens to sit at that number, or at nothing.
//
// The rule here is resolution, not a ban. A doc that numbers its own headings
// (docs/DESKTOP_E2E.md does) can still be cited by number, and this test reads
// the target file to check the number is really there. A doc with unnumbered
// headings can only be cited by heading text.
//
// Only `docs/*.md` targets are checked. A citation of an external spec (RFC
// 8252 §7.3, Apache-2.0 §4(d)) names a document this repo does not own and
// cannot renumber, so it is out of scope by construction: the pattern requires
// a `docs/<name>.md` immediately before the number.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

/**
 * `docs/NAME.md` followed by a section number, with at most a short run of
 * connective text between them (", ", " and ", " → "). The number itself is
 * `§N`, `§N.M`, `section N` or `section N.M`, and a run of them (`§6/§7`,
 * `§6.2, §7`) is matched one at a time by the second pattern below.
 */
const DOC_THEN_NUMBER = /docs\/([A-Za-z0-9_-]+)\.md[^\n]{0,24}?(§\s*\d+(?:\.\d+)*|\bsections?\s+\d+(?:\.\d+)*)/g;

/** Every section number in the tail of a citation, so `§6/§7` reports both. */
const NUMBER = /§\s*(\d+(?:\.\d+)*)|\bsections?\s+(\d+(?:\.\d+)*)/g;

const SCANNED_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".yml", ".yaml", ".md"];
const SCANNED_FILES = new Set([".env.example"]);

/** Not covered: generated, and docs/design/ holds records this guard doesn't pin. */
const EXCLUDED = new Set(["CHANGELOG.md"]);
const EXCLUDED_PREFIXES = ["docs/design/", "node_modules/"];

function isScanned(file: string): boolean {
  if (SCANNED_FILES.has(file)) return true;
  if (EXCLUDED.has(file)) return false;
  if (EXCLUDED_PREFIXES.some((p) => file.startsWith(p))) return false;
  return SCANNED_EXTENSIONS.some((ext) => file.endsWith(ext));
}

/**
 * Tracked files, or `null` when git can't answer: a task worktree's `.git` is a
 * file pointing outside the mount, so `git ls-files` fails under
 * `npm run test:docker` (tests/commentStyle.test.ts documents the same case).
 * CI runs against a real clone, which is the run that gates a merge.
 */
function trackedFiles(): string[] | null {
  let out: Buffer;
  try {
    out = execFileSync("git", ["ls-files", "-z"], {
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
    .filter(isScanned)
    .filter((f) => {
      const abs = path.join(ROOT, f);
      return fs.existsSync(abs) && fs.statSync(abs).isFile();
    });
}

/** The section numbers a doc's own headings carry, e.g. "## 5. The bench VM" -> "5". */
function numberedHeadings(doc: string): Set<string> {
  const abs = path.join(ROOT, doc);
  if (!fs.existsSync(abs)) return new Set();
  const numbers = new Set<string>();
  for (const line of fs.readFileSync(abs, "utf8").split("\n")) {
    const m = /^#{1,6}\s+(\d+(?:\.\d+)*)[.)]?\s/.exec(line);
    if (m) numbers.add(m[1]);
  }
  return numbers;
}

/**
 * Every `docs/<name>.md` citation on one line, paired with the run of section
 * numbers that follows it. The run stops at the first gap, so the `§7` in
 * `docs/X.md §6/§7` belongs to that citation and a later unrelated number
 * does not.
 */
function citationsOn(line: string): { doc: string; numbers: string[] }[] {
  const found: { doc: string; numbers: string[] }[] = [];
  DOC_THEN_NUMBER.lastIndex = 0;
  let citation: RegExpExecArray | null;
  while ((citation = DOC_THEN_NUMBER.exec(line))) {
    const tail = line.slice(citation.index + citation[0].length - citation[2].length);
    const numbers: string[] = [];
    NUMBER.lastIndex = 0;
    let num: RegExpExecArray | null;
    while ((num = NUMBER.exec(tail))) {
      numbers.push(num[1] ?? num[2]);
      if (!/^[\s,/;]*(§|sections?\b)/.test(tail.slice(NUMBER.lastIndex))) break;
    }
    found.push({ doc: `docs/${citation[1]}.md`, numbers });
  }
  return found;
}

interface Hit {
  file: string;
  line: number;
  doc: string;
  number: string;
  text: string;
}

function scan(files: string[]): Hit[] {
  const headings = new Map<string, Set<string>>();
  const hits: Hit[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (!content.includes("docs/")) continue;
    content.split("\n").forEach((line, i) => {
      for (const { doc, numbers } of citationsOn(line)) {
        if (!headings.has(doc)) headings.set(doc, numberedHeadings(doc));
        const known = headings.get(doc)!;
        for (const number of numbers) {
          if (known.has(number)) continue;
          hits.push({ file, line: i + 1, doc, number, text: line.trim().slice(0, 160) });
        }
      }
    });
  }
  return hits;
}

describe("doc citation guard (a cited section number has to exist)", () => {
  it("no comment or string cites a docs/*.md section number the doc does not have", (ctx) => {
    const files = trackedFiles();
    if (!files) return ctx.skip("git ls-files unavailable (worktree .git is outside the mount)");
    const strays = scan(files).map(
      (h) => `${h.file}:${h.line} cites ${h.doc} section ${h.number}, which has no such heading: ${h.text}`
    );
    expect(
      strays,
      strays.length
        ? `Stale doc section citation:\n\n  ${strays.join("\n  ")}\n\n` +
            `Cite the file plus the heading TEXT (docs/DESKTOP_APP.md, "Known limitations"), ` +
            `or a Markdown anchor from a .md file, so a renumbering cannot break it. ` +
            `A number is only allowed when the target doc numbers its own headings.`
        : undefined
    ).toEqual([]);
  });

  it("reads a doc's numbered headings", () => {
    // docs/DESKTOP_E2E.md numbers its sections, so citing one by number resolves.
    const e2e = numberedHeadings("docs/DESKTOP_E2E.md");
    expect(e2e.has("5")).toBe(true);
    // docs/DESKTOP_APP.md does not, so any number cited against it is stale.
    expect(numberedHeadings("docs/DESKTOP_APP.md").size).toBe(0);
  });

  it("catches a stray (sanity, the matcher is not vacuous)", () => {
    const cited = (line: string) => citationsOn(line).flatMap((c) => c.numbers);
    expect(cited("// see docs/DESKTOP_APP.md §6.4 for the rest")).toEqual(["6.4"]);
    expect(cited("# (docs/DESKTOP_APP.md §6/§7) rather than")).toEqual(["6", "7"]);
    expect(cited("// See docs/DESKTOP_APP.md section 8.")).toEqual(["8"]);
    expect(citationsOn("// docs/DESKTOP_E2E.md §5 records the rest")[0].doc).toBe("docs/DESKTOP_E2E.md");
    // A heading-text citation and an anchor are what this guard asks for.
    expect(cited('// docs/DESKTOP_APP.md, "Known limitations".')).toEqual([]);
    expect(cited("[DESKTOP_APP.md](docs/DESKTOP_APP.md#known-limitations)")).toEqual([]);
    // An external spec names a document this repo cannot renumber.
    expect(cited("// The loopback receiver (RFC 8252 §7.3).")).toEqual([]);
    // A cross-doc reference with no number is untouched.
    expect(cited("// See docs/DESKTOP_APP.md.")).toEqual([]);
  });
});
