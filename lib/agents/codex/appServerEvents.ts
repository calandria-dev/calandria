// The app-server half of the Codex event normalizer: pure functions that turn
// `codex app-server` v2 notifications into the SDK-shaped `ThreadEvent`s that
// ./events.ts already maps to StreamEvents. One mapper for both transports,
// so the transcript a task renders is identical whichever protocol ran it,
// and every rendering rule (one `tool` row per item id, failures peek
// tail-first, ask_user suppressed) lives in exactly one place.
//
// The v2 item shapes are the exec protocol's with different spelling
// (camelCase, richer status enums, a `diff` on every file change) plus a few
// kinds exec never surfaces. Types are transcribed from the bindings
// `codex app-server generate-ts` emits for 0.153.0 — the CLI ships no npm
// package for them — and kept loose (optional fields, `unknown` payloads)
// because the binary the instance runs is whatever the user installed.

import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";

// ---------- app-server wire shapes (subset) ----------

export type V2FileChange = { path: string; kind: "add" | "delete" | "update"; diff?: string };

export type V2Item =
  | { type: "agentMessage"; id: string; text: string; phase?: string | null }
  | { type: "reasoning"; id: string; summary?: string[]; content?: string[] }
  | { type: "plan"; id: string; text: string }
  | { type: "commandExecution"; id: string; command: string; cwd?: string; status: "inProgress" | "completed" | "failed" | "declined"; aggregatedOutput?: string | null; exitCode?: number | null }
  | { type: "fileChange"; id: string; changes: V2FileChange[]; status: "inProgress" | "completed" | "failed" | "declined" }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: "inProgress" | "completed" | "failed"; arguments: unknown; result?: { content?: unknown[]; structuredContent?: unknown } | null; error?: { message: string } | null }
  | { type: "webSearch"; id: string; query: string }
  | { type: "contextCompaction"; id: string }
  | { type: string; id: string };

export interface V2TokenUsage {
  total?: Partial<V2Breakdown>;
  last?: Partial<V2Breakdown>;
  modelContextWindow?: number | null;
}
interface V2Breakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface V2Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: { message: string } | null;
}

// ---------- per-turn state ----------

export interface AppServerTurnState {
  /** The turn we started; notifications for any other turn are ignored. */
  turnId: string | null;
  /** The thread's latest cumulative counters, from thread/tokenUsage/updated. */
  total: Usage | null;
  /** The last request's prompt size — the context gauge. */
  contextTokens: number | null;
  /** Config warnings already surfaced this turn (the CLI repeats them). */
  warned: Set<string>;
  /** Which reasoning-summary paragraph the last delta belonged to; null before any. */
  summaryIndex: number | null;
}

export function newAppServerTurnState(): AppServerTurnState {
  return { turnId: null, total: null, contextTokens: null, warned: new Set(), summaryIndex: null };
}

/** What a notification maps to: SDK-shaped events for ./events.ts, plus the few things it has no shape for. */
export interface Mapped {
  events: ThreadEvent[];
  /** A turn-level outcome: the turn we started has ended. */
  turnEnded?: "completed" | "failed" | "interrupted";
  /** A warning to surface as a notice (deduped per turn). */
  notice?: string;
  /** Text to run the approval-downgrade classifier over. */
  warning?: string;
  /** A fresh context-size reading for the gauge. */
  contextTokens?: number;
  /**
   * A fragment of the reply, or of the reasoning summary above it, as the
   * model types it. Kept off `events` because the SDK's ThreadEvent union has
   * no delta shape at all — exec never streamed one — so this is the app
   * server's own extra rather than something ./events.ts could map.
   */
  delta?: { id: string; kind: "assistant" | "reasoning"; text: string };
}

const NONE: Mapped = { events: [] };

/**
 * Map one server notification. Item notifications become `item.started` /
 * `item.completed` carrying the exec-shaped item; `turn/completed` becomes the
 * usage report exec put on `turn.completed` (from the last tokenUsage seen)
 * and, on failure, `turn.failed`.
 */
