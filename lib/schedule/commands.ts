// Slash-command validation for schedule prompts.
//
// A scheduled prompt is typically a skill invocation like "/jira-tasks", and
// the slash form matters: the CLI EXPANDS it textually before the model sees it
// (verified — zero tool calls, the skill body becomes the prompt), whereas the
// bare name makes the model notice a name and choose to call the Skill tool.
// Only the first belongs in unattended work.
//
// The hazard is that an unregistered command is NOT an error. The CLI answers
// "Unknown command: /x. Did you mean …?" with subtype "success", is_error
// false, and no tool calls — so a typo'd schedule would record `succeeded` with
// an empty tray, and the user would conclude Jira had nothing for them. A
// silent skip wearing a green check.
//
// The guard is free: enumerating a session's commands costs no model request at
// all. This file does not do that enumeration — lib/agents/claude/commands.ts
// does, for the composer's "/" menu too, and asking it is the entire point.
// There used to be a second implementation here (send "noop", read
// `slash_commands` off the init message) which answered the same question with
// none of that one's isolation: it ran the user's SessionStart hooks on every
// save and every fire, unattended, inside the ticker's single-flight sweep; it
// left an unresumable session in ~/.claude/projects each time; and it had no
// cache, so a validate-per-blur editor paid a cold spawn per keystroke. What
// remains here is the SCHEDULE'S half — which token is a command, what to do
// when it isn't in the list, and the hard time bound the sweep needs.

import { SCHEDULE_PROBE_MS } from "@/lib/config";
import { SETTING_SOURCES } from "@/lib/agents/claude/driver";
import { listClaudeCommands } from "@/lib/agents/claude/commands";
import type { Project } from "@/lib/types";

/**
 * The command a prompt invokes, or null when it isn't a slash prompt.
 *
 * A token followed by `/` is a PATH, not a command: "/etc/passwd, tell me
 * what's in it" is an ordinary prompt about a file, and reading it as the
 * command "etc" is a false positive with teeth — the same validator runs again
 * at fire time (lib/scheduler.ts), where an unknown command settles the run
 * `failed` and mints nothing. So the prompt would save fine and then fail every
 * morning. Slash commands never contain a path separator, so excluding the
 * followed-by-`/` case costs nothing and closes the whole class.
 *
 * (Spelled as a trailing capture rather than a negative lookahead: `[A-Za-z0-9_:-]+(?!\/)`
 * backtracks the token one character shorter and matches "et" instead of failing.)
 */
export function slashCommandOf(prompt: string): string | null {
  const m = /^\s*\/([A-Za-z0-9_:-]+)(\/?)/.exec(prompt);
  if (!m || m[2] === "/") return null;
  return m[1];
}

/** Exact match only — a near miss is what this exists to catch. */
export const isRegistered = (command: string, registry: string[]): boolean => registry.includes(command);

/**
 * Registered commands that look like what was typed, for the editor's "did you
 * mean". Matches on suffix (a plugin namespace the user omitted) or a small
 * edit distance (a typo).
 */
