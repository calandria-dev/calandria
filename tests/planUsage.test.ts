import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getClaudePlanUsage,
  parseUsagePayload,
  recordClaudeRateLimit,
  resetPlanUsageStateForTests,
} from "@/lib/agents/claude/planUsage";

// The plan-usage snapshot behind GET /api/plan-usage: the merge policy between
// the cached OAuth usage fetch and the passive rate_limit_event telemetry, and
// the fetch discipline the aggressively rate-limited endpoint demands (floor
// between fetches, 429 backoff, never fetching without a live token).
//
// tests/setup.ts points CLAUDE_CONFIG_DIR at an empty tmp dir, so by default
// there are no credentials — each test that needs a login writes its own
// .credentials.json there.

const credsPath = () => path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json");

function writeCreds(over: Record<string, unknown> = {}) {
  fs.writeFileSync(
    credsPath(),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-token",
        expiresAt: Date.now() + 3_600_000,
        subscriptionType: "max",
        ...over,
      },
    })
  );
}

function usageResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

// A realistic /api/oauth/usage payload (shape verified against the CLI's own
// /usage panel on claude-cli 2.1.240): top-level windows carry utilization as
// PERCENT 0–100 with ISO reset stamps, plus a `limits` list whose
// weekly_scoped entries carry per-model weeks as `percent`.
const PAYLOAD = {
  five_hour: { utilization: 12, resets_at: "2026-08-23T22:00:00Z" },
  seven_day: { utilization: 37.5, resets_at: "2026-08-26T07:00:00Z" },
  seven_day_sonnet: { utilization: 4, resets_at: "2026-08-26T07:00:00Z" },
  limits: [
    // Duplicate of the top-level sonnet window — must not render twice.
    { kind: "weekly_scoped", percent: 4, resets_at: "2026-08-26T07:00:00Z", scope: { model: { display_name: "Sonnet" } } },
    { kind: "weekly_scoped", percent: 61, resets_at: "2026-08-26T07:00:00Z", scope: { model: { display_name: "Fable" } } },
    { kind: "monthly", percent: 9 }, // not weekly_scoped — ignored
    { kind: "weekly_scoped", percent: "high" }, // malformed — ignored
  ],
  extra_usage: { balance: 0 },
};

beforeEach(() => {
  resetPlanUsageStateForTests();
});

