// Claude Pro/Max plan usage — the session (5-hour) and week (7-day) meters.
//
// Two sources, merged, because neither is sufficient alone (both verified
// against claude-cli 2.1.240):
//
//   1. PASSIVE — every turn's SDK stream carries `rate_limit_event` messages
//      (the CLI parses `anthropic-ratelimit-unified-*` response headers on the
//      API calls the turn is already making). Free and fresher than any poll —
//      but the event only carries a UTILIZATION PERCENTAGE once a warning
//      threshold is crossed. Below that it says just "allowed" + which window
//      binds + when it resets (measured live: at 12% session usage the event
//      has no `utilization` field). The CLI holds a per-window utilization map
//      internally (it feeds its statusline) but never puts it on the SDK wire.
//
//   2. ACTIVE — `GET https://api.anthropic.com/api/oauth/usage` with the local
//      login's OAuth token: the same call the CLI's own /usage panel makes,
//      returning every window's percentage at any level. Anthropic rate-limits
//      it aggressively, so fetches are demand-driven (only when the UI asks)
//      and floored at PLAN_USAGE_MIN_FETCH_MS (default 300s, the CLI's own
//      minimum for this endpoint), with 429 Retry-After honored and stale data
//      served rather than refetched on failure.
//
// The passive signal overlays the cached fetch: a warning/rejected event from
// a live turn updates its window's percentage and the status trio immediately,
// so "limit reached" never waits out the fetch floor.
//
// Deliberately SDK-free (fs + fetch only — pinned by tests/importGraph.test.ts)
// and instance-wide on globalThis: one Claude login per instance means one
// snapshot, shared by every route chunk and surviving dev HMR (the same
// pattern as lib/events.ts). The OAuth token is read from the CLI's own
// credentials file and sent ONLY to Anthropic's API host; it is never exposed
// on any route. Token refresh is left strictly to the CLI — OAuth refresh
// rotates the token, so refreshing here would race the CLI's copy. An expired
// token just means "coast on cache until the next turn refreshes it".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLAN_USAGE_ENABLED, PLAN_USAGE_MIN_FETCH_MS } from "@/lib/config";
import type { PlanUsageSnapshot, PlanUsageWindow } from "@/lib/types";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FETCH_TIMEOUT_MS = 5000;
// After a failed fetch (non-429), wait at least this long before trying again
// — separate from the success floor so a flapping endpoint isn't hammered at
// the poll rate, but recovery doesn't wait out a full success interval either.
const ERROR_BACKOFF_MS = 60_000;
// A 429 with no Retry-After header backs off this long.
const RATE_LIMITED_BACKOFF_MS = 15 * 60_000;

// Display labels for the window keys the endpoint and the rate_limit_event
// share. Unknown keys pass through labeled by their id — better an ugly row
// than a silently dropped limit when the provider adds a window.
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "Current session",
  seven_day: "Current week (all models)",
  seven_day_opus: "Current week (Opus)",
  seven_day_sonnet: "Current week (Sonnet)",
};

// Which of the two windows every metered plan has each key is — what the pill
// and the queued-start button pick by, so neither has to know one provider's
// spelling of "the 5-hour one". The per-model weeks are deliberately absent:
// they are extra rows, not the week the plan is paced against.
const WINDOW_KINDS: Record<string, "session" | "week"> = {
  five_hour: "session",
  seven_day: "week",
};

interface PassiveSignal {
  status: "allowed" | "allowed_warning" | "rejected";
  window: string | null; // rateLimitType — which window the status is about
  resetsAt: number | null; // epoch ms
  utilization: number | null; // percent 0–100, present only past thresholds
  at: number; // when the event arrived
}

interface State {
  fetched: { at: number; windows: PlanUsageWindow[] } | null;
  passive: PassiveSignal | null;
  lastError: string | null;
  backoffUntil: number;
  inflight: Promise<void> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaClaudePlanUsage: State | undefined;
}

function state(): State {
  if (!global.__calandriaClaudePlanUsage) {
    global.__calandriaClaudePlanUsage = { fetched: null, passive: null, lastError: null, backoffUntil: 0, inflight: null };
  }
  return global.__calandriaClaudePlanUsage;
}

