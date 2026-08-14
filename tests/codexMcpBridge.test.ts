import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { orchestratorMcpConfig } from "@/lib/agents/codex/driver";
import * as TOOL_DEFS from "@/lib/agentToolDefs.mjs";
import type { Project, Task } from "@/lib/types";

// Pins the codex-side wiring of the orchestrator's stdio MCP bridge
// (scripts/orch-mcp.mjs), which gives Codex tasks suggest_task /
// expose_service / ask_user.
//
// The load-bearing field is `default_tools_approval_mode`. Codex gates MCP tool
// calls behind their own approval decision — `approval_policy = "never"` does
// NOT cover them. Under the default mode, `codex exec` (what the SDK spawns)
// has no approver, so every call to this server came back immediately as
// `error: "user cancelled MCP tool call"` and the tool silently never ran.
// Verified live on codex-cli 0.142.5: "auto" reproduces the cancellation,
// "approve" runs the tool. Valid modes are auto | prompt | approve.
const project = { id: "p1", name: "P", repo_path: "/tmp/repo" } as Project;
const task = { id: "t1", agent: "codex" } as Task;

describe("codex orchestrator MCP bridge config", () => {
  const server = (orchestratorMcpConfig(project, task) as Record<string, any>).mcp_servers.orchestrator;

  it("auto-approves the bridge's tools (non-interactive exec has no approver)", () => {
    expect(server.default_tools_approval_mode).toBe("approve");
  });

  it("keeps the parked-ask timeout far above any HTTP-scale default", () => {
    expect(server.tool_timeout_sec).toBeGreaterThanOrEqual(3600);
  });

  it("scopes the bridge to this task/project and authenticates it", () => {
    expect(server.env.ORCH_TASK_ID).toBe("t1");
    expect(server.env.ORCH_PROJECT_ID).toBe("p1");
    expect(server.env.ORCH_BASE_URL).toBeTruthy();
    expect(server.env).toHaveProperty("SERVICE_TOKEN");
  });

  it("spawns the bridge with an absolute node binary (no PATH dependency)", () => {
    expect(server.command).toBe(process.execPath);
    expect(server.args[0]).toMatch(/scripts[/\\]orch-mcp\.mjs$/);
  });
});

// The whole point of lib/agentToolDefs.mjs is that the two servers exposing
// these tools can't drift: the Claude driver's in-process SDK MCP server and
// this stdio bridge. A def nobody mounts is a tool the agent can't see; a tool
// mounted on one side only is exactly the drift the shared file exists to
// prevent. Source-level on purpose — the bridge is a separate process, and the
// SDK server can't be introspected without an SDK session.
const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const TOOL_NAMES = Object.values(TOOL_DEFS)
  .map((d) => (d as { name?: unknown }).name)
  .filter((n): n is string => typeof n === "string");

describe("agent tool defs reach both servers", () => {
  it("mounts every def in the Claude driver's in-process server", () => {
    // The bridge side is covered live in tests/orchMcp.test.ts (listTools over
    // real stdio). The in-process SDK server has no such handle — building one
    // needs an SDK session — so this side is pinned at the source level.
    //
    // ask_user is the deliberate exception: Claude asks through its own native
    // AskUserQuestion tool, intercepted by the driver's PreToolUse hook, and the
    // shared def exists only so the bridge can offer non-Claude agents the same
    // thing. Everything else must be mounted on both.
    const src = read("lib/agents/claude/driver.ts");
    for (const name of TOOL_NAMES.filter((n) => n !== "ask_user")) {
      const constName = Object.keys(TOOL_DEFS).find((k) => (TOOL_DEFS as Record<string, { name?: string }>)[k]?.name === name)!;
      expect(src, `${name} is not mounted in lib/agents/claude/driver.ts`).toContain(`${constName}.name`);
    }
    expect(src).toContain("AskUserQuestion");
  });

  it("keeps update_task's accepted values identical on both sides", () => {
    // The driver spells these literals out because z.enum needs a literal union
    // and the defs are plain .mjs (TS widens their arrays to string[]). That's
    // the one place the shared file can't enforce itself, so pin it here.
    const src = read("lib/agents/claude/driver.ts");
    expect(src).toContain(`z.enum(${JSON.stringify(TOOL_DEFS.UPDATE_TASK.priorities).replaceAll(",", ", ")})`);
    expect(src).toContain(`z.enum(${JSON.stringify(TOOL_DEFS.UPDATE_TASK.statuses).replaceAll(",", ", ")})`);
    expect(TOOL_DEFS.UPDATE_TASK.statuses).not.toContain("cancelled");
  });

  it("offers update_task's `task` target on both sides", () => {
    // The param that lets an agent edit a row other than its own. Mounted on one
    // side only, the cross-task policy is simply unreachable from the other
    // agent — a capability gap no test of either side alone would notice.
    for (const rel of ["lib/agents/claude/driver.ts", "scripts/orch-mcp.mjs"]) {
      expect(read(rel), `update_task's \`task\` param is missing from ${rel}`).toContain("UPDATE_TASK.params.task");
    }
  });

  it("has an internal endpoint behind every path the bridge proxies to", () => {
    // A bridge tool whose endpoint doesn't exist fails at call time with a bare
    // 404 — invisible until an agent tries it in anger.
    const src = read("scripts/orch-mcp.mjs");
    const paths = [...src.matchAll(/callInternal\("([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of new Set(paths)) {
      expect(fs.existsSync(path.join(ROOT, "app/api/internal/agent-tools", p, "route.ts")), `no route for ${p}`).toBe(true);
    }
  });
});