export function mapNotification(method: string, params: unknown, state: AppServerTurnState): Mapped {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "item/started":
    case "item/completed": {
      if (!forThisTurn(p, state)) return NONE;
      const item = toSdkItem(p.item as V2Item);
      if (!item) return NONE;
      return { events: [{ type: method === "item/started" ? "item.started" : "item.completed", item } as ThreadEvent] };
    }
    // Live typing. The item's own `item/completed` still carries the full text
    // and is still what gets persisted, so dropping these costs correctness
    // nothing — it only costs the wait. `item/commandExecution/outputDelta` is
    // deliberately not here: a command's output belongs to its tool row's peek,
    // not to a reply bubble, and that row has no live half yet.
    case "item/agentMessage/delta":
    case "item/reasoning/summaryTextDelta": {
      if (!forThisTurn(p, state)) return NONE;
      const text = String(p.delta ?? "");
      if (!text) return NONE;
      const kind = method === "item/agentMessage/delta" ? "assistant" : "reasoning";
      // A reasoning summary arrives as several indexed paragraphs which the
      // completed item joins with newlines; keep the same seam live so the
      // bubble doesn't run two thoughts together.
      const sep = kind === "reasoning" && p.summaryIndex !== state.summaryIndex && state.summaryIndex != null ? "\n" : "";
      if (kind === "reasoning") state.summaryIndex = (p.summaryIndex as number | undefined) ?? 0;
      return { events: [], delta: { id: String(p.itemId ?? ""), kind, text: sep + text } };
    }
    case "turn/plan/updated": {
      if (!forThisTurn(p, state)) return NONE;
      const plan = (p.plan as { step: string; status: string }[] | undefined) ?? [];
      if (!plan.length) return NONE;
      // The exec protocol's todo_list item: one stable id per turn so the
      // checklist refreshes one row in place (./events.ts mapTodo).
      const item: ThreadItem = {
        id: `plan:${state.turnId}`,
        type: "todo_list",
        items: plan.map((s) => ({ text: s.step, completed: s.status === "completed" })),
      };
      return { events: [{ type: "item.updated", item }] };
    }
    case "thread/tokenUsage/updated": {
      if (!forThisTurn(p, state)) return NONE;
      const u = (p.tokenUsage ?? {}) as V2TokenUsage;
      if (u.total) state.total = toSdkUsage(u.total);
      const last = u.last;
      // The prompt the last request carried: input plus what the cache served
      // of it. Same reading the Claude driver takes off its last message.
      const ctx = last ? (last.inputTokens ?? 0) + (last.cachedInputTokens ?? 0) : null;
      if (ctx != null && ctx > 0) {
        state.contextTokens = ctx;
        return { events: [], contextTokens: ctx };
      }
      return NONE;
    }
    case "turn/completed": {
      if (!forThisTurn(p, state)) return NONE;
      const turn = p.turn as V2Turn;
      const events: ThreadEvent[] = [];
      if (state.total) events.push({ type: "turn.completed", usage: state.total });
      if (turn.status === "failed") {
        events.push({ type: "turn.failed", error: { message: turn.error?.message || "Codex turn failed" } });
        return { events, turnEnded: "failed" };
      }
      return { events, turnEnded: turn.status === "interrupted" ? "interrupted" : "completed" };
    }
    case "error": {
      if (!forThisTurn(p, state)) return NONE;
      // `willRetry` is a transient the CLI is already retrying — say nothing.
      if (p.willRetry) return NONE;
      const err = p.error as { message?: string } | undefined;
      return { events: [{ type: "error", message: err?.message || "Codex reported an error" }], warning: err?.message };
    }
    case "configWarning": {
      const summary = String(p.summary ?? "");
      if (!summary || state.warned.has(summary)) return { events: [], warning: summary };
      state.warned.add(summary);
      return { events: [], notice: `Codex config warning: ${summary}`, warning: summary };
    }
    case "warning": {
      const message = String(p.message ?? "");
      return { events: [], warning: message };
    }
    default:
      return NONE;
  }
}

function forThisTurn(p: Record<string, unknown>, state: AppServerTurnState): boolean {
  // Before turn/start answers we don't know our id; nothing item-shaped
  // arrives that early. A stale id from another client on the same thread
  // (impossible with a process per turn, cheap to guard) is dropped.
  const t = p.turnId ?? (p.turn as { id?: string } | undefined)?.id;
  return !!state.turnId && t === state.turnId;
}

