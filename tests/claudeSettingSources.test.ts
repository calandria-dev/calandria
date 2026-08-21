import { describe, it, expect, beforeEach, vi } from "vitest";

// Pins how much of the user's own machine each Claude query() gets to see.
//
// TWO deliberate policies, not one:
//
// A TURN inherits most of it, but not all. The SDK loads every on-disk setting
// source when `settingSources` is omitted ("matches CLI defaults" — sdk.d.ts);
// we pin the list explicitly instead so an SDK default change can't silently
// change what a task trusts, and we drop 'local' from it. 'user' and 'project'
// give a task session the user's ~/.claude settings, MCP servers, plugins,
// skills, and the repo's CLAUDE.md. 'local' (<worktree>/.claude/settings.local.json)
// is excluded on purpose: it resolves against the task's own worktree, same as
// 'project', but by convention it's gitignored — so an agent that writes one
// (trivial under an auto-accept edit policy) plants a hook, permission-allow
// rule, or env var that never appears in the diff a human reviews, and it
// still runs next turn with no canUseTool check in between. 'project' stays
// because it's tracked and shows up in that same diff.
//
// A ONE-SHOT does not. The handoff note, the recap and the context draft are
// internal transformations with no orchestrator bridge and no UI to answer a
// prompt; inheriting the session config made each of them spawn the user's
// whole MCP fleet (measured: 10 servers, 146 tools) to offer tools they can
// never call. They isolate CAPABILITY (`tools`, `strictMcpConfig`, `skills`,
// `settings.disableAllHooks`) and inherit CONFIG (`settingSources` keeps
// 'user'), the same split the Codex driver's oneShot() already makes.
//
// Three things this file exists to stop regressing, all verified live against
// claude CLI 2.1.228:
//   - `allowedTools` is NOT a restriction. The SDK defines it as "auto-allowed
//     without prompting", and under bypassPermissions everything is
//     auto-approved anyway. All three one-shots used to pass it and get the
//     full toolset: `allowedTools: []` ran Read, and the "read-only" draft
//     agent ran Write. `tools` is the real switch.
//   - `settingSources: []` is NOT free. ~/.claude/settings.json is where a
//     user's `env` block, `apiKeyHelper` and model aliases live. On a
//     Vertex-configured machine with those absent from the server's own
//     environment, `[]` fails the run with "Not logged in" while `["user"]`
//     succeeds with 0 tools and 0 MCP servers.
//   - Hooks are a separate surface from tools, and inline `settings` is the
//     lever that closes it. Keeping 'user' keeps the user's hooks, so a
//     SessionStart hook injects context into a four-bullet recap regardless of
//     the tool set; `settings: { disableAllHooks: true }` suppresses it while
//     the same run still authenticates. `managedSettings` does not — the SDK
//     filters that tier restrictive-only and the key doesn't survive.
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

import { claudeDriver, SETTING_SOURCES } from "@/lib/agents/claude/driver";
import { listSlashCommands } from "@/lib/schedule/commands";
import type { Project, Task } from "@/lib/types";

// The sources a turn actually loads — not the SDK's full default list, which
// also includes 'local' (see SETTING_SOURCES in driver.ts for why that one's
// dropped). 'project' is the load-bearing one of the two: per sdk.d.ts,
// settingSources "must include 'project' to load CLAUDE.md files".
const TURN_SOURCES = ["user", "project"];

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
    // Explicitly present — the whole point. `undefined` here means we're back to
    // relying on an SDK default nobody in this repo controls (and that default
    // includes 'local', which we deliberately don't want).
    expect(optionsOfCall(0).settingSources).toEqual(TURN_SOURCES);
  });

  it("never loads 'local', even though the SDK default would", async () => {
    // The security-relevant assertion: 'local' resolves to
    // <worktree>/.claude/settings.local.json, which is agent-writable and, by
    // convention, gitignored — so a hook planted there never appears in the
    // diff a human reviews before a task's changes land. 'project' is kept
    // despite also being worktree-writable because it's tracked and visible in
    // that same diff; 'local' offers no equivalent review gate.
    await runTurn();
    expect(optionsOfCall(0).settingSources).not.toContain("local");
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
    // A turn is also the one place the full toolset is right: omitted, so the
    // CLI's own default set applies.
    expect(options.tools).toBeUndefined();
    // And the one place the user's hooks and skills are wanted — a task session
    // is supposed to behave like their own terminal.
    expect(options.settings).toBeUndefined();
    expect(options.skills).toBeUndefined();
    // Turns are resumed by session id across a task's whole lineage.
    expect(options.persistSession).toBeUndefined();
  });
});