export function suggestionsFor(command: string, registry: string[]): string[] {
  const lower = command.toLowerCase();
  return registry
    .filter((r) => {
      const rl = r.toLowerCase();
      return rl.endsWith(`:${lower}`) || rl.includes(lower) || editDistance(rl, lower) <= 2;
    })
    .slice(0, 5);
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * A command the shared probe structurally cannot see, so its absence from the
 * registry proves nothing.
 *
 * MCP servers publish prompts as `/mcp__<server>__<prompt>`, and those names
 * live only on a session's `init` message — never in `supportedCommands()`,
 * which is what the probe reads (measured on CLI 2.1.228: 16 such prompts, 0 of
 * them returned, unchanged by strictMcpConfig and unchanged 15s in). A
 * scheduled turn DOES inherit the user's MCP servers and would expand them, so
 * rejecting one here would fail a working job every morning. Reading them costs
 * a real prompt plus the user's whole server fleet spawning unattended, which
 * is the trade this path exists to refuse — so they come back `unchecked`.
 */
const isMcpPrompt = (command: string) => command.startsWith("mcp__");

/**
 * The slash commands a session in this project would have. Costs no tokens.
 * Best-effort — on any failure the caller degrades to "can't check" rather than
 * blocking the user.
 *
 * BOUNDED, and that is not a nicety. This runs inside fireSchedule(), which runs
 * inside tickSchedules()'s single-flight sweep: an unbounded read on a stalled
 * CLI (a hung transport, a binary waiting on something that never arrives)
 * leaves `ticking` true forever and every schedule on the instance silently
 * stops firing — with no error, because nothing ever threw.
 *
 * Two bounds, and they COMPOSE rather than one replacing the other. The probe
 * owns an abort on its own 15s deadline, which kills the child; the race below
 * owns this caller's deadline, which does not depend on the SDK honoring
 * anything. The inner one is the shorter of the two by default (15s against
 * SCHEDULE_PROBE_MS's 20s), so the ordinary stall is cleaned up properly and
 * this race is the backstop for an SDK that ignores its own signal. Aborting
 * from here is deliberately NOT done: several schedules on one project share
 * one in-flight probe, and one caller's deadline must not kill it out from
 * under the others.
 */
export async function listSlashCommands(
  project: Project,
  agent: string,
  timeoutMs = SCHEDULE_PROBE_MS,
  { refresh = false }: { refresh?: boolean } = {}
): Promise<string[] | null> {
  if (agent !== "claude") return null; // only the Claude CLI has this surface
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(1, timeoutMs));
    timer.unref?.();
  });
  try {
    // The driver's own SETTING_SOURCES, and the driver's own probe: validating
    // against a different registry than the scheduled turn actually gets would
    // settle a run `failed` and mint nothing on a command that really is
    // registered. Pinned by tests/claudeSettingSources.test.ts.
    const commands = await Promise.race([
      listClaudeCommands(project.repo_path || process.cwd(), SETTING_SOURCES, { refresh }),
      giveUp,
    ]);
    if (!commands) return null;
    // Aliases are registrations too — the CLI resolves /writing-plans to
    // superpowers:writing-plans — and a false rejection here is the expensive
    // kind, so they count.
    return [...new Set(commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]))];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface PromptValidation {
  ok: boolean;
  /** Set when the prompt names a command that isn't registered. */
  error?: string;
  suggestions?: string[];
  /** True when we could not reach the registry — save is allowed, with a note. */
  unchecked?: boolean;
  /** Why it went unchecked, when the reason isn't "the probe failed". */
  note?: string;
}

/**
 * Validate a schedule's prompt. Non-slash prompts are always fine.
 *
 * The two verdicts are not symmetric, and the asymmetry is the design. "It's in
 * the list" is cheap and safe to answer from a cached read. "It isn't in the
 * list" is a refusal that, at fire time, settles the run `failed` and mints
 * nothing — so it's re-read fresh before it's said, since the registry is
 * cached for a minute and a command installed inside that minute would
 * otherwise be refused for existing too recently.
 *
 * Both reads share ONE deadline. Two sequential probes each bounded by
 * SCHEDULE_PROBE_MS would bound this at twice it, and the bound is what keeps a
 * stalled CLI from wedging the sweep.
 */
export async function validatePrompt(
  prompt: string,
  project: Project,
  agent: string,
  timeoutMs = SCHEDULE_PROBE_MS
): Promise<PromptValidation> {
  const command = slashCommandOf(prompt);
  if (!command) return { ok: true };
  const deadline = Date.now() + timeoutMs;

  const registry = await listSlashCommands(project, agent, timeoutMs);
  if (!registry) return { ok: true, unchecked: true };
  if (isRegistered(command, registry)) return { ok: true };
  if (isMcpPrompt(command)) {
    return {
      ok: true,
      unchecked: true,
      note: `/${command} looks like an MCP prompt, which this check can't see. Saving without verifying.`,
    };
  }

  const fresh = await listSlashCommands(project, agent, deadline - Date.now(), { refresh: true });
  if (!fresh) return { ok: true, unchecked: true };
  if (isRegistered(command, fresh)) return { ok: true };
  return {
    ok: false,
    error: `/${command} is not a command this project's sessions have. An unknown command does not fail — the run would report success having done nothing.`,
    suggestions: suggestionsFor(command, fresh),
  };
}
