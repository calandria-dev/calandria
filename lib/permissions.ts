// Tool-permission policy behind the Claude driver's canUseTool gate
// (lib/agents/claude/driver.ts). Under bypassPermissions the SDK never calls
// this. Otherwise a call is allowed without a prompt only by the built-in
// read-only allowlist or a remembered project rule (permission_rules,
// revocable in Settings); everything else raises a card, like an
// AskUserQuestion. A stopped turn, an unwatched turn, an expired prompt, and
// an unparseable answer all deny.
//
// Pure and DB-free: no agent SDK, no store (pinned by tests/importGraph.test.ts).
// The driver parks the turn; the runner persists.

import type {
  DiffLine,
  PermissionDecision,
  PermissionMatchKind,
  PermissionRule,
  PermissionScopeOffer,
} from "./types";
import { describeToolUse } from "./agents/shared";
import { waitForAnswer, cancelAsk } from "./asks";
import { watcherCount } from "./events";
import { interactionDenied } from "./runContext";

// ---------- step 1: the built-in allowlist ----------

// Tools that only read, or only touch the agent's own scratch state, so a
// prompt for them buys no safety and costs a click per call. WebFetch and
// WebSearch send data out and are excluded, as is anything that writes to
// the filesystem or shells out.
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "TodoWrite",
  "TodoRead",
  // The driver's PreToolUse hook answers this before permissions are
  // consulted; listed here so a future SDK ordering change can't turn it
  // into a live prompt.
  "AskUserQuestion",
]);

// Calandria's own MCP tools, matched by exact name so a future tool on the
// same server can't inherit this trust from a shared name prefix. These
// three can't touch the user's code: they file a suggestion, register a URL,
// or ask a question.
const CALANDRIA_TOOLS = new Set([
  "mcp__calandria__suggest_task",
  "mcp__calandria__expose_service",
  "mcp__calandria__ask_user",
]);

// Tools that must be decided every time: no rule, no allowlist. ExitPlanMode
// is the plan-approval gate; remembering it would defeat plan mode.
const NEVER_REMEMBER = new Set(["ExitPlanMode"]);

/**
 * True when the call needs no human judgement. `blockedPath` is set when the
 * SDK has already blocked the call (typically outside the worktree); its
 * presence always forces a prompt, even for a read, since the allowlist must
 * not swallow that case.
 */
export function isAlwaysAllowed(tool: string, blockedPath?: string): boolean {
  if (blockedPath) return false;
  return READ_ONLY_TOOLS.has(tool) || CALANDRIA_TOOLS.has(tool);
}

// ---------- step 2: remembered rules ----------
//
// Durable rules are Bash-only: "always allow WebFetch" would grant every URL,
// "always allow Write" every path, but a command line is the one input a
// user can read in full and generalize honestly (`npm test`, `git status`).
// Everything else gets allow-once, plus the CLI's own don't-ask-again-this-
// session suggestion, which expires with the session.
//
// A remembered command names a script, not a behavior: `npm test` is
// whatever package.json says today, and an agent running under acceptEdits
// can rewrite that. Rules guard against prompt fatigue, not a sandbox; the
// worktree is the sandbox.

// A Bash command generalizes into a prefix rule only when it is a "plain"
// command line: an allowlist of characters, not a denylist of
// metacharacters. Anything outside this set (quotes, $, backticks, (), {},
// [], ;, |, &, redirects, backslashes, globs, newlines) means the shell
// could do something the prefix doesn't describe, so both rule creation and
// match time refuse it.
const PLAIN_COMMAND_RE = /^[A-Za-z0-9 _\-./=:@+,^%]+$/;

// Commands whose arguments are themselves a command to run, or that take a
// "run this" flag. A prefix rule on one of these would generalize to "run
// anything", so they only ever get an exact-match rule.
const WRAPPER_COMMANDS = new Set([
  "sudo", "doas", "su", "env", "xargs", "nohup", "time", "timeout", "nice", "ionice",
  "eval", "exec", "command", "sh", "bash", "zsh", "fish", "dash", "ksh",
  "ssh", "watch", "script", "setsid", "stdbuf", "unbuffer", "find", "parallel",
]);

