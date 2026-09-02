// The Antigravity (Gemini) event normalizer — pure functions turning `agy`'s
// `--output-format stream-json` NDJSON into the agent-agnostic StreamEvent
// contract (lib/types.ts). Kept out of driver.ts so it can be unit-tested
// against the recorded fixtures in tests/fixtures/gemini/ without spawning the
// CLI, exactly as the Codex normalizer is.
//
// EVERYTHING HERE IS PINNED TO A REAL CAPTURE (2026-09-02, agy 1.1.22), not to
// the vendor's prose, because the two disagree on nearly every detail. Each
// line is one envelope carrying BOTH a tag and a payload key:
//
//   {"event":"init","conversation_id":"…","init":{cwd,tools,permission_mode}}
//   {"event":"step_update","step_update":{conversation_id,step_index,state,step_type,…}}
//   {"event":"result","result":{conversation_id,status,response,usage,num_turns}}
//
// Four things the spike's design doc got wrong, all corrected below:
//
//  1. `step_type` values are lowercase snake_case — `user_input`,
//     `agent_response`, `tool`, `system_message` — NOT the uppercase
//     CORTEX_STEP_TYPE_* enum names in the binary. There is no PLANNER_RESPONSE
//     and no MCP_TOOL step.
//  2. An MCP call is an ORDINARY tool step whose `tool_name` is the CLI's own
//     dispatcher, `call_mcp_tool`. The server and tool the model actually
//     invoked live in `tool_info.parameters.ServerName` / `.ToolName`. Reading
//     `tool_info.name` would label every Calandria tool call "call_mcp_tool"
//     and lib/suggestionCard.ts would never match a suggest_task.
//  3. `result.usage` is CUMULATIVE over the whole conversation, not per turn.
//     Measured: a 2-turn conversation reported 61357 input tokens, exactly the
//     sum of its four steps' reports (14765+15287+15494+15811). So this driver
//     needs the same persisted baseline the Codex driver keeps.
//  4. The conversation id is on `init` (top level of the envelope), so a turn
//     that dies before its terminal event still leaves a resumable session.
//
// Steps arrive ACTIVE → DONE with a `step_index` that keeps counting across
// resumed turns. The runner keys tool messages by id, so exactly one `tool`
// event is emitted per step on first sighting and everything later folds into
// `tool_result` events that update the same row in place.

import type { StreamEvent, ToolPeek } from "../../types";
import { clip, clipKeepTail, summarizeResult, summarizeFailure } from "../shared";
import { DEFAULT_GEMINI_MODEL } from "./pricing";
import { geminiUsage, type GeminiTokenUsage } from "./usage";
import { BRIDGE_SERVER_NAME } from "./mcp";

// ---------- the CLI's wire shapes ----------
// Every field is optional: this is a binary the user installed, which may be
// older or newer than this driver, and a missing field must degrade rather than
// throw mid-turn.

/** `call_mcp_tool`'s parameters, which is where an MCP call's real identity lives. */
export interface AgyMcpParams {
  ServerName?: string;
  ToolName?: string;
  Arguments?: unknown;
}

export interface AgyToolInfo {
  /** The CLI's own tool name — for an MCP call this is "call_mcp_tool". */
  name?: string;
  parameters?: unknown;
  /** Present on DONE. Often a SUMMARY rather than the payload ("1 lines, 146 bytes"). */
  output?: string;
  /** Set when the CLI refused the call. A soft denial does not change the exit
   *  code, so this is the only in-band signal that a tool never ran. */
  error?: string;
}

export interface AgySubagentInfo {
  conversation_id?: string;
  log_uri?: string;
  description?: string;
}

export interface AgyStepUpdate {
  conversation_id?: string;
  step_type?: string;
  /** "ACTIVE" while running, "DONE" once settled. */
  state?: string;
  step_index?: number | string;
  /** Duplicated at step level alongside tool_info.name. */
  tool_name?: string;
  /** Assistant prose, streamed in pieces and accumulated until the step is DONE. */
  text_delta?: string;
  /** The whole text, when the CLI sends it in one piece instead of deltas. */
  text?: string;
  tool_info?: AgyToolInfo;
  subagent_info?: AgySubagentInfo;
  /** Per-step token report. Ignored: the turn total comes from `result`. */
  usage?: GeminiTokenUsage;
  duration_seconds?: number;
}

