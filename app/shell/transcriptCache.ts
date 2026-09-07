// Bounds the per-task transcript state the shell keeps in memory.
//
// useTaskStream holds one Msg[] per task the tab has opened. Every array
// carries whole tool results, so a phone that has visited twenty tasks in one
// long-lived home-screen session was holding twenty transcripts nothing could
// read: only the selected task's array is ever rendered, and reselecting a
// task replays its snapshot from the server anyway. The state is a cache, and
// this file is its policy: a short most-recently-selected list, and everything
// off it evicted. Pure, so the policy is pinned by tests/transcriptCache.test.ts
// rather than by rendering the hook.

// The selected task plus the few most recently left, so tapping back to the
// task you just came from paints instantly instead of through the skeleton.
export const TRANSCRIPT_CACHE_LIMIT = 4;

// Moves `id` to the front of a most-recent-first list and trims it to `limit`.
// A null id (nothing selected) leaves the list alone.
export function touchRecent(order: readonly string[], id: string | null, limit = TRANSCRIPT_CACHE_LIMIT): string[] {
  if (!id) return order.slice(0, limit);
  const rest = order.filter((x) => x !== id);
  return [id, ...rest].slice(0, limit);
}

// Drops every entry whose key is not in `keep`. Returns `map` itself when
// nothing is dropped, because callers hand the result to a React state
// setter and an unchanged object is one React bails out of re-rendering on.
export function evictTranscripts<T>(map: Record<string, T>, keep: readonly string[]): Record<string, T> {
  const keepSet = new Set(keep);
  const doomed = Object.keys(map).filter((k) => !keepSet.has(k));
  if (doomed.length === 0) return map;
  const next: Record<string, T> = {};
  for (const k of Object.keys(map)) if (keepSet.has(k)) next[k] = map[k];
  return next;
}
