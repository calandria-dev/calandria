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
const TIMEOUT_MS = 15_000;

// Cache entries are keyed by worktree, and worktrees are per task — an instance
// that's been up for weeks would otherwise accumulate one entry per task ever
// opened, including the deleted ones. Small enough to be free, large enough
// that no realistic session evicts a task the user is still typing in.
const MAX_ENTRIES = 64;

type Entry = { at: number; commands: AgentCommand[] };

// HMR-surviving, like every other piece of long-lived server state in this app
// (lib/events.ts, lib/abort.ts, lib/asks.ts). Keyed by cwd because that IS the
// input that changes the answer: a task's worktree decides which project-level
// .claude/commands are in scope.
const g = globalThis as unknown as {
  __orchClaudeCommands?: Map<string, Entry>;
  __orchClaudeCommandsInFlight?: Map<string, Promise<AgentCommand[]>>;
};
const cache = (g.__orchClaudeCommands ??= new Map());
const inFlight = (g.__orchClaudeCommandsInFlight ??= new Map());

async function enumerate(cwd: string, settingSources: SettingSource[]): Promise<AgentCommand[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
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
 * The slash commands a Claude session rooted at `cwd` would expand.
 *
 * Cached with a short TTL and deduped while in flight, because this is called
 * from a UI keystroke: several tabs opening the same task must not each spawn a
 * CLI. Best-effort by contract — a missing CLI, a dead login or a wedged
 * process resolves to an empty list, which degrades the menu to Operator's own
 * commands rather than failing the composer.
 */
export async function listClaudeCommands(cwd: string, settingSources: SettingSource[]): Promise<AgentCommand[]> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.commands;

  const pending = inFlight.get(cwd);
  if (pending) return pending;

  const run = enumerate(cwd, settingSources)
    .then((commands) => {
      // Re-insert to make this the newest key, so the eviction below drops the
      // least recently RESOLVED entry rather than an arbitrary one.
      cache.delete(cwd);
      cache.set(cwd, { at: Date.now(), commands });
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      return commands;
    })
    .catch(() => {
      // Don't cache a failure: the next keystroke should retry, not inherit a
      // minute of emptiness from one bad spawn.
      const stale = cache.get(cwd);
      return stale?.commands ?? [];
    })
    .finally(() => {
      inFlight.delete(cwd);
    });

  inFlight.set(cwd, run);
  return run;
}
