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
// One thing the mechanism genuinely cannot see, measured rather than assumed
// (CLI 2.1.228, a machine with four MCP servers exposing 16 prompts): MCP
// PROMPT commands — the `/mcp__<server>__<prompt>` form — are absent from
// `supportedCommands()` and present in the init message's `slash_commands`. Not
// a timing artifact and not strictMcpConfig: re-asking at 3s, 8s and 15s with
// the user's whole fleet inheritable returned the same 59 commands, byte for
// byte, and the init message never arrives at all while the prompt generator
// withholds (no turn, no init). Getting those names therefore costs a real
// prompt and a real MCP fleet spawn, which is the whole thing this path exists
// not to do — so callers that must not produce a false negative treat an absent
// `mcp__` command as unverifiable rather than unknown (see the schedule
// validator).

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
  __orchClaudeCommands?: Map<string, Entry>;
  __orchClaudeCommandsInFlight?: Map<string, Promise<AgentCommand[] | null>>;
};
const cache = (g.__orchClaudeCommands ??= new Map());
const inFlight = (g.__orchClaudeCommandsInFlight ??= new Map());

const cacheKey = (cwd: string, settingSources: SettingSource[]) => `${settingSources.join(",")} @ ${cwd}`;

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
        // No MCP for a question about commands. Verified against CLI 2.1.228
        // that this changes NOTHING about the answer — the same 59 commands
        // come back with and without it, so plugin *commands* don't travel with
        // plugin MCP config — while keeping a keystroke-triggered call from
        // spawning the user's whole server fleet (measured elsewhere in this
        // driver at 10 servers / ~8s).
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
    return commands.map((c) => ({
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
    if (hit && Date.now() - hit.at < TTL_MS) return hit.commands;
  }

  const commands = await startEnumeration(key, cwd, settingSources);
  if (commands) return commands;
  return refresh ? null : (cache.get(key)?.commands ?? null);
}
