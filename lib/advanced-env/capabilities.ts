/* Task+turn capability tokens for Advanced Settings mutations, and the
 * dedicated one-use decision waiter a mandatory approval parks on.
 *
 * Two primitives, kept in one file because both exist for the same reason:
 * an agent proposing to change the environment it runs under must go
 * through a channel neither its permission mode nor a remembered rule can
 * shortcut, and identity for that channel must come from the server, never
 * from anything the model or a stdio bridge process supplies.
 *
 * Capability tokens are an application-protocol control, matched alongside
 * the per-instance service token at an internal mutation endpoint (task 9).
 * They make no OS-isolation claim: an unrestricted process running as the
 * same account can still read or alter any file that account owns.
 *
 * No DB, no SDK: pinned by tests/importGraph.test.ts alongside
 * lib/permissionPrompt.ts, the only module that imports the waiter below.
 */

import crypto from "node:crypto";
import type { PermissionDecision } from "../types";

// ---------- task+turn capability ----------

/** Header a stdio bridge request carries the capability on. Never a model tool argument. */
export const TURN_CAPABILITY_HEADER = "x-calandria-turn-capability";

interface CapabilityEntry {
  token: string;
  taskId: string;
  projectId: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaEnvCapByTask: Map<string, CapabilityEntry> | undefined;
  // eslint-disable-next-line no-var
  var __calandriaEnvCapByToken: Map<string, CapabilityEntry> | undefined;
}

const byTask = (): Map<string, CapabilityEntry> => (global.__calandriaEnvCapByTask ??= new Map());
const byToken = (): Map<string, CapabilityEntry> => (global.__calandriaEnvCapByToken ??= new Map());

/**
 * Mint an unpredictable capability for this task's current turn, called from
 * the runner alongside setRunContext, before the first tool call can arrive.
 * Minting always supersedes any prior token for the same task: a stale token
 * from a turn whose own revoke hasn't run yet (a crash, a queue handoff
 * racing the outgoing turn's finally) stops verifying the instant a new one
 * is minted, not only once the old turn gets around to revoking it. That is
 * also what makes a token from a prior turn unusable in a later one, even
 * under the identical task id.
 */
export function mintTurnCapability(taskId: string, projectId: string): string {
  const prior = byTask().get(taskId);
  if (prior) byToken().delete(prior.token);
  const token = crypto.randomBytes(32).toString("hex");
  const entry: CapabilityEntry = { token, taskId, projectId };
  byTask().set(taskId, entry);
  byToken().set(token, entry);
  return token;
}

/**
 * Release a capability. Identity-checked like unregisterTurn/clearRunContext
 * (lib/abort.ts, lib/runContext.ts): only removes the entry if `token` is
 * still the one on file for `taskId`, so a turn that revokes late (its
 * finally runs after a successor already minted) can never clobber the
 * successor's capability.
 */
export function revokeTurnCapability(taskId: string, token: string): void {
  const cur = byTask().get(taskId);
  if (!cur || cur.token !== token) return;
  byTask().delete(taskId);
  byToken().delete(token);
}

/**
 * Resolve a capability by token alone: identity comes from the token, never
 * from a caller-supplied task or project id. An internal mutation endpoint
 * derives task and project this way, after separately checking the instance
 * service token; neither check substitutes for the other.
 */
export function verifyTurnCapability(token: string): { taskId: string; projectId: string } | null {
  const entry = byToken().get(token);
  return entry ? { taskId: entry.taskId, projectId: entry.projectId } : null;
}

/**
 * The live capability minted for this task's current turn, if any. Task 9's
 * only caller: the three mcp.ts env-block builders (claude/codex/gemini)
 * inject it into the stdio bridge's env as CALANDRIA_ENV_EDIT_CAPABILITY, and
 * the in-process Claude server closes over it directly instead of calling
 * this at all (no HTTP hop to authenticate). Never the source of identity by
 * itself: the bridge only ever forwards it as a header, verified by
 * verifyTurnCapability() token-first at the internal mutation endpoint.
 */
export function currentTurnCapability(taskId: string): string | undefined {
  return byTask().get(taskId)?.token;
}

// ---------- the mandatory-decision waiter ----------
//
// A one-use allow-once/deny decision, parked in a registry the generic
// POST /api/tasks/[id]/answer route (lib/asks.ts's submitAnswer) has no
// access to. Shaped to slot into lib/permissions.ts's waitForPermission() as
// its `waiter` option, so a mandatory prompt reuses the exact same
// attended/unattended deadline math and abort handling as an ordinary one;
// only where the decision is parked differs.

type MandatoryAnswer = Extract<PermissionDecision, "allow_once" | "deny">;

interface PendingMandatory {
  resolve: (answers: string[][]) => void;
  reject: (err: Error) => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaMandatoryDecisions: Map<string, PendingMandatory> | undefined;
}

const mandatory = (): Map<string, PendingMandatory> => (global.__calandriaMandatoryDecisions ??= new Map());

const key = (taskId: string, id: string): string => `${taskId}:${id}`;

function parkMandatoryDecision(taskId: string, id: string, signal?: AbortSignal): Promise<string[][]> {
  return new Promise<string[][]>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const k = key(taskId, id);
    // A collision (retried mint under the same id) settles the old promise
    // instead of orphaning it, mirroring lib/asks.ts's waitForAnswer.
    mandatory().get(k)?.reject(new Error("superseded"));
    const onAbort = () => {
      mandatory().delete(k);
      reject(new Error("aborted"));
    };
    // Settling by decision or cancel drops the listener too, so a turn that
    // parks many proposals does not stack one closure per proposal on its
    // signal until the turn ends.
    mandatory().set(k, {
      resolve: (v) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      reject: (e) => {
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function cancelMandatoryDecision(taskId: string, id: string, reason: string): boolean {
  const k = key(taskId, id);
  const pending = mandatory().get(k);
  if (!pending) return false;
  mandatory().delete(k);
  pending.reject(new Error(reason));
  return true;
}

/**
 * Settle a parked mandatory decision. The signature admits only the two
 * shapes a mandatory prompt may resolve with: there is no `allow_always`
 * here, structurally, unlike the generic answer registry's free-form string
 * pair. `note` carries the same optional typed reason an ordinary decision
 * does (lib/permissions.ts's parseDecision).
 */
export function submitMandatoryDecision(taskId: string, id: string, decision: MandatoryAnswer, note?: string): boolean {
  const k = key(taskId, id);
  const pending = mandatory().get(k);
  if (!pending) return false;
  mandatory().delete(k);
  pending.resolve([[decision, note ?? ""]]);
  return true;
}

/** Whether a mandatory decision is currently parked under this id. */
export function hasMandatoryDecision(taskId: string, id: string): boolean {
  return mandatory().has(key(taskId, id));
}

/** The `waiter` lib/permissions.ts's waitForPermission() takes for a mandatory prompt. */
export const mandatoryDecisionWaiter = {
  park: parkMandatoryDecision,
  cancel: cancelMandatoryDecision,
};
