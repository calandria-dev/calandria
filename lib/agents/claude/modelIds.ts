// What Claude Code's family aliases actually resolve to, parked where the
// synchronous capability descriptor can read it.
//
// claudeCapabilities() is read per request (GET /api/agents on every tab load,
// and modelContextWindow() from inside getTaskContext(), a synchronous
// better-sqlite3 path), so it cannot itself go and ask. ./modelProbe.ts does
// the asking, detached, and leaves the answer here.
//
// This file is the seam between the two and imports nothing, on purpose. The
// prober reaches lib/store.ts to persist its answer, and lib/store.ts imports
// lib/agents/capabilities.ts back for context windows; a descriptor that read
// the prober directly would close that loop. Turbopack mishandles a cycle
// through an async external (see the TurnHooks note in CLAUDE.md), so data
// flows one way here, with no edge back.

/** One CLI version's answer for every alias that was probed. */
export interface ResolvedModelIds {
  /** The `claude --version` that produced these. A different one re-probes. */
  version: string;
  /** Probe value ("opus") → the id that CLI resolves it to ("claude-opus-5"). */
  ids: Record<string, string>;
}

// On globalThis for the same reason lib/events.ts and lib/modelEndpoint.ts's
// probe cache are: HMR reloads the module, and an answer that costs a
// multi-second sweep of CLI spawns must not reset on every edit.
const store = globalThis as { __calandriaClaudeModelIds?: ResolvedModelIds | null };

/** The cached resolution, or null when nothing has been probed yet, which is
 *  every caller's cue to keep the static catalog exactly as written. */
export function resolvedModelIds(): ResolvedModelIds | null {
  return store.__calandriaClaudeModelIds ?? null;
}

export function setResolvedModelIds(value: ResolvedModelIds | null): void {
  store.__calandriaClaudeModelIds = value;
}

/** Forget the resolution, for a test or a re-probe. */
export function clearResolvedModelIds(): void {
  store.__calandriaClaudeModelIds = null;
}
