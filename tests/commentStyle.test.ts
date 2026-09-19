// Pins the result of the comment-style cleanup (CLAUDE.md, "code-deslop" tag).
// The rule tables and the scan itself live in scripts/guards/commentStyle.mjs,
// shared with the plain `node` CLI a pre-commit hook runs without
// node_modules; this file only asserts. See that module's header comment for
// the full rationale.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  COMMENT_LINE,
  EM_DASH,
  MEASURED_OPENER,
  WORK_LOG_PHRASES,
  scan,
  trackedTargetFiles,
} from "../scripts/guards/commentStyle.mjs";
import { ROOT } from "../scripts/guards/files.mjs";

describe("comment style guard (plain source, no em dashes or work-log phrasing)", () => {
  it("no tracked source file contains an em dash", (ctx) => {
    const files = trackedTargetFiles();
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
    const files = trackedTargetFiles();
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
