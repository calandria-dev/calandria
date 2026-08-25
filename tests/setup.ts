import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// This file runs before each test file's module graph is loaded, so env set
// here is seen by lib/config.ts (which reads CALANDRIA_WORKTREES_DIR at import
// time). Everything here is a default the whole suite depends on; env that
// only a fork or one machine needs goes in the optional tests/setup.local.ts
// layer instead (see vitest.config.ts).

// realpathSync: os.tmpdir() is a symlink on macOS (/var -> /private/var) and git
// reports realpaths, so resolve it up front to keep path comparisons exact.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-git-test-"));
process.env.CALANDRIA_TEST_TMP = root;
process.env.CALANDRIA_WORKTREES_DIR = path.join(root, "worktrees");
// Point the SQLite store at a throwaway dir so store-backed tests get a fresh,
// isolated orchestrator.db instead of the user's real one. Read at import time
// by lib/config.ts, so it must be set here (before the module graph loads).
process.env.CALANDRIA_DB_DIR = path.join(root, "db");

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

// Hermetic agent config: CODEX_INHERIT_MCP is read at import time by
// lib/config.ts and flips whether the Codex driver unmounts the user's own MCP
// servers, so a developer who set it in their shell would otherwise invert
// tests/codexMcpBridge.test.ts. Same reasoning as the credential strip above.
delete process.env.CODEX_INHERIT_MCP;

// Hermetic git: pin all config to a file we control so the suite never depends
// on (or mutates) the user's identity, hooks, signing, or default-branch setup.
const gitconfig = path.join(root, "gitconfig");
fs.writeFileSync(
  gitconfig,
  [
    "[user]",
    "\tname = Orchestrator Test",
    "\temail = test@orchestrator.local",
    "[init]",
    "\tdefaultBranch = main",
    "[commit]",
    "\tgpgsign = false",
    "[core]",
    `\thooksPath = ${path.join(root, "no-hooks")}`,
    "",
  ].join("\n")
);
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
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
  fs.rmSync(root, { recursive: true, force: true });
});
