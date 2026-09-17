import { describe, it, expect, beforeEach, vi } from "vitest";

// Pins how much of the user's machine a Claude query() gets to see.
//
// A turn pins settingSources to ["user", "project"], dropping the SDK's
// default 'local' source since it resolves against the task's own
// gitignored settings.local.json, where an agent-written hook or permission
// rule would skip review. A one-shot (handoff note, recap, context draft)
// isolates capability (`tools`, `strictMcpConfig`, `skills`,
// `settings.disableAllHooks`) while keeping 'user' in settingSources so
// authentication and provider routing still work.
//
// The SDK is mocked at its module boundary: the real driver builds the real
// options object, and the test reads back exactly what it handed the CLI.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  // The Calandria MCP server is built eagerly inside runTurn's options; it
  // only has to be *something* here, since this test never calls its tools.
  createSdkMcpServer: (cfg: unknown) => ({ type: "sdk", ...(cfg as object) }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { claudeDriver, SETTING_SOURCES, WATCHED_SETTINGS_FILES, WORKTREE_SETTINGS_FILE } from "@/lib/agents/claude/driver";
import { listSlashCommands } from "@/lib/schedule/commands";
import type { Project, Task } from "@/lib/types";

// The sources a turn actually loads (the SDK's default list also includes
// 'local'; see SETTING_SOURCES in driver.ts). 'project' is required: per
// sdk.d.ts, settingSources "must include 'project' to load CLAUDE.md files".
const TURN_SOURCES = ["user", "project"];

const project = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "", port: 4301 } as Project;
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

// The options each one-shot built, by name. They're independent calls, so run
// them one at a time and keep the mock's call index unambiguous.
async function oneShotOptions(): Promise<Record<string, Record<string, unknown>>> {
  await claudeDriver.summarizeTranscript!("transcript", project);
  await claudeDriver.draftProjectContext!(project, "digest");
  await claudeDriver.summarizeProjectRecap!(project, "digest");
  expect(queryMock).toHaveBeenCalledTimes(3);
  return { summarize: optionsOfCall(0), draft: optionsOfCall(1), recap: optionsOfCall(2) };
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(() => (async function* () {})());
});

describe("claude driver setting sources", () => {
  it("pins settingSources on a turn instead of inheriting the SDK default", async () => {
    await runTurn();
    expect(queryMock).toHaveBeenCalledTimes(1);
    // undefined here would mean falling back to the SDK default, which also
    // includes 'local'.
    expect(optionsOfCall(0).settingSources).toEqual(TURN_SOURCES);
  });

  it("never loads 'local', even though the SDK default would", async () => {
    // 'local' resolves to <worktree>/.claude/settings.local.json, which is
    // agent-writable and gitignored by convention, so a hook written there
    // never appears in the diff a human reviews. 'project' stays because it
    // is tracked and visible in that diff.
    await runTurn();
    expect(optionsOfCall(0).settingSources).not.toContain("local");
  });

  it("keeps the user's own configuration in the session", async () => {
    await runTurn();
    const options = optionsOfCall(0);
    // 'project' loads CLAUDE.md; 'user' is where ~/.claude MCP servers, plugins
    // and skills come from. `[]` is the SDK's isolation mode (no filesystem
    // settings at all), and strictMcpConfig drops every MCP server not passed
    // inline; either one cuts the user out of their own tools.
    expect(options.settingSources).toContain("project");
    expect(options.settingSources).toContain("user");
    expect(options.settingSources).not.toEqual([]);
    expect(options.strictMcpConfig).toBeUndefined();
    // tools is omitted on a turn, so the CLI's own default set applies.
    expect(options.tools).toBeUndefined();
    // A task session keeps the user's hooks and skills so it behaves like
    // their own terminal.
    expect(options.settings).toBeUndefined();
    expect(options.skills).toBeUndefined();
    // Turns are resumed by session id across a task's whole lineage.
    expect(options.persistSession).toBeUndefined();
  });

  it("scopes the turn's own process env: no NODE_ENV, PORT pinned to the project (issue #102)", async () => {
    await runTurn();
    const env = optionsOfCall(0).env as Record<string, string>;
    expect(env).toBeDefined();
    expect("NODE_ENV" in env).toBe(false);
    expect(env.PORT).toBe(String(project.port));
  });
});

