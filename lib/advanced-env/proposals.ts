/* The proposal service behind an agent's environment-mutation tool
 * (task 9): the only path that can write advanced-environment.json on an
 * agent's behalf, and it only ever writes after a fresh, one-use human
 * decision arrives through the dedicated browser route
 * app/api/settings/environment/proposals/[id]/decision/route.ts.
 *
 * A proposal reuses lib/permissionPrompt.ts's mandatory mode wholesale: no
 * auto-allow, no remembered rule, no durable/session grant, settled only
 * through lib/advanced-env/capabilities.ts's dedicated waiter, so neither a
 * task's bypass mode nor POST /api/tasks/[id]/answer can ever commit a
 * change. What this module adds on top is the write itself (raised only
 * after "allow", revalidated against the live revision inside the store's
 * own write transaction) and a second, narrower side channel for a secret's
 * plaintext: staged in memory by the decision route, consumed at most once,
 * and never placed in the note a PermissionOutcome carries into the
 * transcript.
 *
 * No DB, no SDK: everything this imports (lib/permissionPrompt.ts,
 * lib/advanced-env/store.ts, lib/advanced-env/catalog.mjs) already is.
 */

import { nanoid } from "nanoid";

import { promptPermission, type PromptContext } from "../permissionPrompt";
import { createVariable, deleteVariable, getEnvironmentRow, patchVariable, savedRows, type MutationResult } from "./store";
import { findDuplicateRow, lookupDescriptor, validateNameForScope, validateValue } from "./catalog.mjs";
import type { EnvScope, PresentedVariable } from "./types";

/** Same shape lib/permissionPrompt.ts's promptPermission() takes: the turn's
 * event queue and stop signal. A proposal is one more thing that queue can
 * carry a card for. */
export type ProposalContext = PromptContext;

export type ProposalOperation = "create" | "patch" | "delete";

interface ProposalBase {
  expectedRevision: number;
  /** The agent's stated reason, shown on the card. Never the source of a
   * private value: this is free text, and free text is what leaves through
   * the note field settled onto the transcript. */
  reason?: string;
}

export interface CreateProposalInput extends ProposalBase {
  operation: "create";
  scope: EnvScope;
  name: string;
  /** Rejected outright when `secret` is true: a secret's plaintext arrives
   * only through the browser decision route's private-value field. */
  value?: string;
  secret: boolean;
}

export interface PatchProposalInput extends ProposalBase {
  operation: "patch";
  id: string;
  /** Rename. May itself be private (see privateName on the decision route);
   * a tool-supplied rename is fine even for a secret row, since a name alone
   * reveals nothing the row didn't already reveal by existing. */
  name?: string;
  /** Rejected when the row is secret now or would become secret by this same
   * patch (secret: true below). */
  value?: string;
  secret?: boolean;
}

export interface DeleteProposalInput extends ProposalBase {
  operation: "delete";
  id: string;
}

export type ProposalInput = CreateProposalInput | PatchProposalInput | DeleteProposalInput;

export type ProposalResult =
  | { kind: "committed"; row: PresentedVariable | null; revision: number }
  | { kind: "denied"; message: string }
  | { kind: "conflict"; currentRevision: number }
  | { kind: "invalid"; reason: string };

// ---------- private-input staging ----------
//
// The browser decision route stashes a secret's plaintext here, just before
// settling the mandatory decision it is paired with, so proposeEnvironmentMutation
// picks it up the instant its wait resolves. Keyed the same way the mandatory
// decision registry is (taskId:id), so a stale or foreign key can never
// collide with a live proposal. Consumed exactly once: a deny path discards
// it unread, and a commit path takes it and deletes the entry in the same
// call, so nothing lingers past the proposal it belonged to.

interface StagedPrivateInput {
  name?: string;
  value?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaEnvPrivateInputs: Map<string, StagedPrivateInput> | undefined;
}

