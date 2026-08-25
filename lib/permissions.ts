// Tool-permission policy: the decision logic behind the Claude driver's
// canUseTool gate (lib/agents/claude/driver.ts).
//
// Under bypassPermissions nothing here runs — the SDK never
// consults the callback. Under acceptEdits / plan every tool call the
// SDK doesn't auto-approve lands here, and the gate answers in three steps:
//
//   1. a built-in read-only allowlist  → allow silently (otherwise a prompted
//      session would ask before every Read/Grep and be unusable);
//   2. a remembered project-scoped rule → allow silently (the "always allow"
//      button; rules live in permission_rules and are revocable in Settings);
//   3. otherwise → prompt the human, exactly like an AskUserQuestion.
//
// The gate FAILS CLOSED everywhere: a stopped turn, an unwatched turn, an
// expired prompt, and an unparseable answer all deny.
//
// Everything here is pure/DB-free on purpose: no agent SDK, no store. The
// driver owns the parking, the runner owns persistence — the same split the
// ask flow uses. (Pinned SDK-free by tests/importGraph.test.ts.)

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

// Tools that only READ (or only touch the agent's own scratch state), so
// prompting for them buys no safety and costs the user a click per call.
// Deliberately conservative: WebFetch/WebSearch send data out and are NOT here,
// and nothing that writes to the filesystem or shells out is here either.
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "TodoWrite",
  "TodoRead",
  // Answered by the driver's PreToolUse hook before permissions are consulted;
  // listed so a future SDK ordering change can't turn an ask into a prompt.
  "AskUserQuestion",
]);

// Calandria's own MCP tools, spelled out rather than matched by server
// prefix: these three can't touch the user's code (they file a suggestion,
// register a URL, ask a question), but a future tool on the same server must
// not inherit that trust just because its name starts the same way.
const ORCHESTRATOR_TOOLS = new Set([
  "mcp__calandria__suggest_task",
  "mcp__calandria__expose_service",
  "mcp__calandria__ask_user",
]);

// Tools that must be decided EVERY time, no rule and no allowlist.
// ExitPlanMode is the "approve this plan" gate — auto-approving or remembering
// it would defeat plan mode, which is the one thing that mode exists to do.
const NEVER_REMEMBER = new Set(["ExitPlanMode"]);

/**
 * True when the call needs no human judgement. `blockedPath` is the SDK
 * telling us the call reaches somewhere it isn't allowed (outside the
 * worktree, typically) — that is EXACTLY the case the allowlist must not
 * swallow, so its presence forces a prompt even for a read.
 */
export function isAlwaysAllowed(tool: string, blockedPath?: string): boolean {
  if (blockedPath) return false;
  return READ_ONLY_TOOLS.has(tool) || ORCHESTRATOR_TOOLS.has(tool);
}

// ---------- step 2: remembered rules ----------
//
// Durable rules are Bash-only, and deliberately so. "Always allow WebFetch in
// this project" would grant every URL; "always allow Write" every path. A
// command line is the one input a user can read in full and generalize
// honestly, and it's the one that actually recurs (`npm test`, `git status`).
// Everything else gets allow-once, plus the CLI's own don't-ask-again-this-
// session suggestion, which expires with the session.
//
// Caveat worth knowing: a remembered command names a script, not a behaviour.
// `npm test` is whatever package.json says today, and an agent running under
// acceptEdits can rewrite that. Rules are a convenience against prompt
// fatigue, not a sandbox — that's what the worktree is for.

// A Bash command is only ever generalized into a prefix rule when it is a
// "plain" command line: an ALLOWLIST of characters, not a denylist of
// metacharacters. Anything outside this set — quotes, $, backticks, (), {},
// [], ;, |, &, redirects, backslashes, globs, newlines — means the shell could
// do something the prefix doesn't describe, so the rule is refused (and, at
// match time, so is the candidate command).
const PLAIN_COMMAND_RE = /^[A-Za-z0-9 _\-./=:@+,^%]+$/;