export interface AgyInit {
  cwd?: string;
  tools?: string[];
  permission_mode?: string;
  model?: string;
}

export interface AgyResult {
  conversation_id?: string;
  /** SUCCESS | ERROR | CANCELED | INTERRUPTED. */
  status?: string;
  /** The assistant's final answer. */
  response?: string;
  error?: string;
  num_turns?: number;
  duration_seconds?: number;
  usage?: GeminiTokenUsage;
}

export type AgyEvent =
  | { kind: "init"; init: AgyInit; conversationId: string | null }
  | { kind: "step_update"; step: AgyStepUpdate }
  | { kind: "result"; result: AgyResult }
  | { kind: "unknown" };

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/**
 * Decode one parsed NDJSON line.
 *
 * The measured framing carries a redundant `event` tag beside the payload key;
 * either alone is enough to classify, so a CLI that drops one keeps working.
 * Anything unrecognized is `unknown` and drops — the right default for a
 * vocabulary the vendor calls closed but keeps extending.
 */
export function classify(line: unknown): AgyEvent {
  if (!line || typeof line !== "object") return { kind: "unknown" };
  const o = line as Record<string, unknown>;
  const tag = typeof o.event === "string" ? o.event : "";

  if (o.init || tag === "init") {
    const init = (o.init ? asObj(o.init) : o) as AgyInit;
    // Measured at the TOP level of the envelope, not inside `init`.
    const conv = typeof o.conversation_id === "string" ? o.conversation_id : null;
    return { kind: "init", init, conversationId: conv };
  }
  if (o.step_update || tag === "step_update") {
    return { kind: "step_update", step: (o.step_update ? asObj(o.step_update) : o) as AgyStepUpdate };
  }
  if (o.result || tag === "result") {
    return { kind: "result", result: (o.result ? asObj(o.result) : o) as AgyResult };
  }
  return { kind: "unknown" };
}

// ---------- step vocabulary (measured) ----------

const STEP_PROSE = "agent_response";
const STEP_TOOL = "tool";
/** Echoes of our own prompt and the CLI's internal notes — nothing to render. */
const DROPPED_STEPS = new Set(["user_input", "system_message", "checkpoint", "task_boundary", "brain_update", "ephemeral_message"]);

/** The CLI's dispatcher for every MCP call. */
const MCP_DISPATCH_TOOL = "call_mcp_tool";

// Icons by tool name, so a transcript reads the way a Claude or Codex one does.
const TOOL_ICON: Record<string, string> = {
  run_command: "❯",
  command_status: "❯",
  send_command_input: "❯",
  view_file: "📄",
  read_url_content: "🌐",
  list_dir: "📁",
  grep_search: "🔎",
  find_by_name: "🔎",
  search_web: "🔎",
  write_to_file: "✎",
  replace_file_content: "✎",
  multi_replace_file_content: "✎",
  sed_file: "✎",
  notebook_edit: "✎",
  invoke_subagent: "🤖",
  define_subagent: "🤖",
};

/** Tool parameter keys that carry the "what" worth putting in a title. */
const HEADLINE_PARAM = ["CommandLine", "AbsolutePath", "Query", "SearchTerm", "Url", "DirectoryPath", "TargetFile"];

const isDone = (state: string | undefined): boolean => (state || "").toUpperCase() === "DONE";

// ---------- cumulative usage ----------

/** The conversation's running totals, as `result.usage` reports them. Persisted
 *  per conversation (sessions.usage_cum) so the NEXT turn can subtract them. */
export interface GeminiCum {
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
}

export const ZERO_CUM: GeminiCum = { input: 0, output: 0, thinking: 0, cacheRead: 0 };

