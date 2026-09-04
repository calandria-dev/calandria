import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { NULL_DEVICE } from "./platform";

// This file runs before each test file's module graph is loaded, so env set
// here is seen by lib/config.ts (which reads CALANDRIA_WORKTREES_DIR at import
// time). Everything here is a default the whole suite depends on; env that
// only a fork or one machine needs goes in the optional tests/setup.local.ts
// layer instead (see vitest.config.ts).

// Resolve os.tmpdir() up front so path comparisons are exact: it is a symlink
// on macOS (/var -> /private/var) and git reports realpaths, and on Windows it
// is routinely the 8.3 SHORT form — a GitHub runner's is
// `C:\Users\RUNNER~1\AppData\Local\Temp`. `realpathSync` does not expand a short
// name (it resolves links and stops); `realpathSync.native` goes through
// GetFinalPathNameByHandle and gives back `C:\Users\runneradmin\...`. Without it
// the suite compares its own short spelling against the long one everything
// else reports, and `git worktree add` registers a path that the next call's
// identity check reads as a different, "missing but already registered" one.
// libuv strips the `\\?\` prefix GetFinalPathNameByHandle returns; the guard
// below is belt and braces, since a leaked prefix would poison every path in
// the suite. `.native` is what POSIX gets too — same answer there, one code
// path — and it needs an existing directory, which os.tmpdir() is.
const tmpBase = fs.realpathSync.native(os.tmpdir()).replace(/^\\\\\?\\/, "");
const root = fs.mkdtempSync(path.join(tmpBase, "calandria-git-test-"));
process.env.CALANDRIA_TEST_TMP = root;
process.env.CALANDRIA_WORKTREES_DIR = path.join(root, "worktrees");
// Point the SQLite store at a throwaway dir so store-backed tests get a fresh,
// isolated calandria.db instead of the user's real one. Read at import time
// by lib/config.ts, so it must be set here (before the module graph loads).
process.env.CALANDRIA_DB_DIR = path.join(root, "db");
// And the projects dir: seedIfEmpty() scaffolds the welcome repo under
// PROJECTS_DIR, so without this every fresh init(db) in the suite wrote
// ~/projects/welcome on the contributor's machine (issue #34). e2e/env.ts
// already pins all three.
process.env.CALANDRIA_PROJECTS_DIR = path.join(root, "projects");
// And ~/.codex: lib/agents/codex/catalog.ts reads models_cache.json and
// config.toml from there to size the context gauge and resolve the default
// model, so a contributor with a real Codex login would otherwise have their
// own account's catalog decide what the suite asserts. An empty scratch dir is
// the fail-soft branch, which is what every test that doesn't write its own
// fixture expects. Tests that point CODEX_HOME somewhere else must RESTORE this
// value rather than deleting the var, or later files fall back to the real one.
process.env.CODEX_HOME = path.join(root, "codex-home");
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

// Hermetic agent credentials: a developer's real API key exported in their
// shell would otherwise leak into the suite — hasApiKey()/hasOpenAiKey() are
// env-aware (they report the effective billing credential; see lib/env-keys.mjs)
// and would flip status assertions. Same list the boot strip covers. Both
// spellings, since lib/env.mjs now also honors the deprecated ORCH_ name.
for (const v of [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CALANDRIA_ALLOW_API_KEY_ENV",
  "ORCH_ALLOW_API_KEY_ENV",
]) {
  delete process.env[v];
}

// Hermetic env aliasing: the suite sets CALANDRIA_DB_DIR/CALANDRIA_WORKTREES_DIR
// above, but a developer with the OLD ORCH_ names exported in their shell would
// otherwise still have them ambient (readEnv only falls back when the new name
// is unset, which it isn't here — but deleting the legacy spelling keeps this
// hermetic and explicit rather than relying on that precedence silently).
for (const v of ["ORCH_DB_DIR", "ORCH_WORKTREES_DIR"]) {
  delete process.env[v];
}

// Hermetic provider config: Claude's capability descriptor is now computed per
// read from the backend the instance routes through — and that is read out of
// ~/.claude/settings.json and the process env (lib/agents/claude/provider.ts).
// A developer on Vertex or Bedrock would otherwise get a different model list,
// with different context windows, than a developer on a plain Anthropic login,
// and modelContextWindow() feeds store-level assertions. Point the reader at an
// empty config dir and strip the provider flags so the suite always sees the
// default Anthropic-hosted catalog.
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude-config");
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
for (const v of [
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
]) {
  delete process.env[v];
}

