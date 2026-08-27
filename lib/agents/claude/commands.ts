// Enumerating the slash commands a Claude task session would expand.
//
// The composer's "/" menu used to be a hardcoded one-element list, so the 58
// other commands a session actually honors — the user's skills, their plugin
// commands, the repo's .claude/commands, the CLI's built-ins — were invisible
// even though typing one in full worked fine. This is the discovery half: ask
// the CLI what it has rather than maintaining a list that can only rot.
//
// The mechanism is the SDK's own control channel. `supportedCommands()` is
// answered during session INITIALIZATION: we hand query() a prompt generator
// that never yields, read the answer, and tear the process down. No model
// request is ever sent — nothing is billed and the transcript is untouched.
//
// "No model request" is not "nothing happens", though, and the difference is
// what the options below are for. Initialization is a real session startup, so
// with the user's setting sources loaded a SessionStart hook would fire — on a
// keystroke, repeatedly, running whatever the user's hook runs. Discovery
// therefore takes the same shape as the one-shots in driver.ts: inherit the
// CONFIG that decides the answer (settingSources — the menu has to describe the
// commands a REAL turn would honor, so this list must match the turn's), and
// isolate everything else.
//
// This is the app's ONLY slash-command enumeration. lib/schedule/commands.ts
// used to have a second one (send "noop", read `slash_commands` off the init
// message) which answered the same question with none of the isolation above —
// firing the user's SessionStart hooks unattended inside the scheduler's sweep,
// on every save and every fire. Two implementations of one question is how the
// composer's menu and the schedule validator come to disagree, and a
// disagreement there means the editor rejects a command the menu offers.
//
// MCP PROMPT commands — the `/mcp__<server>__<prompt>` form — are the one thing
// this probe cannot see, and that is a CONSEQUENCE OF THE ISOLATION rather than
// a gap in the SDK. Measured on CLI 2.1.240 / SDK 0.3.159, in a checkout with
// fifteen MCP servers configured:
//
//   - A probe that inherits the user's MCP config DOES report them, but under a
//     display label — `stash:analyze-performer (MCP)`, not the token a session
//     expands. Verified with a UserPromptExpansion hook:
//     `/mcp__stash__discover-performers` expands (`expansion_type: "mcp_prompt"`)
//     while `/stash:discover-performers` answers "Unknown command".
//   - The list is FROZEN AT INITIALIZATION. Asked again at 4s, 9s and 20s on one
//     long-lived session it stayed at the same 82 commands while eleven more
//     servers finished connecting — MCP startup is non-blocking, so only the
//     servers that connect inside the ~700ms startup window contribute prompts
//     at all (three of fifteen did).
//
// So loosening the isolation would spawn the user's whole fleet on a menu read
// AND still answer with a racy subset of it. The names come from the sessions
// that already paid for that fleet instead: a real turn's `init` message
// carries `slash_commands` with the `mcp__` forms in it, and the driver hands
// them to recordMcpPrompts() below, which listClaudeCommands() merges in. Free,
// exactly the token the CLI expands — and bounded by what it is: a task offers
// no MCP prompts until its first turn has run, and offers whatever that turn's
// session saw. The schedule validator's probe is keyed to the project's repo,
// where no turn runs, so it still treats an absent `mcp__` command as
// unverifiable rather than unknown.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCommand } from "../types";
import { CLAUDE_CLI_PATH } from "../../config";

// How long a resolved list is reused. Commands change when the user edits a
// file on disk (a new .claude/commands entry, an installed plugin), which is
// rare and never mid-keystroke — but "rare" isn't "never", so this is a short
// TTL rather than a process-lifetime cache. A stale entry costs the user one
// menu that's a minute out of date; the floor on that is the whole reason not
// to cache forever.
const TTL_MS = 60_000;

// A hung CLI must not hang the menu. The measured cost of a real enumeration is
// ~330ms (see the note on strictMcpConfig below), so this is generous by an
// order of magnitude and only ever fires on a genuinely wedged process.
//
// This is the ENUMERATION's deadline, not any one caller's, and deliberately
// not a parameter: several callers share one in-flight probe, so a caller's
// deadline expiring must not kill a probe the others are still waiting on. A
// caller that needs a tighter bound than this races the returned promise
// against its own clock (lib/schedule/commands.ts does; SCHEDULE_PROBE_MS is
// 20s, so in the default configuration this fires first and the child dies
// here rather than being left to the backstop).
const TIMEOUT_MS = 15_000;

// Most cache entries are a worktree, and worktrees are per task — an instance
// that's been up for weeks would otherwise accumulate one entry per task ever
// opened, including the deleted ones. Small enough to be free, large enough
// that no realistic session evicts a task the user is still typing in (the
// schedule validator's project repo paths are a handful on top of that).
const MAX_ENTRIES = 64;

type Entry = { at: number; commands: AgentCommand[] };

