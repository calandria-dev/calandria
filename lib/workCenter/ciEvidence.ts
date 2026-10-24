// Structured CI evidence and episode identity (contract work-center/1). Pure
// and SDK-free apart from node:crypto: the GitHub fetch lives in lib/github.ts
// and hands its decoded rows here.
//
// An EPISODE is one continuous stretch of a failing PR head. It gets a new id
// when the failing fingerprint changes (a different check failing, or a
// same-head rerun that produced a new check id or workflow attempt), and when
// a failure starts again after the PR went green. An identical observation
// keeps the id. A torn or incomplete observation never settles an episode.

import { createHash, randomUUID } from "node:crypto";

export type CheckEvidence = {
  kind: "check_run" | "status";
  id: string;
  headSha: string;
  name: string;
  workflowRunId: string | null;
  attempt: number | null;
  status: string;
  conclusion: string | null;
  url: string | null;
  startedAt: number | null;
  completedAt: number | null;
  providerAppId: string | null;
  workflowId: string | null;
  checkSuiteId: string | null;
  context: string;
  /** Decimal provider database id; the numeric tiebreak inside a group. */
  sortId: string;
};

const FAIL = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale", "error"]);

/** RFC 8785 canonical JSON for the value shapes used here (no floats, no undefined). */
export function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return JSON.stringify(v);
  }
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new Error("unsupported value");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** A check is incomplete evidence when it cannot be tied to a provider app and suite or workflow. */
export function evidenceComplete(e: CheckEvidence): boolean {
  if (e.kind === "status") return !!e.context && /^\d+$/.test(e.sortId);
  return !!e.providerAppId && (!!e.workflowId || !!e.checkSuiteId) && /^\d+$/.test(e.sortId);
}

function groupKey(e: CheckEvidence): string {
  if (e.kind === "status") return canonicalJson([e.kind, e.context]);
  return canonicalJson([e.kind, e.providerAppId, e.workflowId ?? `suite:${e.checkSuiteId}`, e.context]);
}

function newer(a: CheckEvidence, b: CheckEvidence): boolean {
  const ta = a.startedAt ?? 0;
  const tb = b.startedAt ?? 0;
  if (ta !== tb) return ta > tb;
  return BigInt(a.sortId) > BigInt(b.sortId);
}

/** Latest entry per group, in a stable order (group key, then sort id). */
export function selectLatest(rows: CheckEvidence[]): CheckEvidence[] {
  const best = new Map<string, CheckEvidence>();
  for (const r of rows) {
    if (!/^\d+$/.test(r.sortId)) continue;
    const k = groupKey(r);
    const cur = best.get(k);
    if (!cur || newer(r, cur)) best.set(k, r);
  }
  return [...best.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

export function isFailing(e: CheckEvidence): boolean {
  if (e.kind === "status") return FAIL.has(e.status.toLowerCase());
  return e.status.toLowerCase() === "completed" && FAIL.has((e.conclusion ?? "").toLowerCase());
}

export type CiObservation = {
  /** Head the evidence was read against; every row must belong to it. */
  headSha: string;
  /** Latest check per group. */
  checks: CheckEvidence[];
  /** False when any row lacks stable identity or the response was torn. */
  complete: boolean;
};

export function failingFingerprint(checks: CheckEvidence[]): string {
  const failing = selectLatest(checks).filter(isFailing).map((c) => [c.kind, c.id, c.sortId, c.workflowRunId, c.attempt]);
  return sha256Hex(canonicalJson(failing));
}

export type EpisodeState = {
  episodeId: string | null;
  fingerprint: string | null;
  startedAt: number | null;
};

export type EpisodeStep = EpisodeState & {
  /** True when the observation is trustworthy enough to settle or advance an episode. */
  authoritative: boolean;
};

/**
 * Advance the stored episode given a new observation.
 *  - incomplete: keep whatever was stored, never settle (a torn response must
 *    not clear a red episode), and report non-authoritative;
 *  - not failing: settle (no episode);
 *  - failing with the same fingerprint: keep the id;
 *  - failing with a new fingerprint, or none stored: a new random id.
 */
export function stepEpisode(prev: EpisodeState, obs: CiObservation, now: number, mint: () => string = randomUUID): EpisodeStep {
  if (!obs.complete) return { ...prev, authoritative: false };
  const latest = selectLatest(obs.checks);
  if (!latest.some(isFailing)) return { episodeId: null, fingerprint: null, startedAt: null, authoritative: true };
  const fp = failingFingerprint(latest);
  if (prev.episodeId && prev.fingerprint === fp) return { ...prev, authoritative: true };
  return { episodeId: mint(), fingerprint: fp, startedAt: now, authoritative: true };
}

/** Evidence belongs to the head both before and after collection, and each row names it. */
export function coherent(headBefore: string, headAfter: string, rows: CheckEvidence[]): boolean {
  return !!headBefore && headBefore === headAfter && rows.every((r) => r.headSha === headBefore);
}
