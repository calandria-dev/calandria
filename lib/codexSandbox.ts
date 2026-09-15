/** Sandbox choices shared by the Codex API, UI, and run policy. */
export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return typeof value === "string" && (CODEX_SANDBOX_MODES as readonly string[]).includes(value);
}