/** The Bash command string for a call, or null when this isn't a Bash call. */
export function bashCommandOf(tool: string, input: Record<string, unknown>): string | null {
  if (tool !== "Bash") return null;
  const cmd = input?.command;
  return typeof cmd === "string" && cmd.trim() ? cmd.trim() : null;
}

const tokens = (cmd: string): string[] => cmd.trim().split(/\s+/).filter(Boolean);

/**
 * The prefix decision, with the reason when the answer is no. Shared by two
 * callers: the card only needs yes/no (bashPrefixOf below); a rule typed
 * into Settings has no proposed command on screen to explain itself, so its
 * refusal states what it objected to.
 */
type PrefixVerdict = { prefix: string } | { refused: string };

function prefixVerdict(command: string): PrefixVerdict {
  if (!PLAIN_COMMAND_RE.test(command))
    return {
      refused:
        "it contains characters the shell can reinterpret (quotes, $, backticks, |, &, ;, redirects, globs, newlines), " +
        "so the leading words don't describe what would actually run",
    };
  const parts = tokens(command);
  const head = parts[0];
  if (!head || head.startsWith("-")) return { refused: "it doesn't start with a command" };
  // `FOO=bar cmd`: the real command is further along, so the prefix would lie.
  if (head.includes("=")) return { refused: "it starts with an environment assignment, so the command being run is further along the line" };
  const name = head.split("/").pop() ?? head;
  if (WRAPPER_COMMANDS.has(name)) return { refused: `\`${name}\` runs whatever its arguments say, so allowing it by prefix would mean allowing anything` };
  // Widen to two tokens only for a subcommand-shaped word (`push`, `run`,
  // `test:unit`). A flag or path as token 2 means the rest of the line is
  // operands: `rm -rf x` must never become "always allow `rm -rf …`".
  const second = parts[1];
  if (second && /^[a-z][a-z0-9:_-]*$/.test(second)) return { prefix: `${head} ${second}` };
  if (parts.length === 1) return { prefix: head };
  return { refused: `\`${second}\` is a flag or an operand rather than a subcommand, so the rule would have to be \`${head} …\`. That would include every other use of \`${head}\`` };
}

/**
 * The prefix a Bash command may be remembered under: its command word, plus
 * the next token when it reads as a subcommand (`git status`, `npm test`).
 * Returns null when the command isn't plain, starts with an env assignment,
 * or leads with a wrapper that executes its own arguments.
 */
export function bashPrefixOf(command: string): string | null {
  const verdict = prefixVerdict(command);
  return "prefix" in verdict ? verdict.prefix : null;
}

/**
 * What "always allow" would remember for this call, rendered on the card so
 * the user approves the exact rule about to be created. Null for anything
 * but Bash; the driver offers a session-only grant there instead.
 */
export function scopeOfferFor(tool: string, input: Record<string, unknown>): PermissionScopeOffer | null {
  if (NEVER_REMEMBER.has(tool)) return null;
  const command = bashCommandOf(tool, input);
  if (!command) return null;
  const prefix = bashPrefixOf(command);
  return prefix
    ? { scope: "project", match_kind: "bash_prefix", value: prefix, label: `Always allow \`${prefix} …\` here` }
    : { scope: "project", match_kind: "bash_exact", value: command, label: "Always allow this exact command here" };
}

// ---------- step 2b: a rule written by hand, with no call to look at ----------
//
// Settings can mint the same rule without a prompt ("I already know I want
// `npm test` allowed here"), which matters for unattended turns whose card
// would auto-deny before anyone saw it. The grant must go through the same
// prefix policy as the card, and must not diverge from it in two ways:
//
//   - The stored value is what bashPrefixOf() returns, never the raw typed
//     text, or this becomes a way to mint `bash_prefix: "sudo"`.
//   - A refused prefix is an error, not a downgrade to bash_exact: narrowing
//     "allow npm test and its arguments" into one literal line would store a
//     rule the user didn't ask for and believes covers more than it does.
//
// Bash-only: ruleMatches() consults bashCommandOf(), so a rule naming any
// other tool can never match a call. "Always allow WebFetch here" would be
// every URL if it ever did match.

