export const TERMS: RegExp;
export const SYSADMIN_NOUN: RegExp;
export const LEGACY_ENV: RegExp;
export const LEGACY_STORAGE: RegExp;
export const FROZEN_DIRS: string[];
export const ALLOWED: Record<string, RegExp[]>;
export function trackedTextFiles(): string[] | null;
export function scan(files: string[]): string[];