// ---------- shape conversion ----------

const STATUS: Record<string, "in_progress" | "completed" | "failed"> = {
  inProgress: "in_progress",
  completed: "completed",
  failed: "failed",
  declined: "failed",
};

/** A v2 item as the exec protocol would have spelled it; null for kinds exec never renders. */
export function toSdkItem(item: V2Item): ThreadItem | null {
  switch (item.type) {
    case "agentMessage":
      return { id: item.id, type: "agent_message", text: (item as { text: string }).text ?? "" };
    case "plan":
      // Plan mode's proposal is the reply itself.
      return { id: item.id, type: "agent_message", text: (item as { text: string }).text ?? "" };
    case "reasoning": {
      const r = item as { summary?: string[]; content?: string[] };
      const text = (r.summary?.length ? r.summary : (r.content ?? [])).join("\n");
      return { id: item.id, type: "reasoning", text };
    }
    case "commandExecution": {
      const c = item as Extract<V2Item, { type: "commandExecution" }>;
      return {
        id: c.id,
        type: "command_execution",
        command: c.command,
        aggregated_output: c.aggregatedOutput ?? "",
        ...(c.exitCode != null ? { exit_code: c.exitCode } : {}),
        status: STATUS[c.status] ?? "in_progress",
      };
    }
    case "fileChange": {
      const f = item as Extract<V2Item, { type: "fileChange" }>;
      return {
        id: f.id,
        type: "file_change",
        changes: f.changes.map((ch) => ({ path: ch.path, kind: ch.kind })),
        status: f.status === "failed" || f.status === "declined" ? "failed" : "completed",
      };
    }
    case "mcpToolCall": {
      const m = item as Extract<V2Item, { type: "mcpToolCall" }>;
      return {
        id: m.id,
        type: "mcp_tool_call",
        server: m.server,
        tool: m.tool,
        arguments: m.arguments,
        ...(m.result
          ? { result: { content: (m.result.content ?? []) as never, structured_content: m.result.structuredContent } }
          : {}),
        ...(m.error ? { error: { message: m.error.message } } : {}),
        status: STATUS[m.status] ?? "in_progress",
      };
    }
    case "webSearch":
      return { id: item.id, type: "web_search", query: (item as { query: string }).query ?? "" };
    case "contextCompaction":
      return { id: item.id, type: "agent_message", text: "" };
    default:
      return null;
  }
}

function toSdkUsage(b: Partial<V2Breakdown>): Usage {
  return {
    input_tokens: b.inputTokens ?? 0,
    cached_input_tokens: b.cachedInputTokens ?? 0,
    cache_write_input_tokens: b.cacheWriteInputTokens ?? 0,
    output_tokens: b.outputTokens ?? 0,
    reasoning_output_tokens: b.reasoningOutputTokens ?? 0,
  };
}

// ---------- diffs ----------

import type { DiffLine } from "../../types";

/** A unified diff's hunk lines as DiffLine[], capped; headers dropped. */
export function diffLinesOf(unified: string, max = 400): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of unified.split("\n")) {
    if (out.length >= max) break;
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("@@")) {
      out.push({ sign: " ", text: line });
      continue;
    }
    if (line.startsWith("+")) out.push({ sign: "+", text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ sign: "-", text: line.slice(1) });
    else if (line.length) out.push({ sign: " ", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  return out;
}

// ---------- commands ----------

/**
 * The command a user would recognise, out of the shell wrapper Codex runs it
 * through: the CLI spells a command execution `/bin/zsh -lc '<command>'` (or
 * bash/sh, `-c` or `-lc`, single or double quotes), and a permission rule
 * remembered on that wrapper would match nothing a human ever typed. Anything
 * not shaped like the wrapper is returned unchanged.
 */
export function unwrapShellCommand(command: string): string {
  const m = /^(?:\S*\/)?(?:zsh|bash|sh|fish|dash)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim());
  if (!m) return command;
  const inner = m[2];
  // A single-quoted body can't contain a quote except as '\'' — undo that.
  return (m[1] === "'" ? inner.replace(/'\\''/g, "'") : inner).trim() || command;
}
