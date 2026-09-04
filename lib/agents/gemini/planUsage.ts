// Antigravity plan usage: the quota meters behind the titlebar pill.
//
// The CLI answers this itself: `agy -p "/usage" --output-format json` returns
// a structured `command.data` payload (groups of models, each with a weekly
// and a 5-hour bucket carrying `remaining_fraction` and `reset_time`) and
// spends nothing doing it: the run reports `num_turns: 0` and zero tokens, so
// this is a read, not a turn. That makes it the counterpart of Claude's usage
// endpoint (lib/agents/claude/planUsage.ts), with two differences:
//
//   - There is no passive half. Nothing in the turn stream carries rate-limit
//     telemetry, so `status`/`statusWindow` stay null and the snapshot is only
//     ever as fresh as the last poll.
//   - The fetch is a process spawn, not an HTTP call, taking a second or two,
//     so the same floor (PLAN_USAGE_MIN_FETCH_MS) matters for CPU instead of
//     for a provider's rate limit, and the poll is single-flighted for the
//     same reason: several tabs asking at once must not spawn several CLIs.
//
// The CLI reports remaining fraction where the snapshot wants percent spent,
// so the conversion happens here and nothing downstream has to know which
// way round a given provider phrases its quota.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { AGY_CLI_PATH, PLAN_USAGE_ENABLED, PLAN_USAGE_MIN_FETCH_MS } from "@/lib/config";
import type { PlanUsageSnapshot, PlanUsageWindow } from "@/lib/types";
import { parseJsonResult } from "./auth";
import { isAgentConnected } from "../connections";

const execFileAsync = promisify(execFile);

const FETCH_TIMEOUT_MS = 60_000;
/** After a failed read, wait this long before spawning the CLI again. */
const ERROR_BACKOFF_MS = 60_000;

interface State {
  fetched: { at: number; windows: PlanUsageWindow[] } | null;
  lastError: string | null;
  backoffUntil: number;
  inflight: Promise<void> | null;
}

const g = globalThis as unknown as { __calandriaGeminiPlanUsage?: State };

function state(): State {
  if (!g.__calandriaGeminiPlanUsage) {
    g.__calandriaGeminiPlanUsage = { fetched: null, lastError: null, backoffUntil: 0, inflight: null };
  }
  return g.__calandriaGeminiPlanUsage;
}

/** Tests only. The state is process-global and tests must not share it. */
export function resetGeminiPlanUsageForTests(): void {
  g.__calandriaGeminiPlanUsage = undefined;
}

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

/**
 * `/usage`'s payload mapped to the windows the meter renders. Shape:
 * `command.data.groups[] = { name, buckets[] }`, each bucket
 * `{ id, name, window: "weekly" | "5h", remaining_fraction, reset_time }`.
 *
 * Every group is kept, not just Gemini's: an Antigravity subscription meters
 * the Claude and GPT models it also serves on a separate pair of limits, and
 * a task pointed at one of those spends that pair. Labels mirror Claude's
 * ("Current session (…)" / "Current week (…)") so one popover reads as one
 * feature, and `kind` is what the pill and lib/usageReset.ts pick by, since
 * the ids are the provider's own.
 */
export function parseUsagePayload(data: unknown): PlanUsageWindow[] {
  const groups = (data as { command?: { data?: { groups?: unknown } } })?.command?.data?.groups;
  if (!Array.isArray(groups)) return [];
  const windows: PlanUsageWindow[] = [];
  for (const group of groups) {
    const gr = group as { name?: unknown; buckets?: unknown };
    const groupName = typeof gr.name === "string" ? gr.name : null;
    if (!Array.isArray(gr.buckets)) continue;
    for (const bucket of gr.buckets) {
      const b = bucket as { id?: unknown; name?: unknown; window?: unknown; remaining_fraction?: unknown; reset_time?: unknown };
      if (typeof b.remaining_fraction !== "number" || !Number.isFinite(b.remaining_fraction)) continue;
      const kind = b.window === "5h" ? "session" : b.window === "weekly" ? "week" : null;
      const period = kind === "session" ? "Current session" : kind === "week" ? "Current week" : typeof b.name === "string" ? b.name : "Limit";
      const reset = typeof b.reset_time === "string" ? Date.parse(b.reset_time) : NaN;
      windows.push({
        id: typeof b.id === "string" && b.id ? b.id : `${groupName ?? "group"}:${String(b.window ?? windows.length)}`,
        label: groupName ? `${period} (${groupName})` : period,
        // The CLI reports what is left; the meter shows what is spent.
        utilization: clampPct((1 - b.remaining_fraction) * 100),
        resetsAt: Number.isFinite(reset) ? reset : null,
        kind,
      });
    }
  }
  return windows;
}

async function refreshFromCli(): Promise<void> {
  const st = state();
  try {
    const { stdout } = await execFileAsync(AGY_CLI_PATH || "agy", ["-p", "/usage", "--output-format", "json"], {
      timeout: FETCH_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      cwd: os.tmpdir(),
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    });
    const windows = parseUsagePayload(parseJsonResult(stdout));
    if (!windows.length) {
      st.backoffUntil = Date.now() + ERROR_BACKOFF_MS;
      st.lastError = "the CLI reported no quota windows";
      return;
    }
    st.fetched = { at: Date.now(), windows };
    st.lastError = null;
    st.backoffUntil = 0;
  } catch (err) {
    // A signed-out CLI, an API-key login with no subscription behind it, or no
    // `agy` on PATH all land here. None is worth retrying at the poll rate.
    st.backoffUntil = Date.now() + ERROR_BACKOFF_MS;
    st.lastError = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Current Antigravity quota, refetched only when the floor and backoff allow.
 * Null when the feature is off or nothing has ever been read; the UI hides
 * the meter entirely instead of showing an empty one.
 */
export async function getGeminiPlanUsage(): Promise<PlanUsageSnapshot | null> {
  if (!PLAN_USAGE_ENABLED) return null;
  // Never spawn for an agent the user hasn't connected. Every driver is
  // registered on every instance now, and this route is polled by every open
  // tab, so without this an instance that only uses Claude would still fork a
  // (usually missing) `agy` on a one-minute error-backoff loop forever.
  if (!isAgentConnected("gemini")) return null;
  const st = state();
  const now = Date.now();
  if (now >= st.backoffUntil && now - (st.fetched?.at ?? 0) >= PLAN_USAGE_MIN_FETCH_MS) {
    if (!st.inflight) {
      st.inflight = refreshFromCli().finally(() => {
        st.inflight = null;
      });
    }
    await st.inflight;
  }
  if (!st.fetched) return null;
  return {
    available: st.fetched.windows.length > 0,
    reason: st.lastError,
    // The CLI names no tier on any no-quota command, so the popover title is
    // the agent's own name instead of an invented plan.
    plan: null,
    windows: st.fetched.windows.map((w) => ({ ...w })),
    // No passive signal exists on this agent's stream (see the header).
    status: null,
    statusWindow: null,
    statusResetsAt: null,
    fetchedAt: st.fetched.at,
    stale: st.lastError != null,
  };
}
