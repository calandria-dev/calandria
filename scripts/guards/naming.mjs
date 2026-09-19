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
import { ROOT, trackedFiles as gitTrackedFiles } from "./files.mjs";

/** The guarded spellings. Case-insensitive, so "Orch"/"Operator" hit too. */
export const TERMS = /\b(orch|orchestrators?|operators?)\b|ORCH_/i;

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
export const SYSADMIN_NOUN = /\boperators?\b(?!-oss)/g;

/** (b) the deprecated env prefix and any prose about it. */
export const LEGACY_ENV = /ORCH_/;

/** (c) the pre-rename storage names, still read where they already exist. */
export const LEGACY_STORAGE = /\.zen-orchestrator|\.agent-orchestrator|orchestrator\.(db|lock)/;

// Whole directories of frozen history, (d). Everything under these paths
// predates the rename and is a record, not a live reference.
export const FROZEN_DIRS = [
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
export const ALLOWED = {
  // (a) attribution: the fork's obligations under Apache-2.0 §4(d) and the
  // README section that credits upstream by name.
  NOTICE: [/Operator/, /operator-oss/],
  "README.md": [/Operator/, /operator-oss/],

  // (b) the alias table itself, plus everything that documents or tests it.
  "lib/env.mjs": [LEGACY_ENV],
  "tests/env.test.ts": [LEGACY_ENV],
  // The advanced-env catalog normalizes a submitted ORCH_* name to its
  // CALANDRIA_* spelling before checking reservation, so a custom variable
  // can't dodge a reserved/unsupported name via the alias table; its test
  // exercises that normalization directly.
  "lib/advanced-env/catalog.mjs": [LEGACY_ENV],
  // Case-insensitive: this test also exercises a lowercase "orch_db_dir"
  // input, since the catalog's own alias check is case-insensitive too.
  "tests/advancedEnvCatalog.test.ts": [/ORCH_/i],
  // A saved app row is shadowed by the launch environment under either
  // spelling, so the store checks the ORCH_* alias of a CALANDRIA_* name
  // before it calls a row unshadowed; its test covers that alias.
  "lib/advanced-env/store.ts": [LEGACY_ENV],
  "tests/advancedEnvStore.test.ts": [LEGACY_ENV],
  // The boot loader applies a saved app row only when neither spelling is
  // already set in the launch environment, so it reads the alias table too.
  "lib/advanced-env/bootstrap.mjs": [LEGACY_ENV],
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
  // (b) and (c) together: the boot loader's test covers a host value under the
  // alias spelling, and resolving the settings file beside a pre-rename
  // database, which is named by the file it sits next to.
  "tests/advancedEnvBootstrap.test.ts": [LEGACY_ENV, LEGACY_STORAGE],
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
  // The data table this guard scans against lives here now; its own sanity
  // and dead-entry tests still quote the guarded spellings verbatim.
  "scripts/guards/naming.mjs": [/./],
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
export function trackedTextFiles() {
  const files = gitTrackedFiles();
  if (!files) return null;
  return files
    .filter((f) => f !== "package-lock.json") // a lockfile is generated, and huge
    .filter((f) => {
      const abs = path.join(ROOT, f);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
      // Binaries (fonts, images, the .ico) have no naming to guard.
      return !fs.readFileSync(abs).includes(0);
    });
}

/** Scans the given tracked text files and returns the stray hits. */
export function scan(files) {
  const strays = [];
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
  return strays;
}
