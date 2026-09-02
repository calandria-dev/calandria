// The Google / Antigravity driver — the `agy` CLI behind the AgentDriver seam
// (lib/agents/types.ts), alongside lib/agents/claude/driver.ts and
// lib/agents/codex/driver.ts.
//
// There is no SDK for this CLI, so unlike the other two drivers this one owns
// the process itself: spawn `agy -p <prompt> --output-format stream-json`, read
// NDJSON off stdout, and normalize it through ./events.ts. The conversation id
// is emitted as the `session` StreamEvent, so the existing lineage/resume
// machinery (sessions table, /clear generations) works unchanged — an `agy`
// conversation id is just another opaque id in tasks.session_id.
//
// Two things are unusual enough to state up front:
//
//  - EACH TASK RUNS UNDER ITS OWN HOME (./home.ts). The CLI reads MCP servers
//    from one user-global file, so that is the only way parallel tasks each get
//    a bridge entry carrying their own CALANDRIA_TASK_ID.
//  - `result.usage` IS CUMULATIVE over the conversation, so the per-turn figure
//    is a subtraction against a persisted baseline, exactly as for Codex.

import { spawn } from "node:child_process";
import type { Project, Task, StreamEvent, TurnUsage } from "../../types";
import type { AgentDriver, OneShotResult } from "../types";
import { GEMINI_CAPABILITIES } from "./capabilities";
import { getSetting, getThreadUsageCum, setThreadUsageCum } from "../../store";
import { AGY_CLI_PATH } from "../../config";
import { buildProjectContext } from "../shared";
import { mapAgyEvent, newState, ZERO_CUM, type GeminiCum, type GeminiMapState } from "./events";
import { resolveGeminiModel, DEFAULT_GEMINI_MODEL } from "./pricing";
import { prepareTaskHome } from "./home";
import {
  geminiStatus,
  verifyGeminiTurn,
  startGeminiLogin,
  getGeminiLogin,
  submitGeminiCode,
  cancelGeminiLogin,
  geminiApiKey,
  applyStoredApiKey,
} from "./auth";
import { agentTurnEnv } from "../../agentEnv";

const AGY = () => AGY_CLI_PATH || "agy";

/**
 * The task's run permission → `agy` flags.
 *
 * The CLI's own default ("request-review") is NOT reachable here, and that is
 * deliberate: headless mode has nobody to prompt, so it auto-denies every tool
 * and the turn ends having done nothing (measured — see ./capabilities.ts).
 * bypassPermissions is therefore the floor rather than an escalation, exactly
 * as it is for Codex, and it is safe for the same reason: tasks run in isolated
 * worktrees, and in the container behind a hardened image.
 */
export function permissionFlags(mode: string | null): string[] {
  if (mode === "plan") return ["--mode", "plan"];
  if (mode === "acceptEdits") return ["--mode", "accept-edits"];
  return ["--dangerously-skip-permissions"];
}

/** The argv for one turn. Exported for tests. */
export function turnArgs(opts: {
  prompt: string;
  conversationId: string | null;
  model: string | null;
  permission: string | null;
}): string[] {
  const args = ["-p", opts.prompt, "--output-format", "stream-json"];
  if (opts.conversationId) args.push("--conversation", opts.conversationId);
  // Omitted when nothing chose, so the CLI's own default keeps winning.
  if (opts.model) args.push("--model", opts.model);
  // No --effort: this catalog sells reasoning effort as part of the model slug
  // ("gemini-3.8-flash-high"), so a second knob would contradict the model.
  args.push(...permissionFlags(opts.permission));
  return args;
}

/**
 * A tool the CLI refused because headless mode cannot prompt. It does NOT change
 * the exit code and does not always change `result.status` (both SUCCESS and
 * CANCELED were measured), so this stderr line is the only reliable signal that
 * the turn stopped short of doing the work.
 */
const SOFT_DENIAL = /no output produced|auto-denied|cannot prompt for/i;