/** How long a hand-typed command may be. Past this it's a script, not a rule. */
const TYPED_COMMAND_CAP = 2_000;

export type TypedRule =
  | { ok: true; tool: "Bash"; match_kind: PermissionMatchKind; value: string }
  | { ok: false; error: string };

export function ruleFromTypedCommand(rawCommand: string, matchKind: PermissionMatchKind): TypedRule {
  const command = String(rawCommand ?? "").trim();
  if (!command) return { ok: false, error: "Type the command you want to allow." };
  if (command.length > TYPED_COMMAND_CAP)
    return { ok: false, error: `That's longer than ${TYPED_COMMAND_CAP.toLocaleString()} characters. Approve something that size from the permission card, where you can read what's being run.` };
  if (matchKind === "bash_exact") return { ok: true, tool: "Bash", match_kind: "bash_exact", value: command };
  const verdict = prefixVerdict(command);
  if ("refused" in verdict)
    return {
      ok: false,
      error: `\`${command}\` can't be allowed by prefix: ${verdict.refused}. Add it as an exact command instead, and it will match that line and nothing else.`,
    };
  return { ok: true, tool: "Bash", match_kind: "bash_prefix", value: verdict.prefix };
}

// ---------- step 2c: a whole hosted MCP server, trusted from project settings ----------
//
// Hosted gateway MCP servers (docs/AGENTS.md, "Hosted MCP servers") break
// the Bash-only rule above without breaking its rationale: LiteLLM returns
// tools as `<alias>-<tool>`, so Claude sees `mcp__<alias>__<alias>-<tool>`,
// and the alias is a server the user picked by name in the project's MCP
// picker, not a wildcard invented at approval time. "Trust this server"
// mints a rule matching every tool call under one alias's namespace, through
// the same permission_rules table and canUseTool gate a Bash prefix uses,
// minted from project settings since there is no per-call MCP prompt:
// LiteLLM tools land wholesale when the alias is mounted.

/** How long an alias may be before it's refused as a rule. Generous: a
 *  LiteLLM alias is normally a short slug; this only guards against abuse. */
const MCP_ALIAS_CAP = 200;

export type McpServerRule = { ok: true; tool: string; match_kind: "mcp_server"; value: string } | { ok: false; error: string };

/**
 * The rule a "trust this server" toggle mints: matches every
 * `mcp__<alias>__*` tool call, never just one. `tool` is stored as the
 * wildcard spelling for the Settings list to render; matching itself keys off
 * `value` (see ruleMatches below), not `tool`.
 */
export function ruleForGatewayMcpServer(alias: string): McpServerRule {
  const a = String(alias ?? "").trim();
  if (!a) return { ok: false, error: "alias is required" };
  if (a.length > MCP_ALIAS_CAP || /[\0-\x1f\x7f]/.test(a)) return { ok: false, error: "invalid alias" };
  return { ok: true, tool: `mcp__${a}__*`, match_kind: "mcp_server", value: a };
}

/** Does a remembered rule cover this call? */
export function ruleMatches(rule: { tool: string; match_kind: PermissionMatchKind; value: string }, tool: string, input: Record<string, unknown>): boolean {
  if (NEVER_REMEMBER.has(tool)) return false;
  // mcp_server matches by namespace, not the exact tool the card showed:
  // LiteLLM names every tool under an alias `mcp__<alias>__<alias>-<tool>`,
  // and trusting the server means trusting all of them, present and future.
  if (rule.match_kind === "mcp_server") return tool.startsWith(`mcp__${rule.value}__`);
  if (rule.tool !== tool) return false;
  const command = bashCommandOf(tool, input);
  if (!command) return false;
  if (rule.match_kind === "bash_exact") return command === rule.value;
  // bash_prefix: the candidate must also be plain (a rule minted from
  // `npm test` can never cover `npm test && curl …`), and must match the
  // remembered tokens as whole tokens, not a string prefix, so `npm testfoo`
  // doesn't match.
  if (!PLAIN_COMMAND_RE.test(command)) return false;
  const want = tokens(rule.value);
  const got = tokens(command);
  return want.length <= got.length && want.every((t, i) => got[i] === t);
}