// …and the other half of that descriptor's inputs: the alias probe
// (lib/agents/claude/modelProbe.ts) would spawn the developer's real `claude`
// five times to fill in what "Opus (latest)" resolves to, which is neither
// hermetic nor free. Off for the whole suite; tests/claudeModelProbe.test.ts
// exercises the probe against a fake CLI of its own instead.
process.env.CALANDRIA_CLAUDE_MODEL_PROBE = "0";

// Hermetic idle behavior: CALANDRIA_TURN_IDLE_NUDGE is read at import time by
// lib/config.ts and decides whether an idle turn is TOLD it went quiet, which
// injects a message and writes a transcript line. A developer who set it in
// their shell would otherwise flip tests/turnIdle.test.ts's default-off case.
// The test that needs it on mocks the config module rather than setting it here.
delete process.env.CALANDRIA_TURN_IDLE_NUDGE;

// Hermetic agent config: CODEX_INHERIT_MCP is read at import time by
// lib/config.ts and flips whether the Codex driver unmounts the user's own MCP
// servers (default: mounted), so a developer who set it to 0 in their shell
// would otherwise invert tests/codexMcpBridge.test.ts. Same reasoning as the
// credential strip above.
delete process.env.CODEX_INHERIT_MCP;

// Hermetic git: pin all config to a file we control so the suite never depends
// on (or mutates) the user's identity, hooks, signing, or default-branch setup.
const gitconfig = path.join(root, "gitconfig");
fs.writeFileSync(
  gitconfig,
  [
    "[user]",
    "\tname = Calandria Test",
    "\temail = test@calandria.local",
    "[init]",
    "\tdefaultBranch = main",
    "[commit]",
    "\tgpgsign = false",
    "[core]",
    // Windows-only in effect, and both are about the fixtures being the same
    // bytes on every platform. `autocrlf` is already off here because
    // GIT_CONFIG_NOSYSTEM strips the system config Git for Windows sets it in
    // — pinned anyway, since a checkout that rewrote line endings would make
    // every diff/patch assertion in the suite platform-dependent. `longpaths`
    // matches what lib/git.ts passes the app's own git calls: fixture repos
    // live under a mkdtemp root inside %TEMP%, which is deep before the
    // repository's own tree starts.
    "\tautocrlf = false",
    "\tlongpaths = true",
    // `autocrlf` alone doesn't settle it: a fixture that ships its own
    // `.gitattributes` with `* text=auto` (tests/merge.test.ts does, as the
    // tool-dropping case) marks its files as text, and git then checks them out
    // with `core.eol`, which defaults to NATIVE — CRLF on Windows. The file
    // came back from a stash as `* text=auto\r\n` and failed a byte assertion.
    // Pinning `lf` makes the working tree the same bytes on every platform,
    // which is the only thing this block is for; with no text attributes in
    // play (every other fixture) it changes nothing at all.
    "\teol = lf",
    // The null device rather than a directory under `root`: a Windows path in
    // a git CONFIG FILE would carry backslashes, and `\U` in `C:\Users\...` is
    // an invalid escape git rejects the whole file for. `NUL`/`/dev/null` has
    // no separator to escape and disables hooks just as well (git looks for
    // `<hooksPath>/pre-commit`, which can't exist under a device). Same value
    // e2e/env.ts pins.
    `\thooksPath = ${NULL_DEVICE}`,
    "",
  ].join("\n")
);
process.env.GIT_CONFIG_GLOBAL = gitconfig;
// The bit bucket is spelled differently on Windows, and this is a path git
// opens: `/dev/null` there is a missing file in the current drive's root, which
// git reports as an error rather than as "no system config". e2e/env.ts has
// always branched here; this is the same branch (docs/WINDOWS.md §7).
process.env.GIT_CONFIG_SYSTEM = NULL_DEVICE;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
for (const v of [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
]) {
  delete process.env[v];
}

afterAll(() => {
  // Close the suite's SQLite connection BEFORE deleting the tree it lives in.
  // POSIX lets an open file be unlinked and simply disappear; Windows refuses
  // with EBUSY while any handle is open, and `global.__calandriaDb` (lib/db.ts)
  // is held for the process's lifetime — so on Windows this teardown failed in
  // every one of the 79 test files that had touched the store, turning a green
  // suite into a wall of red that named the teardown rather than the test.
  // Same shape as the app's own worktree teardown (lib/paths.ts): close what we
  // hold, then retry for the handles we don't (a Defender scan of a fresh
  // checkout, an indexer). A residual failure is not worth failing a passing
  // suite over — the directory is under %TEMP% — so it is reported, not thrown.
  try {
    global.__calandriaDb?.close();
  } catch {
    /* already closed, or never opened */
  }
  global.__calandriaDb = undefined;
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    console.warn(`[tests] could not remove ${root}:`, err);
  }
});
