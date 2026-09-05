import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { calandriaMcpConfig, gatewayMcpForPermission } from "@/lib/agents/codex/driver";
import { disableInheritedServers, CALANDRIA_SERVER } from "@/lib/agents/codex/mcp";
import { getCapabilities } from "@/lib/agents/capabilities";
import * as TOOL_DEFS from "@/lib/agentToolDefs.mjs";
import type { Project, Task } from "@/lib/types";

// Pins the codex-side wiring of Calandria's stdio MCP bridge
// (scripts/calandria-mcp.mjs), which gives Codex tasks suggest_task,
// expose_service, and ask_user.
//
// The critical field is `default_tools_approval_mode`. Codex gates MCP tool
// calls behind its own approval decision; `approval_policy = "never"` does
// not cover them. Under the default mode, `codex exec` (what the SDK spawns)
// has no approver, so every call to this server comes back immediately as
// `error: "user cancelled MCP tool call"` and the tool never runs. "auto"
// reproduces the cancellation, "approve" runs the tool. Valid modes are
// auto | prompt | approve.
const project = { id: "p1", name: "P", repo_path: "/tmp/repo" } as Project;
const task = { id: "t1", agent: "codex" } as Task;

describe("codex calandria MCP bridge config", () => {
  const server = (calandriaMcpConfig(project, task) as Record<string, any>).mcp_servers.calandria;

  it("auto-approves the bridge's tools (non-interactive exec has no approver)", () => {
    expect(server.default_tools_approval_mode).toBe("approve");
  });

  it("keeps the parked-ask timeout far above any HTTP-scale default", () => {
    expect(server.tool_timeout_sec).toBeGreaterThanOrEqual(3600);
  });

  it("scopes the bridge to this task/project and authenticates it", () => {
    expect(server.env.CALANDRIA_TASK_ID).toBe("t1");
    expect(server.env.CALANDRIA_PROJECT_ID).toBe("p1");
    expect(server.env.CALANDRIA_BASE_URL).toBeTruthy();
    expect(server.env).toHaveProperty("SERVICE_TOKEN");
  });

  it("spawns the bridge with an absolute node binary (no PATH dependency)", () => {
    expect(server.command).toBe(process.execPath);
    expect(server.args[0]).toMatch(/scripts[/\\]calandria-mcp\.mjs$/);
  });

  it("keeps the auto-approval scoped to the bridge, never a global default", () => {
    // `approve` is correct for Calandria's own first-party loopback proxy, and
    // must not drift into a blanket policy: as a top-level codex setting it
    // would auto-approve anything else that gets mounted.
    const cfg = calandriaMcpConfig(project, task) as Record<string, unknown>;
    expect(cfg).not.toHaveProperty("default_tools_approval_mode");
    expect(cfg).not.toHaveProperty("tools");
    expect(Object.keys(cfg)).toEqual(["mcp_servers"]);
  });
});

