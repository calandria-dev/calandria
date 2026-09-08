// Per-task HOME for Antigravity turns: how each task gets its own MCP bridge
// entry without tasks trampling each other.
//
// `agy` reads MCP servers from exactly one place, the user-global
// `~/.gemini/config/mcp_config.json`. The Calandria bridge takes its task
// identity from that entry's env (CALANDRIA_TASK_ID, read by
// scripts/calandria-mcp.mjs), so a single global file cannot serve parallel
// tasks: whichever task wrote last would own every other task's
// suggest_task, create_pr and ask_user calls. The CLI's workspace
// customization roots (`.agents/` and similar) work for skills, rules and
// hooks but not for MCP servers, so the fix is to point HOME at a per-task
// directory: the CLI then reads `$HOME/.gemini/config/mcp_config.json`,
// which is ours alone.
//
// Two wrinkles follow from that, both handled below. A bare per-task HOME
// loses the login (the CLI re-prompts for OAuth), because something under
// `~/.gemini/antigravity-cli` gates authentication beyond the D-Bus keyring;
// symlinking that one directory back to the real home restores it while
// leaving `config/` private. And HOME is inherited by every shell command
// the agent runs, so a naive override would take away `~/.gitconfig`,
// `~/.ssh` and the rest; the overlay below symlinks every other entry of the
// real home across, substituting only `.gemini`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project, Task } from "../../types";
import { GEMINI_HOMES_DIR } from "../../config";
import { bridgeConfig } from "./mcp";
import { taskProvider } from "../../agentEnv";
import { writeModelProviderSetting } from "./auth";

/** The one directory that must stay shared: it carries the login. */
const AUTH_DIR = "antigravity-cli";
const GEMINI_DIR = ".gemini";
const CONFIG_DIR = "config";
const MCP_CONFIG_FILE = "mcp_config.json";

export interface TaskHome {
  /** HOME for the CLI process. */
  home: string;
  /** Working directory for the turn. */
  cwd: string;
}

/**
 * Mirror the real home into `taskHome` as symlinks, so shell commands the
 * agent runs still find ~/.gitconfig, ~/.ssh, ~/.npmrc and everything else.
 * `.gemini` is skipped, since that is what the overlay exists to substitute.
 *
 * Best-effort per entry: an unreadable or racing entry must not take the turn
 * down, and a missing symlink costs at most one tool that can't find its config.
 * Re-run every turn so a dotfile the user added since is picked up, and cheap
 * because an existing link is left alone.
 */
function overlayRealHome(realHome: string, taskHome: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(realHome);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === GEMINI_DIR) continue;
    const link = path.join(taskHome, name);
    try {
      if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) continue;
    } catch {
      continue;
    }
    try {
      fs.symlinkSync(path.join(realHome, name), link);
    } catch {
      // A racing turn created it, or the name is not linkable. Either is fine.
    }
  }
}

/**
 * Prepare (and refresh) the task's private HOME, returning it plus the working
 * directory the turn should run in.
 *
 * Called once per turn, not once per task: the bridge entry carries the
 * landing mode, the instance's base URL and its service token, all of which can
 * change between turns while the worktree persists.
 */
export function prepareTaskHome(project: Project, task: Task): TaskHome {
  const realHome = os.homedir();
  const home = path.join(GEMINI_HOMES_DIR, task.id);
  const configDir = path.join(home, GEMINI_DIR, CONFIG_DIR);
  fs.mkdirSync(configDir, { recursive: true });

  // Share the login. Recreated if it is missing or dangling, so a home that
  // outlived a reinstall heals instead of forcing the user to log in again.
  const authLink = path.join(home, GEMINI_DIR, AUTH_DIR);
  const authTarget = path.join(realHome, GEMINI_DIR, AUTH_DIR);
  try {
    if (!fs.existsSync(authLink)) {
      // lstat catches a dangling link, which existsSync reports as absent.
      if (fs.lstatSync(authLink, { throwIfNoEntry: false })) fs.unlinkSync(authLink);
      fs.symlinkSync(authTarget, authLink);
    }
  } catch {
    // Without this the CLI will ask for a login; surfaced as an auth error on
    // the turn, which is the honest outcome, so don't fail the launch here.
  }

  overlayRealHome(realHome, home);

  fs.writeFileSync(
    path.join(configDir, MCP_CONFIG_FILE),
    JSON.stringify(bridgeConfig(project, task), null, 2) + "\n"
  );

  // The gateway kind needs `{"modelProvider":"gemini"}` before `agy` will
  // read GEMINI_API_KEY at all (docs/AGENTS.md). This is the one real, shared
  // settings.json (see writeModelProviderSetting), the same file the API-key
  // connect card writes; there is no per-task HOME for it, unlike the MCP
  // config above.
  if (taskProvider(project, task).kind === "gateway") writeModelProviderSetting(true);

  return { home, cwd: task.worktree_path || project.repo_path || process.cwd() };
}
