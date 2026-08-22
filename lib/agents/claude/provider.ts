// Which backend Claude Code is configured to talk to, read from the same places
// Claude Code itself reads. SDK-free by construction (node fs/os/path only), so
// lib/agents/capabilities.ts can import it without dragging the Agent SDK into
// the graph — see the poisoning note in that file.
//
// Calandria never invents provider config of its own: it reads what the CLI will
// use, so the app and the agent can't disagree about which backend a turn runs
// on or which model an alias resolves to.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

type Env = Record<string, string | undefined>;

const enabled = (value: unknown) => ["1", "true", "on"].includes(String(value ?? "").toLowerCase());

function readClaudeSettings(env: Env): { env?: Record<string, unknown> } | null {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The env block from ~/.claude/settings.json, stringified — the variables
 *  Claude Code injects into its own session (provider selection, project/region,
 *  model mappings). */
export function claudeSettingsEnv(env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const block = readClaudeSettings(env)?.env;
  if (block && typeof block === "object") {
    for (const [k, v] of Object.entries(block)) if (v != null) out[k] = String(v);
  }
  return out;
}

// A config value Claude Code would see. The settings.json env block wins over
// the inherited process env — that ordering is MEASURED, not assumed: exporting
// ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8 into the process while
// settings.json said claude-opus-5[1m] still ran claude-opus-5[1m] (CLI
// 2.1.228). Reading them the other way round would make the picker claim a
// model the turn won't use. The process env is still the fallback, because
// container deployments set these in the environment and ship no settings.json.
const effective = (name: string, env: Env): string | null => {
  const v = claudeSettingsEnv(env)[name] ?? env[name];
  return v && v.trim() ? v.trim() : null;
};

export type ClaudeProvider = "anthropic" | "vertex" | "bedrock";

/** Which backend this Calandria process is configured to route Claude through.
 *  "anthropic" is the plain subscription/API-key path and the default. */
export function configuredProvider(env: Env = process.env): ClaudeProvider {
  const settings = claudeSettingsEnv(env);
  const flag = (name: string) => enabled(settings[name] ?? env[name]);
  if (flag("CLAUDE_CODE_USE_VERTEX")) return "vertex";
  if (flag("CLAUDE_CODE_USE_BEDROCK") || flag("CLAUDE_CODE_USE_MANTLE")) return "bedrock";
  return "anthropic";
}

/** The model ids Claude Code's family aliases resolve to (ANTHROPIC_DEFAULT_*_MODEL),
 *  plus the session default (ANTHROPIC_MODEL). null = unmapped, in which case the
 *  alias falls back to the CLI's own built-in choice for that family. */
export function claudeDefaultModels(env: Env = process.env): {
  opus: string | null;
  sonnet: string | null;
  haiku: string | null;
  default: string | null;
} {
  return {
    opus: effective("ANTHROPIC_DEFAULT_OPUS_MODEL", env),
    sonnet: effective("ANTHROPIC_DEFAULT_SONNET_MODEL", env),
    haiku: effective("ANTHROPIC_DEFAULT_HAIKU_MODEL", env),
    default: effective("ANTHROPIC_MODEL", env),
  };
}
