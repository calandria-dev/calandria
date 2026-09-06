// Enumerating the slash commands a Claude task session would expand.
//
// The composer's "/" menu previously listed only "/clear", so skills, plugin
// commands, the repo's .claude/commands, and the CLI's built-ins were invisible
// even though typing one in full worked. This asks the CLI what it has instead
// of maintaining a list that can only rot.
//
// The mechanism is the SDK's own control channel. `supportedCommands()` is
// answered during session initialization: query() is handed a prompt generator
// that never yields, the answer is read, and the process is torn down. No
// model request is sent, so nothing is billed and the transcript is untouched.
//
// "No model request" is not "nothing happens", though. Initialization is a
// real session startup, so with the user's setting sources loaded a
// SessionStart hook would fire on every keystroke. Discovery therefore takes
// the same shape as the one-shots in driver.ts: inherit the config that
// decides the answer (settingSources, so the menu matches what a real turn
// would honor) and isolate everything else.
//
// This is the app's only slash-command enumeration. lib/schedule/commands.ts
// used to have a second one (send "noop", read `slash_commands` off the init
// message) that answered the same question with none of the isolation above,
// firing the user's SessionStart hooks unattended inside the scheduler's sweep
// on every save and every fire. Two implementations of one question is how the
// composer's menu and the schedule validator came to disagree.
//
// MCP prompt commands (the `/mcp__<server>__<prompt>` form) are the one thing
// this probe cannot see, a consequence of the isolation rather than a gap in
// the SDK:
//
//   - A probe that inherits the user's MCP config does report them, but under a
//     display label ("stash:analyze-performer (MCP)") rather than the token a
//     session actually expands; typing that label answers "Unknown command".
//   - The list is frozen at initialization, so only servers that connect
//     inside the startup window contribute prompts at all.
//
// So loosening the isolation would spawn the user's whole MCP fleet on a menu
// read and still answer with a racy subset of it. The names come from the
// sessions that already paid for that fleet instead: a real turn's `init`
// message carries `slash_commands` with the `mcp__` forms in it, and the driver
// hands them to recordMcpPrompts() below, which listClaudeCommands() merges in.
// That's the same token the CLI expands, bounded by what it is: a task offers
// no MCP prompts until its first turn has run, and offers whatever that turn's
// session saw. The schedule validator's probe is keyed to the project's repo,
// where no turn runs, so it treats an absent `mcp__` command as unverifiable
// rather than unknown.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCommand } from "../types";
import { CLAUDE_CLI_PATH } from "../../config";

// How long a resolved list is reused. Commands change when the user edits a
// file on disk (a new .claude/commands entry, an installed plugin), which is
// rare but not never, so this is a short TTL rather than a process-lifetime
// cache. A stale entry costs the user a menu that's at most a minute out of
// date.
const TTL_MS = 60_000;

// A hung CLI must not hang the menu. A real enumeration costs on the order of
// a few hundred milliseconds (see the note on strictMcpConfig below), so this
// is generous by an order of magnitude and only fires on a genuinely wedged
// process.
//
// This is the enumeration's deadline, not any one caller's, and is not a
// parameter: several callers share one in-flight probe, so a caller's own
// deadline expiring must not kill a probe the others are still waiting on. A
// caller that needs a tighter bound races the returned promise against its own
// clock (lib/schedule/commands.ts does, with a shorter bound, so in the default
// configuration this fires first and the child dies here rather than being
// left to the backstop).
const TIMEOUT_MS = 15_000;

// Most cache entries are a worktree, and worktrees are per task, so a
// long-lived instance would otherwise accumulate one entry per task ever
// opened, including deleted ones. Small enough to be free, large enough that no
// realistic session evicts a task the user is still typing in (the schedule
// validator's project repo paths add a handful on top of that).
const MAX_ENTRIES = 64;

type Entry = { at: number; commands: AgentCommand[] };