/** True when any of the project's remembered rules covers this call. */
export function allowedByRules(rules: PermissionRule[], tool: string, input: Record<string, unknown>): boolean {
  return rules.some((r) => ruleMatches(r, tool, input));
}

// ---------- step 3: the card ----------

// What a permission card shows of the tool input. Much larger than the
// transcript's clip: the user is authorizing this text, so a suffix hidden
// by truncation is a suffix nobody approved. Anything past the cap is
// called out in the card, not dropped.
const DETAIL_CAP = 20_000;

/**
 * What the permission card shows. The user needs the tool name and enough
 * of its input to judge it, so this reuses the describeToolUse() normalizer
 * the transcript uses for tool calls, except Bash gets its command verbatim:
 * describeToolUse clips at 4k, which is fine for reading a transcript but
 * not for approving one.
 */
export function describePermission(tool: string, input: Record<string, unknown>): { title: string; detail: string; diff?: DiffLine[] } {
  const { title, detail, diff } = describeToolUse(tool, input);
  const command = bashCommandOf(tool, input);
  const full = command ?? detail;
  return { title, detail: capDetail(full), diff };
}

function capDetail(text: string): string {
  if (text.length <= DETAIL_CAP) return text;
  return (
    `${text.slice(0, DETAIL_CAP)}\n\n` +
    `⚠ ${text.length - DETAIL_CAP} more characters are not shown here. ` +
    `Approving applies to the WHOLE input, including the part above the fold.`
  );
}

// The decision travels back through the ask registry, whose payload is
// AskAnswers (string[][]): answers[0][0] is the decision, answers[0][1] an
// optional note the user typed. Anything unrecognized fails closed, so a
// malformed, replayed, or stale client can never widen a permission.
const DECISIONS: PermissionDecision[] = ["allow_once", "allow_always", "deny"];
const NOTE_CAP = 2_000;

export function parseDecision(answers: string[][] | undefined): { decision: PermissionDecision; note: string } {
  const first = answers?.[0] ?? [];
  const raw = String(first[0] ?? "");
  const decision = (DECISIONS as string[]).includes(raw) ? (raw as PermissionDecision) : "deny";
  return { decision, note: String(first[1] ?? "").trim().slice(0, NOTE_CAP) };
}

/** The text the model receives when a call is refused, so it adapts instead of retrying blindly. */
export function denyMessage(title: string, reason: string): string {
  return (
    `The user did not approve this tool call (${title}). ${reason}\n\n` +
    `Do not retry it, and do not work around it with a different tool. Continue with what you ` +
    `can do without it, and if that leaves the task blocked, stop and say exactly what you need approved.`
  );
}

// ---------- refusals the CLI makes on its own ----------

// A `system`/`permission_denied` message is the CLI reporting a call it
// refused before canUseTool was ever consulted. This only decides which of
// the message's two text fields a human should see.
//
// The SDK documents `decision_reason` as the human-readable reason and
// `message` as the rejection text returned to the model, which can include
// instructions aimed at the model, not the user (see
// tests/claudePermissionMode.test.ts). Prefer decision_reason; otherwise
// take `message` up to its model-directed tail, and cap whatever survives.
const BLOCK_REASON_CAP = 400;

export function blockedReason(decisionReason?: string, message?: string): string | undefined {
  const stated = decisionReason?.trim();
  if (stated) return capReason(stated);
  // Everything from "IMPORTANT:" on is instruction aimed at the model.
  const head = (message ?? "").split(/\bIMPORTANT:/)[0].trim();
  return head ? capReason(head) : undefined;
}

const capReason = (text: string): string =>
  text.length <= BLOCK_REASON_CAP ? text : `${text.slice(0, BLOCK_REASON_CAP).trimEnd()}…`;

export const DENIED_BY_USER = "They declined it.";
export const DENIED_UNATTENDED =
  "Nobody was watching this session to approve it, so it was declined automatically. " +
  "Stop here and summarize what you were about to do — the user will pick it up when they return.";