describe("drift detection covers every source a turn loads from the worktree", () => {
  // Complements the 'local' decision above: the runner hashes
  // settings.json before every turn and holds the turn on a card when it
  // moved (lib/settingsDrift.ts), so which sources a turn loads and which
  // files that gate watches must stay the same list, or a re-added source
  // reopens the hole under a name the gate doesn't watch.
  it("derives the watch list from SETTING_SOURCES rather than restating it", () => {
    // Every worktree source SETTING_SOURCES loads must appear in
    // WATCHED_SETTINGS_FILES, and nothing else does.
    const worktreeSources = SETTING_SOURCES.filter((s) => WORKTREE_SETTINGS_FILE[s]);
    for (const source of worktreeSources) {
      expect(WATCHED_SETTINGS_FILES, `${source} is loaded but unwatched`).toContain(WORKTREE_SETTINGS_FILE[source]);
    }
    expect(WATCHED_SETTINGS_FILES).toHaveLength(worktreeSources.length);
    // watchedSettingsFiles is the AgentDriver field the runner reads to decide
    // whether to watch a task's settings; only Claude publishes it here.
    expect(claudeDriver.watchedSettingsFiles).toEqual(WATCHED_SETTINGS_FILES);
    expect(claudeDriver.watchedSettingsFiles).toContain(".claude/settings.json");
  });

  it("maps every source in the SDK's union, so a re-added one arrives watched", () => {
    // WORKTREE_SETTINGS_FILE is total over SettingSource: 'local' maps to a
    // path, so re-adding it to SETTING_SOURCES would be watched automatically;
    // 'user' maps to null because ~/.claude sits outside every worktree, so
    // there is no file there to watch.
    expect(WORKTREE_SETTINGS_FILE.local).toBe(".claude/settings.local.json");
    expect(WORKTREE_SETTINGS_FILE.project).toBe(".claude/settings.json");
    expect(WORKTREE_SETTINGS_FILE.user).toBeNull();
  });
});

describe("the schedule preflight validates against the same sources a turn gets", () => {
  it("probes with SETTING_SOURCES itself, not a second copy of the list", async () => {
    // lib/schedule/commands.ts reads the slash-command registry a scheduled
    // turn would have, and refuses the run if the prompt's command isn't in
    // it. If this registry drifted from the turn's own sources, the
    // preflight would validate against the wrong list and settle a valid
    // command's run failed.
    //
    // Asserted behaviourally, on what the probe handed the SDK, so it catches
    // any way of getting the value wrong, not just one particular way. The
    // probe is the composer's own (lib/agents/claude/commands.ts), which pins
    // both callers to the turn's sources at once.
    queryMock.mockImplementation(() => ({
      supportedCommands: async () => [{ name: "jira-tasks", description: "", argumentHint: "" }],
      close: () => {},
    }));

    expect(await listSlashCommands(project, "claude")).toEqual(["jira-tasks"]);
    expect(optionsOfCall(0).settingSources).toBe(SETTING_SOURCES);
    expect(optionsOfCall(0).settingSources).toEqual(TURN_SOURCES);
  });
});