const toCum = (u: GeminiTokenUsage): GeminiCum => ({
  input: Math.max(0, u.input_tokens ?? 0),
  output: Math.max(0, u.output_tokens ?? 0),
  thinking: Math.max(0, u.thinking_tokens ?? 0),
  cacheRead: Math.max(0, u.cache_read_tokens ?? 0),
});

// Is this report still counting up from the baseline? Decided on the input side
// for the reason the Codex driver gives: it is the dominant counter and can only
// grow while a conversation lives. Going backwards means the baseline belongs to
// a different run, so the report is taken at face value instead of clamped to zero.
const monotonic = (cur: GeminiCum, prev: GeminiCum): boolean =>
  cur.input >= prev.input && cur.cacheRead >= prev.cacheRead;

const diffCum = (cur: GeminiCum, prev: GeminiCum): GeminiCum => ({
  input: Math.max(0, cur.input - prev.input),
  output: Math.max(0, cur.output - prev.output),
  thinking: Math.max(0, cur.thinking - prev.thinking),
  cacheRead: Math.max(0, cur.cacheRead - prev.cacheRead),
});

// ---------- per-turn state ----------

/**
 * Threaded through every event of one turn and mutated in place. A fresh object
 * per turn, seeded with the conversation's persisted usage baseline — see
 * newState().
 */
export interface GeminiMapState {
  emittedTool: Set<string>;
  prose: Map<string, string>;
  model: string;
  conversationId: string | null;
  cum: GeminiCum;
  cumDirty: boolean;
  /** Prose already emitted from a step, so `result.response` doesn't repeat it. */
  saidSomething: boolean;
  /** Whether the terminal `result` arrived — and with it the `done` event. A
   *  turn killed before it never gets one, so the driver emits the fallback. */
  sawResult: boolean;
}

export function newState(model: string = DEFAULT_GEMINI_MODEL, cum: GeminiCum = ZERO_CUM): GeminiMapState {
  return {
    emittedTool: new Set<string>(),
    prose: new Map<string, string>(),
    model,
    conversationId: null,
    cum,
    cumDirty: false,
    saidSomething: false,
    sawResult: false,
  };
}

/**
 * Map one parsed NDJSON line to zero or more StreamEvents.
 *
 * `aborted` says whether OUR abort fired. The CLI reports a cancelled run as
 * CANCELED/INTERRUPTED, which is a deliberate teardown when we asked for it and
 * a real failure when we didn't — and it really does arrive unasked, because
 * that is also the status a turn gets when the CLI auto-denies a tool it cannot
 * prompt about (measured). Swallowing it unconditionally would render a
 * permission failure as a silent success.
 */
export function mapAgyEvent(line: unknown, state: GeminiMapState, aborted = false): StreamEvent[] {
  const ev = classify(line);
  switch (ev.kind) {
    case "init":
      return mapInit(ev, state);
    case "step_update":
      return mapStep(ev.step, state);
    case "result":
      return mapResult(ev.result, state, aborted);
    default:
      return [];
  }
}

function mapInit(ev: Extract<AgyEvent, { kind: "init" }>, state: GeminiMapState): StreamEvent[] {
  const out: StreamEvent[] = [];
  if (ev.conversationId) {
    state.conversationId = ev.conversationId;
    out.push({ type: "session", sessionId: ev.conversationId });
  }
  // The CLI does not announce the model on init, so the driver emits the
  // resolved one itself; this only fires if a future version starts to.
  if (ev.init.model) {
    state.model = ev.init.model;
    out.push({ type: "model", model: ev.init.model });
  }
  return out;
}

const stepKey = (step: AgyStepUpdate): string =>
  step.step_index != null ? String(step.step_index) : step.step_type ?? "step";

function mapStep(step: AgyStepUpdate, state: GeminiMapState): StreamEvent[] {
  if (step.conversation_id && !state.conversationId) state.conversationId = step.conversation_id;
  const type = (step.step_type || "").toLowerCase();
  if (DROPPED_STEPS.has(type)) return [];
  if (type === STEP_PROSE) return mapProse(step, state);
  if (type === STEP_TOOL || step.tool_info) return mapTool(step, state);
  if (step.subagent_info) return mapSubagent(step, state);
  return [];
}

