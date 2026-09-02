// Per-task HOME for Antigravity turns — how each task gets its own MCP bridge
// entry without tasks trampling each other.
//
// THE PROBLEM. `agy` reads MCP servers from exactly ONE place: the user-global
// `~/.gemini/config/mcp_config.json`. The Calandria bridge takes its task
// identity from that entry's env (CALANDRIA_TASK_ID, read by
// scripts/calandria-mcp.mjs), so a single global file cannot serve parallel
// tasks — whichever task wrote last would own every other task's suggest_task,
// create_pr and ask_user calls.
//
// WHAT WAS RULED OUT, by experiment against agy 1.1.22 rather than by reading:
//
//   - A workspace customization root. The CLI's own embedded docs say `.agents/`
//     in the repo may carry `mcp_config.json`, and that is how skills, rules and
//     hooks work — but it is NOT true of MCP servers. A config placed at
//     `.agents/`, `.agent/`, `_agents/`, `_agent/`, `.gemini/`,
//     `.gemini/config/`, `.antigravity/` and the repo root, all at once, left
//     the model answering "NO MCP". Only the global file is read.
//   - Teaching the bridge to take the task id from argv. One global entry has
//     one argv, so it has the same problem.
//
// WHAT WORKS. Point HOME at a per-task directory. The CLI then reads
// `$HOME/.gemini/config/mcp_config.json`, which is ours alone. Two wrinkles,
// both measured and both handled below:
//
//   1. A bare per-task HOME LOSES THE LOGIN — the CLI re-prompts for OAuth. So
//      the token is not purely in the D-Bus keyring as the spike concluded;
//      something under `~/.gemini/antigravity-cli` gates it. Symlinking that one
//      directory back to the real home restores authentication while leaving
//      `config/` private. (Verified: same prompt, same worktree, auth intact and
//      the bridge visible, with the task's own CALANDRIA_TASK_ID coming back
//      through a get_task call.)
//   2. HOME is inherited by every shell command the agent runs, so a naive
//      override would take away ~/.gitconfig, ~/.ssh and the rest — an agent
//      that cannot set a committer identity or reach a remote. The overlay below
//      symlinks every entry of the real home across, so tools see what they
//      normally would, and only `.gemini` is substituted.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project, Task } from "../../types";
import { GEMINI_HOMES_DIR } from "../../config";
import { bridgeConfig } from "./mcp";

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
 * Mirror the real home into `taskHome` as symlinks, so shell commands the agent
 * runs still find ~/.gitconfig, ~/.ssh, ~/.npmrc and everything else. `.gemini`
 * is skipped — that is the whole point of the overlay.
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
 * Called once per turn rather than once per task: the bridge entry carries the
 * landing mode, the instance's base URL and its service token, all of which can
 * change between turns while the worktree persists.
 */
export function prepareTaskHome(project: Project, task: Task): TaskHome {
  const realHome = os.homedir();
  const home = path.join(GEMINI_HOMES_DIR, task.id);
  const configDir = path.join(home, GEMINI_DIR, CONFIG_DIR);
  fs.mkdirSync(configDir, { recursive: true });

  // Share the login. Recreated if it is missing or dangling, so a home that
  // outlived a reinstall heals instead of silently asking the user to log in.
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

  return { home, cwd: task.worktree_path || project.repo_path || process.cwd() };
}
