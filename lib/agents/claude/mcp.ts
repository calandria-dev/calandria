// Calandria's tools mounted into a Claude turn over the STDIO bridge instead of
// in-process — the escape hatch behind CALANDRIA_CLAUDE_TOOL_TRANSPORT=stdio
// (lib/config.ts). Pure data, so tests can read it without spawning anything.
//
// Why there are two transports at all: the in-process (`type: "sdk"`) server is
// the one the CLI cuts calls off on in resumed sessions, and the measurement
// plus the upstream report are in ../CLAUDE.md. This mounts the very same
// scripts/calandria-mcp.mjs the Codex and Antigravity drivers spawn, whose tool
// calls POST to /api/internal/agent-tools/* and run the same lib/agentTools.ts
// logic the in-process handlers call directly.
//
// The env block is deliberately the Codex driver's, field for field
// (calandriaMcpConfig in ../codex/driver.ts), with one addition — see
// CALANDRIA_MCP_ASK_USER below. Keeping the two identical is what makes "the
// bridge behaves the same for Claude as it does for Codex" a fact rather than a
// hope.

import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Project, Task } from "../../types";
import { AGENT_TOOL_TIMEOUT_MS, CALANDRIA_MCP_SCRIPT, INTERNAL_BASE_URL } from "../../config";

/**
 * The `mcpServers.calandria` entry for one Claude turn, as a stdio server.
 *
 * `command` is the absolute node binary (process.execPath) so the spawn doesn't
 * depend on PATH surviving into the MCP subprocess — the same reasoning as the
 * other two drivers.
 */
export function calandriaBridgeServer(project: Project, task: Task): McpStdioServerConfig {
  return {
    type: "stdio",
    command: process.execPath,
    args: [CALANDRIA_MCP_SCRIPT],
    // The CLI's per-server cap, which the in-process transport has no way to
    // set (it is why AGENT_TOOL_TIMEOUT_MS exists at all). Set ABOVE the
    // bridge's own guard deadline rather than at it, so the guard is always the
    // one that answers and the model gets a sentence naming the tool instead of
    // the CLI's own cut-off text. 0 means the operator disabled the bound, so
    // there is nothing to sit above and the CLI's ~27.7h default stands.
    ...(AGENT_TOOL_TIMEOUT_MS > 0 ? { timeout: AGENT_TOOL_TIMEOUT_MS + 30_000 } : {}),
    // Never defer these behind tool search. The in-process server has no such
    // knob and is always loaded, so without this the escape hatch would quietly
    // change WHICH tools a turn can see as well as how they are carried. The
    // cost is that turn startup blocks until the server connects, capped by the
    // CLI at 5s.
    alwaysLoad: true,
    env: {
      CALANDRIA_TASK_ID: task.id,
      CALANDRIA_PROJECT_ID: project.id,
      // Whether the bridge registers create_pr at all (scripts/calandria-mcp.mjs).
      // The in-process server gates on the same column.
      CALANDRIA_LANDING_MODE: project.landing_mode,
      CALANDRIA_BASE_URL: INTERNAL_BASE_URL,
      SERVICE_TOKEN: process.env.SERVICE_TOKEN || "",
      // The bridge is plain Node and can't read lib/config.ts, and this env
      // block may REPLACE the inherited environment, so every knob has to be
      // handed over explicitly or the bridged tool falls back to the built-in
      // default (lib/agentToolGuard.mjs).
      CALANDRIA_AGENT_TOOL_TIMEOUT_MS: String(AGENT_TOOL_TIMEOUT_MS),
      // The one field the Codex entry doesn't set. Claude has AskUserQuestion of
      // its own, which the driver's PreToolUse hook already routes to the same
      // card through the same lib/asks.ts registry; offering ask_user beside it
      // would give one session two ways to ask and the transcript two kinds of
      // card for one question. Codex has no native ask, which is the whole
      // reason the bridge carries one.
      CALANDRIA_MCP_ASK_USER: "0",
    },
  };
}
