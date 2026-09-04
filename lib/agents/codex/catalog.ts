// What the local codex CLI would actually do, read off its own on-disk state:
// the per-account model catalog it fetches at startup, plus the two top-level
// keys in ~/.codex/config.toml that override it. Two facts come out — the
// context window a turn gets, and which model a turn runs when nothing picks
// one — and both were hardcoded before, wrongly for anyone whose account or
// config disagreed with the constant.
//
// SDK-free by contract: node:fs / node:os / node:path only. ./capabilities.ts
// and ./pricing.ts are both pinned SDK-free (tests/importGraph.test.ts) and
// both import this.
//
// Fail-soft in every direction, because a wrong window is worse than a static
// one and a wrong price is worse than both. Missing file (fresh install, a
// container with no ~/.codex mounted), unparseable JSON, an unrecognised shape
// from a future client_version, a field of the wrong type: every one of them
// yields "we don't know", and the caller keeps its own constant.
//
// The reads are SYNC on purpose. getCapabilities() in lib/agents/capabilities.ts
// is synchronous and sits on the request path (taskContextWindow in
// lib/store.ts), so this is a read-through against a cache, never an await —
// the same shape lastGatewayModelCatalog() keeps for the Claude descriptor.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** How long one read of ~/.codex serves. The CLI refetches its catalog per
 *  process start, so nothing here changes on a scale this misses; the window is
 *  about not stat-ing the disk once per rendered task row. */
const CACHE_MS = 60_000;

export interface CodexCatalogEntry {
  slug: string;
  /** What a turn on this model actually gets. 272000 for every entry in a
   *  0.153.0 catalog, but per-slug in the file, so read per-slug. */
  contextWindow: number | null;
  /** A CEILING, not a window: the most `model_context_window` may raise this
   *  model to. Never report it as the window — it over-reports every task that
   *  never set the override. */
  maxContextWindow: number | null;
  /** The CLI compacts at this percentage of the window, so it is the usable
   *  part. 95 today, which is why the gauge was ~5% optimistic. */
  effectivePercent: number | null;
  /** "list" or "hide". We only read it to skip hidden entries when picking the
   *  default; the model LIST itself stays hand-maintained in ./capabilities.ts. */
  visibility: string | null;
  /** The CLI's ranking. Lowest wins, 1 is the top, and the top listed entry is
   *  the model a turn runs when nothing picks one. */
  priority: number | null;
}

export interface CodexLocalCatalog {
  entries: CodexCatalogEntry[];
  /** Top-level `model` from config.toml — the user's own default, which beats
   *  the catalog's ranking. */
  model: string | null;
  /** Top-level `model_context_window` from config.toml, the knob that makes
   *  reading any of this worthwhile: the catalog alone reports the same 272000
   *  we already hardcoded. */
  windowOverride: number | null;
}

const EMPTY: CodexLocalCatalog = { entries: [], model: null, windowOverride: null };

type Store = { __calandriaCodexCatalog?: { at: number; value: CodexLocalCatalog } };

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// `{fetched_at, etag, client_version, models: [...]}`. Anything that isn't an
// array of objects with a string slug is a shape we don't recognise, and an
// unrecognised shape is the same answer as no file.
function readModelsCache(dir: string): CodexCatalogEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, "models_cache.json"), "utf8"));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object") return [];
  const models = (raw as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: CodexCatalogEntry[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if (typeof r.slug !== "string" || !r.slug) continue;
    out.push({
      slug: r.slug,
      contextWindow: num(r.context_window),
      maxContextWindow: num(r.max_context_window),
      effectivePercent: num(r.effective_context_window_percent),
      visibility: typeof r.visibility === "string" ? r.visibility : null,
      priority: num(r.priority),
    });
  }
  return out;
}