// Commands whose ARGUMENTS are themselves a command to run, or which take a
// "run this" flag. A prefix rule on one of these silently generalizes to "run
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
 * The prefix decision, with the REASON when the answer is no. One
 * implementation, two callers: the card only needs the yes/no (bashPrefixOf
 * below), while a rule typed into Settings has no proposed command in front of
 * the user to explain itself, so a refusal there has to say what it objected to.
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
  // `FOO=bar cmd` — the real command is further along, so the prefix would lie.
  if (head.includes("=")) return { refused: "it starts with an environment assignment, so the command being run is further along the line" };
  const name = head.split("/").pop() ?? head;
  if (WRAPPER_COMMANDS.has(name)) return { refused: `\`${name}\` runs whatever its arguments say, so allowing it by prefix would mean allowing anything` };
  // Only widen to two tokens for a subcommand-shaped word (`push`, `run`,
  // `test:unit`). A flag or a path as token 2 means the rest of the line is
  // operands — `rm -rf x` must never become "always allow `rm -rf …`".
  const second = parts[1];
  if (second && /^[a-z][a-z0-9:_-]*$/.test(second)) return { prefix: `${head} ${second}` };
  if (parts.length === 1) return { prefix: head };
  return { refused: `\`${second}\` is a flag or an operand rather than a subcommand, so the rule would have to be \`${head} …\` — every other use of \`${head}\` included` };
}

/**
 * The prefix a Bash command may be remembered under — its command word plus,
 * when the next token reads as a subcommand (`git status`, `npm test`), that
 * too. Returns null when the command isn't plain, starts with an env
 * assignment, or leads with a wrapper that would execute its own arguments.
 */
export function bashPrefixOf(command: string): string | null {
  const verdict = prefixVerdict(command);
  return "prefix" in verdict ? verdict.prefix : null;
}

/**
 * What "always allow" would remember for this call, rendered on the card so
 * the user approves the exact rule they're about to create rather than an
 * implied one. Null for anything but Bash — see the note above; the driver
 * offers a session-only grant there instead.
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
// Settings can mint the same rule without waiting for a prompt to happen ("I
// already know I want `npm test` allowed here"), which matters most for the
// unattended turns whose card would auto-deny before anyone saw it. The grant
// must be no wider than the card's, so it goes through the SAME prefix policy —
// and the two ways it must NOT differ:
//
//   - The value stored is what bashPrefixOf() returns, never what was typed.
//     Otherwise this becomes the way to mint `bash_prefix: "sudo"`.
//   - A refused prefix is an ERROR, not a quiet downgrade to bash_exact. The
//     card can fall back because it shows the user the exact rule it's about to
//     create; a form that silently narrows "allow npm test and its arguments"
//     into one literal line stores a rule nobody asked for, which the user then
//     believes covers calls it doesn't.
//
// Bash-only, and not a choice worth re-opening here: ruleMatches() consults
// bashCommandOf(), so a rule naming any other tool can never match anything.
// Accepting one would store a row that reads like a grant and does nothing —
// and if it ever DID work, "always allow WebFetch here" is every URL.

/** How long a hand-typed command may be. Past this it's a script, not a rule. */
const TYPED_COMMAND_CAP = 2_000;

export type TypedRule =
  | { ok: true; tool: "Bash"; match_kind: PermissionMatchKind; value: string }
  | { ok: false; error: string };

export function ruleFromTypedCommand(rawCommand: string, matchKind: PermissionMatchKind): TypedRule {
  const command = String(rawCommand ?? "").trim();
  if (!command) return { ok: false, error: "Type the command you want to allow." };
  if (command.length > TYPED_COMMAND_CAP)
    return { ok: false, error: `That's longer than ${TYPED_COMMAND_CAP.toLocaleString()} characters — approve something that size from the permission card, where you can read what's being run.` };
  if (matchKind === "bash_exact") return { ok: true, tool: "Bash", match_kind: "bash_exact", value: command };
  const verdict = prefixVerdict(command);
  if ("refused" in verdict)
    return {
      ok: false,
      error: `\`${command}\` can't be allowed by prefix — ${verdict.refused}. Add it as an exact command instead, and it will match that line and nothing else.`,
    };
  return { ok: true, tool: "Bash", match_kind: "bash_prefix", value: verdict.prefix };
}

