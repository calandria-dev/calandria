// Asking the installed CLI what a family alias resolves to.
//
// The picker can say who resolves "Opus (latest)" (the CLI, at turn time), but
// not what to. On Vertex it can: the mapping is ANTHROPIC_DEFAULT_*_MODEL and
// ./provider.ts reads it directly, which is why vertexModels() puts the
// resolved id in each alias row's subtitle. The subscription path has no such
// file; the answer lives inside the CLI's own catalog.
//
// It is still readable, and reading it costs no API call:
//
//   claude -p --bare --model <value> --output-format stream-json --verbose \
//     --no-session-persistence "hi"
//
// prints a `system`/`init` line carrying the resolved `model` and the
// `claude_code_version` that resolved it, before any request goes out.
//
// Two independent reasons the probe cannot spend anything:
//
//  - `--bare` reads Anthropic auth strictly from ANTHROPIC_API_KEY or an
//    apiKeyHelper supplied via `--settings`. OAuth and the keychain are never
//    read, so the user's subscription login is not in the process at all. It
//    also skips hooks, plugin sync, auto-memory and CLAUDE.md discovery, so the
//    probe cannot fire the user's SessionStart hooks.
//  - ANTHROPIC_BASE_URL is pointed at a dead loopback port. Resolution happens
//    before the first request, proven by the init line still arriving with the
//    API unreachable.
//
// The child is killed the moment the init line is read; it does not run a turn.
//
// What it does cost is a full CLI spawn at close to 100% CPU, several seconds
// per value. That is why nothing here is on a request path: claudeCapabilities()
// is synchronous and read per request (GET /api/agents, and
// modelContextWindow() from inside getTaskContext()), so this runs detached and
// leaves its answer in ./modelIds.ts for the descriptor to read. Every failure
// is silent (no `claude` on PATH, a probe that times out, a CLI that stops
// printing the field) and leaves the static catalog exactly as written.
//
// Keyed by CLI version because the resolution moves with it. `claude --version`
// is cheap against the sweep it guards, the same trade codexCliVersion() makes
// in ../codex/providerCheck.ts.

import { execFile, spawn } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { CLAUDE_CLI_PATH, CLAUDE_MODEL_PROBE, CLAUDE_MODEL_PROBE_MS } from "../../config";
import { spawnSpec } from "../../binPath";
import { getSetting, setSetting } from "../../store";
import { configuredProvider } from "./provider";
import { resolvedModelIds, setResolvedModelIds, type ResolvedModelIds } from "./modelIds";

const run = promisify(execFile);

/**
 * The alias values that get their own spawn. The `[1m]` picker rows are not
 * here: `opus[1m]` resolves to the `[1m]` spelling of whatever `opus` resolves
 * to, so the descriptor derives them from these five the same way
 * vertexModels() derives them from the env mapping. Three fewer spawns for an
 * answer already available.
 */
export const PROBE_ALIASES = ["fable", "opus", "sonnet", "haiku", "opusplan"] as const;

/** Where the answer survives a restart: one row, keyed inside by CLI version. */
const SETTING_KEY = "claude_model_ids";

/** How long a version check is skipped for. The sweep it guards is idempotent
 *  and version-keyed, so this only stops four tabs loading /api/agents from
 *  spawning `claude --version` four times. */
const RECHECK_MS = 60_000;

const spec = (args: string[], bin = CLAUDE_CLI_PATH) => spawnSpec(bin, args);

/** `2.1.257 (Claude Code)` → `2.1.257`. Null when the binary is missing or mute. */
export async function claudeCliVersion(bin?: string): Promise<string | null> {
  try {
    const s = spec(["--version"], bin);
    const { stdout } = await run(s.command, s.args, {
      timeout: 10_000,
      env: process.env,
      windowsVerbatimArguments: s.windowsVerbatimArguments,
    });
    return stdout.match(/(\d+\.\d+\.\d+[\w.+-]*)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The init line's two useful fields. */
export interface ProbeReading {
  model: string;
  version: string | null;
}

/**
 * The resolved id for one `--model` value, read off the init line. Null for
 * every failure: a missing binary, a timeout, an exit before the line, a CLI
 * that no longer prints the field. This is a picker subtitle, so nothing here
 * is worth blocking on or raising an error about.
 */
export async function probeModelId(value: string, bin?: string): Promise<ProbeReading | null> {
  const s = spec(
    ["-p", "--bare", "--model", value, "--output-format", "stream-json", "--verbose", "--no-session-persistence", "hi"],
    bin,
  );
  return new Promise<ProbeReading | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(s.command, s.args, {
        // Neutral cwd: nothing about the answer depends on a repo, and a task
        // worktree could be removed under us mid-probe.
        cwd: os.tmpdir(),
        env: {
          ...process.env,
          // See the header: makes it impossible for this to reach the API even
          // if a future CLI moves resolution after the first request.
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
          // A probe must not install anything.
          DISABLE_AUTOUPDATER: "1",
        },
        windowsVerbatimArguments: s.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }

    let done = false;
    const finish = (reading: ProbeReading | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // The CLI does not exit on its own here: with the API unreachable it sits
      // retrying, so the kill is the normal path out, not the error path.
      child.kill();
      resolve(reading);
    };
    const timer = setTimeout(() => finish(null), CLAUDE_MODEL_PROBE_MS);

    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      // Hold the trailing partial line; stream-json emits one JSON object per
      // line and the init line is several KB, so it can arrive split.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const reading = readInit(line);
        if (reading) {
          finish(reading);
          return;
        }
      }
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
  });
}

/** The `system`/`init` line's model + version, or null for any other line. */
export function readInit(line: string): ProbeReading | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const row = parsed as { type?: unknown; subtype?: unknown; model?: unknown; claude_code_version?: unknown };
  if (row.type !== "system" || row.subtype !== "init") return null;
  if (typeof row.model !== "string" || !row.model.trim()) return null;
  return {
    model: row.model.trim(),
    version: typeof row.claude_code_version === "string" ? row.claude_code_version : null,
  };
}

