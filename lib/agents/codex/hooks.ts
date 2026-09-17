// Codex hook inventory, per-hook trust, and hook-run lifecycle.
//
// A Codex hook runs a command (or an MCP tool, or a prompt) on a lifecycle
// event, `preToolUse` among them. That command runs outside Calandria's
// permission gate, the same hazard ../../settingsDrift.ts covers for Claude's
// settings.json. Codex gates it itself: a hook whose definition has not been
// trusted is skipped, and the trust record is the definition's hash, so
// editing a hook invalidates the prior review. What Calandria adds is the
// inventory, the review, and the evidence a run leaves behind.
//
// Wire facts, verified live against codex-cli 0.153.0:
//
//   * `hooks/list` takes `{ cwds?: string[] }` (empty means the session's own
//     cwd) and answers `{ data: [{ cwd, hooks, warnings, errors }] }`. Each
//     hook carries `currentHash` and `trustStatus`, so trust is per hook
//     entry, not per file and not per project.
//   * `trustStatus` is "trusted" only when the stored hash equals
//     `currentHash`. A hook edited after review reads "modified", one never
//     reviewed reads "untrusted", and one an administrator pinned reads
//     "managed".
//   * There is NO `hooks/trust` method. The CLI's own TUI writes trust with
//     `config/batchWrite`, which is what ./appServer.ts sends here. The stored
//     value must carry the `sha256:` prefix verbatim, or the hook reads
//     "modified" instead of "trusted".
//   * PROJECT trust outranks hook trust and is reported nowhere in the answer:
//     an untrusted project answers with an EMPTY hooks array and empty
//     `warnings` and `errors`, and says why only in a `configWarning`
//     notification. An empty inventory is therefore ambiguous on its own,
//     which is why `suppressedReason` exists.
//   * Per-hook "untrusted" and "modified" are silent outside this answer. No
//     notification reports them, so nothing but reading `trustStatus` per hook
//     establishes that a configured hook is inert.
//
// This module is pure: types, parsing and rendering, no spawning. The
// transport is ./appServer.ts and the route is app/api/agents/[id]/hooks.

/** Lifecycle event a hook fires on. */
export type CodexHookEventName =
  | "preToolUse"
  | "permissionRequest"
  | "postToolUse"
  | "preCompact"
  | "postCompact"
  | "sessionStart"
  | "sessionEnd"
  | "userPromptSubmit"
  | "subagentStart"
  | "subagentStop"
  | "stop"
  | "interrupt";

/** Where a hook definition came from. */
export type CodexHookSource =
  | "system"
  | "user"
  | "project"
  | "mdm"
  | "sessionFlags"
  | "plugin"
  | "cloudRequirements"
  | "cloudManagedConfig"
  | "legacyManagedConfigFile"
  | "legacyManagedConfigMdm"
  | "unknown";

/**
 * Whether this exact definition has been reviewed. "trusted" means the stored
 * hash matches the definition on disk; "modified" means it was reviewed and
 * then edited; "managed" means an administrator pinned it and the user cannot
 * review it away.
 */
export type CodexHookTrustStatus = "managed" | "untrusted" | "trusted" | "modified";

/** What a hook does when it fires. */
export type CodexHookHandlerType = "command" | "mcpTool" | "prompt" | "agent";

/** One configured hook, as `hooks/list` reports it. */
export interface CodexHook {
  /**
   * The hook's identity, `<sourcePath>:<event>:<group>:<index>`. This is the
   * key trust is stored under, so it is what a review writes about.
   */
  key: string;
  eventName: CodexHookEventName;
  /** Tool-name pattern this hook narrows to, or null for every tool. */
  matcher: string | null;
  handlerType: CodexHookHandlerType;
  /** The shell command, for a `command` hook. */
  command?: string;
  /** Whether a `command` hook runs without blocking the event. */
  async?: boolean;
  /** The MCP server and tool, for an `mcpTool` hook. */
  server?: string;
  tool?: string;
  /** File the definition lives in. */
  sourcePath: string;
  source: CodexHookSource;
  pluginId: string | null;
  timeoutSec: number | null;
  statusMessage: string | null;
  displayOrder: number;
  enabled: boolean;
  isManaged: boolean;
  /** Hash of the definition as it reads on disk right now, `sha256:<hex>`. */
  currentHash: string;
  trustStatus: CodexHookTrustStatus;
}