/** Does a remembered rule cover this call? */
export function ruleMatches(rule: { tool: string; match_kind: PermissionMatchKind; value: string }, tool: string, input: Record<string, unknown>): boolean {
  if (rule.tool !== tool || NEVER_REMEMBER.has(tool)) return false;
  const command = bashCommandOf(tool, input);
  if (!command) return false;
  if (rule.match_kind === "bash_exact") return command === rule.value;
  // bash_prefix: the candidate must be plain too (a rule minted from
  // `npm test` can never cover `npm test && curl …`), and must match the
  // remembered tokens whole — not as a string prefix, which would let
  // `npm testfoo` through.
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

// What a permission card will show of the tool input. Much larger than the
// transcript's clip: the user is AUTHORIZING this text, so a suffix hidden by
// truncation is a suffix nobody approved. Anything past the cap is called out
// in the card itself rather than silently dropped.
const DETAIL_CAP = 20_000;

/**
 * What the permission card shows. A permission prompt isn't a multiple-choice
 * question — the user needs the tool, and enough of its INPUT to judge it — so
 * this reuses the same describeToolUse() normalizer the transcript renders tool
 * calls with, except that Bash gets its command verbatim (describeToolUse clips
 * at 4k, which is fine for reading a transcript and not fine for approving one).
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
// AskAnswers (string[][]) — answers[0][0] is the decision, answers[0][1] an
// optional note the user typed. Anything unrecognized fails CLOSED, so a
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

// A `system`/`permission_denied` message is the CLI saying it refused a call
// before canUseTool was ever consulted. Nothing here decides anything — this is
// only about which of the message's two text fields a HUMAN should be shown.
//
// The SDK documents `decision_reason` as "human-readable reason from the
// deciding component" and `message` as "the rejection message returned to the
// model". Live CLI 2.1.x leaves `decision_reason` unset on the denials we could
// actually provoke and fills only `message` — which really is written for the
// model: the `mode` denial is ~700 characters of "IMPORTANT: You *may* attempt
// to accomplish this action using other tools…". Recorded verbatim in
// tests/claudePermissionMode.test.ts.
//
// So: prefer decision_reason, else take `message` up to the model-directed
// tail, and cap whatever survives. Pasting the raw `message` into the UI is
// what this exists to prevent.
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
// A prompt reuses the ask registry wholesale — same waitForAnswer/submitAnswer,
// same POST /api/tasks/[id]/answer route — with one addition an ordinary
// question doesn't need: a DEADLINE. A question card can sit forever because
// the user asked for the turn; a permission prompt can be raised by a turn
// nobody launched (an auto-started task at 3am), and a turn parked with nobody
// watching holds its abort slot and keeps the instance marked busy indefinitely.
//
// So the gate distinguishes the two cases by whether any client is connected:
//   - watchers now      → the attended cap (hours; a human is around)
//   - no watchers       → a short grace, re-checked, then deny
// The grace is re-checked rather than fired blindly so opening the app a few
// seconds later still lets you decide; once a watcher shows up the prompt is
// upgraded to the attended cap and behaves like any other card.
//
// Connection count is PRESENCE, not intent — a tab left open on a sleeping
// laptop reads as attended. It's a heuristic that only ever SHORTENS the wait,
// never lengthens it past the attended cap, so the worst case is the same
// bounded park a watched prompt gets.

export type PermissionWait =
  | { answers: string[][] }
  /** Nobody decided: "unattended" = no client ever appeared, "timeout" = the attended cap ran out. */
  | { expired: "unattended" | "timeout" }
  /** The turn (or this specific request) was torn down before anyone decided. */
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
  // Register the waiter FIRST, so an answer arriving in the same tick as the
  // published card can't miss it. The registry keys on the id, not questions.
  const answer = waitForAnswer(taskId, id, [], signal);

  // A scheduled turn is unattended BY DECLARATION, whatever watcherCount()
  // says: the user didn't launch it, so an open tab is not consent to be
  // interrupted by it. Settle at once rather than parking — there is no answer
  // coming, and the runner already knows what to do with an unattended deny.
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
    // A tab opened during the grace — this is a watched session after all.
    if (!attended && watcherCount() > 0) {
      attended = true;
      deadline = deadlineFrom(attendedMs);
      return;
    }
    if (deadline && Date.now() >= deadline) {
      expired = attended ? "timeout" : "unattended";
      clearInterval(timer);
      // Settles the waiter below and removes the registry entry, so a late
      // answer reports "nothing waiting" instead of resolving a dead turn.
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
