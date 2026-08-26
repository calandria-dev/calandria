// Pins the residue of the Operator -> Calandria rename.
//
// The fork changed its name, and the cutover touched env vars, storage paths,
// the MCP server, git artifacts, UI copy, internal identifiers and docs. What
// makes a rename stick is not the sweep — it's stopping the next one from
// growing back. So: walk every tracked text file, find every `orch`,
// `orchestrator`, `operator` and `ORCH_`, and fail unless the file has an
// explicit entry below saying which spellings it is allowed to keep and why.
//
// A hit is legitimate for exactly five reasons:
//
//   (a) attribution — the Apache NOTICE and README's "Name and lineage" credit
//       the upstream project, and must keep naming it;
//   (b) the deprecated `ORCH_*` -> `CALANDRIA_*` alias table (lib/env.mjs and
//       everything documenting or testing it) — a compatibility surface;
//   (c) on-disk and on-wire names minted before the rename that are read on
//       miss and never rewritten: `~/.zen-orchestrator/orchestrator.db`,
//       `~/.agent-orchestrator/worktrees`, `orch/<id>` branches, `orch-u-*`
//       volumes, `/home/orch`, legacy localStorage keys;
//   (d) frozen history — docs/superpowers/ specs+plans, docs/design/ handoff,
//       and the release-please CHANGELOG, all of which record what was true
//       when written;
//   (e) "operator" the ordinary noun — the person running this instance. The
//       brand is always capitalized, so the patterns below are case-SENSITIVE
//       where that distinction carries weight: /\boperators?\b/ allows the
//       sysadmin sense and still fails a stray "Operator".
//
// The concept words "orchestration" / "orchestrates" are not matched at all
// (\borchestrator\b doesn't fire inside "orchestration"), so ordinary prose
// about orchestrating agents needs no entry.
//
// To extend: add the file with the narrowest pattern that covers the line, and
// a comment saying which of (a)-(e) it is. If it isn't one of them, the rename
// missed a spot — fix the spot instead.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

/** The guarded spellings. Case-insensitive, so "Orch"/"Operator" hit too. */
const TERMS = /\b(orch|orchestrators?|operators?)\b|ORCH_/i;

// Shared patterns, so the reasoning lives in one place:

/** (e) "the operator" = whoever runs this instance. Lowercase only — a
 *  capitalized "Operator" is the upstream product and stays guarded. */
const SYSADMIN = /\boperators?\b/;

/** (b) the deprecated env prefix and any prose about it. */
const LEGACY_ENV = /ORCH_/;

/** (c) the pre-rename storage names, still read where they already exist. */
const LEGACY_STORAGE = /\.zen-orchestrator|\.agent-orchestrator|orchestrator\.(db|lock)/;

// Whole directories of frozen history — (d). Everything under these paths
// predates the rename and is a record, not a live reference.
const FROZEN_DIRS = [
  "docs/superpowers/", // shipped specs + plans, dated in their filenames
  "docs/design/", //      the visual-identity handoff that COMMISSIONED the new name
];