/** The hooks that apply in one working directory. */
export interface CodexHookScope {
  cwd: string;
  hooks: CodexHook[];
  /** Non-fatal complaints about the definitions, as the CLI worded them. */
  warnings: string[];
  /** A definition file that could not be read, with the CLI's reason. */
  errors: { path: string; message: string }[];
}

export interface CodexHookInventory {
  scopes: CodexHookScope[];
  /**
   * Why the inventory is empty when it is empty for a reason the answer does
   * not carry: an untrusted project suppresses every project-local hook and
   * reports it only as a `configWarning`. Absent when nothing suppressed
   * anything, in which case an empty inventory means no hooks are configured.
   */
  suppressedReason?: string;
}

/** A hook that Codex will skip, with the reason it will skip it. */
export interface CodexHookSkip {
  hook: CodexHook;
  reason: string;
}

// The `configWarning` the CLI pushes when a project is not trusted. Matched on
// the stable half of the sentence; the rest names the folders and varies.
const UNTRUSTED_PROJECT = "until the project is trusted";

/** Whether a `configWarning` summary is the project-untrust notice. */
export function isProjectUntrustedWarning(summary: string): boolean {
  return summary.includes(UNTRUSTED_PROJECT);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function optStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown, fallback: number): number {
  // ts-rs types these `bigint`, but the wire is JSON, so they arrive as
  // numbers. A string is tolerated in case a future build widens them.
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

const EVENTS = new Set<string>([
  "preToolUse",
  "permissionRequest",
  "postToolUse",
  "preCompact",
  "postCompact",
  "sessionStart",
  "sessionEnd",
  "userPromptSubmit",
  "subagentStart",
  "subagentStop",
  "stop",
  "interrupt",
]);

const TRUST = new Set<string>(["managed", "untrusted", "trusted", "modified"]);

const HANDLERS = new Set<string>(["command", "mcpTool", "prompt", "agent"]);

function parseHook(raw: unknown): CodexHook | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = str(r.key);
  if (!key) return null;
  const event = str(r.eventName);
  const handler = str(r.handlerType);
  const trust = str(r.trustStatus);
  const hook: CodexHook = {
    key,
    // An unknown event or handler is reported as it came rather than dropped:
    // a hook this build cannot name is still a hook that runs, and hiding it
    // would be the one failure mode this inventory exists to prevent.
    eventName: (EVENTS.has(event) ? event : "preToolUse") as CodexHookEventName,
    matcher: optStr(r.matcher),
    handlerType: (HANDLERS.has(handler) ? handler : "command") as CodexHookHandlerType,
    sourcePath: str(r.sourcePath),
    source: (str(r.source) || "unknown") as CodexHookSource,
    pluginId: optStr(r.pluginId),
    timeoutSec: r.timeoutSec == null ? null : num(r.timeoutSec, 0),
    statusMessage: optStr(r.statusMessage),
    displayOrder: num(r.displayOrder, 0),
    enabled: r.enabled !== false,
    isManaged: r.isManaged === true,
    currentHash: str(r.currentHash),
    // An unrecognized trust status is treated as untrusted, the safe reading:
    // it never claims a definition was reviewed when this build cannot tell.
    trustStatus: (TRUST.has(trust) ? trust : "untrusted") as CodexHookTrustStatus,
  };
  if (typeof r.command === "string") hook.command = r.command;
  if (typeof r.async === "boolean") hook.async = r.async;
  if (typeof r.server === "string") hook.server = r.server;
  if (typeof r.tool === "string") hook.tool = r.tool;
  return hook;
}

/**
 * Normalize a `hooks/list` result. Tolerant on purpose: a field this build
 * does not know about is dropped, and a malformed entry is skipped rather than
 * failing the whole inventory, since a partial answer still tells the user
 * which hooks are live.
 */