async function* runTurn(
  task: Task,
  project: Project,
  userText: string,
  abortController?: AbortController
): AsyncGenerator<StreamEvent> {
  // The task's own choice, else this agent's Settings default ("default_model:<agent>";
  // agent-scoped, since a model id names one provider's catalog).
  const chosen = task.model ?? getSetting(`default_model:${task.agent}`);
  const model = resolveGeminiModel(chosen);
  const permission =
    task.permission_mode ?? getSetting(`default_permission_mode:${task.agent}`) ?? getSetting("default_permission_mode");

  const state = newState(
    model,
    (task.session_id ? getThreadUsageCum<GeminiCum>(task.session_id) : null) ?? ZERO_CUM
  );

  // Fresh session: seed the opening prompt with the project context. `agy` has
  // no system-prompt append, so context rides the first message; resumed turns
  // rely on the CLI's own conversation persistence.
  const prompt = task.session_id
    ? userText
    : `${buildProjectContext(project, task)}\n\n---\n\n${userText}`;

  const { home, cwd } = prepareTaskHome(project, task);
  const env = applyStoredApiKey({
    ...agentTurnEnv(project),
    // Per-task MCP config lives here; see ./home.ts for why HOME is the lever.
    HOME: home,
    // A background self-update would swap the binary mid-turn.
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  });

  // The CLI emits no model event of its own, so this resolved value is the best
  // truth available — and it prices the estimate.
  yield { type: "model", model };

  const args = turnArgs({ prompt, conversationId: task.session_id, model: chosen, permission });
  const child = spawn(AGY(), args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] as const });

  let killedByUs = false;
  const onAbort = () => {
    killedByUs = true;
    // SIGTERM, not SIGKILL: give the CLI the chance to write its terminal
    // `result` so the conversation id survives and the task stays resumable.
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  };
  abortController?.signal.addEventListener("abort", onAbort, { once: true });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    stderr = (stderr + d).slice(-8_000);
  });

  try {
    for await (const line of ndjson(child)) {
      for (const ev of mapAgyEvent(line, state, killedByUs)) yield ev;
      // Advance the conversation's cumulative baseline the moment usage is
      // mapped, not at the end: a crash or a Stop between here and turn end
      // would otherwise make the NEXT turn re-bill everything this one did.
      // The session row exists by now — the runner persists it when it consumes
      // the `session` event.
      if (state.cumDirty) {
        state.cumDirty = false;
        const id = state.conversationId ?? task.session_id;
        if (id) setThreadUsageCum(id, state.cum);
      }
    }
    const code = await exited(child);

    // A refusal the stream itself never reports. Only surfaced when the turn
    // produced no prose, so a run that worked and merely skipped one optional
    // tool isn't labelled a failure.
    if (!killedByUs && !state.saidSomething && SOFT_DENIAL.test(stderr)) {
      yield { type: "error", content: firstMeaningfulLine(stderr) };
    } else if (!killedByUs && code !== 0 && !state.conversationId) {
      // Died before saying anything at all — a missing binary, a bad flag.
      yield { type: "error", content: firstMeaningfulLine(stderr) || `${AGY()} exited with code ${code}` };
    }
  } catch (err) {
    if (!killedByUs) yield { type: "error", content: err instanceof Error ? err.message : String(err) };
  } finally {
    abortController?.signal.removeEventListener("abort", onAbort);
  }

  // ./events.ts emits `done` from the CLI's terminal `result`. A turn that died
  // before that event still needs one, so the runner can settle the task.
  if (!state.sawResult) yield { type: "done", sessionId: state.conversationId ?? task.session_id };
}

/** Yield each parsed NDJSON object from the child's stdout. Unparseable lines
 *  are skipped rather than fatal — the CLI interleaves plain-text chatter. */
async function* ndjson(child: import("node:child_process").ChildProcess): AsyncGenerator<unknown> {
  if (!child.stdout) return;
  child.stdout.setEncoding("utf8");
  let buf = "";
  for await (const chunk of child.stdout as AsyncIterable<string>) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // not JSON; ignore
      }
    }
  }
  const rest = buf.trim();
  if (rest) {
    try {
      yield JSON.parse(rest);
    } catch {
      // ignore
    }
  }
}

function exited(child: import("node:child_process").ChildProcess): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("close", (code) => resolve(code ?? 0)));
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^\s*$/.test(l));
  return line ?? "";
}

// ---------- one-shot helpers (no session, text in → text out) ----------

/**
 * A minimal read-only run, shared by the summarize/draft/recap helpers. Any
 * failure degrades to empty text (callers add their own "(no … produced)"
 * fallback) so a failed helper turn never rejects into the recap/refresh jobs —
 * mirrors both other drivers.
 *
 * `plan` mode is the read-only one: it lets the agent explore and propose
 * without editing, which is exactly a one-shot's remit.
 */
async function oneShot(project: Project, prompt: string, timeoutMs = 5 * 60 * 1000): Promise<OneShotResult> {
  const env = applyStoredApiKey({ ...agentTurnEnv(project), AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
  const args = ["-p", prompt, "--output-format", "stream-json", "--mode", "plan"];
  const child = spawn(AGY(), args, {
    cwd: project.repo_path || process.cwd(),
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"] as const,
  });
  const timer = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }, timeoutMs);

  const state: GeminiMapState = newState(resolveGeminiModel(null));
  let text = "";
  let usage: TurnUsage | undefined;
  try {
    child.stderr?.resume();
    for await (const line of ndjson(child)) {
      for (const ev of mapAgyEvent(line, state)) {
        if (ev.type === "assistant") text = ev.content;
        if (ev.type === "usage") usage = ev.usage;
        if (ev.type === "error") return { text: "", usage };
      }
    }
  } catch {
    return { text: "", usage };
  } finally {
    clearTimeout(timer);
  }
  return { text: text.trim(), usage };
}