// The difference between agents here is invisible unless something pins it: a
// Claude task gets the user's own MCP servers, a Codex task gets only the
// bridge. See lib/agents/codex/mcp.ts for why: codex exec has no approver, so
// inherited tools would be offered but every call cancelled.
describe("codex does not inherit the user's MCP servers", () => {
  it("unmounts each of the user's servers alongside the bridge", () => {
    const cfg = calandriaMcpConfig(project, task, disableInheritedServers(["userthing", "another"])) as Record<string, any>;
    expect(cfg.mcp_servers.userthing).toEqual({ enabled: false });
    expect(cfg.mcp_servers.another).toEqual({ enabled: false });
    // …without touching the bridge.
    expect(cfg.mcp_servers.calandria.command).toBe(process.execPath);
    expect(cfg.mcp_servers.calandria.default_tools_approval_mode).toBe("approve");
  });

  it("never disables the bridge, even if the user has a server by that name", () => {
    const cfg = calandriaMcpConfig(project, task, disableInheritedServers([CALANDRIA_SERVER])) as Record<string, any>;
    expect(cfg.mcp_servers.calandria.enabled).toBeUndefined();
    expect(cfg.mcp_servers.calandria.command).toBe(process.execPath);
  });

  it("skips names that aren't safe as a --config dotted-path segment", () => {
    // The SDK builds `mcp_servers.<name>.enabled` by string concatenation with
    // no quoting, so a dotted or spaced name would address the wrong table.
    // Skipping leaves that server mounted instead of emitting an override that
    // means something else.
    expect(disableInheritedServers(["ok-1", "has.dot", "has space", 'has"quote'])).toEqual({ "ok-1": { enabled: false } });
  });

  it("is declared in the capability descriptors, both ways", () => {
    // app/api/agents hands these to the client, so the asymmetry is data, not
    // per-agent knowledge hardcoded in a driver or the UI. Settings → Agents
    // renders both halves verbatim (McpInheritance in SettingsView.tsx), so
    // every driver owes the note as well as the verdict.
    expect(getCapabilities("codex").inheritsUserMcpServers).toBe(false);
    expect(getCapabilities("claude").inheritsUserMcpServers).toBe(true);
    expect(getCapabilities("codex").userMcpServersNote).toContain("CODEX_INHERIT_MCP");
    expect(getCapabilities("claude").userMcpServersNote).toContain("~/.claude");
  });

  it("states the hosted-gateway mount's own caveat separately from the flag above", () => {
    // A different mount from projects.gateway_mcp, with its own per-driver
    // note. Claude has nothing special to say; Codex's is the approval gate.
    expect(getCapabilities("codex").gatewayMcpNote).toContain("workspace-write");
    expect(getCapabilities("codex").gatewayMcpNote).toContain("auto-approved");
    expect(getCapabilities("claude").gatewayMcpNote).toBeNull();
  });

  it("tracks CODEX_INHERIT_MCP rather than claiming a flat no", async () => {
    // With the opt-in set the driver mounts the user's servers
    // (inheritedServerOverrides above returns nothing to disable), and the
    // Settings line is rendered straight from this flag, so a hardcoded false
    // would tell that user the opposite of what their own turns do. Read at
    // import time via lib/config, hence the module reset.
    vi.stubEnv("CODEX_INHERIT_MCP", "1");
    vi.resetModules();
    try {
      const caps = (await import("@/lib/agents/capabilities")).getCapabilities("codex");
      expect(caps.inheritsUserMcpServers).toBe(true);
      expect(caps.userMcpServersNote).toContain("default_tools_approval_mode");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

// Hosted LiteLLM gateway MCP servers (docs/AGENTS.md, "Mounting, per
// driver"): mounted with the whole server pre-approved (codex exec has no
// approver), and only under the bypass-equivalent permission mode.
// gatewayMcpForPermission is the gate lib/agents/codex/driver.ts's runTurn
// applies before calandriaMcpConfig ever sees a gateway server.
describe("codex hosted gateway MCP mount", () => {
  const gatewayProject = { ...project, gateway_mcp: JSON.stringify(["demo"]) } as Project;

  beforeEach(() => {
    process.env.CALANDRIA_LITELLM_BASE_URL = "http://gw.example";
  });
  afterEach(() => {
    delete process.env.CALANDRIA_LITELLM_BASE_URL;
  });

  it("mounts the resolved gateway selection, pre-approved, under the default (bypass-equivalent) permission", () => {
    const out = gatewayMcpForPermission(gatewayProject, task, null);
    expect(out.demo).toEqual({ url: "http://gw.example/demo/mcp", default_tools_approval_mode: "approve" });
  });

  it("mounts nothing under plan — codex exec has no approver, and plan runs read-only anyway", () => {
    expect(gatewayMcpForPermission(gatewayProject, task, "plan")).toEqual({});
  });

  it("mounts nothing under plan even with bypassPermissions written explicitly for a different check", () => {
    // Every other value falls to the bypass-equivalent branch; "plan" is the
    // exception. Pin both ends so a future permission mode cannot fall the
    // wrong way.
    expect(gatewayMcpForPermission(gatewayProject, task, "bypassPermissions").demo).toBeTruthy();
  });

  it("merges into mcp_servers alongside the bridge, which still wins any name collision", () => {
    const gatewayServers = gatewayMcpForPermission(gatewayProject, task, null);
    const cfg = calandriaMcpConfig(project, task, {}, gatewayServers) as Record<string, any>;
    expect(cfg.mcp_servers.demo).toEqual({ url: "http://gw.example/demo/mcp", default_tools_approval_mode: "approve" });
    expect(cfg.mcp_servers.calandria.command).toBe(process.execPath);
  });
});

// lib/agentToolDefs.mjs exists so the two servers exposing these tools cannot
// drift: the Claude driver's in-process SDK MCP server and this stdio bridge.
// A def nobody mounts is a tool the agent cannot see; a tool mounted on one
// side only is the drift the shared file prevents. This check is source-level
// because the bridge is a separate process, and the SDK server cannot be
// introspected without an SDK session.
const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const TOOL_NAMES = Object.values(TOOL_DEFS)
  .map((d) => (d as { name?: unknown }).name)
  .filter((n): n is string => typeof n === "string");

describe("agent tool defs reach both servers", () => {
  it("mounts every def in the Claude driver's in-process server", () => {
    // The bridge side is covered live in tests/calandriaMcp.test.ts (listTools
    // over real stdio). The in-process SDK server has no such handle, since
    // building one needs an SDK session, so this side is pinned at the source
    // level.
    //
    // ask_user is the exception: Claude asks through its own native
    // AskUserQuestion tool, intercepted by the driver's PreToolUse hook, and the
    // shared def exists so the bridge can offer non-Claude agents the same
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
    // and the defs are plain .mjs (TS widens their arrays to string[]). The
    // shared file cannot enforce this itself, so it is pinned here.
    const src = read("lib/agents/claude/driver.ts");
    expect(src).toContain(`z.enum(${JSON.stringify(TOOL_DEFS.UPDATE_TASK.priorities).replaceAll(",", ", ")})`);
    expect(src).toContain(`z.enum(${JSON.stringify(TOOL_DEFS.UPDATE_TASK.statuses).replaceAll(",", ", ")})`);
    expect(TOOL_DEFS.UPDATE_TASK.statuses).not.toContain("cancelled");
  });

  it("offers update_task's `task` target on both sides", () => {
    // The param that lets an agent edit a row other than its own. Mounted on
    // one side only, the cross-task policy is unreachable from the other agent,
    // a capability gap no test of either side alone would notice.
    for (const rel of ["lib/agents/claude/driver.ts", "scripts/calandria-mcp.mjs"]) {
      expect(read(rel), `update_task's \`task\` param is missing from ${rel}`).toContain("UPDATE_TASK.params.task");
    }
  });

  it("offers update_task's `blocked_by` on both sides", () => {
    // The only way an agent can order a plan: suggest_task takes blockers in the
    // call that invents the task, so a batch of new tasks has no ids to
    // reference yet. Mounted on one side only, that agent can file a roadmap but
    // never say what waits on what.
    for (const rel of ["lib/agents/claude/driver.ts", "scripts/calandria-mcp.mjs"]) {
      expect(read(rel), `update_task's \`blocked_by\` param is missing from ${rel}`).toContain("UPDATE_TASK.params.blocked_by");
    }
  });

  it("offers withdraw_suggestion's `task` + `reason` on both sides", () => {
    // The retraction verb, and the explanation that makes it worth having.
    // Mounted on one side only, an agent on the other has nothing but
    // `status: "done"` for "this suggestion is redundant", which claims work
    // nobody started is finished and fires the auto-start sweep.
    for (const rel of ["lib/agents/claude/driver.ts", "scripts/calandria-mcp.mjs"]) {
      const src = read(rel);
      expect(src, `withdraw_suggestion's \`task\` param is missing from ${rel}`).toContain("WITHDRAW_SUGGESTION.params.task");
      expect(src, `withdraw_suggestion's \`reason\` param is missing from ${rel}`).toContain("WITHDRAW_SUGGESTION.params.reason");
      // Neither is .optional() anywhere; a reason the model can omit is
      // something this tool must not allow.
      expect(src).not.toMatch(/optional\(\)\.describe\(WITHDRAW_SUGGESTION\.params\./);
    }
  });

  it("has an internal endpoint behind every path the bridge proxies to", () => {
    // A bridge tool whose endpoint doesn't exist fails at call time with a bare
    // 404, not caught until an agent calls it.
    const src = read("scripts/calandria-mcp.mjs");
    const paths = [...src.matchAll(/callInternal\("([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of new Set(paths)) {
      expect(fs.existsSync(path.join(ROOT, "app/api/internal/agent-tools", p, "route.ts")), `no route for ${p}`).toBe(true);
    }
  });
});