export function parseHooksList(data: unknown, suppressedReason?: string): CodexHookInventory {
  const rows = (data as { data?: unknown } | null)?.data;
  const scopes: CodexHookScope[] = [];
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const hooks = Array.isArray(r.hooks)
        ? r.hooks.map(parseHook).filter((h): h is CodexHook => !!h)
        : [];
      hooks.sort((a, b) => a.displayOrder - b.displayOrder || a.key.localeCompare(b.key));
      scopes.push({
        cwd: str(r.cwd),
        hooks,
        warnings: Array.isArray(r.warnings) ? r.warnings.map(str).filter(Boolean) : [],
        errors: Array.isArray(r.errors)
          ? r.errors
              .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
              .map((e) => ({ path: str(e.path), message: str(e.message) }))
          : [],
      });
    }
  }
  return suppressedReason ? { scopes, suppressedReason } : { scopes };
}

/** Every hook in the inventory, across scopes. */
export function allHooks(inv: CodexHookInventory): CodexHook[] {
  return inv.scopes.flatMap((s) => s.hooks);
}

/**
 * The reason Codex will skip this hook, or null if it will run it. Disabled
 * outranks trust in the message because re-reviewing an off hook changes
 * nothing.
 */
export function hookSkipReason(hook: CodexHook): string | null {
  if (!hook.enabled) return "disabled";
  if (hook.trustStatus === "untrusted") return "never reviewed";
  if (hook.trustStatus === "modified") return "edited since it was reviewed";
  return null;
}

/** Every configured hook Codex will not run, with why. */
export function skippedHooks(inv: CodexHookInventory): CodexHookSkip[] {
  const out: CodexHookSkip[] = [];
  for (const hook of allHooks(inv)) {
    const reason = hookSkipReason(hook);
    if (reason) out.push({ hook, reason });
  }
  return out;
}

/** One line naming what a hook does, for a card or a log. */
export function describeHook(hook: CodexHook): string {
  const what =
    hook.handlerType === "command"
      ? (hook.command || "(no command)")
      : hook.handlerType === "mcpTool"
        ? `${hook.server ?? "?"}/${hook.tool ?? "?"}`
        : hook.handlerType;
  const on = hook.matcher ? `${hook.eventName}(${hook.matcher})` : hook.eventName;
  return `${on}: ${what}`;
}

