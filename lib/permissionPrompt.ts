// One permission card, one policy, every driver.
//
// The DECISION half of the gate (the read-only allowlist, the project's
// remembered rules, the card that parks the turn on the user through
// lib/asks.ts and the /answer route, and what "always allow" records) existed
// twice: inside the Claude driver's canUseTool and again in the Codex
// app-server's approval handlers. Two copies of one policy drift, so both now
// call promptPermission() and only translate its verdict into the answer their
// own protocol wants: the SDK's PermissionResult for Claude, the app-server's
// accept / acceptForSession / decline / cancel enum for Codex.
//
// What stays with the caller is what only the caller knows: the permission
// mode the turn runs under (bypassPermissions never reaches here at all), the
// CLI's own prompt sentence and `suggestions` payload, and the shape of the
// answer to hand back.
//
// Policy itself lives in lib/permissions.ts, which is pure. This module adds
// the two things a real prompt needs that stay out of that file: the
// store (reading and minting rules) and the turn's event queue.

import type { DiffLine, PermissionOutcome, PermissionRequest, PermissionScopeOffer, StreamEvent } from "./types";
import {
  allowedByRules,
  denyMessage,
  describePermission,
  isAlwaysAllowed,
  parseDecision,
  promptDeadline,
  scopeOfferFor,
  waitForPermission,
  DENIED_BY_USER,
  DENIED_TIMED_OUT,
  DENIED_UNATTENDED,
} from "./permissions";
import { PERMISSION_PROMPT_TIMEOUT_MS, PERMISSION_UNATTENDED_MS } from "./config";
import { addPermissionRule, listPermissionRules } from "./store";

export interface PromptContext {
  taskId: string;
  projectId: string;
  /** Where permission / permission_decided events go (the turn's queue). */
  push: (ev: StreamEvent) => void;
  /**
   * Stop. A caller with more than one signal to honor (Claude has the turn's
   * and the SDK's per-request one) links them before handing one in.
   */
  signal?: AbortSignal;
}

export interface PromptSpec {
  /** Card id, already namespaced (`perm:<tool_use or item id>`). */
  id: string;
  /** The tool the allowlist and the rules are matched against ("Bash" for a command). */
  tool: string;
  /** The call as the rules see it (`{ command }` for Bash). */
  input: Record<string, unknown>;
  /** Headline. Defaults to what the transcript would title this call. */
  title?: string;
  /** The input worth judging. Defaults to the card's own rendering of `input`. */
  detail?: string;
  description?: string;
  diff?: DiffLine[];
  /**
   * Override the offer "Always allow" makes. For a call no durable rule can
   * describe honestly, where the caller has a session-scoped grant of its own.
   */
  scope?: PermissionScopeOffer;
  /** Offer used only when the call can't be generalized into a durable rule. */
  scopeFallback?: PermissionScopeOffer;
  /**
   * The CLI saying this call reaches somewhere it isn't allowed (outside the
   * worktree, typically). It forces the card: neither the allowlist nor a
   * remembered rule may swallow the CLI's own warning.
   */
  blockedPath?: string;
}

export type PromptDecision =
  | { kind: "allow"; always: boolean; remembered?: string; message?: undefined; auto?: boolean }
  | { kind: "deny"; message: string; interrupted?: boolean };

/**
 * Decide one tool call. Resolves "allow" without a card when the tool is
 * read-only or a remembered rule covers it; otherwise publishes the card,
 * waits, and settles it. Every non-answer path denies: a stopped turn, an
 * unwatched one, an expired prompt and an unparseable answer all fail closed.
 * The returned message (on deny) is what the model should be told.
 */
export async function promptPermission(ctx: PromptContext, spec: PromptSpec): Promise<PromptDecision> {
  const auto: PromptDecision = { kind: "allow", always: false, auto: true };
  if (isAlwaysAllowed(spec.tool, spec.blockedPath)) return auto;
  // Re-read the rules per call, not per turn: an "always allow" answered
  // earlier in THIS turn has to take effect immediately, and a rule the user
  // revokes mid-turn has to stop applying just as fast.
  if (!spec.blockedPath && allowedByRules(listPermissionRules(ctx.projectId), spec.tool, spec.input)) return auto;

  // Build the card lazily: a prompted session runs this gate on every Read
  // and Grep, and the card's rendering is not free.
  let card: ReturnType<typeof describePermission> | undefined;
  const described = () => (card ??= describePermission(spec.tool, spec.input));
  const scope = spec.scope ?? scopeOfferFor(spec.tool, spec.input) ?? spec.scopeFallback;
  const request: PermissionRequest = {
    id: spec.id,
    tool: spec.tool,
    title: spec.title?.trim() || described().title,
    detail: spec.detail ?? described().detail,
    description: spec.blockedPath
      ? `Reaches outside the task's working directory: ${spec.blockedPath}`
      : spec.description?.trim() || undefined,
    diff: spec.diff ?? described().diff,
    scope,
    expiresAt: promptDeadline(PERMISSION_PROMPT_TIMEOUT_MS, PERMISSION_UNATTENDED_MS, ctx.taskId),
  };
  ctx.push({ type: "permission", request });
  const settle = (outcome: PermissionOutcome) => ctx.push({ type: "permission_decided", id: spec.id, outcome });

  const waited = await waitForPermission({
    taskId: ctx.taskId,
    id: spec.id,
    signal: ctx.signal,
    attendedMs: PERMISSION_PROMPT_TIMEOUT_MS,
    unattendedMs: PERMISSION_UNATTENDED_MS,
  });

  if ("aborted" in waited) {
    const note = "The session was stopped before this was approved.";
    settle({ decision: "deny", auto: true, reason: "interrupted", note });
    return { kind: "deny", message: note, interrupted: true };
  }
  if ("expired" in waited) {
    const note = waited.expired === "unattended" ? DENIED_UNATTENDED : DENIED_TIMED_OUT;
    settle({ decision: "deny", auto: true, reason: waited.expired, note });
    return { kind: "deny", message: denyMessage(request.title, note) };
  }

  const { decision, note } = parseDecision(waited.answers);
  if (decision === "deny") {
    settle({ decision, note: note || undefined });
    return { kind: "deny", message: denyMessage(request.title, note || DENIED_BY_USER) };
  }
  let remembered: string | undefined;
  if (decision === "allow_always" && scope?.scope === "project" && scope.match_kind) {
    addPermissionRule({ project_id: ctx.projectId, tool: spec.tool, match_kind: scope.match_kind, value: scope.value });
    remembered = scope.label;
  } else if (decision === "allow_always" && scope) {
    // A session-scoped offer records nothing: the caller's own protocol carries
    // it (Claude's `updatedPermissions`, Codex's acceptForSession), and it dies
    // with the session. The label is only what the transcript row reads back.
    remembered = scope.label;
  }
  settle({ decision, remembered });
  return { kind: "allow", always: decision === "allow_always", remembered };
}
