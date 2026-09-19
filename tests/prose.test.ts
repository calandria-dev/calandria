// Pins the plain-prose register the docs-cleanup pass rewrote every Markdown
// file into (CLAUDE.md, "Prose and comments are plain technical writing").
// The rule tables and the scan itself live in scripts/guards/prose.mjs,
// shared with the plain `node` CLI a pre-commit hook runs without
// node_modules; this file only asserts. See that module's header comment for
// the full rationale.

import fs from "node:fs";
import {
  ALLOWLIST,
  BANNED_PHRASES,
  EM_DASH,
  reportHits,
  scanMarkdownFile,
  trackedMarkdownFiles,
} from "../scripts/guards/prose.mjs";
import { ROOT } from "../scripts/guards/files.mjs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
            `UI label, add it to ALLOWLIST in scripts/guards/prose.mjs with the file:line it was ` +
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