// file -> the spellings it may keep, and why.
const ALLOWED: Record<string, RegExp[]> = {
  // (a) attribution — the fork's obligations under Apache-2.0 §4(d) and the
  // README section that credits upstream by name.
  NOTICE: [/Operator/, /operator-oss/],
  "README.md": [/Operator/, /operator-oss/],

  // (b) the alias table itself, plus everything that documents or tests it.
  "lib/env.mjs": [LEGACY_ENV],
  "tests/env.test.ts": [LEGACY_ENV],
  "tests/setup.ts": [LEGACY_ENV], //        clears stale ORCH_* out of a developer's shell
  "tests/importGraph.test.ts": [LEGACY_ENV], // one comment naming lib/env.mjs's job
  "lib/resolveHostname.js": [LEGACY_ENV], // hand-rolls the alias (plain-Node, can't import .mjs freely)
  "desktop/supervisor.js": [LEGACY_ENV], // ditto, for the desktop wrapper
  "docs/SELF_HOSTING.md": [LEGACY_ENV, LEGACY_STORAGE, /orch-u-|-p orch-|\/home\/orch\b/],
  "docs/SERVICES.md": [/ORCH_PUBLIC_HOST/], // injected into services forever; not deprecated
  "lib/services.ts": [/ORCH_PUBLIC_HOST/], // the injection site
  "e2e/README.md": [/ORCH_TEST_|orch-test/], //      the pre-rename volume/image names, named so they can be deleted
  "scripts/docker-test.sh": [/ORCH_TEST_|orch-test/], // same

  // (b)+(c) the container surface: ORCH_* compose interpolation kept working,
  // and the volume/network/home names deliberately did NOT change (renaming a
  // named volume orphans its data; /home/orch is baked into DB rows).
  "docker-compose.yml": [LEGACY_ENV, /orch-u-/, /\/home\/orch\b/],
  Dockerfile: [LEGACY_ENV, /\/home\/orch\b/, SYSADMIN],
  "docker/entrypoint.sh": [LEGACY_ENV, LEGACY_STORAGE, SYSADMIN],
  "examples/overlay/compose.yaml": [/orch-u-/],

  // (c) storage: the old locations are read where they already hold data and
  // are never moved, so the names survive in the resolver, its callers and docs.
  "lib/storage.mjs": [LEGACY_STORAGE, LEGACY_ENV, SYSADMIN, /"orchestrator" : "calandria"/],
  "lib/db.ts": [LEGACY_STORAGE],
  "lib/db-lock.mjs": [LEGACY_STORAGE],
  "lib/config.ts": [LEGACY_STORAGE],
  "tests/storageDefaults.test.ts": [LEGACY_STORAGE, SYSADMIN],
  ".gitignore": [/orchestrator\.db/], //   a pre-rename db sitting in the repo root
  ".env.example": [LEGACY_ENV, LEGACY_STORAGE],
  "docs/ARCHITECTURE.md": [LEGACY_STORAGE],
  "docs/TROUBLESHOOTING.md": [LEGACY_STORAGE],
  "CLAUDE.md": [LEGACY_STORAGE],

  // (c) git artifacts minted before the rename. A branch name is written into
  // the repo once and lives there forever; the merge-abort ref likewise.
  "lib/git.ts": [/refs\/worktree\/orch-merge-abort/],
  "tests/legacyBranchPrefix.test.ts": [/orch\\?\/|orch-merge-abort/],

  // (c) localStorage keys minted before the rename, read once on miss so a
  // returning browser keeps its collapse/dismiss/draft state.
  "app/TaskChanges.tsx": [/"orch:diffViewMode"/],
  "app/shell/AgentConnect.tsx": [/"orch_agent_nudge_dismissed"/],
  "app/shell/Composer.tsx": [/orch:draft:/],
  "app/shell/GroupChips.tsx": [/orch_group_filter_/],
  "app/shell/TasksColumn.tsx": [/orch_(done|cancelled)_collapsed_/],
  "app/shell/Welcome.tsx": [/"orch:welcomeCoach:dismissed"/],
  "app/shell/persist.ts": [/orchestrator-era/], // the comment explaining the pair above

  // (d) generated release notes: the subjects are quoted from commits that
  // really did say "orchestrator task", and release-please rewrites this file.
  "CHANGELOG.md": [/\(orchestrator task [\w-]+\)/, /ORCH_GH_BIN/],

  // (e) the ordinary noun.
  "app/api/instance/usage/route.ts": [SYSADMIN],
  "lib/agents/claude/capabilities.ts": [SYSADMIN],
  "lib/agents/claude/driver.ts": [SYSADMIN],
  "lib/auth/local-origin.mjs": [SYSADMIN],
  "tests/localOrigin.test.ts": [SYSADMIN],
  "server.js": [SYSADMIN, LEGACY_ENV, LEGACY_STORAGE],

  // This guard, which has to spell out everything it forbids…
  "tests/naming.test.ts": [/./],
  // …and the contributor-facing note pointing at it (CONTRIBUTING.md, "Ground rules"),
  // which quotes the guarded words in backticks.
  "CONTRIBUTING.md": [/`orch|`orchestrator|`operator|`ORCH_/],
};

/**
 * Tracked, non-binary text files — the surface this guard covers.
 *
 * `null` when git can't answer: a task worktree's `.git` is a FILE pointing
 * outside the mount, so `git ls-files` fails under `npm run test:docker`
 * (e2e/README.md documents the same red herring). CI checks out a real clone,
 * which is the run that gates a merge, so the guard skips rather than walking
 * the filesystem and grepping a developer's untracked scratch files.
 */
function trackedTextFiles(): string[] | null {
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
    .filter((f) => f !== "package-lock.json") // a lockfile is generated, and huge
    .filter((f) => {
      const abs = path.join(ROOT, f);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
      // Binaries (fonts, images, the .ico) have no naming to guard.
      return !fs.readFileSync(abs).includes(0);
    });
}

describe("naming guard (Operator -> Calandria)", () => {
  it("every orch/operator reference left in the tree is on the allowlist", (ctx) => {
    const files = trackedTextFiles();
    if (!files) return ctx.skip("git ls-files unavailable (worktree .git is outside the mount)");
    const strays: string[] = [];
    for (const file of files) {
      if (FROZEN_DIRS.some((d) => file.startsWith(d))) continue;
      const allowed = ALLOWED[file] ?? [];
      const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!TERMS.test(line)) return;
        if (allowed.some((p) => p.test(line))) return;
        strays.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    expect(
      strays,
      strays.length
        ? `Unallowed orch/operator reference(s):\n\n  ${strays.join("\n  ")}\n\n` +
            `Calandria is not called Operator and has no "orch" anything. Rename it — or, if ` +
            `it is attribution, the ORCH_* alias table, a pre-rename on-disk/localStorage name, ` +
            `or "operator" the ordinary noun, add it to ALLOWED in tests/naming.test.ts with a ` +
            `comment saying which.`
        : undefined
    ).toEqual([]);
  });

  it("the allowlist has no dead entries", () => {
    // An entry whose file is gone (or no longer matches) is a rename that
    // finished — drop it, so the list keeps meaning what it says.
    const dead = Object.keys(ALLOWED).filter((file) => {
      if (file === "tests/naming.test.ts") return false;
      const abs = path.join(ROOT, file);
      if (!fs.existsSync(abs)) return true;
      return !fs.readFileSync(abs, "utf8").split("\n").some((l) => TERMS.test(l));
    });
    expect(dead, `ALLOWED entries that no longer match anything: ${dead.join(", ")}`).toEqual([]);
  });

  it("catches a stray (sanity — the matcher is not vacuous)", () => {
    // The exact shape a regression takes: a plain sentence in a live file.
    const line = "// hand it to the orchestrator and let it run";
    expect(TERMS.test(line)).toBe(true);
    expect((ALLOWED["lib/runner.ts"] ?? []).some((p) => p.test(line))).toBe(false);
    // …and does not fire on the concept word.
    expect(TERMS.test("// the runner orchestrates every turn")).toBe(false);
  });
});
