// Context-window sizing for the gauge, shared by the server
// (lib/agents/capabilities.ts modelContextWindow) and the client
// (app/shell/format.ts contextWindowOf) so the live SSE update and the
// persisted number can't disagree. Pure; no imports — the client bundles it.
//
// Two misses, two answers (issue #39):
//   - model == null: the driver picks its own model, so approximate with the
//     WIDEST window the agent offers — the gauge must not over-report fullness
//     for a session that may well be running the 1M variant.
//   - model set but not in the catalog: an id we can't size. Widest-on-miss
//     here would size any unrecognised 200k model at 1M and show a fifth of
//     its real fullness right up to the context overflow — the gauge least
//     trustworthy exactly when it matters. So err the other way: the NARROWEST
//     catalog entry, which over-reports fullness and nudges a /clear early
//     rather than late.
//   - an empty catalog (a driver with no model list): a conservative constant.

export const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface SizedModel {
  value: string;
  contextWindow: number;
}

export function contextWindowFor(models: ReadonlyArray<SizedModel>, model: string | null | undefined): number {
  if (model) {
    const hit = models.find((m) => m.value === model);
    if (hit) return hit.contextWindow;
  }
  const sizes = models.map((m) => m.contextWindow).filter((n) => n > 0);
  if (sizes.length === 0) return DEFAULT_CONTEXT_WINDOW;
  return model ? Math.min(...sizes) : Math.max(...sizes);
}