const staged = (): Map<string, StagedPrivateInput> => (global.__calandriaEnvPrivateInputs ??= new Map());
const stagingKey = (taskId: string, id: string): string => `${taskId}:${id}`;

/** Called only by the browser decision route, before it settles the
 * mandatory decision the same request carries. */
export function stagePrivateInput(taskId: string, id: string, input: StagedPrivateInput): void {
  if (input.name === undefined && input.value === undefined) return;
  staged().set(stagingKey(taskId, id), input);
}

function takePrivateInput(taskId: string, id: string): StagedPrivateInput | undefined {
  const key = stagingKey(taskId, id);
  const value = staged().get(key);
  staged().delete(key);
  return value;
}

/** Drop anything staged for a proposal without reading it: the deny and
 * invalid-before-prompt paths call this so a private value typed for a
 * proposal that never committed can't outlive it. */
export function discardPrivateInput(taskId: string, id: string): void {
  staged().delete(stagingKey(taskId, id));
}

// ---------- the card ----------

function targetSecret(input: ProposalInput, existing: PresentedVariable | null): boolean {
  if (input.operation === "create") return input.secret;
  if (input.operation === "patch") return input.secret ?? existing!.secret;
  return existing!.secret;
}

function opVerb(op: ProposalOperation): string {
  return op === "create" ? "create" : op === "delete" ? "delete" : "change";
}

function describeTarget(existing: PresentedVariable | null, name: string | undefined): string {
  if (existing) return existing.secret ? `Secret variable · ${existing.id.slice(0, 4)}` : existing.name ?? existing.id;
  return name ?? "a variable";
}

function proposalCard(
  input: ProposalInput,
  scope: EnvScope,
  existing: PresentedVariable | null
): { title: string; detail: string; description: string } {
  const target = describeTarget(existing, input.operation !== "delete" ? input.name : undefined);
  const verb = opVerb(input.operation);
  const title = `${input.operation === "create" ? "Create" : verb === "delete" ? "Delete" : "Change"} ${scope} variable: ${target}`;
  const lines: string[] = [`Scope: ${scope}`, `Operation: ${verb}`];
  if (input.operation === "patch" && input.name && (!existing?.secret || input.name !== existing?.name)) lines.push(`Rename to: ${input.name}`);
  if (input.operation !== "delete" && input.secret !== undefined) lines.push(`Secret: ${input.secret ? "yes" : "no"}`);
  if (input.operation !== "delete" && input.value !== undefined) lines.push(`New value: ${input.value}`);
  if (existing?.secret && input.operation === "patch" && input.secret === false) {
    lines.push("Turning off Secret will reveal this variable's name and value in the list.");
  }
  if (input.reason) lines.push("", `Reason: ${input.reason}`);
  const effect = existing ? existing.effect : lookupDescriptor(input.operation === "create" ? input.name : "")?.effect ?? (scope === "app" ? "restart" : "next_turn");
  lines.push("", effect === "restart" ? "Takes effect after a server restart." : "Takes effect on the next turn.");
  return { title, detail: lines.join("\n"), description: `An agent is proposing to ${verb} an environment variable.` };
}

// ---------- pre-prompt validation ----------
//
// Checked before the card is raised, so a doomed proposal (an unknown/
// reserved name, a value the descriptor rejects, a name already taken)
// never interrupts anyone. The write itself re-runs the same checks inside
// its own transaction (lib/advanced-env/store.ts), since state can move
// between this check and the human's decision.

