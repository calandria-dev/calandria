// Pins the residue of the Operator -> Calandria rename.
//
// The fork changed its name, and the cutover touched env vars, storage paths,
// the MCP server, git artifacts, UI copy, internal identifiers and docs. What
// makes a rename stick is stopping the next stray spelling from growing back,
// not just sweeping the current ones. So: walk every tracked text file, find
// every `orch`, `orchestrator`, `operator` and `ORCH_`, and fail unless the
// file has an explicit entry below saying which spellings it is allowed to
// keep and why.
//
// A hit is legitimate for exactly five reasons:
//
//   (a) attribution: the Apache NOTICE and README's "Name and lineage" credit
//       the upstream project, and must keep naming it;
//   (b) the deprecated `ORCH_*` -> `CALANDRIA_*` alias table (lib/env.mjs and
//       everything documenting or testing it), a compatibility surface;
//   (c) on-disk and on-wire names minted before the rename that are read on
//       miss and never rewritten: `~/.zen-orchestrator/orchestrator.db`,
//       `~/.agent-orchestrator/worktrees`, `orch/<id>` branches, `orch-u-*`
//       volumes, `/home/orch`, legacy localStorage keys;
//   (d) frozen history: docs/superpowers/ specs+plans, docs/design/ handoff,
//       and the release-please CHANGELOG, all of which record what was true
//       when written;
//   (e) "operator" the ordinary noun, the person running this instance. This
//       one is not a per-file entry: it is decided from the spelling, because
//       the brand is always capitalized and the noun is the word every doc,
//       refusal message and comment addressed to a self-hoster reaches for. A
//       list that grows an entry per commit does not scale, since ordinary
//       prose about the person running the instance can arrive in any file
//       and each entry then covers the whole file for the rest of its life.
//       See SYSADMIN_NOUN below for the rule and the one lowercase spelling
//       that is the product after all.
//
// The concept words "orchestration" / "orchestrates" are not matched at all
// (\borchestrator\b doesn't fire inside "orchestration"), so ordinary prose
// about orchestrating agents needs no entry.
//
// To extend: add the file with the narrowest pattern that covers the line, and
// a comment saying which of (a)-(e) it is. If it isn't one of them, the rename
// missed a spot; fix the spot instead.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

/** The guarded spellings. Case-insensitive, so "Orch"/"Operator" hit too. */
const TERMS = /\b(orch|orchestrators?|operators?)\b|ORCH_/i;

// Shared patterns, so the reasoning lives in one place:

/**
 * (e) "the operator" = whoever runs this instance. Applied to every file, by
 * deleting the noun from the line and re-running TERMS over what is left, so a
 * line that also says "orchestrator" still fails. A per-file allowlist entry
 * could never do that, since an entry covers the whole line.
 *
 * Lowercase only: a capitalized "Operator" is the upstream product and stays
 * guarded, which is the distinction that makes the rule safe at all. The one
 * lowercase spelling that is the product is the upstream repo slug, so it is
 * excluded and stays on NOTICE's and README's attribution entries.
 *
 * Kept as a strip instead of tightened further (no lookaround on the trailing
 * side): "an operator-supplied SERVICE_TOKEN" is the noun too, and a rule that
 * failed hyphenated compounds would just re-grow the allowlist it replaces.
 * Residual risk: a bare lowercase "operator" meaning the upstream product in
 * running prose passes. In a document that names the fork's lineage the brand
 * is capitalized, and that document is NOTICE or README, where the entry
 * already exists.
 */
const SYSADMIN_NOUN = /\boperators?\b(?!-oss)/g;

/** (b) the deprecated env prefix and any prose about it. */
const LEGACY_ENV = /ORCH_/;

/** (c) the pre-rename storage names, still read where they already exist. */
const LEGACY_STORAGE = /\.zen-orchestrator|\.agent-orchestrator|orchestrator\.(db|lock)/;

// Whole directories of frozen history, (d). Everything under these paths
// predates the rename and is a record, not a live reference.
const FROZEN_DIRS = [
  "docs/superpowers/", // shipped specs + plans, dated in their filenames
  "docs/design/", //      the visual-identity handoff that commissioned the new name
  // (d) too: release-please writes it from commit messages, and the release
  // that performed the rename necessarily names everything it renamed: the
  // 0.3.0 breaking-change note lists ORCH_*, orch/<id>, /home/orch and the
  // old MCP server by name. A generated record of what each release said,
  // never a live reference; the lineage preamble at its top is (a).
  "CHANGELOG.md",
];

