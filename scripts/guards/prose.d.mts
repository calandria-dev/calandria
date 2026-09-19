export type ProseHit = { file: string; line: number; rule: string; text: string };
export type AllowEntry = {
  /** Why this exact line is allowed to keep its hit. */
  reason: string;
  /** For a quote of this repo's own code: assert the doc still matches the source. */
  verify?: () => void;
};

export const EM_DASH: string;
export const LINE_START_PATTERNS: RegExp[];
export const BANNED_PHRASES: RegExp[];
export const EXCLUDED_MD: Set<string>;
export const EXCLUDED_MD_PREFIXES: string[];
export const ALLOWLIST: Record<string, AllowEntry>;
export function trackedMarkdownFiles(): string[] | null;
export function isTableSeparatorRow(line: string): boolean;
export function maskInlineCode(line: string): string;
export function scanMarkdownFile(file: string): ProseHit[];
export function reportHits(hits: ProseHit[]): string[];