// HMR-surviving, like every other piece of long-lived server state in this app
// (lib/events.ts, lib/abort.ts, lib/asks.ts). Keyed by cwd AND setting sources,
// because those are the two inputs that change the answer: a task's worktree
// decides which project-level .claude/commands are in scope, and the sources
// decide whether project-level ones are read at all. Sources are a constant
// today (every caller passes the driver's SETTING_SOURCES), which is exactly
// why keying on cwd alone would go wrong silently the first time they aren't.
const g = globalThis as unknown as {
  __calandriaClaudeCommands?: Map<string, Entry>;
  __calandriaClaudeCommandsInFlight?: Map<string, Promise<AgentCommand[] | null>>;
  __calandriaClaudeMcpPrompts?: Map<string, Entry>;
};
const cache = (g.__calandriaClaudeCommands ??= new Map());
const inFlight = (g.__calandriaClaudeCommandsInFlight ??= new Map());
// The MCP prompts observed on real turns, same key, same cap — see the header.
// Deliberately WITHOUT a TTL: the probe's entries expire because a fresh probe
// can always be run, and nothing can refresh these but another turn, so expiry
// would only ever throw away the single source there is.
const mcpPrompts: Map<string, Entry> = (g.__calandriaClaudeMcpPrompts ??= new Map());

const cacheKey = (cwd: string, settingSources: SettingSource[]) => `${settingSources.join(",")} @ ${cwd}`;

/** The `(MCP)` display label the CLI reports for a prompt when MCP is loaded. */
const MCP_LABEL = / \(MCP\)$/;
const MCP_PREFIX = "mcp__";

/**
 * An `mcp__<server>__<prompt>` name as a menu row. The init message carries the
 * name and nothing else, so the description is synthesized — in the CLI's own
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
        // The one thing that IS inherited, because it's what decides the
        // answer: the same sources a real turn loads (SETTING_SOURCES in
        // driver.ts). A narrower list here would make the menu describe a
        // session the user is not going to get.
        settingSources,
        pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
        abortController: abort,
        // No MCP for a question about commands, so a keystroke-triggered call
        // never spawns the user's server fleet (measured elsewhere in this
        // driver at 10 servers / ~8s). What that costs is exactly the MCP
        // prompt rows and nothing else: re-measured on CLI 2.1.240, the same
        // list comes back with and without it apart from those (a checkout with
        // no MCP prompts published: 70 commands either way; one with four:
        // 78 against 82, the diff being those four). Plugin *commands* still
        // don't travel with plugin MCP config. See the header for why the fleet
        // is not the way to get the prompts back.
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
      // a DISPLAY label, not a command: typing `/stash:discover-performers` gets
      // "Unknown command" from the same CLI that reports it. Dropping it costs
      // nothing — the invocable form arrives via recordMcpPrompts — while
      // keeping it would put a name in the menu that inserting can only break.
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
 * Record the MCP prompt commands a REAL session reported on its `init` message,
 * so the menu can offer what the probe structurally cannot see (header).
 *
 * Called by the driver for every turn, which is what keeps this honest: the
 * newest observation replaces the previous one wholesale, so a server the user
 * removed stops being offered after the next turn rather than lingering until a
 * restart. An empty list IS an observation — a session with no MCP prompts is a
 * fact worth recording — but a message without the field at all is not, since
 * that's an SDK shape we didn't expect rather than a session without prompts.
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
  // Re-insert so the eviction below drops the least recently OBSERVED entry —
  // most keys here are task worktrees, and an instance up for weeks would
  // otherwise accumulate one per task ever run, deleted ones included.
  mcpPrompts.delete(key);
  mcpPrompts.set(key, { at: Date.now(), commands });
  while (mcpPrompts.size > MAX_ENTRIES) mcpPrompts.delete(mcpPrompts.keys().next().value as string);
}

/**
 * The probe's answer plus any MCP prompts observed for the same key.
 *
 * Merged at READ time rather than into the cache entry, so a prompt observed on
 * a turn shows up in the very next menu instead of waiting out the probe's TTL.
 * `null` is passed straight through: it means "we could not find out", and an
 * observation from an earlier session is not an answer to that question — the
 * validator would read the list as complete and refuse a real command.
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
 * what a failure means, because they don't agree — see listClaudeCommands.
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
      // least recently RESOLVED entry rather than an arbitrary one.
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
 * check" rather than "that command doesn't exist" — reading a dead login as an
 * empty registry there settles a scheduled run `failed` and mints nothing,
 * every morning, for a command that is in fact registered.
 *
 * MCP prompts are folded in from what real turns in the same cwd reported (see
 * recordMcpPrompts), because no probe cheap enough to run here can see them.
 *
 * Cached with a short TTL and deduped while in flight, because this is called
 * from a UI keystroke: several tabs opening the same task must not each spawn a
 * CLI, and several schedules on one project must not each spawn one inside a
 * single sweep.
 *
 * `refresh` bypasses the TTL and, on failure, refuses the stale entry too — for
 * the caller that is about to turn "absent from this list" into a refusal and
 * needs the absence to be a fact rather than a fact from a minute ago.
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
