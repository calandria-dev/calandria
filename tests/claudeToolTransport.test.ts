import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { calandriaBridgeServer } from "@/lib/agents/claude/mcp";
import { calandriaMcpConfig } from "@/lib/agents/codex/driver";
import { CLAUDE_TOOL_TRANSPORT, AGENT_TOOL_TIMEOUT_MS, CALANDRIA_MCP_SCRIPT } from "@/lib/config";
import type { Project, Task } from "@/lib/types";

// Pins the escape hatch: serving Claude's Calandria tools over the stdio
// bridge (scripts/calandria-mcp.mjs) instead of the Agent SDK's in-process
// MCP server. The in-process transport is the one the CLI cuts calls off on
// in resumed sessions; lib/agents/CLAUDE.md has the detail. Switching
// transports must change how the tools arrive and nothing else.

const project = { id: "p1", name: "P", repo_path: "/tmp/repo", landing_mode: "pr" } as Project;
const task = { id: "t1", agent: "claude" } as Task;

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("claude tool transport", () => {
  it("defaults to in-process, so the hatch is opt-in", () => {
    expect(CLAUDE_TOOL_TRANSPORT).toBe("in-process");
  });

  it("mounts the same bridge script the other drivers spawn, on an absolute node", () => {
    const server = calandriaBridgeServer(project, task);
    expect(server.type).toBe("stdio");
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual([CALANDRIA_MCP_SCRIPT]);
  });

  it("hands the bridge the same per-turn env the Codex driver does", () => {
    // Field for field, since the bridge's behavior is entirely env-driven: a
    // key the Codex entry sets and this one omits makes the tool behave
    // differently for Claude than for Codex.
    const codexEnv = ((calandriaMcpConfig(project, task) as Record<string, any>).mcp_servers.calandria.env ?? {}) as Record<string, string>;
    const claudeEnv = calandriaBridgeServer(project, task).env ?? {};
    for (const [k, v] of Object.entries(codexEnv)) expect(claudeEnv[k]).toBe(v);
    expect(claudeEnv.CALANDRIA_TASK_ID).toBe(task.id);
    expect(claudeEnv.CALANDRIA_PROJECT_ID).toBe(project.id);
    expect(claudeEnv.CALANDRIA_BASE_URL).toMatch(/^http/);
  });

  it("withholds ask_user, which Claude has natively", () => {
    // The CLI's own AskUserQuestion is already routed to the same card by the
    // driver's PreToolUse hook. Two asking tools would mean two kinds of card
    // for one question. tests/calandriaMcp.test.ts proves the bridge honours it.
    expect(calandriaBridgeServer(project, task).env?.CALANDRIA_MCP_ASK_USER).toBe("0");
  });

  it("keeps the CLI's per-server cap above the bridge's own deadline", () => {
    // Both ends have a bound, unlike the in-process transport where only the
    // guard does. The guard has to be the one that answers, or the model
    // gets the CLI's cut-off sentence for a call that merely ran long.
    const timeout = calandriaBridgeServer(project, task).timeout;
    expect(timeout).toBeGreaterThan(AGENT_TOOL_TIMEOUT_MS);
  });

  it("never defers the tools behind tool search", () => {
    // The in-process server has no such knob and is always loaded. Without this
    // the hatch would change which tools a turn can see, not just how they get
    // there.
    expect(calandriaBridgeServer(project, task).alwaysLoad).toBe(true);
  });

  it("is the driver's only fork: one knob picks between the two servers", () => {
    const src = read("lib/agents/claude/driver.ts");
    expect(src).toContain("CLAUDE_TOOL_TRANSPORT === \"stdio\"");
    expect(src).toContain("calandriaBridgeServer(project, task)");
    // createSdkMcpServer remains as the fallback branch alongside the hatch.
    expect(src).toContain("createSdkMcpServer");
  });
});