/** Tests only — the state is process-global and tests must not share it. */
export function resetPlanUsageStateForTests(): void {
  global.__calandriaClaudePlanUsage = undefined;
}

// Epoch normalization: the endpoint reports ISO strings, the SDK event epoch
// seconds; tolerate milliseconds defensively (values past ~2001 in ms terms) —
// same heuristic as the driver's withResetTime().
function toEpochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

/**
 * Passive intake: the Claude driver calls this for every rate_limit_event a
 * turn's stream carries. Cheap and synchronous — it must never slow the pump.
 */
export function recordClaudeRateLimit(info: unknown): void {
  if (!info || typeof info !== "object") return;
  const o = info as { status?: unknown; rateLimitType?: unknown; resetsAt?: unknown; utilization?: unknown; surpassedThreshold?: unknown };
  if (o.status !== "allowed" && o.status !== "allowed_warning" && o.status !== "rejected") return;
  // The event's utilization (and its surpassedThreshold fallback — a floor the
  // CLI reports when the exact figure is absent) is a 0–1 fraction: the CLI
  // multiplies the same header value by 100 for its statusline. Tolerate an
  // already-percent value defensively (a fraction can't exceed 1).
  const rawUtil = typeof o.utilization === "number" ? o.utilization : typeof o.surpassedThreshold === "number" ? o.surpassedThreshold : null;
  const utilization = rawUtil == null || !Number.isFinite(rawUtil) ? null : clampPct(rawUtil <= 1 ? rawUtil * 100 : rawUtil);
  state().passive = {
    status: o.status,
    window: typeof o.rateLimitType === "string" ? o.rateLimitType : null,
    resetsAt: toEpochMs(o.resetsAt),
    utilization,
    at: Date.now(),
  };
}

// ---------- the OAuth credential the CLI already maintains ----------

interface OauthCreds {
  token: string;
  expiresAt: number | null; // epoch ms
  plan: string | null; // subscriptionType ("max", "pro") when recorded
}

function readOauthCreds(): OauthCreds | null {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown };
    };
    const o = raw?.claudeAiOauth;
    if (!o || typeof o.accessToken !== "string" || !o.accessToken) return null;
    return {
      token: o.accessToken,
      expiresAt: toEpochMs(o.expiresAt),
      plan: typeof o.subscriptionType === "string" ? o.subscriptionType : null,
    };
  } catch {
    // No file (API-key auth, or never logged in) or unreadable JSON — either
    // way there is no subscription to meter.
    return null;
  }
}

// ---------- endpoint response → windows ----------

// The response shape the CLI's /usage panel renders (verified against the
// 2.1.240 bundle): top-level `{utilization, resets_at}` objects under the
// WINDOW_LABELS keys — utilization already percent 0–100 — plus a `limits`
// array whose `weekly_scoped` entries carry per-model weeks as
// `{kind, percent, resets_at, scope: {model: {display_name}}}`.
export function parseUsagePayload(data: unknown): PlanUsageWindow[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const windows: PlanUsageWindow[] = [];
  for (const id of Object.keys(WINDOW_LABELS)) {
    const w = d[id];
    if (!w || typeof w !== "object") continue;
    const util = (w as { utilization?: unknown }).utilization;
    if (typeof util !== "number" || !Number.isFinite(util)) continue;
    windows.push({ id, label: WINDOW_LABELS[id], utilization: clampPct(util), resetsAt: toEpochMs((w as { resets_at?: unknown }).resets_at), kind: WINDOW_KINDS[id] ?? null });
  }
  if (Array.isArray(d.limits)) {
    const have = new Set(windows.map((w) => w.label.toLowerCase()));
    for (const item of d.limits) {
      if (!item || typeof item !== "object") continue;
      const l = item as { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } } };
      const name = l.scope?.model?.display_name;
      if (l.kind !== "weekly_scoped" || typeof l.percent !== "number" || !Number.isFinite(l.percent) || typeof name !== "string") continue;
      const label = `Current week (${name})`;
      // The top-level opus/sonnet keys and the scoped list can describe the
      // same model — keep the top-level one, which the CLI also prefers.
      if (have.has(label.toLowerCase())) continue;
      windows.push({ id: `weekly:${name.toLowerCase()}`, label, utilization: clampPct(l.percent), resetsAt: toEpochMs(l.resets_at) });
    }
  }
  return windows;
}