// Prose streams as `text_delta` and is accumulated until the step settles, then
// emitted as ONE assistant message — the transcript stores whole messages, not
// deltas. Most agent_response steps carry no text at all (they are the model's
// tool-planning turns), which is why an empty one emits nothing rather than a
// blank bubble.
function mapProse(step: AgyStepUpdate, state: GeminiMapState): StreamEvent[] {
  const key = stepKey(step);
  if (step.text_delta) state.prose.set(key, (state.prose.get(key) ?? "") + step.text_delta);
  if (!isDone(step.state)) return [];
  const text = (step.text ?? state.prose.get(key) ?? "").trim();
  state.prose.delete(key);
  if (!text) return [];
  state.saidSomething = true;
  return [{ type: "assistant", content: text }];
}

/**
 * The identity of an MCP call: the CLI dispatches every one through its own
 * `call_mcp_tool`, so the server and tool the model actually asked for are in
 * the parameters. Returns null for an ordinary (non-MCP) tool step.
 */
export function mcpIdentity(info: AgyToolInfo): { server: string; tool: string } | null {
  if ((info.name || "") !== MCP_DISPATCH_TOOL) return null;
  const p = asObj(info.parameters) as AgyMcpParams;
  if (!p.ToolName) return null;
  return { server: String(p.ServerName ?? ""), tool: String(p.ToolName) };
}

function mapTool(step: AgyStepUpdate, state: GeminiMapState): StreamEvent[] {
  const info = step.tool_info ?? {};
  const cliName = info.name || step.tool_name || "";
  const mcp = mcpIdentity(info);

  // ask_user is rendered as an interactive card published directly by the
  // internal ask-user endpoint (lib/agentTools.startAskUser) — suppress the
  // generic tool line so the question isn't shown twice. Mirrors the Codex
  // driver, and the Claude driver skipping AskUserQuestion tool_use blocks.
  if (mcp && mcp.tool === "ask_user" && (!mcp.server || mcp.server === BRIDGE_SERVER_NAME)) return [];

  const key = stepKey(step);
  const out: StreamEvent[] = [];
  const params = paramText(info.parameters);

  if (!state.emittedTool.has(key)) {
    state.emittedTool.add(key);
    out.push({
      type: "tool",
      id: key,
      // What CODE matches on, as opposed to the human-facing title.
      // lib/suggestionCard.ts finds a suggest_task call by SUBSTRING precisely
      // because each driver spells it differently, so the bare tool name has to
      // survive — hence the MCP identity rather than "call_mcp_tool".
      name: mcp ? `${mcp.server || BRIDGE_SERVER_NAME}__${mcp.tool}` : cliName || undefined,
      title: title(cliName, mcp, info),
      detail: clip(params),
      file: writtenFile(cliName, info),
    });
  }

  if (isDone(step.state)) {
    const isError = !!info.error;
    const content = info.error ? info.error : info.output ?? "";
    out.push({
      type: "tool_result",
      id: key,
      content: isError ? clipKeepTail(content, 6000) : clip(content, 6000),
      isError,
      peek: isError ? summarizeFailure(content) : summarizeResult("output", content),
    });
  }
  return out;
}

function mapSubagent(step: AgyStepUpdate, state: GeminiMapState): StreamEvent[] {
  const key = stepKey(step);
  const info = step.subagent_info ?? {};
  const out: StreamEvent[] = [];
  if (!state.emittedTool.has(key)) {
    state.emittedTool.add(key);
    out.push({ type: "tool", id: key, title: "🤖 Subagent", detail: info.description || info.conversation_id || "" });
  }
  if (isDone(step.state)) {
    out.push({
      type: "tool_result",
      id: key,
      content: info.log_uri ? `Subagent finished (${info.log_uri})` : "Subagent finished",
      isError: false,
    });
  }
  return out;
}

