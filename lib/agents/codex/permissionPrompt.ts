// The permission card for a Codex approval request — the app-server's
// `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`
// and `item/permissions/requestApproval` — run through the same gate the
// Claude driver's canUseTool uses (lib/permissions.ts): the project's
// remembered rules first, then a card that parks the turn on the user through
// lib/asks.ts and the /answer route, with every non-answer path denying.
//
// Same policy in a different shape: Claude's gate is a callback that returns
// the SDK's verdict, this one returns a decision the driver translates into the
// protocol's own enum (accept / acceptForSession / decline / cancel). The
// pieces that could drift — what counts as pre-approved, what "always allow"
// records, how long a card waits — are all called from lib/permissions.ts and
// lib/config.ts rather than restated here.

import type { PermissionRequest, PermissionOutcome, StreamEvent, DiffLine, PermissionScopeOffer } from "../../types";
import {
  allowedByRules,
  scopeOfferFor,
  parseDecision,
  waitForPermission,
  promptDeadline,
  denyMessage,
  DENIED_BY_USER,
  DENIED_UNATTENDED,
  DENIED_TIMED_OUT,
} from "../../permissions";
import { PERMISSION_PROMPT_TIMEOUT_MS, PERMISSION_UNATTENDED_MS } from "../../config";
import { listPermissionRules, addPermissionRule } from "../../store";

export interface PromptContext {
  taskId: string;
  projectId: string;
  /** Where permission / permission_decided events go (the turn's queue). */
  push: (ev: StreamEvent) => void;
  signal?: AbortSignal;
}

export interface PromptSpec {
  /** Card id, already namespaced (`perm:<item id>`). */
  id: string;
  /** The tool the rules are matched against ("Bash" for a command). */
  tool: string;
  /** The call as the rules see it (`{ command }` for Bash). */
  input: Record<string, unknown>;
  title: string;
  detail: string;
  description?: string;
  diff?: DiffLine[];
  /** Override the offer the card shows for "Always allow". */
  scope?: PermissionScopeOffer;
}

export type PromptDecision =
  | { kind: "allow"; always: boolean; remembered?: string; message?: undefined; auto?: boolean }
  | { kind: "deny"; message: string; interrupted?: boolean };

/**
 * Decide one approval request. Resolves "allow" without a card when a
 * remembered rule covers the call; otherwise publishes the card, waits, and
 * settles it. The returned message (on deny) is what the model should be told.
 */
export async function promptPermission(ctx: PromptContext, spec: PromptSpec): Promise<PromptDecision> {
  // Re-read per request, like the Claude gate: an "always allow" answered
  // moments ago must apply immediately, and a rule revoked mid-turn must stop.
  if (allowedByRules(listPermissionRules(ctx.projectId), spec.tool, spec.input)) {
    return { kind: "allow", always: false, auto: true };
  }

  const scope = spec.scope ?? scopeOfferFor(spec.tool, spec.input) ?? undefined;
  const request: PermissionRequest = {
    id: spec.id,
    tool: spec.tool,
    title: spec.title,
    detail: spec.detail,
    description: spec.description,
    diff: spec.diff,
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
    remembered = scope.label;
  }
  settle({ decision, remembered });
  return { kind: "allow", always: decision === "allow_always", remembered };
}