describe("the schedule preflight validates against the same sources a turn gets", () => {
  it("probes with SETTING_SOURCES itself, not a second copy of the list", async () => {
    // lib/schedule/commands.ts reads the slash-command registry a scheduled turn
    // WOULD have, and refuses the run if the prompt's command isn't in it. It
    // used to hardcode its own ["user","project","local"], so the two could
    // drift — and drift doesn't degrade quietly here: the preflight would
    // validate against a different registry than the turn actually gets, settle
    // the run `failed` and mint nothing, every morning, for a command that is
    // in fact registered.
    //
    // Asserted behaviourally (what the probe HANDED the SDK) rather than by
    // grepping for an import, so any future way of getting the value wrong —
    // a re-declared local, a spread that drops an entry — still fails here.
    // Since the probe is now the composer's own (lib/agents/claude/commands.ts),
    // this pins BOTH callers to the turn's sources at once.
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
    // The counter-pin to the isolation asserts below. settingSources: [] drops
    // ~/.claude/settings.json, which for a Bedrock/Vertex/proxy/apiKeyHelper
    // user is where the login itself comes from — the one-shots would fail
    // while their ordinary turns kept working.
    for (const [name, options] of Object.entries(o)) {
      expect(options.settingSources, `${name} lost the user's settings`).toContain("user");
      expect(options.settingSources, `${name} is fully isolated`).not.toEqual([]);
    }
  });

  it("mounts no MCP servers on any one-shot", async () => {
    const o = await oneShotOptions();
    for (const [name, options] of Object.entries(o)) {
      // strictMcpConfig is what actually drops them: settings, .mcp.json and
      // plugins alike. `tools` doesn't — it governs built-ins only, so without
      // this the user's whole fleet still spawns and still fills the context.
      expect(options.strictMcpConfig, `${name} still inherits MCP servers`).toBe(true);
      // None of the three mounts the orchestrator bridge either — no task, no
      // transcript, nothing for suggest_task to attach to.
      expect(options.mcpServers, `${name} mounted an MCP server`).toBeUndefined();
    }
  });

  it("shuts off the surfaces that aren't the tool list", async () => {
    const o = await oneShotOptions();
    for (const [name, options] of Object.entries(o)) {
      // Hooks fire whether or not a tool exists to hook — a SessionStart hook
      // injects context into a four-bullet recap. Inline `settings` is the lever
      // that works; `managedSettings` is filtered restrictive-only and drops the
      // key, and impersonating the IT policy tier is the wrong move regardless.
      expect(options.settings, `${name} still runs the user's hooks`).toEqual({
        disableAllHooks: true,
        autoMemoryEnabled: false,
      });
      expect(options.managedSettings, `${name} impersonates the managed tier`).toBeUndefined();
      expect(options.skills, `${name} still discovers skills`).toEqual([]);
      // Nothing records a one-shot's session id, so these can never be resumed;
      // persisting only fills the user's own ~/.claude/projects with recap turns.
      expect(options.persistSession, `${name} litters the session store`).toBe(false);
    }
  });

  it("restricts tools with `tools`, never with `allowedTools`", async () => {
    const o = await oneShotOptions();
    for (const [name, options] of Object.entries(o)) {
      // The bug this whole change came from: `allowedTools` only pre-approves,
      // and bypassPermissions pre-approves everything anyway. Any reappearance
      // here is a restriction that isn't one.
      expect(options.allowedTools, `${name} is back to the decorative allowedTools`).toBeUndefined();
      expect(Array.isArray(options.tools), `${name} did not pin a tool set`).toBe(true);
    }
  });

  it("gives the text-only one-shots no tools at all", async () => {
    const o = await oneShotOptions();
    // Transcript summary and recap are text in, text out. Nothing to read,
    // nothing to run — and with maxTurns: 1 nothing to iterate on either.
    for (const name of ["summarize", "recap"] as const) {
      expect(o[name].tools, `${name} can still call tools`).toEqual([]);
      expect(o[name].maxTurns, `${name} is no longer single-turn`).toBe(1);
      // No CLAUDE.md, no repo-level hooks: for a text transform that's context
      // that can only skew the output.
      expect(o[name].settingSources, `${name} loads repo settings it can't use`).toEqual(["user"]);
    }
  });

  it("leaves the context draft able to read the repo, and only read it", async () => {
    const o = await oneShotOptions();
    // This is the one one-shot that genuinely explores, so it keeps 'project' —
    // what loads CLAUDE.md, the most useful file it can see — and a real
    // read-only tool set. 'local' stays off: gitignored CLAUDE.local.md and
    // settings.local.json are one developer's private overrides, and this
    // document is written for everyone.
    expect(o.draft.settingSources).toEqual(["user", "project"]);
    expect(o.draft.settingSources).not.toContain("local");
    expect(o.draft.tools).toEqual(["Read", "Grep", "Glob"]);
    // Bash under bypassPermissions with no canUseTool is unreviewed arbitrary
    // execution in the user's own checkout, to produce a paragraph of prose.
    expect(o.draft.tools).not.toContain("Bash");
    // Nor anything that could change the repo it was asked to describe.
    for (const write of ["Write", "Edit", "NotebookEdit"]) {
      expect(o.draft.tools, `draft can still ${write}`).not.toContain(write);
    }
  });
});