function title(cliName: string, mcp: { server: string; tool: string } | null, info: AgyToolInfo): string {
  if (mcp) return `⚙ ${mcp.server || BRIDGE_SERVER_NAME}: ${mcp.tool}`;
  const icon = TOOL_ICON[cliName] ?? "⚙";
  const headline = headlineParam(info.parameters);
  const label = humanize(cliName);
  if (cliName === "run_command" && headline) return `${icon} ${firstLine(headline)}`;
  return headline ? `${icon} ${label}: ${firstLine(headline)}` : `${icon} ${label}`;
}

/** The path a file-WRITING call touched, so the transcript card can open it in
 *  collaboration mode. Only for calls that actually write. */
function writtenFile(cliName: string, info: AgyToolInfo): string | undefined {
  if (!["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"].includes(cliName)) {
    return undefined;
  }
  const p = asObj(info.parameters);
  for (const k of ["AbsolutePath", "TargetFile", "FilePath"]) {
    if (typeof p[k] === "string" && p[k]) return p[k] as string;
  }
  return undefined;
}

/** The single parameter worth showing in a one-line title. */
function headlineParam(params: unknown): string {
  const p = asObj(params);
  for (const k of HEADLINE_PARAM) {
    if (typeof p[k] === "string" && p[k]) return p[k] as string;
  }
  return "";
}

/** Tool parameters as text: a bare string stays as-is, anything structured is
 *  JSON so the detail pane shows what was actually asked for. */
function paramText(params: unknown): string {
  if (params == null) return "";
  if (typeof params === "string") return params;
  try {
    return JSON.stringify(params, null, 2);
  } catch {
    return String(params);
  }
}

function mapResult(result: AgyResult, state: GeminiMapState, aborted: boolean): StreamEvent[] {
  const out: StreamEvent[] = [];
  const status = (result.status || "").toUpperCase();
  state.sawResult = true;
  if (result.conversation_id) state.conversationId = result.conversation_id;

  // `result.usage` accumulates over the WHOLE conversation, so subtract the
  // baseline the previous turn left behind — the StreamEvent contract is
  // per-turn (the runner adds each usage event to the task's running spend).
  if (result.usage) {
    const cur = toCum(result.usage);
    const turn = monotonic(cur, state.cum) ? diffCum(cur, state.cum) : cur;
    state.cum = cur;
    state.cumDirty = true;
    out.push({
      type: "usage",
      usage: geminiUsage(
        {
          input_tokens: turn.input,
          output_tokens: turn.output,
          thinking_tokens: turn.thinking,
          cache_read_tokens: turn.cacheRead,
        },
        state.model
      ),
    });
  }

  // The final answer lands here rather than in a step whenever the CLI didn't
  // stream it — emitted only if no step already said it, so the transcript
  // doesn't show the same reply twice.
  const response = (result.response || "").trim();
  if (response && !state.saidSomething) out.push({ type: "assistant", content: response });

  if (status === "CANCELED" || status === "INTERRUPTED") {
    // Our own Stop killed it: deliberate teardown, and the partial transcript is
    // already persisted by the runner. Unasked, it is a real failure — measured,
    // this is also what a turn reports when the CLI auto-denies a tool it has
    // nobody to prompt about, and calling that a success would hide the fact
    // that the work never happened.
    if (!aborted) out.push({ type: "error", content: result.error || `The agent stopped early (${status.toLowerCase()})` });
  } else if (status === "ERROR") {
    // Raw text, so lib/authFailure.ts can classify it ("You are not logged into
    // Antigravity", "authentication failed or timed out") and the UI can offer
    // Reconnect.
    out.push({ type: "error", content: result.error || "The agent reported an error" });
  }

  out.push({ type: "done", sessionId: state.conversationId });
  return out;
}

// ---------- small helpers ----------

const firstLine = (s: string): string => s.split("\n")[0].slice(0, 70);

/** "view_file" → "View file", for a tool with no icon-worthy headline. */
function humanize(name: string): string {
  const words = name.toLowerCase().split("_").filter(Boolean).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Tool";
}

/** Exported for tests. */
export function linesPeek(text: string): ToolPeek {
  const MAX = 6;
  const lines = text.split("\n").filter((l) => l.trim());
  return { kind: "lines", lines: lines.slice(0, MAX), truncated: Math.max(0, lines.length - MAX) };
}
