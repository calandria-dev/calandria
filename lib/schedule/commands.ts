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
// The guard is free: the session's `init` message carries the whole registry
// and arrives BEFORE any model call (~1.5s), so we start a session, read the
// list, and abandon it without spending a token.

import type { Project } from "@/lib/types";

/** The command a prompt invokes, or null when it isn't a slash prompt. */
export function slashCommandOf(prompt: string): string | null {
  const m = /^\s*\/([A-Za-z0-9_:-]+)/.exec(prompt);
  return m ? m[1] : null;
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
 * The slash commands a session in this project would have. Costs no tokens: we
 * read the init message and abandon the session before the model is called.
 * Best-effort — on any failure the caller degrades to "can't check" rather than
 * blocking the user.
 */
export async function listSlashCommands(project: Project, agent: string): Promise<string[] | null> {
  if (agent !== "claude") return null; // only the Claude CLI has this surface
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const session = query({
      prompt: "noop",
      options: {
        cwd: project.repo_path || process.cwd(),
        // Must match the driver's SETTING_SOURCES, or we'd validate against a
        // different set of commands than the scheduled turn actually gets.
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
      },
    });
    let commands: string[] | null = null;
    for await (const message of session) {
      if (message.type === "system" && message.subtype === "init") {
        commands = (message as { slash_commands?: string[] }).slash_commands ?? [];
        break;
      }
      if (message.type === "assistant") break; // shouldn't happen; don't spend a turn
    }
    await session.interrupt?.().catch(() => {});
    return commands;
  } catch {
    return null;
  }
}

export interface PromptValidation {
  ok: boolean;
  /** Set when the prompt names a command that isn't registered. */
  error?: string;
  suggestions?: string[];
  /** True when we could not reach the registry — save is allowed, with a note. */
  unchecked?: boolean;
}

/** Validate a schedule's prompt. Non-slash prompts are always fine. */
export async function validatePrompt(prompt: string, project: Project, agent: string): Promise<PromptValidation> {
  const command = slashCommandOf(prompt);
  if (!command) return { ok: true };
  const registry = await listSlashCommands(project, agent);
  if (!registry) return { ok: true, unchecked: true };
  if (isRegistered(command, registry)) return { ok: true };
  return {
    ok: false,
    error: `/${command} is not a command this project's sessions have. An unknown command does not fail — the run would report success having done nothing.`,
    suggestions: suggestionsFor(command, registry),
  };
}