export const DENIED_TIMED_OUT = "The request went unanswered and expired.";
export const DENIED_INTERRUPTED = "The turn ended before this was answered.";

// ---------- parking the turn on a human ----------
//
// A prompt reuses the ask registry (same waitForAnswer/submitAnswer, same
// POST /api/tasks/[id]/answer route), plus a deadline an ordinary question
// doesn't need: a permission prompt can be raised by a turn nobody launched
// (an auto-started task at 3am), and a turn parked with nobody watching
// holds its abort slot and keeps the instance marked busy indefinitely.
//
// The gate distinguishes by whether any client is connected: watchers now
// use the attended cap (hours), no watchers get a short grace that is
// re-checked and then denies. The recheck lets opening the app a few
// seconds later still catch the decision; a watcher
// appearing upgrades the prompt to the attended cap.
//
// Connection count is presence, not intent: a tab left open on a sleeping
// laptop reads as attended. The heuristic only ever shortens the wait, never
// lengthens it past the attended cap.

export type PermissionWait =
  | { answers: string[][] }
  /** Nobody decided: "unattended" means no client ever appeared, "timeout" means the attended cap ran out. */
  | { expired: "unattended" | "timeout" }
  /** The turn, or this specific request, was torn down before anyone decided. */
  | { aborted: true };

export async function waitForPermission(opts: {
  taskId: string;
  id: string;
  signal?: AbortSignal;
  /** ms to wait while a client is connected; 0 = park indefinitely. */
  attendedMs: number;
  /** ms to wait while NO client is connected; 0 = never shortcut, use attendedMs. */
  unattendedMs: number;
}): Promise<PermissionWait> {
  const { taskId, id, signal, attendedMs, unattendedMs } = opts;
  // Register the waiter first, so an answer arriving in the same tick as the
  // published card can't miss it. The registry keys on the id, not questions.
  const answer = waitForAnswer(taskId, id, [], signal);

  // A scheduled turn is unattended regardless of watcherCount(): the user
  // didn't launch it, so an open tab isn't consent to be interrupted by it.
  // Settle at once instead of parking; the runner already handles an
  // unattended deny.
  const denied = interactionDenied(taskId);
  if (denied) {
    cancelAsk(taskId, id, "unattended: scheduled run");
    await answer.catch(() => {});
    return { expired: "unattended" };
  }
  let attended = unattendedMs <= 0 || watcherCount() > 0;
  let deadline = deadlineFrom(attended ? attendedMs : unattendedMs);
  let expired: "unattended" | "timeout" | null = null;
  const every = Math.max(25, Math.min(3_000, Math.floor((unattendedMs || 6_000) / 2)));
  const timer = setInterval(() => {
    // A tab opened during the grace: this is a watched session after all.
    if (!attended && watcherCount() > 0) {
      attended = true;
      deadline = deadlineFrom(attendedMs);
      return;
    }
    if (deadline && Date.now() >= deadline) {
      expired = attended ? "timeout" : "unattended";
      clearInterval(timer);
      // Settles the waiter and removes the registry entry, so a late answer
      // reports "nothing waiting" instead of resolving a dead turn.

      cancelAsk(taskId, id, "permission expired");
    }
  }, every);

  try {
    return { answers: await answer };
  } catch {
    return expired ? { expired } : { aborted: true };
  } finally {
    clearInterval(timer);
  }
}

const deadlineFrom = (msFromNow: number): number => (msFromNow > 0 ? Date.now() + msFromNow : 0);

/**
 * The deadline to stamp on a freshly raised card, for the transcript record.
 * Advisory: the gate extends it if a client appears during an unattended grace,
 * which is why the UI phrases it as "declines automatically", not a countdown.
 */
export function promptDeadline(attendedMs: number, unattendedMs: number, taskId?: string): number {
  // A declared-unattended turn is decided immediately; anything else is the
  // presence heuristic.
  if (taskId && interactionDenied(taskId)) return Date.now();
  return deadlineFrom(unattendedMs > 0 && watcherCount() === 0 ? unattendedMs : attendedMs);
}