function preValidate(input: ProposalInput, scope: EnvScope, existing: PresentedVariable | null): string | null {
  if (input.operation !== "delete") {
    const name = input.operation === "create" ? input.name : input.name ?? existing?.name;
    if (name) {
      const named = validateNameForScope(name, scope);
      if (!named.ok) return named.reason;
      const rows = savedRows(scope);
      const excludeId = input.operation === "patch" ? input.id : undefined;
      if (findDuplicateRow(rows, scope, name, excludeId)) return `A ${scope} variable with that name already exists.`;
    }
    if (input.value !== undefined) {
      const secret = targetSecret(input, existing);
      if (secret) return "A secret value can't be supplied by the agent directly. Approve on the card and enter it there.";
      const checked = validateValue(lookupDescriptor(name ?? ""), input.value);
      if (!checked.ok) return checked.reason;
    }
  }
  // Turning an existing secret off needs no pre-check here: approval itself
  // is the confirmation (see the commit path's `confirmExpose`), so there is
  // nothing to reject, only what the card already notes.
  return null;
}

function toResult(result: MutationResult): ProposalResult {
  if (result.ok) return { kind: "committed", row: result.row, revision: result.revision };
  if (result.code === "revision_conflict") return { kind: "conflict", currentRevision: result.currentRevision ?? -1 };
  return { kind: "invalid", reason: result.reason };
}

/**
 * Propose one mutation, park it on a fresh mandatory approval, and commit it
 * only if the human allows it once. Every other outcome (deny, expiry,
 * cancellation, an aborted turn) leaves the file untouched; a stale
 * `expectedRevision` at commit time is a conflict the caller must re-propose
 * against, never retried automatically.
 */
export async function proposeEnvironmentMutation(ctx: ProposalContext, input: ProposalInput): Promise<ProposalResult> {
  let existing: PresentedVariable | null = null;
  let scope: EnvScope;
  if (input.operation === "create") {
    scope = input.scope;
  } else {
    existing = getEnvironmentRow(input.id);
    if (!existing) return { kind: "invalid", reason: "That variable no longer exists." };
    scope = existing.scope;
  }

  const invalid = preValidate(input, scope, existing);
  if (invalid) return { kind: "invalid", reason: invalid };

  const id = `env:${nanoid()}`;
  const secret = targetSecret(input, existing);
  const needsPrivateValue = input.operation !== "delete" && secret;
  const needsPrivateName = input.operation !== "delete" && secret;
  const { title, detail, description } = proposalCard(input, scope, existing);

  const decision = await promptPermission(ctx, {
    id,
    tool: "change_environment_setting",
    input: { operation: input.operation, scope, id: input.operation === "delete" ? input.id : input.operation === "patch" ? input.id : undefined },
    title,
    detail,
    description,
    mandatory: true,
    kind: "environment",
    // valueRequired: a new secret has no value to keep, so the card must
    // collect one before Allow once can be pressed. A patch may leave the
    // field blank to keep the stored value.
    privateInput:
      needsPrivateValue || needsPrivateName
        ? { name: needsPrivateName, value: needsPrivateValue, ...(input.operation === "create" ? { valueRequired: true } : {}) }
        : undefined,
  });

  if (decision.kind === "deny") {
    discardPrivateInput(ctx.taskId, id);
    return { kind: "denied", message: decision.message };
  }

  const priv = takePrivateInput(ctx.taskId, id);
  const finalName = priv?.name ?? (input.operation !== "delete" ? input.name : undefined);
  const finalValue = priv?.value ?? (input.operation !== "delete" ? input.value : undefined);

  if (input.operation === "create") {
    if (secret && finalValue === undefined) {
      return { kind: "invalid", reason: "No value was supplied for this secret. Propose again and enter one on the card." };
    }
    return toResult(
      createVariable({
        scope: input.scope,
        name: finalName ?? input.name,
        value: finalValue ?? "",
        secret: input.secret,
        expectedRevision: input.expectedRevision,
      })
    );
  }

  if (input.operation === "patch") {
    const turningOff = !!existing?.secret && input.secret === false;
    return toResult(
      patchVariable(input.id, {
        name: finalName,
        value: finalValue,
        secret: input.secret,
        expectedRevision: input.expectedRevision,
        confirmExpose: turningOff ? true : undefined,
      })
    );
  }

  return toResult(deleteVariable(input.id, { expectedRevision: input.expectedRevision }));
}