// A line reader for two top-level scalars, not a TOML parser — the repo has no
// TOML dependency and this needs `model` and `model_context_window`, both of
// which codex documents as top-level keys.
//
// It stops at the first `[table]` header, which is the important part. A
// `[profiles.foo]` block sets those same keys for a profile that only applies
// when that profile is selected, and we don't model profile selection; reading
// one would apply somebody's occasional profile to every turn. Same for
// `[model_providers.*]`. Not reading a profile override just leaves the fallback
// in place, which is the failure this file is built to make safe.
function readConfigToml(dir: string): { model: string | null; windowOverride: number | null } {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
  } catch {
    return { model: null, windowOverride: null };
  }
  let model: string | null = null;
  let windowOverride: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    if (s.startsWith("[")) break;
    const eq = s.indexOf("=");
    if (eq < 0) continue;
    const key = s.slice(0, eq).trim();
    const value = s.slice(eq + 1).trim();
    if (key === "model") {
      // Anchored at the opening quote, so a trailing `# comment` needs no
      // stripping and can't eat a `#` that is inside the string.
      const q = /^"([^"]*)"|^'([^']*)'/.exec(value);
      const v = q ? (q[1] ?? q[2] ?? "") : "";
      if (v) model = v;
    } else if (key === "model_context_window") {
      const n = Number(value.replace(/#.*$/, "").trim().replace(/_/g, ""));
      if (Number.isFinite(n) && n > 0) windowOverride = Math.floor(n);
    }
  }
  return { model, windowOverride };
}

/** Everything ~/.codex says about models, cached for CACHE_MS. Never throws;
 *  an absent or unreadable ~/.codex is the ordinary empty answer. */
export function codexLocalCatalog(): CodexLocalCatalog {
  const store = globalThis as Store;
  const hit = store.__calandriaCodexCatalog;
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const dir = codexHome();
  let value: CodexLocalCatalog;
  try {
    const cfg = readConfigToml(dir);
    value = { entries: readModelsCache(dir), model: cfg.model, windowOverride: cfg.windowOverride };
  } catch {
    value = EMPTY;
  }
  store.__calandriaCodexCatalog = { at: Date.now(), value };
  return value;
}

/**
 * The model a codex turn runs when nothing picks one: the user's own
 * `model` from config.toml, else the lowest-`priority` LISTED entry in the
 * account catalog, else `fallback`.
 *
 * The fallback matters as much as the lookup. With no catalog on disk the CLI
 * uses the one compiled into its binary, so the right answer there is
 * DEFAULT_CODEX_MODEL — which is exactly what the CLI itself falls back to,
 * not a guess standing in for one.
 */
export function codexDefaultModel(fallback: string): string {
  const cat = codexLocalCatalog();
  if (cat.model) return cat.model;
  let best: CodexCatalogEntry | null = null;
  for (const e of cat.entries) {
    // A missing `visibility` is treated as listed: an unrecognised catalog
    // should still be able to answer, and "hide" is the field's only exclusion.
    if (e.visibility != null && e.visibility !== "list") continue;
    if (e.priority == null) continue;
    if (best == null || e.priority < best.priority!) best = e;
  }
  return best?.slug ?? fallback;
}

/**
 * The context window a turn on `slug` actually gets, in the order the CLI
 * applies them:
 *
 *   1. the catalog's `context_window` for the slug, else `fallback`;
 *   2. replaced outright by config.toml's `model_context_window` if set —
 *      that knob is why parsing any of this pays, since the catalog alone
 *      reports the 272000 already hardcoded;
 *   3. clamped to the slug's `max_context_window`, the ceiling the override
 *      cannot exceed;
 *   4. scaled to `effective_context_window_percent`, the point the CLI
 *      compacts at and therefore the end of the usable window.
 *
 * Every step is skipped when the file didn't say, so an absent ~/.codex returns
 * `fallback` unchanged.
 */
export function codexContextWindow(slug: string, fallback: number): number {
  const cat = codexLocalCatalog();
  const entry = cat.entries.find((e) => e.slug === slug) ?? null;
  let window = entry != null && entry.contextWindow != null && entry.contextWindow > 0 ? entry.contextWindow : fallback;
  if (cat.windowOverride != null) window = cat.windowOverride;
  if (entry != null && entry.maxContextWindow != null && entry.maxContextWindow > 0) window = Math.min(window, entry.maxContextWindow);
  const pct = entry?.effectivePercent;
  if (pct != null && pct > 0 && pct <= 100) window = Math.floor((window * pct) / 100);
  return window > 0 ? Math.floor(window) : fallback;
}

/** Drop the cached read. Tests point CODEX_HOME at a scratch dir per case, and
 *  the cache would otherwise carry one case's fixture into the next. */
export function resetCodexCatalogStateForTests(): void {
  delete (globalThis as Store).__calandriaCodexCatalog;
}
