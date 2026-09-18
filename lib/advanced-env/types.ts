/* Shared contracts for Settings → Advanced: the scope-aware environment
 * catalog, its stored/presented row shapes, and the process-local app
 * bootstrap slot. Pure types only: no runtime behavior lives here, so this
 * file is safe for both server modules and the client bundle to import.
 */

/** Where a saved variable applies: the server process, or agent turns. */
export type EnvScope = "app" | "agent";

/** Who may edit a catalog name: the user, nobody (reserved), or Settings →
 * Models (provider-owned, editable there instead). */
export type EnvOwnership = "editable" | "reserved" | "providers";

/** When a saved change takes effect. */
export type EnvEffect = "restart" | "next_turn";

/** The shape a catalog descriptor's value takes, for input rendering and
 * validation. `duration_ms` and the two integer families share `integer`;
 * bounds distinguish them. */
export type EnvInputType = "string" | "integer" | "boolean" | "enum" | "duration_ms" | "path_list";

export type SupportedAgentId = "claude" | "codex" | "gemini";

/** A known Calandria/agent environment variable's metadata. Never carries a
 * live value: `defaultDescription` is prose, not a parsed default. */
export interface CatalogDescriptor {
  readonly name: string;
  readonly scope: EnvScope;
  readonly description: string;
  readonly inputType: EnvInputType;
  readonly enumValues?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly defaultDescription: string;
  readonly effect: EnvEffect;
  readonly supportedAgents?: readonly SupportedAgentId[];
  readonly secretByDefault: boolean;
  readonly ownership: EnvOwnership;
  /** `file:line` (or `file`) this descriptor's behavior was read from. */
  readonly source: string;
}

export type ValidationErrorCode =
  | "invalid_name"
  | "reserved_name"
  | "provider_owned"
  | "unsupported_name"
  | "wrong_scope"
  | "invalid_value"
  | "duplicate_name";

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ValidationErrorCode; readonly reason: string };

/** A saved override, on disk. `value` is plaintext even for a secret row:
 * masking happens only when presenting a row, never in storage. */
export type StoredVariable = {
  id: string;
  scope: EnvScope;
  name: string;
  value: string;
  secret: boolean;
  revision: number;
};

export type StoredEnvironment = {
  version: 1;
  revision: number;
  rows: StoredVariable[];
};

/** The redacted shape sent to the browser and to agent tools. For a secret
 * row, `name` and `value` are both `null`; `hasValue` distinguishes an unset
 * secret from one whose value happens to be the empty string. */
export type PresentedVariable = {
  id: string;
  scope: EnvScope;
  name: string | null;
  value: string | null;
  secret: boolean;
  hasValue: boolean;
  revision: number;
  effect: EnvEffect;
  overriddenByHost: boolean;
};

export type CreateEnvironmentInput = {
  scope: EnvScope;
  name: string;
  value: string;
  secret: boolean;
  expectedRevision: number;
};

/** Omitted `name`/`value` preserves the stored field; `confirmExpose` is
 * required only when `secret` is being turned off. */
export type PatchEnvironmentInput = {
  name?: string;
  value?: string;
  secret?: boolean;
  expectedRevision: number;
  confirmExpose?: boolean;
};

export type DeleteEnvironmentInput = {
  expectedRevision: number;
};

export type RevisionConflictResult = {
  readonly conflict: true;
  readonly currentRevision: number;
};

/** The process-local record of what the app-scope overlay applied at boot,
 * published on `globalThis[Symbol.for("calandria.advancedEnvironment")]`.
 * Never serialized or exposed through an API. */
export type AppliedAppEnvironment = {
  appliedRevision: number;
  applied: Record<string, string>;
  preOverlay: Record<string, string | undefined>;
  loadError: string | null;
};
