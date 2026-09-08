import { nanoid } from "nanoid";
import { getDb } from "./db";
import type { TurnUsage } from "./types";

export type InternalJob = "summarizeTranscript" | "draftProjectContext" | "summarizeProjectRecap" | "planTagRefresh" | "verify";

export interface InternalJobUsage30d {
  job: InternalJob;
  runs: number;
  cost_usd: number;
  /** Models these runs actually used, busiest first. Empty when none recorded. */
  models: string[];
}

export function internalUsageLast30Days(): InternalJobUsage30d[] {
  // Groups by job and model, then folds each job's models into one list so
  // the caller gets totals plus models in a single read.
  const rows = getDb().prepare(
    `SELECT job, model, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM internal_usage
      WHERE created_at >= ?
      GROUP BY job, model
      ORDER BY runs DESC`
  ).all(Date.now() - 30 * 24 * 60 * 60 * 1000) as { job: InternalJob; model: string | null; runs: number; cost_usd: number }[];

  const byJob = new Map<InternalJob, InternalJobUsage30d>();
  for (const row of rows) {
    const entry = byJob.get(row.job) ?? { job: row.job, runs: 0, cost_usd: 0, models: [] };
    entry.runs += row.runs;
    entry.cost_usd += row.cost_usd;
    // A run with no reported model is still counted but left off the models list.
    if (row.model && !entry.models.includes(row.model)) entry.models.push(row.model);
    byJob.set(row.job, entry);
  }
  return [...byJob.values()];
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
  /** The model that actually ran. Null when the driver can't report it. */
  model?: string | null;
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
         (id, job, agent, requested_agent, fallback, model, project_id, task_id, ok, ms,
          cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nanoid(), input.job, input.agent, input.requested_agent, input.fallback ? 1 : 0,
      input.model || null,
      input.project_id ?? null, input.task_id ?? null, input.ok === false ? 0 : 1, input.ms ?? 0,
      u?.cost_usd ?? 0, u?.input_tokens ?? 0, u?.output_tokens ?? 0,
      u?.cache_read_tokens ?? 0, u?.cache_creation_tokens ?? 0, Date.now()
    );
}