function readStored(): ResolvedModelIds | null {
  let raw: string | null = null;
  try {
    raw = getSetting(SETTING_KEY);
  } catch {
    return null; // no database yet (a build, a probe racing boot)
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ResolvedModelIds;
    if (typeof parsed?.version !== "string" || !parsed.ids || typeof parsed.ids !== "object") return null;
    return { version: parsed.version, ids: parsed.ids };
  } catch {
    return null;
  }
}

// The in-process guard. Not a cache: ./modelIds.ts holds the answer, this only
// stops concurrent sweeps and per-request version spawns.
const guard = (globalThis as { __calandriaClaudeModelProbe?: { at: number; running: boolean } });
const state = (guard.__calandriaClaudeModelProbe ??= { at: 0, running: false });

/** Run the sweep now, ignoring the recheck window. Returns what it settled on. */
export async function probeClaudeModelIds(): Promise<ResolvedModelIds | null> {
  const version = await claudeCliVersion();
  if (!version) return null; // no CLI to ask, keep the static catalog

  // A remembered answer from this same CLI is what version-keying buys: a
  // restart costs one cheap version spawn instead of the full sweep.
  const known = resolvedModelIds() ?? readStored();
  if (known?.version === version) {
    setResolvedModelIds(known);
    return known;
  }

  // Sequentially, never in parallel: each spawn is a CLI near full CPU, and
  // five at once on a small box would be felt by whatever turns are running.
  const ids: Record<string, string> = {};
  for (const alias of PROBE_ALIASES) {
    const reading = await probeModelId(alias);
    if (reading) ids[alias] = reading.model;
  }
  // Nothing answered at all: no CLI worth asking, or a spelling it no longer
  // prints, so cache nothing and let the next recheck try again. A partial
  // answer is taken as this CLI's answer and not retried: the likeliest reason
  // one alias is missing is that this CLI doesn't have that family, and the
  // cost of being wrong is one row keeping its static subtitle.
  if (Object.keys(ids).length === 0) return null;

  const next: ResolvedModelIds = { version, ids };
  setResolvedModelIds(next);
  try {
    setSetting(SETTING_KEY, JSON.stringify(next));
  } catch {
    // Memory still has it; the next boot just re-probes.
  }
  return next;
}

/**
 * Kick the probe off if it is worth kicking off, and return immediately. Called
 * from GET /api/agents, the request that renders the picker, because that is
 * where the answer is wanted, and lazily is the only way to pay for it: probing
 * at boot would spend CPU on every instance, including the ones whose users
 * never open a model picker.
 *
 * Nothing awaits this. The picker renders from whatever is cached now; the
 * first load after a CLI upgrade shows the static catalog and the next one
 * shows ids.
 */
export function ensureClaudeModelIds(): void {
  if (!CLAUDE_MODEL_PROBE) return;
  // Vertex and Bedrock don't need asking: vertexModels() reads the mapping out
  // of ANTHROPIC_DEFAULT_*_MODEL, and Bedrock gets no alias corrections at all.
  if (configuredProvider() !== "anthropic") return;
  if (state.running) return;
  if (Date.now() - state.at < RECHECK_MS) return;
  state.at = Date.now();
  state.running = true;
  void probeClaudeModelIds()
    .catch(() => null)
    .finally(() => {
      state.running = false;
    });
}

/** Forget the persisted answer and the recheck window, for the suite's reset. */
export function clearClaudeModelIdCache(): void {
  state.at = 0;
  state.running = false;
  try {
    setSetting(SETTING_KEY, null);
  } catch {
    // no database; nothing to clear
  }
}
