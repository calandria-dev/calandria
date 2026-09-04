// Codex / ChatGPT plan usage: the Codex half of the titlebar session/week
// meter, the same PlanUsageSnapshot the Claude driver serves.
//
// The Claude side (lib/agents/claude/planUsage.ts) gets most of its freshness
// for free, because every turn's stream carries `rate_limit_event` messages.
// That trick does not work here:
//
//   * The SDK's `ThreadEvent` union is closed at eight members and carries no
//     rate-limit data (dist/index.d.ts). `turn.completed.usage` is token counts
//     only (input/cached_input/cache_write/output/reasoning), which is what
//     ./usage.ts already bills against.
//   * That is the CLI's doing, not the SDK's: the exec JSONL serializer's own
//     field table lists its whole vocabulary (`thread.started turn.started
//     turn.completed turn.failed item.started item.updated item.completed`)
//     with no `token_count` and no `rate_limits` anywhere in it. Older codex
//     builds emitted a legacy `token_count` event carrying `rate_limits`; the
//     current dotted exec protocol does not.
//   * Nor is it cached anywhere on disk to read passively: the CLI's rollout
//     transcripts under `$CODEX_HOME/sessions` record `session_meta` /
//     `event_msg` / `response_item` / `world_state` / `turn_context` and no
//     rate-limit entry, and `state_5.sqlite` holds threads, not limits.
//
// So this half is an active read, floored the same way Claude's usage endpoint
// is: `codex app-server`'s `account/rateLimits/read` (./appServer.ts, where the
// verified handshake is transcribed). Field names come from the CLI's own
// generated schema (`codex app-server generate-json-schema`), which is camelCase
// and differs from the snake_case legacy event shape: a `RateLimitSnapshot` of
// `primary` / `secondary` `RateLimitWindow`s, each `{usedPercent,
// windowDurationMins, resetsAt}`, plus `planType` and `rateLimitReachedType`.
//
// Instance-wide on globalThis for the same reasons as the Claude side: one
// ChatGPT login per instance means one snapshot, shared by every route chunk
// and surviving dev HMR. No credential is ever read or forwarded here; the
// CLI holds the login and answers about it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLAN_USAGE_ENABLED, PLAN_USAGE_MIN_FETCH_MS } from "@/lib/config";
import type { PlanUsageSnapshot, PlanUsageWindow } from "@/lib/types";
import { hasOpenAiKey } from "../../openai-key";
import { readAccountRateLimits } from "./appServer";

// After a failed read, wait at least this long before spawning another
// app-server. Kept separate from the success floor so a broken CLI isn't
// respawned at the poll rate, but recovery doesn't wait out a full success
// interval.
const ERROR_BACKOFF_MS = 60_000;

interface Fetched {
  at: number;
  windows: PlanUsageWindow[];
  plan: string | null;
  /** The account is currently over a limit (rateLimitReachedType/spendControl). */
  reached: boolean;
}

interface State {
  fetched: Fetched | null;
  lastError: string | null;
  backoffUntil: number;
  inflight: Promise<void> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaCodexPlanUsage: State | undefined;
}

function state(): State {
  if (!global.__calandriaCodexPlanUsage) {
    global.__calandriaCodexPlanUsage = { fetched: null, lastError: null, backoffUntil: 0, inflight: null };
  }
  return global.__calandriaCodexPlanUsage;
}

/** Tests only: the state is process-global and tests must not share it. */
export function resetCodexPlanUsageStateForTests(): void {
  global.__calandriaCodexPlanUsage = undefined;
}

// `resetsAt` is an int64 with no unit in the schema; the neighbouring reset-credit
// fields are documented as "Unix timestamp in seconds", so treat it as seconds
// while tolerating milliseconds, the same heuristic the Claude side uses.
function toEpochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  return null;
}

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

// The app-server names its windows by rank (which limit binds first), not by
// duration, so the label states the duration it actually reported instead of
// assuming the plan's shape. In practice primary is the ~5h session and
// secondary the week, which is what the ids are matched on client-side.
function windowLabel(kind: "primary" | "secondary", mins: number | null): string {
  const base = kind === "primary" ? "Current session" : "Current week";
  if (mins == null || mins <= 0) return base;
  if (kind === "secondary" && Math.round(mins / 1440) === 7) return base;
  const span = mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
  return `${base} (${span})`;
}

function windowFrom(kind: "primary" | "secondary", raw: unknown): PlanUsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown };
  if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) return null;
  const mins = typeof w.windowDurationMins === "number" && Number.isFinite(w.windowDurationMins) ? w.windowDurationMins : null;
  return { id: kind, label: windowLabel(kind, mins), utilization: clampPct(w.usedPercent), resetsAt: toEpochMs(w.resetsAt) };
}

