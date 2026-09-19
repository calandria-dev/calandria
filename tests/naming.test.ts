// Pins the residue of the Operator -> Calandria rename. The data table and
// the scan itself live in scripts/guards/naming.mjs, shared with the plain
// `node` CLI a pre-commit hook runs without node_modules; this file only
// asserts. See that module's header comment for the full rationale.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWED, SYSADMIN_NOUN, TERMS, scan, trackedTextFiles } from "../scripts/guards/naming.mjs";
import { ROOT } from "../scripts/guards/files.mjs";

describe("naming guard (Operator -> Calandria)", () => {
  it("every orch/operator reference left in the tree is on the allowlist", (ctx) => {
    const files = trackedTextFiles();
    if (!files) return ctx.skip("git ls-files unavailable (worktree .git is outside the mount)");
    const strays = scan(files);
    expect(
      strays,
      strays.length
        ? `Unallowed orch/operator reference(s):\n\n  ${strays.join("\n  ")}\n\n` +
            `Calandria is not called Operator and has no "orch" anything. Rename it, or, if ` +
            `it is attribution, the ORCH_* alias table, or a pre-rename on-disk/localStorage ` +
            `name, add it to ALLOWED in scripts/guards/naming.mjs with a comment saying which. ` +
            `("operator" the ordinary noun needs no entry, but a line reported here says ` +
            `something else guarded as well, so read the whole line.)`
        : undefined
    ).toEqual([]);
  });

  it("the allowlist has no dead entries", () => {
    // An entry whose file is gone (or no longer matches) is a rename that
    // finished; drop it, so the list keeps meaning what it says.
    const dead = Object.keys(ALLOWED).filter((file) => {
      if (file === "tests/naming.test.ts") return false;
      if (file === "scripts/guards/naming.mjs") return false;
      const abs = path.join(ROOT, file);
      if (!fs.existsSync(abs)) return true;
      // Same strip as the guard: a file left with nothing but the ordinary noun
      // needs no entry, so its entry is dead even though TERMS still fires.
      return !fs.readFileSync(abs, "utf8").split("\n").some((l) => TERMS.test(l.replace(SYSADMIN_NOUN, "")));
    });
    expect(dead, `ALLOWED entries that no longer match anything: ${dead.join(", ")}`).toEqual([]);
  });

  it("catches a stray (sanity check: the matcher is not vacuous)", () => {
    // The exact shape a regression takes: a plain sentence in a live file.
    const line = "// hand it to the orchestrator and let it run";
    expect(TERMS.test(line)).toBe(true);
    expect((ALLOWED["lib/runner.ts"] ?? []).some((p) => p.test(line))).toBe(false);
    // Does not fire on the concept word.
    expect(TERMS.test("// the runner orchestrates every turn")).toBe(false);
  });

  it("passes the ordinary noun anywhere, and only the ordinary noun", () => {
    const clean = (l: string) => TERMS.test(l) && !TERMS.test(l.replace(SYSADMIN_NOUN, ""));
    // (e) in any file, no entry: the sense every self-hosting doc is written in.
    expect(clean(" * The refusal an operator sees. It has to answer \"what do I do now?\"")).toBe(true);
    expect(clean("# An operator-supplied SERVICE_TOKEN always wins.")).toBe(true);
    expect(clean("// two operators, one database")).toBe(true);
    // The brand, which is what the guard is for, capitalized in prose.
    expect(clean("// inherited from Operator, the upstream project")).toBe(false);
    // Lowercase only as the upstream repo slug.
    expect(clean("https://github.com/iishyfishyy/operator-oss")).toBe(false);
    // The noun never launders a second term sharing its line.
    expect(clean("// the operator hands it to the orchestrator")).toBe(false);
    expect(clean("// the operator sets ORCH_PORT")).toBe(false);
  });
});
