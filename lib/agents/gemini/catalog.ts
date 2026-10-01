// The Antigravity CLI's live model catalog. `agy models` is a read-only,
// no-quota command. Keep discovery separate from capabilities so synchronous
// callers can use the last successful result without spawning a process.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AGY_CLI_PATH, MODEL_PROBE_MS } from "@/lib/config";

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
const MAX_BUFFER = 1024 * 1024;

export interface GeminiCatalogEntry {
  slug: string;
  label: string;
}

interface CatalogState {
  fetchedAt: number;
  value: GeminiCatalogEntry[] | null;
  inflight: Promise<GeminiCatalogEntry[] | null> | null;
  generation: number;
}

const globalState = globalThis as typeof globalThis & { __calandriaGeminiCatalog?: CatalogState };

function state(): CatalogState {
  return (globalState.__calandriaGeminiCatalog ??= {
    fetchedAt: 0,
    value: null,
    inflight: null,
    generation: 0,
  });
}

const VALID_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const SIGNED_OUT = /please sign in|not logged into antigravity|authentication required/i;

/** Parse the CLI's TSV output while ignoring status chatter. */
export function parseGeminiModelCatalog(stdout: string): GeminiCatalogEntry[] {
  const entries: GeminiCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(?:fetching|error|warning|info|loading)\b/i.test(trimmed)) continue;
    const columns = trimmed.split(/\t+/).map((column) => column.trim());
    if (columns.length < 2) continue;
    const [slug, ...labels] = columns;
    const label = labels.join(" ").trim();
    if (!slug || !VALID_SLUG.test(slug) || !label || /^(?:fetching|error)\b/i.test(label)) continue;
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ slug, label });
  }
  return entries;
}

async function fetchCatalog(): Promise<GeminiCatalogEntry[] | null> {
  try {
    const { stdout, stderr } = await execFileAsync(AGY_CLI_PATH || "agy", ["models"], {
      timeout: MODEL_PROBE_MS,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    });
    if (SIGNED_OUT.test(`${stdout}\n${stderr}`)) return null;
    const entries = parseGeminiModelCatalog(stdout);
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

/** Read the live catalog, sharing concurrent probes and retaining good data on failure. */
export function geminiModelCatalog(): Promise<GeminiCatalogEntry[] | null> {
  const current = state();
  if (current.inflight) return current.inflight;
  if (current.fetchedAt > 0 && Date.now() - current.fetchedAt < CACHE_MS) return Promise.resolve(current.value);

  const generation = current.generation;
  const pending = fetchCatalog().then((result) => {
    const latest = state();
    if (latest.generation !== generation) return latest.value;
    if (result) {
      latest.value = result;
    }
    latest.fetchedAt = Date.now();
    return latest.value;
  }).finally(() => {
    const latest = state();
    if (latest.generation === generation && latest.inflight === pending) latest.inflight = null;
  });
  current.inflight = pending;
  return pending;
}

/** Last successful catalog, or null before the first successful probe. */
export function lastGeminiModelCatalog(): GeminiCatalogEntry[] | null {
  return state().value;
}

/** Expire the result and detach old work while preserving the last good value. */
export function invalidateGeminiCatalogCache(): void {
  const current = state();
  current.generation += 1;
  current.fetchedAt = 0;
  current.inflight = null;
}

/** Clear all catalog state for test isolation. */
export function clearGeminiCatalogCache(): void {
  invalidateGeminiCatalogCache();
  state().value = null;
}