/**
 * `GetAccountRateLimitsResponse` mapped to the rows the meter renders. The
 * response wraps the snapshot in `rateLimits` (the schema's "backward-compatible
 * single-bucket view"); a bare snapshot is accepted too, so a future protocol
 * that hands one over directly still meters instead of showing nothing.
 * `rateLimitsByLimitId` is ignored: the multi-bucket view is the same numbers
 * keyed by metered limit, and one plan's meter should not fan out into a row
 * per bucket.
 */
export function parseRateLimits(result: unknown): Fetched | null {
  if (!result || typeof result !== "object") return null;
  const outer = result as { rateLimits?: unknown };
  const raw = outer.rateLimits && typeof outer.rateLimits === "object" ? outer.rateLimits : result;
  const snap = raw as { primary?: unknown; secondary?: unknown; planType?: unknown; rateLimitReachedType?: unknown; spendControlReached?: unknown };

  const windows = [windowFrom("primary", snap.primary), windowFrom("secondary", snap.secondary)].filter((w): w is PlanUsageWindow => w != null);
  // "unknown" is the schema's own placeholder for an indeterminate plan, and
  // isn't worth printing in the popover title.
  const plan = typeof snap.planType === "string" && snap.planType && snap.planType !== "unknown" ? snap.planType : null;
  const reached = typeof snap.rateLimitReachedType === "string" && !!snap.rateLimitReachedType ? true : snap.spendControlReached === true;
  return { at: Date.now(), windows, plan, reached };
}

// Is there a ChatGPT login to meter at all? Cheap fs check so an instance that
// never connected Codex doesn't spawn an app-server every fetch interval
// forever. Permissive about the file's contents: an auth.json whose shape
// isn't recognized still proceeds to the RPC, which is the authority and
// answers "authentication required" for itself.
function hasChatgptLogin(): boolean {
  const dir = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    if (!raw || typeof raw !== "object") return false;
    if ("tokens" in raw) return !!(raw as { tokens?: unknown }).tokens;
    return true;
  } catch {
    // No file (never logged in) or unreadable JSON: nothing to meter.
    return false;
  }
}

async function refresh(): Promise<void> {
  const st = state();
  const { data, error } = await readAccountRateLimits();
  if (error != null) {
    st.backoffUntil = Date.now() + ERROR_BACKOFF_MS;
    st.lastError = error;
    return;
  }
  const parsed = parseRateLimits(data);
  if (!parsed) {
    st.backoffUntil = Date.now() + ERROR_BACKOFF_MS;
    st.lastError = "codex reported no rate-limit data";
    return;
  }
  st.fetched = parsed;
  st.lastError = null;
  st.backoffUntil = 0;
}

/**
 * Current Codex plan usage, re-reading only when the floor and backoff allow.
 * Returns null when the feature is off, when an OpenAI API key is what the
 * codex children actually bill (no plan to meter), or when there is no ChatGPT
 * login at all; the UI then shows no Codex pill.
 */
export async function getCodexPlanUsage(): Promise<PlanUsageSnapshot | null> {
  if (!PLAN_USAGE_ENABLED) return null;
  // Key check before the login file, matching codexStatus's precedence: a key
  // in the env is what the codex children bill whatever ~/.codex says.
  if (hasOpenAiKey()) return null;

  const st = state();
  const loggedIn = hasChatgptLogin();
  if (!loggedIn && !st.fetched) return null;

  const now = Date.now();
  if (loggedIn && now >= st.backoffUntil && now - (st.fetched?.at ?? 0) >= PLAN_USAGE_MIN_FETCH_MS) {
    // Single-flight: concurrent tabs polling at once share one app-server.
    if (!st.inflight) {
      st.inflight = refresh().finally(() => {
        st.inflight = null;
      });
    }
    await st.inflight;
  }

  const f = st.fetched;
  const windows = (f?.windows ?? []).map((w) => ({ ...w }));
  // There is no passive telemetry to overlay (see the header), so the status
  // trio comes from the same read as the windows: `rateLimitReachedType` says
  // a limit is reached but not which, so the fullest window is named. It is
  // the one that reset unblocks, and the only one whose reset time is worth
  // offering as "turns resume at".
  const binding = f?.reached ? windows.reduce<PlanUsageWindow | null>((a, b) => (a && a.utilization >= b.utilization ? a : b), null) : null;
  const reason = !loggedIn ? "No ChatGPT subscription login" : st.lastError;

  return {
    available: windows.length > 0,
    reason: reason ?? null,
    plan: f?.plan ?? null,
    windows,
    status: f?.reached ? "rejected" : null,
    statusWindow: binding?.id ?? null,
    statusResetsAt: binding?.resetsAt ?? null,
    fetchedAt: f?.at ?? null,
    stale: st.lastError != null && f != null,
  };
}