// file -> the spellings it may keep, and why.
const ALLOWED: Record<string, RegExp[]> = {
  // (a) attribution: the fork's obligations under Apache-2.0 §4(d) and the
  // README section that credits upstream by name.
  NOTICE: [/Operator/, /operator-oss/],
  "README.md": [/Operator/, /operator-oss/],

  // (b) the alias table itself, plus everything that documents or tests it.
  "lib/env.mjs": [LEGACY_ENV],
  "tests/env.test.ts": [LEGACY_ENV],
  // The shared log emitter and its test, which document why CALANDRIA_LOG_FORMAT
  // is read straight off process.env: a knob born AFTER the rename has no old
  // spelling to honor, and routing it through the table would mint a deprecated
  // `ORCH_LOG_FORMAT` alias for a variable that never existed.
  "lib/log.mjs": [LEGACY_ENV],
  "tests/log.test.ts": [LEGACY_ENV],
  "tests/setup.ts": [LEGACY_ENV], //        clears stale ORCH_* out of a developer's shell
  "tests/importGraph.test.ts": [LEGACY_ENV], // one comment naming lib/env.mjs's job
  "lib/resolveHostname.js": [LEGACY_ENV], // hand-rolls the alias (plain-Node, can't import .mjs freely)
  "desktop/supervisor.js": [LEGACY_ENV], // ditto, for the desktop wrapper
  "desktop/README.md": [LEGACY_ENV], //   documents that alias reaching the sidecars by inheritance
  "docs/SELF_HOSTING.md": [LEGACY_ENV, LEGACY_STORAGE, /orch-u-|-p orch-|\/home\/orch\b/],
  "docs/SERVICES.md": [/ORCH_PUBLIC_HOST/], // injected into services forever; not deprecated
  "lib/services.ts": [/ORCH_PUBLIC_HOST/], // the injection site
  "e2e/README.md": [/ORCH_TEST_|orch-test/], //      the pre-rename volume/image names, named so they can be deleted
  "scripts/docker-test.sh": [/ORCH_TEST_|orch-test/], // same

  // (b)+(c) the container surface: ORCH_* compose interpolation kept working,
  // and the volume/network/home names did NOT change (renaming a named volume
  // orphans its data; /home/orch is baked into DB rows).
  "docker-compose.yml": [LEGACY_ENV, /orch-u-/, /\/home\/orch\b/],
  Dockerfile: [LEGACY_ENV, /\/home\/orch\b/],
  "docker/entrypoint.sh": [LEGACY_ENV, LEGACY_STORAGE],
  "examples/overlay/compose.yaml": [/orch-u-/],

  // (c) storage: the old locations are read where they already hold data and
  // are never moved, so the names survive in the resolver, its callers and docs.
  "lib/storage.mjs": [LEGACY_STORAGE, LEGACY_ENV, /"orchestrator" : "calandria"/],
  "lib/db.ts": [LEGACY_STORAGE],
  "lib/db-lock.mjs": [LEGACY_STORAGE],
  "lib/config.ts": [LEGACY_STORAGE],
  "tests/storageDefaults.test.ts": [LEGACY_STORAGE],
  // (c) too: the desktop suite reads the database file straight off disk after
  // the shell has exited, so it has to resolve the name the way the app does
  // instead of hardcoding the current one.
  "desktop/e2e/03-quit-drain.spec.ts": [LEGACY_STORAGE],
  // The backup script follows lib/storage.mjs instead of assuming a filename,
  // so both it and its test name the pre-rename database they have to archive.
  "scripts/backup.mjs": [LEGACY_STORAGE],
  "tests/backup.test.ts": [LEGACY_STORAGE],
  ".gitignore": [/orchestrator\.db/], //   a pre-rename db sitting in the repo root
  ".env.example": [LEGACY_ENV, LEGACY_STORAGE],
  "docs/ARCHITECTURE.md": [LEGACY_STORAGE],
  "docs/TROUBLESHOOTING.md": [LEGACY_STORAGE],
  "CLAUDE.md": [LEGACY_STORAGE],

  // (c) git artifacts minted before the rename. A branch name is written into
  // the repo once and lives there forever, so ensureWorktree's self-heal has
  // to adopt an `orch/<id>` branch (legacyBranchForTask) instead of cutting an
  // empty `calandria/<id>` beside it; the merge-abort ref likewise.
  "lib/git.ts": [/refs\/worktree\/orch-merge-abort/, /`orch\/\$\{taskId\}`/, /`orch\/<id>`/],
  "tests/legacyBranchPrefix.test.ts": [/orch\\?\/|orch-merge-abort/],

  // (c) localStorage keys minted before the rename, read once on miss so a
  // returning browser keeps its collapse/dismiss/draft state.
  "app/TaskChanges.tsx": [/"orch:diffViewMode"/],
  "app/shell/AgentConnect.tsx": [/"orch_agent_nudge_dismissed"/],
  "app/shell/Composer.tsx": [/orch:draft:/],
  "app/shell/TagChips.tsx": [/orch_group_filter_/], // legacy localStorage key, kept as-read on miss
  "app/shell/TasksColumn.tsx": [/orch_(done|cancelled)_collapsed_/],
  "app/shell/Welcome.tsx": [/"orch:welcomeCoach:dismissed"/],
  "app/shell/persist.ts": [/orchestrator-era/], // the comment explaining the pair above

  // (d) generated release notes: the subjects are quoted from commits that
  // really did say "orchestrator task", and release-please rewrites this file.

  // (e) has no entries: SYSADMIN_NOUN decides it from the spelling, for every
  // file, including the usage route, the Claude driver and its capabilities,
  // lib/auth/local-origin.mjs and its test, and turnLogging, all of which are
  // prose about the person running the instance and need no permission.
  "server.js": [LEGACY_ENV, LEGACY_STORAGE],

  // This guard has to spell out everything it forbids.
  "tests/naming.test.ts": [/./],
  // The contributor-facing note pointing at it (CONTRIBUTING.md, "Ground rules")
  // quotes the guarded words in backticks.
  "CONTRIBUTING.md": [/`orch|`orchestrator|`operator|`ORCH_/],
};