// HMR-surviving, like every other piece of long-lived server state in this app
// (lib/events.ts, lib/abort.ts, lib/asks.ts). Keyed by cwd and setting sources,
// because those are the two inputs that change the answer: a task's worktree
// decides which project-level .claude/commands are in scope, and the sources
// decide whether project-level ones are read at all. Sources are a constant
// today (every caller passes the driver's SETTING_SOURCES), so keying on cwd
// alone would go wrong the first time they aren't.
const g = globalThis as unknown as {
  __calandriaClaudeCommands?: Map<string, Entry>;
  __calandriaClaudeCommandsInFlight?: Map<string, Promise<AgentCommand[] | null>>;
  __calandriaClaudeMcpPrompts?: Map<string, Entry>;
};
const cache = (g.__calandriaClaudeCommands ??= new Map());
const inFlight = (g.__calandriaClaudeCommandsInFlight ??= new Map());
// The MCP prompts observed on real turns, same key, same cap; see the header.
// Without a TTL, unlike the probe's entries: a fresh probe can always be run,
// but nothing can refresh these but another turn, so expiry would only ever
// throw away the single source there is.
const mcpPrompts: Map<string, Entry> = (g.__calandriaClaudeMcpPrompts ??= new Map());

const cacheKey = (cwd: string, settingSources: SettingSource[]) => `${settingSources.join(",")} @ ${cwd}`;

/** The `(MCP)` display label the CLI reports for a prompt when MCP is loaded. */
const MCP_LABEL = / \(MCP\)$/;
const MCP_PREFIX = "mcp__";

/**
 * An `mcp__<server>__<prompt>` name as a menu row. The init message carries the
 * name and nothing else, so the description is synthesized in the CLI's own
 * idiom for a command that came from somewhere (`(claude-mem) Watch a pull
 * request…`), since the one thing worth saying about these is which server the
 * prompt belongs to.
 */
function mcpPromptCommand(name: string): AgentCommand {
  const server = name.slice(MCP_PREFIX.length).split("__")[0];
  return { name, description: server ? `(${server}) MCP prompt` : "MCP prompt" };
}

