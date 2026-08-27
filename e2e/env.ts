// Hermetic run environment for the Playwright suite. One temp root per run —
// created by the first process that loads this module (Playwright's main
// process) and shared with worker processes via CALANDRIA_E2E_ROOT, which children
// inherit. Everything the app persists (SQLite, worktrees, cloned/seeded repos)
// lands under this root, so an e2e run never touches ~/.calandria or the
// developer's real projects, and every run starts from a truly fresh instance
// (which is what makes the onboarding spec deterministic).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function ensureRoot(): string {
  let root = process.env.CALANDRIA_E2E_ROOT;
  if (!root) {
    // realpathSync the tmp root, like tests/setup.ts: on macOS os.tmpdir() is a
    // symlink (/var -> /private/var) and on Windows a CI runner's %TEMP% is
    // often the 8.3 short form (C:\Users\RUNNER~1\...). Git and the app both
    // report the resolved spelling, so resolving up front keeps the paths the
    // specs compare identical to the ones the server persists.
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "calandria-e2e-"));
    process.env.CALANDRIA_E2E_ROOT = root;
  }
  for (const d of ["db", "worktrees", "projects", "fixtures", "claude-config"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  // Pinned git identity/config for BOTH the server (worktree + merge commits)
  // and the test helpers (fixture repos) — hermetic like tests/setup.ts, so the
  // suite passes on a machine with no global git config, and no user hooks or
  // signing setup can interfere.
  const gitconfig = path.join(root, "gitconfig");
  if (!fs.existsSync(gitconfig)) {
    fs.writeFileSync(
      gitconfig,
      [
        "[user]",
        "\tname = Calandria E2E",
        "\temail = e2e@example.com",
        "[init]",
        "\tdefaultBranch = main",
        "[commit]",
        "\tgpgsign = false",
        "[core]",
        // Windows-only in effect: a checkout that rewrote line endings would
        // change the diffs the specs read, and the fixture repos live deep
        // under %TEMP%. Same pair tests/setup.ts pins, same reasoning.
        "\tautocrlf = false",
        "\tlongpaths = true",
        `\thooksPath = ${os.platform() === "win32" ? "NUL" : "/dev/null"}`,
        "",
      ].join("\n")
    );
  }
  return root;
}

export const E2E_ROOT = ensureRoot();
export const E2E_PORT = Number(process.env.CALANDRIA_E2E_PORT || 4711);
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const FIXTURES_DIR = path.join(E2E_ROOT, "fixtures");

export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: path.join(E2E_ROOT, "gitconfig"),
  GIT_CONFIG_SYSTEM: os.platform() === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** Env for the app under test (server.js + pty-server.js via `npm start`). */
export const SERVER_ENV: Record<string, string> = {
  PORT: String(E2E_PORT),
  HOSTNAME: "127.0.0.1",
  PTY_PORT: String(E2E_PORT + 1),
  PTY_HOST: "127.0.0.1",
  CALANDRIA_DB_DIR: path.join(E2E_ROOT, "db"),
  CALANDRIA_WORKTREES_DIR: path.join(E2E_ROOT, "worktrees"),
  CALANDRIA_PROJECTS_DIR: path.join(E2E_ROOT, "projects"),
  // Keep the managed-services port block clear of the app/pty ports.
  CALANDRIA_SERVICE_PORT_BASE: String(E2E_PORT + 100),
  // Registers the deterministic mock agent (lib/agents/mock/driver.ts) so
  // onboarding and turns run without any real agent CLI or login.
  CALANDRIA_E2E_MOCK_AGENT: "1",
  // Hermetic Claude config, same reasoning as tests/setup.ts: the server reads
  // this dir for the developer's real settings.json (model catalog/provider)
  // and .credentials.json — which the plan-usage meter would otherwise use to
  // call Anthropic's real usage API mid-suite, once per titlebar render.
  CLAUDE_CONFIG_DIR: path.join(E2E_ROOT, "claude-config"),
  ...GIT_ENV,
};