describe("claude driver one-shot isolation", () => {
  it("gives every one-shot the user's settings, so auth and provider routing survive", async () => {
    const o = await oneShotOptions();
    // settingSources: [] drops ~/.claude/settings.json, which for a
    // Bedrock/Vertex/proxy/apiKeyHelper user is where authentication comes
    // from, so an isolated one-shot would fail while ordinary turns kept
    // working.
    for (const [name, options] of Object.entries(o)) {
      expect(options.settingSources, `${name} lost the user's settings`).toContain("user");
      expect(options.settingSources, `${name} is fully isolated`).not.toEqual([]);
    }
  });

  it("mounts no MCP servers on any one-shot", async () => {
    const o = await oneShotOptions();
    for (const [name, options] of Object.entries(o)) {
      // strictMcpConfig drops every MCP source (settings, .mcp.json, plugins);
      // `tools` only governs built-ins, so without strictMcpConfig the user's
      // whole MCP fleet would still spawn and fill the context.
      expect(options.strictMcpConfig, `${name} still inherits MCP servers`).toBe(true);
      // None of the three mounts the Calandria bridge: there is no task or
      // transcript for suggest_task to attach to.
      expect(options.mcpServers, `${name} mounted an MCP server`).toBeUndefined();
    }
  });

  it("shuts off the surfaces that aren't the tool list", async () => {
    const o = await oneShotOptions();
    for (const [name, options] of Object.entries(o)) {
      // Hooks fire independent of the tool list, so a SessionStart hook can
      // inject context into a four-bullet recap unless suppressed. Inline
      // `settings: { disableAllHooks: true }` suppresses it; `managedSettings`
      // is filtered restrictive-only and drops the key, and is also the wrong
      // tier to impersonate.
      expect(options.settings, `${name} still runs the user's hooks`).toEqual({
        disableAllHooks: true,
        autoMemoryEnabled: false,
      });
      expect(options.managedSettings, `${name} impersonates the managed tier`).toBeUndefined();
      expect(options.skills, `${name} still discovers skills`).toEqual([]);
      // Nothing records a one-shot's session id, so it can never be resumed;
      // persisting would only fill ~/.claude/projects with recap turns.
      expect(options.persistSession, `${name} litters the session store`).toBe(false);
    }
  });

  it("restricts tools with `tools`, never with `allowedTools`", async () => {
    const o = await oneShotOptions();
    for (const [name, options] of Object.entries(o)) {
      // `allowedTools` only pre-approves calls, and bypassPermissions
      // pre-approves everything anyway, so it is never a real restriction.
      expect(options.allowedTools, `${name} is back to the decorative allowedTools`).toBeUndefined();
      expect(Array.isArray(options.tools), `${name} did not pin a tool set`).toBe(true);
    }
  });

  it("gives the text-only one-shots no tools at all", async () => {
    const o = await oneShotOptions();
    // Transcript summary and recap are text in, text out, with nothing to
    // read or run, and maxTurns: 1 leaves nothing to iterate on.
    for (const name of ["summarize", "recap"] as const) {
      expect(o[name].tools, `${name} can still call tools`).toEqual([]);
      expect(o[name].maxTurns, `${name} is no longer single-turn`).toBe(1);
      // A text transform has no use for CLAUDE.md or repo-level hooks;
      // loading them would only skew the output.
      expect(o[name].settingSources, `${name} loads repo settings it can't use`).toEqual(["user"]);
    }
  });

  it("leaves the context draft able to read the repo, and only read it", async () => {
    const o = await oneShotOptions();
    // The context draft is the only one-shot that explores the repo, so it
    // keeps 'project' to load CLAUDE.md and a real read-only tool set. 'local'
    // stays off because gitignored CLAUDE.local.md and settings.local.json
    // are one developer's private overrides, not part of a document meant
    // for everyone.
    expect(o.draft.settingSources).toEqual(["user", "project"]);
    expect(o.draft.settingSources).not.toContain("local");
    expect(o.draft.tools).toEqual(["Read", "Grep", "Glob"]);
    // Bash under bypassPermissions with no canUseTool would be unreviewed
    // arbitrary execution in the user's own checkout, just to produce a
    // paragraph of prose.
    expect(o.draft.tools).not.toContain("Bash");
    // Nor anything that could change the repo it was asked to describe.
    for (const write of ["Write", "Edit", "NotebookEdit"]) {
      expect(o.draft.tools, `draft can still ${write}`).not.toContain(write);
    }
  });
});
