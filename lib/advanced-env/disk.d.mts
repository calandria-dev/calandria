import type { EnvScope, StoredEnvironment } from "./types.js";

export const ADVANCED_ENV_FILE: string;

export function advancedEnvPath(dir: string): string;
export function emptyEnvironment(): StoredEnvironment;
export function parseEnvironment(
  text: string,
): { ok: true; store: StoredEnvironment } | { ok: false; error: string };
export function readEnvironmentFile(filePath: string): {
  store: StoredEnvironment | null;
  error: string | null;
  missing: boolean;
};
export function overlayFor(store: StoredEnvironment | null, scope: EnvScope): Record<string, string>;