/**
 * Tracked, non-binary text files: the surface this guard covers.
 *
 * `null` when git can't answer: a task worktree's `.git` is a FILE pointing
 * outside the mount, so `git ls-files` fails under `npm run test:docker`
 * (e2e/README.md documents the same red herring). CI checks out a real clone,
 * which is the run that gates a merge, so the guard skips instead of walking
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
        // (e), file-independent: take the ordinary noun OUT and see whether the
        // line still says anything guarded. A line that was only about the
        // person running the instance is clean; one that also says
        // "orchestrator" is not, and no entry can hide that.
        if (!TERMS.test(line.replace(SYSADMIN_NOUN, ""))) return;
        if (allowed.some((p) => p.test(line))) return;
        strays.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    expect(
      strays,
      strays.length
        ? `Unallowed orch/operator reference(s):\n\n  ${strays.join("\n  ")}\n\n` +
            `Calandria is not called Operator and has no "orch" anything. Rename it — or, if ` +
            `it is attribution, the ORCH_* alias table, or a pre-rename on-disk/localStorage ` +
            `name, add it to ALLOWED in tests/naming.test.ts with a comment saying which. ` +
            `("operator" the ordinary noun needs no entry — but a line reported here says ` +
            `something else guarded as well, so read the whole line.)`
        : undefined
    ).toEqual([]);
  });

  it("the allowlist has no dead entries", () => {
    // An entry whose file is gone (or no longer matches) is a rename that
    // finished; drop it, so the list keeps meaning what it says.
    const dead = Object.keys(ALLOWED).filter((file) => {
      if (file === "tests/naming.test.ts") return false;
      const abs = path.join(ROOT, file);
      if (!fs.existsSync(abs)) return true;
      // Same strip as the guard: a file left with nothing but the ordinary noun
      // needs no entry, so its entry is dead even though TERMS still fires.
      return !fs.readFileSync(abs, "utf8").split("\n").some((l) => TERMS.test(l.replace(SYSADMIN_NOUN, "")));
    });
    expect(dead, `ALLOWED entries that no longer match anything: ${dead.join(", ")}`).toEqual([]);
  });

  it("catches a stray (sanity — the matcher is not vacuous)", () => {
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
