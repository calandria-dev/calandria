/* Pure agent-turn environment composition.
 *
 * `buildAgentSnapshot()` is the boundary between the saved advanced-settings
 * file and a running agent turn. It takes every input explicitly (the
 * inherited/launch environment, the app-scope bootstrap's applied state, and
 * the saved agent-scope rows) instead of reading `process.env` or the
 * `globalThis[Symbol.for("calandria.advancedEnvironment")]` bootstrap slot
 * itself, so it has no dependency on runner wiring, request scope, or a
 * module-local singleton. Task 5 is the one that reads the real inputs (via
 * lib/advanced-env/bootstrap.mjs and lib/advanced-env/store.ts) and threads
 * the result through a driver's turn; this module only composes them.
 *
 * Composition order, matching the plan: the inherited environment with the
 * app overlay undone (lib/advanced-env/bootstrap.mjs's restoreAppOverlay,
 * called here with an explicit state instead of its default global read),
 * then the saved agent-scope rows layered on top. Provider credentials,
 * gateway headers, ports and other runtime-owned overrides are layered by the
 * caller afterward (lib/agentEnv.ts); this module never applies them, so it
 * stays ignorant of provider/task identity.
 *
 * The result is frozen. A turn's snapshot never changes after it is built: a
 * save made mid-turn is only visible to the next turn's own
 * `buildAgentSnapshot()` call, never to one already running.
 */

import { restoreAppOverlay } from "./bootstrap.mjs";
import { isAgentScopeReservedName, isGloballyReservedName } from "./catalog.mjs";
import {
  resolveCodexApprovalPolicy,
  resolveCodexExternalSandbox,
  resolveCodexHookTrace,
  resolveCodexInheritMcp,
  resolveCodexTransport,
  type CodexApprovalPolicySetting,
  type CodexTransportSetting,
} from "../config";
import type { AppliedAppEnvironment, StoredVariable } from "./types";

export type { CodexApprovalPolicySetting, CodexTransportSetting };

/** Everything `buildAgentSnapshot()` needs, supplied explicitly by the caller. */
export interface AgentSnapshotInput {
  /** The host/launch environment a turn would otherwise inherit, e.g.
   * `process.env`. Never mutated. */
  readonly inheritedEnv: Readonly<Record<string, string | undefined>>;
  /** What the app-scope overlay applied at boot, or `null` when no entrypoint
   * has run the bootstrap yet. Passed explicitly: this module never reads the
   * bootstrap's `globalThis` slot itself. */
  readonly appliedAppEnvironment: AppliedAppEnvironment | null;
  /** Saved agent-scope rows, unredacted (lib/advanced-env/store.ts's
   * `savedRows("agent")`). A row outside agent scope, or naming something
   * reserved, is ignored rather than trusted: the store already enforces this
   * at write time, and this is the defense against a hand-edited file. */
  readonly savedAgentRows: readonly StoredVariable[];
}

/** An immutable, point-in-time agent-turn environment. */
export interface AgentSnapshot {
  /** The inherited environment with the app overlay undone, then the saved
   * agent rows layered on top. Frozen; callers copy before adding their own
   * overrides. */
  readonly env: Readonly<Record<string, string>>;
  /** The highest saved-row revision folded in, or 0 when no saved agent row
   * applied. Lets a caller tell two snapshots apart without diffing `env`. */
  readonly revision: number;
}

/** Compose one immutable agent-turn snapshot. Does not touch `process.env`
 * or any global state. */
export function buildAgentSnapshot(input: AgentSnapshotInput): AgentSnapshot {
  const env = restoreAppOverlay(input.inheritedEnv, input.appliedAppEnvironment);
  let revision = 0;
  for (const row of input.savedAgentRows) {
    if (row.scope !== "agent") continue;
    if (isGloballyReservedName(row.name) || isAgentScopeReservedName(row.name)) continue;
    env[row.name] = row.value;
    if (row.revision > revision) revision = row.revision;
  }
  return Object.freeze({ env: Object.freeze(env), revision });
}

/** The six Codex controls the catalog exposes under agent scope, resolved
 * from a snapshot instead of import-time `process.env` constants. */
export interface CodexControls {
  readonly transport: CodexTransportSetting;
  readonly approvalPolicy: CodexApprovalPolicySetting;
  readonly writableRoots: string;
  readonly externalSandbox: boolean;
  readonly inheritMcp: boolean;
  readonly hookTrace: boolean;
}

/** Resolve the six Codex controls from a snapshot, preserving
 * lib/config.ts's current defaults and precedence: a name the snapshot's
 * `env` doesn't carry falls back to that name's own unset-value default,
 * exactly as reading `process.env[name]` would. */
export function resolveCodexControls(snapshot: AgentSnapshot): CodexControls {
  const env = snapshot.env;
  return Object.freeze({
    transport: resolveCodexTransport(env.CODEX_TRANSPORT),
    approvalPolicy: resolveCodexApprovalPolicy(env.CODEX_APPROVAL_POLICY),
    writableRoots: String(env.CODEX_WRITABLE_ROOTS || ""),
    externalSandbox: resolveCodexExternalSandbox(env.CODEX_EXTERNAL_SANDBOX),
    inheritMcp: resolveCodexInheritMcp(env.CODEX_INHERIT_MCP),
    hookTrace: resolveCodexHookTrace(env.CALANDRIA_CODEX_HOOK_TRACE),
  });
}