async function refreshFromApi(creds: OauthCreds): Promise<void> {
  const st = state();
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RATE_LIMITED_BACKOFF_MS;
        st.backoffUntil = Date.now() + Math.max(waitMs, PLAN_USAGE_MIN_FETCH_MS);
        st.lastError = "usage API rate-limited";
        return;
      }
      st.backoffUntil = Date.now() + ERROR_BACKOFF_MS;
      st.lastError = `usage API returned ${res.status}`;
      return;
    }
    st.fetched = { at: Date.now(), windows: parseUsagePayload(await res.json()) };
    st.lastError = null;
    st.backoffUntil = 0;
  } catch (err) {
    st.backoffUntil = Date.now() + ERROR_BACKOFF_MS;
    st.lastError = err instanceof Error ? err.message : String(err);
  }
}

// ---------- the merged snapshot the route serves ----------

/**
 * Current plan usage, refetching from the usage API only when the floor and
 * backoff allow. Returns null when the feature is off or there is no
 * subscription login at all (API-key auth) — the UI hides the meter entirely.
 */
export async function getClaudePlanUsage(): Promise<PlanUsageSnapshot | null> {
  if (!PLAN_USAGE_ENABLED) return null;
  const st = state();
  const creds = readOauthCreds();
  if (!creds && !st.fetched && !st.passive) return null;

  const now = Date.now();
  const tokenLive = !!creds && (creds.expiresAt == null || creds.expiresAt > now);
  if (creds && tokenLive && now >= st.backoffUntil && now - (st.fetched?.at ?? 0) >= PLAN_USAGE_MIN_FETCH_MS) {
    // Single-flight: concurrent tabs polling at once share one request.
    if (!st.inflight) {
      st.inflight = refreshFromApi(creds).finally(() => {
        st.inflight = null;
      });
    }
    await st.inflight;
  }

  // Start from the cached fetch, then let fresher passive telemetry win: an
  // event from a running turn postdating the fetch updates its own window (the
  // only one it names), and a percentage is only ever moved by newer data.
  // A passive figure whose own reset has passed is stale by definition — the
  // window rolled over and its utilization snapped back — so it must not
  // overlay (or a healed 100% would alarm until the fetch floor allowed a
  // correction).
  const windows = (st.fetched?.windows ?? []).map((w) => ({ ...w }));
  const p = st.passive;
  const passiveCurrent = p != null && !(p.resetsAt != null && p.resetsAt <= now);
  if (p && passiveCurrent && p.at >= (st.fetched?.at ?? 0) && p.window && p.utilization != null) {
    const hit = windows.find((w) => w.id === p.window);
    if (hit) {
      hit.utilization = p.utilization;
      if (p.resetsAt != null) hit.resetsAt = p.resetsAt;
    } else {
      // No fetch has succeeded (or the endpoint doesn't list this window) —
      // the passive figure alone still beats showing nothing.
      windows.push({ id: p.window, label: WINDOW_LABELS[p.window] ?? p.window, utilization: p.utilization, resetsAt: p.resetsAt, kind: WINDOW_KINDS[p.window] ?? null });
    }
  }

  // The status trio expires with its own reset: once a rejected window's
  // resetsAt passes, the quota has healed and the flag must not linger until
  // the next turn happens to emit an event.
  const statusLive = p && !(p.resetsAt != null && p.resetsAt <= now && p.status !== "allowed");

  const stale = st.lastError != null && st.fetched != null;
  const reason = !creds
    ? "No Claude subscription login"
    : !tokenLive
      ? "Login token expired. It refreshes when the next turn runs"
      : st.lastError;

  return {
    available: windows.length > 0,
    reason: reason ?? null,
    plan: creds?.plan ?? null,
    windows,
    status: statusLive ? p.status : null,
    statusWindow: statusLive ? p.window : null,
    statusResetsAt: statusLive ? p.resetsAt : null,
    fetchedAt: st.fetched?.at ?? null,
    stale,
  };
}