afterEach(() => {
  fs.rmSync(credsPath(), { force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseUsagePayload", () => {
  it("normalizes the known windows and scoped weekly limits, dropping junk", () => {
    const windows = parseUsagePayload(PAYLOAD);
    expect(windows.map((w) => w.id)).toEqual(["five_hour", "seven_day", "seven_day_sonnet", "weekly:fable"]);
    const session = windows[0];
    expect(session.label).toBe("Current session");
    expect(session.utilization).toBe(12);
    expect(session.resetsAt).toBe(Date.parse("2026-08-23T22:00:00Z"));
    expect(windows[3].label).toBe("Current week (Fable)");
    expect(windows[3].utilization).toBe(61);
  });

  it("clamps utilization into 0–100 and survives garbage", () => {
    expect(parseUsagePayload({ five_hour: { utilization: 250, resets_at: null } })[0].utilization).toBe(100);
    expect(parseUsagePayload(null)).toEqual([]);
    expect(parseUsagePayload({ five_hour: { utilization: "12" } })).toEqual([]);
  });
});

describe("getClaudePlanUsage", () => {
  it("returns null with no subscription login and never fetches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getClaudePlanUsage()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches once, serves the cache inside the floor, and reports plan + windows", async () => {
    writeCreds();
    const fetchMock = vi.fn().mockResolvedValue(usageResponse(PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getClaudePlanUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(opts.headers.Authorization).toBe("Bearer test-token");

    expect(first?.available).toBe(true);
    expect(first?.plan).toBe("max");
    expect(first?.windows.find((w) => w.id === "seven_day")?.utilization).toBe(37.5);
    expect(first?.stale).toBe(false);

    // Second poll lands inside PLAN_USAGE_MIN_FETCH_MS: cache only.
    const second = await getClaudePlanUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second?.windows.length).toBe(first?.windows.length);
  });

  it("does not fetch on an expired token and says why", async () => {
    writeCreds({ expiresAt: Date.now() - 1000 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const snap = await getClaudePlanUsage();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(snap?.available).toBe(false); // nothing cached yet either
    expect(snap?.reason).toMatch(/expired/i);
  });

  it("backs off after a 429 instead of hammering the endpoint", async () => {
    writeCreds();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(usageResponse({ error: "rate limited" }, { status: 429, headers: { "retry-after": "600" } }));
    vi.stubGlobal("fetch", fetchMock);

    const snap = await getClaudePlanUsage();
    expect(snap?.available).toBe(false);
    expect(snap?.reason).toMatch(/rate-limited/);

    // Poll again immediately: still inside the backoff, no second request.
    await getClaudePlanUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves stale windows when a refetch fails", async () => {
    writeCreds();
    const fetchMock = vi.fn().mockResolvedValue(usageResponse(PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    await getClaudePlanUsage();

    // Age the cache past the floor, then have the endpoint start failing.
    const st = (globalThis as { __orchClaudePlanUsage?: { fetched: { at: number } | null } }).__orchClaudePlanUsage!;
    st.fetched!.at = Date.now() - 10 * 60_000;
    fetchMock.mockResolvedValue(usageResponse({}, { status: 500 }));

    const snap = await getClaudePlanUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(snap?.available).toBe(true); // old windows still shown
    expect(snap?.stale).toBe(true);
    expect(snap?.reason).toMatch(/500/);
  });
});

describe("passive rate_limit_event overlay", () => {
  it("a warning event's utilization (a 0–1 fraction on the wire) updates its window", async () => {
    writeCreds();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(usageResponse(PAYLOAD)));
    await getClaudePlanUsage();

    recordClaudeRateLimit({
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.82,
      resetsAt: Math.floor(Date.parse("2026-08-26T07:00:00Z") / 1000),
    });
    const snap = await getClaudePlanUsage();
    const week = snap?.windows.find((w) => w.id === "seven_day");
    expect(week?.utilization).toBe(82);
    expect(snap?.status).toBe("allowed_warning");
    expect(snap?.statusWindow).toBe("seven_day");
  });

  it("a representative-only event (no utilization — the below-threshold case) sets status without touching windows", async () => {
    writeCreds();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(usageResponse(PAYLOAD)));
    await getClaudePlanUsage();

    // What a real turn emits at low usage (measured on claude-cli 2.1.240):
    // status + binding window + reset, and no percentage at all.
    recordClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", resetsAt: 1787534400 });
    const snap = await getClaudePlanUsage();
    expect(snap?.windows.find((w) => w.id === "five_hour")?.utilization).toBe(12);
    expect(snap?.status).toBe("allowed");
  });

  it("shows a passive-only window when no fetch has ever succeeded", async () => {
    // No credentials at all — but a turn ran and reported a warning.
    recordClaudeRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9, resetsAt: Date.now() / 1000 + 3600 });
    const snap = await getClaudePlanUsage();
    expect(snap?.available).toBe(true);
    expect(snap?.windows).toEqual([
      expect.objectContaining({ id: "five_hour", label: "Current session", utilization: 90 }),
    ]);
  });

  it("a rejected status expires once its reset passes", async () => {
    recordClaudeRateLimit({ status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: (Date.now() - 60_000) / 1000 });
    const snap = await getClaudePlanUsage();
    expect(snap?.status).toBeNull();
  });

  it("ignores malformed events", () => {
    recordClaudeRateLimit(null);
    recordClaudeRateLimit({ status: "banana" });
    recordClaudeRateLimit("rejected");
    expect((globalThis as { __orchClaudePlanUsage?: { passive: unknown } }).__orchClaudePlanUsage?.passive ?? null).toBeNull();
  });
});
