import { describe, it, expect, vi, afterEach } from "vitest";

// The CODEX_INHERIT_MCP=0 path in lib/agents/codex/mcp.ts, driven by a fixture
// of `codex mcp list --json` as codex-cli prints it: one stdio server from a
// plugin (cua_repl, the one whose startup failure was reported) and one
// streamable-HTTP server. Two facts are pinned here.
//
//   1. The override carries an inert transport of the same KIND as the server.
//      Codex validates every mcp_servers entry before merging plugin-provided
//      definitions, and a bare { enabled: false } failed that validation and
//      broke every Codex turn for a user with a plugin server.
//   2. Nothing but the name and transport type survives parsing: the real
//      command, args, env, cwd, URL, headers and bearer-token variable never
//      reach an override, so nothing credential-shaped is echoed into `--config`
//      flags on a command line.
//
// The CLI is stood in for by `node -e` printing the fixture, through the same
// ./bin resolver the real call goes through, so listUserMcpServers runs its
// real subprocess path rather than a mocked child_process.

const FIXTURE = [
  {
    name: "cua_repl",
    enabled: true,
    transport: {
      type: "stdio",
      command: "/path/to/node",
      args: ["/path/to/plugin/launch.mjs"],
      env: { SECRET_TOKEN: "hunter2" },
      env_vars: ["ANOTHER_SECRET"],
      cwd: null,
    },
  },
  {
    name: "openaiDeveloperDocs",
    enabled: true,
    transport: {
      type: "streamable_http",
      url: "https://developers.openai.com/mcp",
      bearer_token_env_var: "OPENAI_DOCS_TOKEN",
      http_headers: { "X-Api-Key": "abc123" },
      env_http_headers: null,
    },
  },
];

const EXPECTED = {
  cua_repl: { enabled: false, command: "calandria-disabled-mcp-server" },
  openaiDeveloperDocs: { enabled: false, url: "https://mcp-disabled.invalid" },
};

vi.mock("@/lib/agents/codex/bin", () => ({
  codexSpawn: (_args: string[]) => ({
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(FIXTURE))})`],
    windowsVerbatimArguments: false,
  }),
  resolveCodexBin: () => process.execPath,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("codex disable overrides from `codex mcp list --json`", () => {
  it("keeps only each server's name and transport type", async () => {
    const { parseMcpList } = await import("@/lib/agents/codex/mcp");
    expect(parseMcpList(JSON.stringify(FIXTURE))).toEqual([
      { name: "cua_repl", transport: "stdio" },
      { name: "openaiDeveloperDocs", transport: "streamable_http" },
    ]);
  });

  it("treats a missing or unknown transport type as stdio, and drops the bridge's own name", async () => {
    const { parseMcpList } = await import("@/lib/agents/codex/mcp");
    expect(
      parseMcpList(JSON.stringify([{ name: "bare" }, { name: "odd", transport: { type: "sse" } }, { name: "calandria" }, { nope: 1 }])),
    ).toEqual([
      { name: "bare", transport: "stdio" },
      { name: "odd", transport: "stdio" },
    ]);
    expect(parseMcpList("{}")).toEqual([]);
  });

  it("emits the inert transport per kind, and nothing from the real transport", async () => {
    const { disableInheritedServers, parseMcpList } = await import("@/lib/agents/codex/mcp");
    const overrides = disableInheritedServers(parseMcpList(JSON.stringify(FIXTURE)));
    expect(overrides).toEqual(EXPECTED);
    // Belt and braces against a future field being "helpfully" copied across:
    // no value from the fixture's real transports appears anywhere in what
    // becomes a --config flag.
    const flat = JSON.stringify(overrides);
    for (const leak of ["/path/to/node", "launch.mjs", "hunter2", "ANOTHER_SECRET", "developers.openai.com", "OPENAI_DOCS_TOKEN", "abc123", "X-Api-Key"]) {
      expect(flat).not.toContain(leak);
    }
  });

  it("runs the enumeration through the CLI when the opt-out is set", async () => {
    vi.stubEnv("CODEX_INHERIT_MCP", "0");
    const { inheritedServerOverrides, listUserMcpServers } = await import("@/lib/agents/codex/mcp");
    expect(await listUserMcpServers()).toEqual([
      { name: "cua_repl", transport: "stdio" },
      { name: "openaiDeveloperDocs", transport: "streamable_http" },
    ]);
    expect(await inheritedServerOverrides()).toEqual(EXPECTED);
  });

  it("spawns nothing and overrides nothing under the default", async () => {
    // CODEX_INHERIT_MCP unset (tests/setup.ts strips it) means on.
    const { inheritedServerOverrides } = await import("@/lib/agents/codex/mcp");
    expect(await inheritedServerOverrides()).toEqual({});
  });
});
