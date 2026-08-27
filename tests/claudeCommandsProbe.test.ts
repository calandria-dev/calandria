import { describe, expect, it, beforeEach, vi } from "vitest";

// lib/agents/claude/commands.ts — the app's ONE slash-command enumeration,
// shared by the composer's "/" menu and the schedule validator.
//
// It was unpinned while it had a single caller whose worst failure was a short
// menu. It now also decides whether a scheduled run fires, so the two things
// that were only ever comments — that it sends no model request, and that it
// isolates everything except the sources that decide the answer — are asserted
// here. The hooks flag is the load-bearing one: without it a SessionStart hook
// runs on every "/" keystroke AND, since the consolidation, unattended inside
// the scheduler's sweep on every save and every fire.

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => cfg,
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { listClaudeCommands, recordMcpPrompts } from "@/lib/agents/claude/commands";
import { claudeDriver, SETTING_SOURCES } from "@/lib/agents/claude/driver";
import { uid } from "./helpers";
import type { Project, Task } from "@/lib/types";

type Cmd = { name: string; description?: string; argumentHint?: string; aliases?: string[] };

const closeMock = vi.fn();

const answer = (...rounds: Cmd[][]) => {
  for (const commands of rounds) {
    queryMock.mockImplementationOnce(() => ({
      supportedCommands: async () => commands.map((c) => ({ description: "", argumentHint: "", ...c })),
      close: closeMock,
    }));
  }
};

const fail = () =>
  queryMock.mockImplementationOnce(() => ({
    supportedCommands: async () => { throw new Error("no CLI on PATH"); },
    close: closeMock,
  }));

const argsOf = (n: number) =>
  queryMock.mock.calls[n][0] as { prompt: AsyncIterable<unknown>; options: Record<string, unknown> };

// The cache is keyed by cwd and lives on globalThis, so every test needs its own.
const cwd = () => `/tmp/wt-${uid()}`;

beforeEach(() => {
  queryMock.mockReset();
  closeMock.mockReset();
});

