// Stable attention source identities (contract work-center/1). The id is the
// kind, a colon, and the base64url of a canonical JSON array with no
// whitespace, so an opaque id containing any delimiter cannot collide with a
// different tuple. Pure and SDK-free.

import type { Attention } from "./types";

export type AttentionKind = Attention["kind"];

export function sourceId(kind: AttentionKind, tuple: ReadonlyArray<string | number>): string {
  return `${kind}:${Buffer.from(JSON.stringify(tuple), "utf8").toString("base64url")}`;
}

/** The tuple behind an id, or null for anything this module did not write. */
export function parseSourceId(id: string): { kind: AttentionKind; tuple: Array<string | number> } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  try {
    const tuple = JSON.parse(Buffer.from(id.slice(i + 1), "base64url").toString("utf8"));
    if (!Array.isArray(tuple) || !tuple.every((v) => typeof v === "string" || typeof v === "number")) return null;
    return { kind: id.slice(0, i) as AttentionKind, tuple };
  } catch {
    return null;
  }
}

/** Deterministic episode id for a row that predates structured provenance. */
export function legacyEpisodeId(taskId: string, stamp: number | string): string {
  return `legacy:${Buffer.from(JSON.stringify([taskId, stamp]), "utf8").toString("base64url")}`;
}
