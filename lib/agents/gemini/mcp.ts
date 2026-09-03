// The Calandria MCP bridge entry for an Antigravity turn — pure data, so tests
// can assert on it without touching disk. Where the file it goes into lives,
// and how each task gets its own, is ./home.ts.

import type { Project, Task } from "../../types";
import { INTERNAL_BASE_URL, CALANDRIA_MCP_SCRIPT } from "../../config";
import { gatewayMcpServersForGemini, type GatewayMcpGeminiServer } from "../../gatewayMcp";

/**
 * The bridge's server name. The CLI dispatches MCP calls through its own
 * `call_mcp_tool` and reports this in `tool_info.parameters.ServerName`, which
 * ./events.ts recombines into the tool name lib/suggestionCard.ts matches as a
 * SUBSTRING — so it must stay in step with the Codex driver's spelling.
 */
export const BRIDGE_SERVER_NAME = "calandria";

export interface GeminiMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface GeminiMcpConfig {
  mcpServers: Record<string, GeminiMcpServer | GatewayMcpGeminiServer>;
}

/**
 * The `mcp_config.json` body mounting Calandria's stdio bridge for ONE task,
 * plus any hosted LiteLLM gateway MCP servers the project/task selected
 * (docs/design/litellm.md, "Mounting, per driver"). Unlike Codex, mounting
 * these needs no permission-mode gate: `agy` decides tool approval from its
 * own settings/CLI flags rather than per-MCP-server config, so there's
 * nothing here for a read-only mode to leave dangling.
 *
 * `command` is the absolute node binary (process.execPath) so the spawn doesn't
 * depend on PATH surviving into the MCP subprocess — the same reasoning as the
 * Codex driver's config.
 *
 * There is no per-server approval knob to set here, unlike Codex's
 * `default_tools_approval_mode`: `agy` decides tool permissions from its own
 * settings and CLI flags, so the driver allow-lists the bridge there instead
 * (see ./driver.ts).
 */
export function bridgeConfig(project: Project, task: Task): GeminiMcpConfig {
  return {
    mcpServers: {
      // Spread first so the bridge below always wins a name collision. Keys
      // are already slugified to hyphens (gatewayMcpServersForGemini), since
      // the CLI's policy engine splits a tool name on the first underscore
      // after `mcp_`.
      ...gatewayMcpServersForGemini(project, task),
      [BRIDGE_SERVER_NAME]: {
        command: process.execPath,
        args: [CALANDRIA_MCP_SCRIPT],
        env: {
          CALANDRIA_TASK_ID: task.id,
          CALANDRIA_PROJECT_ID: project.id,
          // Whether the bridge registers create_pr at all (scripts/calandria-mcp.mjs).
          // Both other drivers make the same call off the same column.
          CALANDRIA_LANDING_MODE: project.landing_mode,
          CALANDRIA_BASE_URL: INTERNAL_BASE_URL,
          SERVICE_TOKEN: process.env.SERVICE_TOKEN || "",
        },
      },
    },
  };
}