// A TOML dotted key wraps a segment in double quotes when the segment is not a
// bare key. A hook's own key always needs it: it starts with a path and
// contains dots (`.codex/hooks.json`), and an unquoted segment silently splits
// into several tables that match no hook at all.
function tomlQuote(segment: string): string {
  return `"${segment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The `config.toml` dotted path a hook's trust record is stored under. */
export function hookTrustKeyPath(key: string): string {
  return `hooks.state.${tomlQuote(key)}.trusted_hash`;
}

/** The `config.toml` dotted path a hook's on/off state is stored under. */
export function hookEnabledKeyPath(key: string): string {
  return `hooks.state.${tomlQuote(key)}.enabled`;
}

export interface CodexConfigEdit {
  keyPath: string;
  value: unknown;
  mergeStrategy: "upsert" | "replace";
}

/**
 * The `config/batchWrite` edit that records a review of this exact definition.
 * The hash is stored verbatim, `sha256:` prefix included: a bare hex digest
 * does not compare equal to `currentHash` and leaves the hook "modified".
 *
 * The review is pinned to the hash, so a later edit to the same hook needs a
 * new review.
 */
export function hookTrustEdit(hook: CodexHook): CodexConfigEdit {
  return { keyPath: hookTrustKeyPath(hook.key), value: hook.currentHash, mergeStrategy: "upsert" };
}

/** The edit that withdraws a review, leaving the hook untrusted and inert. */
export function hookUntrustEdit(hook: CodexHook): CodexConfigEdit {
  return { keyPath: hookTrustKeyPath(hook.key), value: "", mergeStrategy: "upsert" };
}

/** The edit that turns a hook on or off without touching its review. */
export function hookEnabledEdit(hook: CodexHook, enabled: boolean): CodexConfigEdit {
  return { keyPath: hookEnabledKeyPath(hook.key), value: enabled, mergeStrategy: "upsert" };
}

// ---------------------------------------------------------------------------
// Hook runs: what `hook/started` and `hook/completed` report.
// ---------------------------------------------------------------------------

export type CodexHookRunStatus = "running" | "completed" | "failed" | "blocked" | "stopped";

export type CodexHookOutputKind = "warning" | "stop" | "feedback" | "context" | "error";

export interface CodexHookOutputEntry {
  kind: CodexHookOutputKind;
  text: string;
}

/** One firing of one hook. */
export interface CodexHookRun {
  id: string;
  eventName: CodexHookEventName;
  handlerType: CodexHookHandlerType;
  executionMode: "sync" | "async";
  scope: "thread" | "turn";
  sourcePath: string;
  source: CodexHookSource;
  status: CodexHookRunStatus;
  statusMessage: string | null;
  durationMs: number | null;
  entries: CodexHookOutputEntry[];
}

const RUN_STATUS = new Set<string>(["running", "completed", "failed", "blocked", "stopped"]);
const OUTPUT_KIND = new Set<string>(["warning", "stop", "feedback", "context", "error"]);

/** Normalize a `hook/started` or `hook/completed` payload's `run`. */
export function parseHookRun(raw: unknown): CodexHookRun | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const status = str(r.status);
  const entries = Array.isArray(r.entries)
    ? r.entries
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .map((e) => ({
          kind: (OUTPUT_KIND.has(str(e.kind)) ? str(e.kind) : "context") as CodexHookOutputKind,
          text: str(e.text),
        }))
        .filter((e) => e.text)
    : [];
  return {
    id,
    eventName: (EVENTS.has(str(r.eventName)) ? str(r.eventName) : "preToolUse") as CodexHookEventName,
    handlerType: (HANDLERS.has(str(r.handlerType)) ? str(r.handlerType) : "command") as CodexHookHandlerType,
    executionMode: str(r.executionMode) === "async" ? "async" : "sync",
    scope: str(r.scope) === "thread" ? "thread" : "turn",
    sourcePath: str(r.sourcePath),
    source: (str(r.source) || "unknown") as CodexHookSource,
    // An unrecognized status is treated as failed rather than completed, so a
    // future status this build cannot name is never read as a clean pass.
    status: (RUN_STATUS.has(status) ? status : "failed") as CodexHookRunStatus,
    statusMessage: optStr(r.statusMessage),
    durationMs: r.durationMs == null ? null : num(r.durationMs, 0),
    entries,
  };
}

/**
 * Whether a finished run passed with nothing to say. A clean run is the common
 * case and stays off the transcript unless hook tracing is on.
 */
export function isCleanHookRun(run: CodexHookRun): boolean {
  if (run.status !== "completed") return false;
  return !run.entries.some((e) => e.kind === "stop" || e.kind === "error" || e.kind === "warning");
}

/** Whether this run stopped the thing it fired on. */
export function hookRunDenied(run: CodexHookRun): boolean {
  return run.status === "blocked" || run.status === "stopped" || run.entries.some((e) => e.kind === "stop");
}

const STATUS_WORD: Record<CodexHookRunStatus, string> = {
  running: "started",
  completed: "passed",
  failed: "failed",
  blocked: "blocked the call",
  stopped: "stopped the turn",
};

/**
 * The transcript line for a finished run. Names the event, where the
 * definition lives and what it said, since a hook denial is otherwise
 * indistinguishable from the model choosing not to make the call.
 */
export function hookRunNotice(run: CodexHookRun): string {
  const parts = [`Codex hook ${run.eventName} ${STATUS_WORD[run.status]}`];
  if (run.source !== "unknown") parts.push(`(${run.source})`);
  const head = parts.join(" ");
  const said = run.entries
    .filter((e) => e.kind === "stop" || e.kind === "error" || e.kind === "warning" || e.kind === "feedback")
    .map((e) => `${e.kind}: ${e.text}`);
  if (run.statusMessage) said.unshift(run.statusMessage);
  const tail = said.length ? `: ${said.join("; ")}` : "";
  const where = run.sourcePath ? ` [${run.sourcePath}]` : "";
  return `${head}${tail}${where}`;
}
