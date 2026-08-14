import { describe, it, expect, beforeEach, vi } from "vitest";

// Pins the Claude driver's setting-source inheritance.
//
// The SDK loads ALL on-disk setting sources when `settingSources` is omitted
// ("matches CLI defaults" — sdk.d.ts), which is precisely the behavior we want:
// a task session should see the user's own ~/.claude settings, MCP servers,
// plugins and skills, and the repo's CLAUDE.md. Relying on the default made
// that a hidden dependency — an SDK bump flipping it to isolation-by-default
// would strip every session's MCP + CLAUDE.md with no symptom other than the
// agent quietly getting worse. The driver now says it out loud; this test is
// what fails if someone deletes the line.
//
// The SDK is mocked at its module boundary, so the REAL driver builds the real
// options object and we read back exactly what would have been handed to the CLI.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  // The orchestrator MCP server is built eagerly inside runTurn's options; it
  // only has to be *something* here, since this test never calls its tools.
  createSdkMcpServer: (cfg: unknown) => ({ type: "sdk", ...(cfg as object) }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { claudeDriver } from "@/lib/agents/claude/driver";
import type { Project, Task } from "@/lib/types";

// Every source the SDK knows about — the CLI default, spelled out. 'project' is
// the load-bearing one: per sdk.d.ts, settingSources "must include 'project' to
// load CLAUDE.md files".
const ALL_SOURCES = ["user", "project", "local"];

const project = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "" } as Project;
const task = { id: "t1", agent: "claude", title: "T", description: "", session_id: null } as unknown as Task;

// Drive a real turn to completion. query() is mocked to an empty stream, so the
// driver drains nothing and finishes; all we want is the options it built.
async function runTurn(): Promise<void> {
  for await (const _ev of claudeDriver.runTurn(task, project, "hello")) void _ev;
}

// The options object the driver passed to query() on the Nth call.
function optionsOfCall(n: number): Record<string, unknown> {
  const arg = queryMock.mock.calls[n]?.[0] as { options?: Record<string, unknown> } | undefined;
  return arg?.options ?? {};
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(() => (async function* () {})());
});

describe("claude driver setting sources", () => {
  it("pins settingSources on a turn instead of inheriting the SDK default", async () => {
    await runTurn();
    expect(queryMock).toHaveBeenCalledTimes(1);
    // Explicitly present — the whole point. `undefined` here means we're back to
    // relying on an SDK default nobody in this repo controls.
    expect(optionsOfCall(0).settingSources).toEqual(ALL_SOURCES);
  });

  it("keeps the user's own configuration in the session", async () => {
    await runTurn();
    const options = optionsOfCall(0);
    // 'project' loads CLAUDE.md; 'user' is where ~/.claude MCP servers, plugins
    // and skills come from. `[]` would be the SDK's isolation mode (no
    // filesystem settings at all) and strictMcpConfig drops every MCP server we
    // didn't pass inline — either one silently cuts the user out of their tasks.
    expect(options.settingSources).toContain("project");
    expect(options.settingSources).toContain("user");
    expect(options.settingSources).not.toEqual([]);
    expect(options.strictMcpConfig).toBeUndefined();
  });

  it("pins the same sources on every one-shot helper", async () => {
    // The one-shots (transcript summarize, context draft, project recap) run
    // outside the main chat but through the same SDK, and inherited the same
    // implicit default. They're pinned to preserve today's behavior exactly, so
    // an SDK bump can't change one half of the app and not the other.
    await claudeDriver.summarizeTranscript!("transcript", project);
    await claudeDriver.draftProjectContext!(project, "digest");
    await claudeDriver.summarizeProjectRecap!(project, "digest");

    expect(queryMock).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      expect(optionsOfCall(i).settingSources, `one-shot #${i} did not pin settingSources`).toEqual(ALL_SOURCES);
    }
  });
});
