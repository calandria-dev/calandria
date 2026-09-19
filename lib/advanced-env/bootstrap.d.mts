import type { AppliedAppEnvironment } from "./types.js";

export const APPLIED_ENV_SLOT: unique symbol;

export function appliedAppEnvironment(): AppliedAppEnvironment | null;

export function environmentFilePathFor(opts?: {
  env?: Record<string, string | undefined>;
  dbDir?: string;
}): string;

export function applyAppEnvironment(opts?: {
  env?: Record<string, string | undefined>;
  dbDir?: string;
  filePath?: string;
}): AppliedAppEnvironment;

export function restoreAppOverlay(
  env?: Record<string, string | undefined>,
  state?: AppliedAppEnvironment | null,
): Record<string, string>;