async function summarizeTranscript(transcript: string, project: Project): Promise<OneShotResult> {
  const result = await oneShot(
    project,
    `Summarize the following agent session into a concise handoff note for a fresh session continuing the ` +
      `same task. Cover: what was done, the current state of the code, decisions made, and what remains. Be ` +
      `specific about files and follow-ups. Output only the note.\n\n=== TRANSCRIPT ===\n${transcript}`
  );
  return { text: result.text || "(no summary produced)", usage: result.usage };
}

const CTX_OPEN = "<<<CONTEXT>>>";
const CTX_CLOSE = "<<<END_CONTEXT>>>";

async function draftProjectContext(project: Project, digest: string): Promise<OneShotResult> {
  const result = await oneShot(
    project,
    `You are refreshing the saved "project context" for the project "${project.name}". This context is prepended ` +
      `to every new session in this project, so it must get a fresh session up to speed fast and accurately reflect ` +
      `what the project IS NOW.\n\n` +
      `Explore the repository in your working directory (read key files, list the tree, grep for patterns, check ` +
      `package manifests and configs, skim the README and entry points). Then write the new context.\n\n` +
      `Cover, concisely: what the app does and its purpose; the tech stack and key dependencies; how the code is ` +
      `organized (the directories/modules that matter and what lives where); important conventions, patterns, and ` +
      `constraints; how to run/build/test it; and any other orientation a new contributor needs. Prefer concrete ` +
      `file paths over vague description. Be accurate — only state what you verified in the code.\n\n` +
      `Write the context as plain markdown (no code fences around the whole thing), tight and information-dense, ` +
      `~200–500 words. Wrap ONLY the final document between a line containing ${CTX_OPEN} and a line containing ` +
      `${CTX_CLOSE}.\n\n=== EXISTING SAVED CONTEXT (may be stale) ===\n${project.context || "(none)"}\n\n` +
      `=== RECENT ACTIVITY ===\n${digest || "(none)"}`,
    10 * 60 * 1000
  );
  const open = result.text.indexOf(CTX_OPEN);
  const close = result.text.lastIndexOf(CTX_CLOSE);
  let doc = open !== -1 && close > open ? result.text.slice(open + CTX_OPEN.length, close) : result.text;
  doc = doc.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1").trim();
  return { text: doc || "(no context produced)", usage: result.usage };
}

async function summarizeProjectRecap(project: Project, digest: string): Promise<OneShotResult> {
  const result = await oneShot(
    project,
    `Write a very short "where I left off" recap for the project "${project.name}", shown when the user returns after ` +
      `time away. Output ONLY 2–4 terse markdown bullet points ("- " each), one line each, ideally under ~12 words. ` +
      `Be concrete about features, files, and tasks. No headings, no intro/outro, no next steps — recap only what has ` +
      `already happened.\n\n=== PROJECT CONTEXT ===\n${project.context || "(none)"}\n\n=== RECENT ACTIVITY ===\n${digest}`
  );
  return { text: result.text || "(no recap produced)", usage: result.usage };
}

export const geminiDriver: AgentDriver = {
  id: "gemini",
  label: "Antigravity",
  capabilities: GEMINI_CAPABILITIES,
  runTurn,
  summarizeTranscript,
  draftProjectContext,
  summarizeProjectRecap,
  // The CLI runs command hooks from `hooks.json` in a workspace customization
  // root, and hooks execute shell commands outside any permission gate. Whether
  // this build actually loads it from the worktree is unproven — MCP config
  // demonstrably is NOT read from there (./home.ts) — but the asymmetry of the
  // bet decides it: watching a file the CLI ignores costs one hash per turn,
  // while not watching one it obeys is arbitrary code execution the user never
  // approved. See lib/settingsDrift.ts.
  watchedSettingsFiles: [".agents/hooks.json"],
  authStatus: geminiStatus,
  startLogin: startGeminiLogin,
  getLogin: getGeminiLogin,
  submitLoginCode: submitGeminiCode,
  cancelLogin: cancelGeminiLogin,
  verify: verifyGeminiTurn,
  apiKey: geminiApiKey,
};

export { DEFAULT_GEMINI_MODEL };