describe("the claude command probe", () => {
  it("never sends a prompt, so no turn is spent and nothing is billed", async () => {
    answer([{ name: "simplify" }]);
    await listClaudeCommands(cwd(), SETTING_SOURCES);

    const { prompt } = argsOf(0);
    // A string prompt would BE a turn. It's a generator that parks forever:
    // initialization answers the question, and nothing is ever sent.
    expect(typeof prompt).not.toBe("string");
    const first = await Promise.race([
      prompt[Symbol.asyncIterator]().next(),
      new Promise((r) => setTimeout(() => r("withheld"), 20)),
    ]);
    expect(first).toBe("withheld");
  });

  it("inherits the sources that decide the answer and isolates the rest", async () => {
    answer([{ name: "simplify" }]);
    const dir = cwd();
    await listClaudeCommands(dir, SETTING_SOURCES);
    const { options } = argsOf(0);

    // The one thing inherited: the menu has to describe the session the user
    // will actually get.
    expect(options.cwd).toBe(dir);
    expect(options.settingSources).toBe(SETTING_SOURCES);
    // …and the rest isolated. disableAllHooks is why a SessionStart hook does
    // not run on a keystroke or, unattended, inside the scheduler's sweep.
    expect(options.settings).toEqual({ disableAllHooks: true });
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({});
    // Nothing records this session's id, so persisting it would only litter the
    // user's own ~/.claude/projects with unresumable empties.
    expect(options.persistSession).toBe(false);
  });

  it("tears the process down once it has its answer", async () => {
    answer([{ name: "simplify" }]);
    await listClaudeCommands(cwd(), SETTING_SOURCES);
    // Both halves: abort releases the never-yielding prompt iterable, close()
    // is the SDK's own kill. Aborting alone can leave the child parked.
    expect((argsOf(0).options.abortController as AbortController).signal.aborted).toBe(true);
    expect(closeMock).toHaveBeenCalled();
  });

  it("normalizes what it reports: no leading slash, aliases carried", async () => {
    answer([{ name: "/simplify" }, { name: "superpowers:writing-plans", aliases: ["/writing-plans"] }]);
    const commands = await listClaudeCommands(cwd(), SETTING_SOURCES);
    expect(commands).toEqual([
      { name: "simplify", description: "" },
      { name: "superpowers:writing-plans", description: "", aliases: ["writing-plans"] },
    ]);
  });

  it("answers a second ask from cache instead of spawning again", async () => {
    answer([{ name: "simplify" }]);
    const dir = cwd();
    expect(await listClaudeCommands(dir, SETTING_SOURCES)).toHaveLength(1);
    expect(await listClaudeCommands(dir, SETTING_SOURCES)).toHaveLength(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent asks — several tabs opening one task spawn one CLI", async () => {
    answer([{ name: "simplify" }]);
    const dir = cwd();
    const all = await Promise.all([
      listClaudeCommands(dir, SETTING_SOURCES),
      listClaudeCommands(dir, SETTING_SOURCES),
      listClaudeCommands(dir, SETTING_SOURCES),
    ]);
    expect(all.map((c) => c!.length)).toEqual([1, 1, 1]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("keys the cache on the sources too, not just the cwd", async () => {
    // Constant today — every caller passes the driver's SETTING_SOURCES — which
    // is exactly why keying on cwd alone would go wrong silently the first time
    // they aren't: 'project' decides whether the repo's .claude/commands load.
    answer([{ name: "everything" }], [{ name: "user-only" }]);
    const dir = cwd();
    expect((await listClaudeCommands(dir, SETTING_SOURCES))![0].name).toBe("everything");
    expect((await listClaudeCommands(dir, ["user"]))![0].name).toBe("user-only");
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("reports null when it could not find out, never an empty list", async () => {
    // An empty list and a failed spawn are the same shape and opposite facts.
    // The schedule validator turns absence into a refusal, so conflating them
    // settles a run `failed` for a command that exists.
    fail();
    expect(await listClaudeCommands(cwd(), SETTING_SOURCES)).toBeNull();
  });

  it("does not cache a failure — the next ask retries", async () => {
    const dir = cwd();
    fail();
    expect(await listClaudeCommands(dir, SETTING_SOURCES)).toBeNull();
    answer([{ name: "simplify" }]);
    expect(await listClaudeCommands(dir, SETTING_SOURCES)).toHaveLength(1);
  });

  it("falls back to a stale list when a refresh fails, but not under `refresh`", async () => {
    const dir = cwd();
    answer([{ name: "simplify" }]);
    expect(await listClaudeCommands(dir, SETTING_SOURCES)).toHaveLength(1);

    // Same cwd, TTL expired: the menu would rather show a minute-old list than
    // nothing…
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      fail();
      expect(await listClaudeCommands(dir, SETTING_SOURCES)).toHaveLength(1);
      // …but a caller about to turn absence into a refusal is asking whether
      // this command exists NOW, and a stale list cannot answer that.
      fail();
      expect(await listClaudeCommands(dir, SETTING_SOURCES, { refresh: true })).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("drops a `(MCP)` display label, which is not a name any session expands", async () => {
    // Only reachable if the isolation above stops working — but then it matters:
    // the CLI reports MCP prompts as `stash:analyze-performer (MCP)` and answers
    // "Unknown command" to `/stash:analyze-performer` (measured, CLI 2.1.240).
    // The invocable form comes from recordMcpPrompts instead.
    answer([{ name: "simplify" }, { name: "stash:analyze-performer (MCP)" }]);
    const commands = await listClaudeCommands(cwd(), SETTING_SOURCES);
    expect(commands!.map((c) => c.name)).toEqual(["simplify"]);
  });

  it("refresh bypasses a live cache entry", async () => {
    const dir = cwd();
    answer([{ name: "simplify" }], [{ name: "simplify" }, { name: "just-installed" }]);
    expect(await listClaudeCommands(dir, SETTING_SOURCES)).toHaveLength(1);
    expect(await listClaudeCommands(dir, SETTING_SOURCES, { refresh: true })).toHaveLength(2);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe("the driver's view of it", () => {
  it("records what a real turn's init reported, so the next menu has it", async () => {
    // The end of the wire this whole mechanism hangs on: a turn is the only
    // thing that ever sees an MCP prompt name, and it sees it here.
    const dir = cwd();
    const project = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "" } as Project;
    const task = { id: "t1", agent: "claude", title: "T", description: "", session_id: null, worktree_path: dir } as unknown as Task;
    queryMock.mockImplementationOnce(() =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s1", slash_commands: ["clear", "mcp__stash__discover-performers"] };
      })()
    );
    for await (const _ev of claudeDriver.runTurn(task, project, "hello")) void _ev;

    answer([{ name: "simplify" }]);
    const commands = await listClaudeCommands(dir, SETTING_SOURCES);
    expect(commands!.map((c) => c.name)).toEqual(["simplify", "mcp__stash__discover-performers"]);
  });


  it("degrades a failed probe to an empty menu, not a null", async () => {
    // The composer's contract is unchanged by the null above: a missing CLI
    // costs the menu its long tail and nothing else.
    fail();
    const project = { id: "p1", repo_path: cwd() } as Project;
    const task = { id: "t1", agent: "claude", worktree_path: null } as unknown as Task;
    expect(await claudeDriver.listCommands!(task, project)).toEqual([]);
  });
});

describe("MCP prompts observed on real turns", () => {
  // The probe cannot see these at all: they exist only on a session's init
  // message, and reading one means spawning the user's MCP fleet. A turn has
  // already spawned it, so the driver hands its list over and the menu merges
  // it in — see the header of lib/agents/claude/commands.ts.
  const SLASH = ["clear", "mcp__stash__discover-performers", "mcp__ha-mcp__ha_overview"];

  it("adds the mcp__ names to the menu, and only those", async () => {
    const dir = cwd();
    answer([{ name: "simplify" }]);
    recordMcpPrompts(dir, SETTING_SOURCES, SLASH);
    const commands = await listClaudeCommands(dir, SETTING_SOURCES);
    expect(commands).toEqual([
      { name: "simplify", description: "" },
      // Named exactly as the CLI expands them, and described by the server they
      // came from — the init message carries no description of its own.
      { name: "mcp__stash__discover-performers", description: "(stash) MCP prompt" },
      { name: "mcp__ha-mcp__ha_overview", description: "(ha-mcp) MCP prompt" },
    ]);
    // "clear" was in the same list and is NOT merged: everything the probe can
    // see is the probe's to report, with its real description.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("merges into a cached list without waiting out its TTL", async () => {
    const dir = cwd();
    answer([{ name: "simplify" }]);
    expect(await listClaudeCommands(dir, SETTING_SOURCES)).toHaveLength(1);
    // The first turn of a task lands after the menu has already been opened
    // once; making the user wait a minute for it would be the same bug.
    recordMcpPrompts(dir, SETTING_SOURCES, SLASH);
    expect(await listClaudeCommands(dir, SETTING_SOURCES)).toHaveLength(3);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the observation keyed to the cwd it was seen in", async () => {
    // MCP config is per-project as well as per-user, and every task worktree is
    // its own cwd — one task's servers are not another's.
    const mine = cwd();
    const theirs = cwd();
    recordMcpPrompts(mine, SETTING_SOURCES, SLASH);
    answer([{ name: "simplify" }], [{ name: "simplify" }]);
    expect(await listClaudeCommands(mine, SETTING_SOURCES)).toHaveLength(3);
    expect(await listClaudeCommands(theirs, SETTING_SOURCES)).toHaveLength(1);
  });

  it("replaces the previous observation, so a removed server stops being offered", async () => {
    const dir = cwd();
    recordMcpPrompts(dir, SETTING_SOURCES, SLASH);
    // The next turn's session no longer has stash configured. An empty list is
    // an observation like any other; the newest one wins outright.
    recordMcpPrompts(dir, SETTING_SOURCES, ["clear"]);
    answer([{ name: "simplify" }]);
    expect(await listClaudeCommands(dir, SETTING_SOURCES)).toHaveLength(1);
  });

  it("does not turn a failed probe into an answer", async () => {
    // null means "could not find out". The schedule validator turns a complete
    // list into a refusal, so a list that is only the MCP prompts we happen to
    // remember would refuse every real command in it.
    const dir = cwd();
    recordMcpPrompts(dir, SETTING_SOURCES, SLASH);
    fail();
    expect(await listClaudeCommands(dir, SETTING_SOURCES)).toBeNull();
  });

  it("ignores a message with no slash_commands field at all", async () => {
    // Not the same as a session with no MCP prompts: it's a shape we did not
    // expect, and forgetting what we know on account of it helps nobody.
    const dir = cwd();
    recordMcpPrompts(dir, SETTING_SOURCES, SLASH);
    recordMcpPrompts(dir, SETTING_SOURCES, undefined);
    answer([{ name: "simplify" }]);
    expect(await listClaudeCommands(dir, SETTING_SOURCES)).toHaveLength(3);
  });
});
