// Context-window sizing for the gauge, shared by the server
// (lib/agents/capabilities.ts modelContextWindow) and the client
// (app/shell/format.ts contextWindowOf) so the live SSE update and the
// persisted number agree. Pure, no imports, so the client can bundle it.
//
// Two misses, two answers:
//   - model == null: the driver picks its own model, so approximate with the
//     WIDEST window the agent offers, since the session may be running the
//     1M variant.
//   - model set but not in the catalog: an id that can't be sized. Sizing an
//     unrecognized 200k model at 1M would show a fifth of its real fullness
//     right up to context overflow, so this case uses the NARROWEST catalog
//     entry instead, which over-reports fullness and nudges a /clear early.
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