async function enumerate(cwd: string, settingSources: SettingSource[]): Promise<AgentCommand[]> {
  const abort = new AbortController();
  // unref'd: this is a watchdog on a background probe, not work anyone is owed.
  // The server's own listeners hold the loop open; a short-lived process (the
  // suite, a script) should be free to exit without waiting out the deadline.
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  timer.unref?.();
  let q: ReturnType<typeof query> | null = null;
  try {
    q = query({
      // Never yields, so the CLI initializes and then waits. Initialization is
      // all we need; the teardown in `finally` ends the process.
      prompt: (async function* () {
        await new Promise<void>(() => {});
      })(),
      options: {
        cwd,
        // The one thing that is inherited, because it's what decides the
        // answer: the same sources a real turn loads (SETTING_SOURCES in
        // driver.ts). A narrower list here would describe a session the user
        // is not going to get.
        settingSources,
        pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
        abortController: abort,
        // No MCP for a question about commands, so a keystroke-triggered call
        // never spawns the user's server fleet. What that costs is exactly the
        // MCP prompt rows and nothing else: the rest of the command list is the
        // same with or without it. Plugin commands still don't travel with
        // plugin MCP config. See the header for why the fleet is not the way to
        // get the prompts back.
        strictMcpConfig: true,
        mcpServers: {},
        // A SessionStart hook fires on initialization whether or not a turn
        // follows. Left on, every "/" keystroke would run the user's hooks.
        settings: { disableAllHooks: true },
        // Discovery is not a conversation; without this it litters the user's
        // own ~/.claude/projects with unresumable empty sessions.
        persistSession: false,
      },
    });
    const commands = await q.supportedCommands();
    return commands
      // A `… (MCP)` row can only appear if the isolation above stopped working
      // (a future SDK ignoring strictMcpConfig, a fork that drops it), and it is
      // a display label, not a command: typing `/stash:discover-performers`
      // gets "Unknown command" from the same CLI that reports it. Dropping it
      // costs nothing, since the invocable form arrives via recordMcpPrompts,
      // while keeping it would put a name in the menu that inserting can only
      // break.
      .filter((c) => !MCP_LABEL.test(c.name))
      .map((c) => ({
      name: c.name.replace(/^\//, ""),
      description: c.description ?? "",
      ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      ...(c.aliases?.length ? { aliases: c.aliases.map((a) => a.replace(/^\//, "")) } : {}),
    }));
  } finally {
    clearTimeout(timer);
    // Both halves matter: abort releases our never-yielding prompt iterable,
    // close() is the SDK's own "kill the subprocess" API. Aborting alone can
    // leave the child parked, and this runs on a keystroke.
    abort.abort();
    q?.close();
  }
}

/**
 * Record the MCP prompt commands a real session reported on its `init` message,
 * so the menu can offer what the probe structurally cannot see (header).
 *
 * Called by the driver for every turn: the newest observation replaces the
 * previous one wholesale, so a server the user removed stops being offered
 * after the next turn rather than lingering until a restart. An empty list is
 * an observation, since a session with no MCP prompts is a fact worth
 * recording, but a message without the field at all is not, since that's an
 * unexpected SDK shape rather than a session without prompts.
 */
export function recordMcpPrompts(
  cwd: string,
  settingSources: SettingSource[],
  slashCommands: readonly string[] | undefined
): void {
  if (!Array.isArray(slashCommands)) return;
  const commands = slashCommands
    .map((c) => String(c).replace(/^\//, "").trim())
    .filter((c) => c.startsWith(MCP_PREFIX))
    .map(mcpPromptCommand);
  const key = cacheKey(cwd, settingSources);
  // Re-insert so the eviction below drops the least recently observed entry.
  // Most keys here are task worktrees, and a long-lived instance would
  // otherwise accumulate one per task ever run, deleted ones included.
  mcpPrompts.delete(key);
  mcpPrompts.set(key, { at: Date.now(), commands });
  while (mcpPrompts.size > MAX_ENTRIES) mcpPrompts.delete(mcpPrompts.keys().next().value as string);
}

/**
 * The probe's answer plus any MCP prompts observed for the same key.
 *
 * Merged at read time rather than into the cache entry, so a prompt observed on
 * a turn shows up in the very next menu instead of waiting out the probe's TTL.
 * `null` is passed straight through: it means "we could not find out", and an
 * observation from an earlier session is not an answer to that question, since
 * the validator would then read the list as complete and refuse a real
 * command.
 */
function withMcpPrompts(key: string, commands: AgentCommand[] | null): AgentCommand[] | null {
  if (!commands) return null;
  const observed = mcpPrompts.get(key)?.commands ?? [];
  const have = new Set(commands.map((c) => c.name));
  const extra = observed.filter((c) => !have.has(c.name));
  return extra.length ? [...commands, ...extra] : commands;
}

/**
 * One enumeration per (cwd, sources), shared by everyone who asks while it is
 * running. Resolves to `null` on failure and never rejects; the caller decides
 * what a failure means, since callers don't agree on that; see
 * listClaudeCommands.
 */
function startEnumeration(
  key: string,
  cwd: string,
  settingSources: SettingSource[]
): Promise<AgentCommand[] | null> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = enumerate(cwd, settingSources)
    .then((commands) => {
      // Re-insert to make this the newest key, so the eviction below drops the
      // least recently resolved entry rather than an arbitrary one.
      cache.delete(key);
      cache.set(key, { at: Date.now(), commands });
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      return commands;
    })
    // Don't cache a failure: the next keystroke should retry, not inherit a
    // minute of emptiness from one bad spawn.
    .catch(() => null)
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, run);
  return run;
}

/**
 * The slash commands a Claude session rooted at `cwd` would expand, or `null`
 * when we could not find out.
 *
 * That distinction is the contract. An empty list and a failed spawn are the
 * same shape and opposite facts, and the two callers need opposite things from
 * them: the composer's menu degrades to Calandria's own commands either way
 * (`?? []` at the driver), while the schedule validator must say "couldn't
 * check" rather than "that command doesn't exist", since reading a dead login
 * as an empty registry there would settle a scheduled run `failed` and mint
 * nothing for a command that is in fact registered.
 *
 * MCP prompts are folded in from what real turns in the same cwd reported (see
 * recordMcpPrompts), because no probe cheap enough to run here can see them.
 *
 * Cached with a short TTL and deduped while in flight, because this is called
 * from a UI keystroke: several tabs opening the same task must not each spawn a
 * CLI, and several schedules on one project must not each spawn one inside a
 * single sweep.
 *
 * `refresh` bypasses the TTL and, on failure, refuses the stale entry too, for
 * the caller that is about to turn "absent from this list" into a refusal and
 * needs the absence to be a current fact rather than a fact from a minute ago.
 */
export async function listClaudeCommands(
  cwd: string,
  settingSources: SettingSource[],
  { refresh = false }: { refresh?: boolean } = {}
): Promise<AgentCommand[] | null> {
  const key = cacheKey(cwd, settingSources);
  if (!refresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return withMcpPrompts(key, hit.commands);
  }

  const commands = await startEnumeration(key, cwd, settingSources);
  if (commands) return withMcpPrompts(key, commands);
  return refresh ? null : withMcpPrompts(key, cache.get(key)?.commands ?? null);
}
