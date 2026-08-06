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
