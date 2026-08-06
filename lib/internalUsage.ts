import { nanoid } from "nanoid";
import { getDb } from "./db";
import type { TurnUsage } from "./types";

export type InternalJob = "summarizeTranscript" | "draftProjectContext" | "summarizeProjectRecap" | "verify";

export interface InternalJobUsage30d {
  job: InternalJob;
  runs: number;
  cost_usd: number;
}

export function internalUsageLast30Days(): InternalJobUsage30d[] {
  return getDb().prepare(
    `SELECT job, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM internal_usage
      WHERE created_at >= ?
      GROUP BY job`
  ).all(Date.now() - 30 * 24 * 60 * 60 * 1000) as InternalJobUsage30d[];
}

export type InternalUsageEstimate = {
  tokens: number;
  cost_usd: number;
  source: "project_latest" | "instance_median" | "scaled_history";
};

type UsageRow = {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};

const totalTokens = (r: UsageRow) =>
  r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens;
const inputTokens = (r: UsageRow) =>
  r.input_tokens + r.cache_read_tokens + r.cache_creation_tokens;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Latest context draft for this project, or the typical instance run. */
export function getContextDraftEstimate(projectId: string): InternalUsageEstimate | null {
  const db = getDb();
  const usable = `job = 'draftProjectContext'
    AND input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens > 0`;
  const latest = db.prepare(
    `SELECT cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
     FROM internal_usage WHERE ${usable} AND project_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(projectId) as UsageRow | undefined;
  if (latest) return { tokens: totalTokens(latest), cost_usd: latest.cost_usd, source: "project_latest" };

  const rows = db.prepare(
    `SELECT cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
     FROM internal_usage WHERE ${usable}`
  ).all() as UsageRow[];
  if (!rows.length) return null;
  return {
    tokens: Math.round(median(rows.map(totalTokens))),
    cost_usd: median(rows.map((r) => r.cost_usd)),
    source: "instance_median",
  };
}

/**
 * Estimate a /clear one-shot at the current transcript size. Its prompt is the
 * transcript, so scale historical summary runs by their input-side tokens.
 */
export function getClearEstimate(contextTokens: number, agent?: string | null): InternalUsageEstimate | null {
  if (contextTokens <= 0) return null;
  const db = getDb();
  const usable = `job = 'summarizeTranscript'
    AND input_tokens + cache_read_tokens + cache_creation_tokens > 0`;
  const read = (sameAgent: boolean) => db.prepare(
    `SELECT cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
     FROM internal_usage WHERE ${usable}${sameAgent ? " AND agent = ?" : ""}`
  ).all(...(sameAgent ? [agent] : [])) as UsageRow[];
  let rows = agent ? read(true) : [];
  if (!rows.length) rows = read(false);
  if (!rows.length) return null;

  return {
    tokens: Math.round(median(rows.map((r) => contextTokens * totalTokens(r) / inputTokens(r)))),
    cost_usd: median(rows.map((r) => contextTokens * r.cost_usd / inputTokens(r))),
    source: "scaled_history",
  };
}

export function addInternalUsage(input: {
  job: InternalJob;
  agent: string;
  requested_agent: string;
  fallback?: boolean;
  project_id?: string | null;
  task_id?: string | null;
  ok?: boolean;
  ms?: number;
  usage?: TurnUsage;
}): void {
  const u = input.usage;
  getDb()
    .prepare(
      `INSERT INTO internal_usage
         (id, job, agent, requested_agent, fallback, project_id, task_id, ok, ms,
          cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nanoid(), input.job, input.agent, input.requested_agent, input.fallback ? 1 : 0,
      input.project_id ?? null, input.task_id ?? null, input.ok === false ? 0 : 1, input.ms ?? 0,
      u?.cost_usd ?? 0, u?.input_tokens ?? 0, u?.output_tokens ?? 0,
      u?.cache_read_tokens ?? 0, u?.cache_creation_tokens ?? 0, Date.now()
    );
}
