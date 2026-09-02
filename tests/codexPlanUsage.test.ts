import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Codex half of GET /api/plan-usage: the app-server response → windows
// mapping, and the fetch discipline that keeps a `codex app-server` spawn from
// happening at the poll rate (floor between reads, backoff after a failure,
// never spawning without a ChatGPT login to ask about).
//
// The RPC itself lives in lib/agents/codex/appServer.ts precisely so it can be
// stubbed here — the alternative is spawning a real CLI, which a hermetic suite
// can't have. Its handshake is documented (and was verified live) there.

const readAccountRateLimits = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/codex/appServer", () => ({ readAccountRateLimits }));

const { getCodexPlanUsage, parseRateLimits, resetCodexPlanUsageStateForTests } = await import("@/lib/agents/codex/planUsage");

// A realistic account/rateLimits/read result. Field names and casing come from
// the CLI's own `codex app-server generate-json-schema` output for
// GetAccountRateLimitsResponse (codex-cli 0.146.0): camelCase, windows named by
// rank, `resetsAt` a Unix timestamp in SECONDS.
const RESETS_PRIMARY = Math.floor(Date.parse("2026-09-02T21:00:00Z") / 1000);
const RESETS_SECONDARY = Math.floor(Date.parse("2026-09-08T07:00:00Z") / 1000);
const RESULT = {
  rateLimits: {
    planType: "pro",
    primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: RESETS_PRIMARY },
    secondary: { usedPercent: 46, windowDurationMins: 10080, resetsAt: RESETS_SECONDARY },
    rateLimitReachedType: null,
    spendControlReached: false,
  },
};

// tests/setup.ts gives each run its own tmp HOME-ish dirs, but CODEX_HOME is
// this module's own concern — point it at a scratch dir so the developer's real
// ~/.codex login can't make these tests pass or fail.
let codexHome: string;
const authPath = () => path.join(codexHome, "auth.json");

function writeLogin(body: unknown = { OPENAI_API_KEY: null, tokens: { access_token: "t", account_id: "a" } }) {
  fs.writeFileSync(authPath(), JSON.stringify(body));
}

beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  process.env.CODEX_HOME = codexHome;
  delete process.env.OPENAI_API_KEY;
  resetCodexPlanUsageStateForTests();
  readAccountRateLimits.mockReset();
});

afterEach(() => {
  fs.rmSync(codexHome, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
  vi.restoreAllMocks();
});

describe("parseRateLimits", () => {
  it("maps primary/secondary into session and week rows", () => {
    const parsed = parseRateLimits(RESULT)!;
    expect(parsed.plan).toBe("pro");
    expect(parsed.reached).toBe(false);
    expect(parsed.windows).toEqual([
      { id: "primary", label: "Current session (5h)", utilization: 18, resetsAt: RESETS_PRIMARY * 1000 },
      // A 7-day secondary is just "the week" — no redundant (7d) suffix.
      { id: "secondary", label: "Current week", utilization: 46, resetsAt: RESETS_SECONDARY * 1000 },
    ]);
  });

  it("accepts a bare snapshot as well as the rateLimits wrapper", () => {
    const parsed = parseRateLimits(RESULT.rateLimits)!;
    expect(parsed.windows.map((w) => w.id)).toEqual(["primary", "secondary"]);
  });

  it("labels an unreported or unusual window duration without inventing one", () => {
    const parsed = parseRateLimits({
      rateLimits: {
        primary: { usedPercent: 5 },
        secondary: { usedPercent: 9, windowDurationMins: 43_200 },
      },
    })!;
    expect(parsed.windows.map((w) => w.label)).toEqual(["Current session", "Current week (30d)"]);
  });

  it("clamps utilization, drops windows with no number, and survives garbage", () => {
    const parsed = parseRateLimits({
      rateLimits: { planType: "unknown", primary: { usedPercent: 140 }, secondary: { usedPercent: "lots" } },
    })!;
    expect(parsed.windows).toHaveLength(1);
    expect(parsed.windows[0].utilization).toBe(100);
    // "unknown" is the schema's placeholder, not a plan name to print.
    expect(parsed.plan).toBeNull();
    expect(parseRateLimits(null)).toBeNull();
    expect(parseRateLimits("nope")).toBeNull();
  });

  it("reports a reached limit from either the rate-limit or spend-control flag", () => {
    expect(parseRateLimits({ rateLimits: { ...RESULT.rateLimits, rateLimitReachedType: "rate_limit_reached" } })!.reached).toBe(true);
    expect(parseRateLimits({ rateLimits: { ...RESULT.rateLimits, spendControlReached: true } })!.reached).toBe(true);
  });
});

describe("getCodexPlanUsage", () => {
  it("returns null with no ChatGPT login and never spawns an app-server", async () => {
    expect(await getCodexPlanUsage()).toBeNull();
    expect(readAccountRateLimits).not.toHaveBeenCalled();
  });

  it("returns null under API-key billing, which has no plan to meter", async () => {
    writeLogin();
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      expect(await getCodexPlanUsage()).toBeNull();
      expect(readAccountRateLimits).not.toHaveBeenCalled();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("reads once, then serves the cache inside the fetch floor", async () => {
    writeLogin();
    readAccountRateLimits.mockResolvedValue({ data: RESULT });

    const first = (await getCodexPlanUsage())!;
    expect(first.available).toBe(true);
    expect(first.plan).toBe("pro");
    expect(first.windows.map((w) => w.utilization)).toEqual([18, 46]);
    expect(first.stale).toBe(false);
    expect(first.reason).toBeNull();
    expect(first.fetchedAt).toBeGreaterThan(0);

    const second = (await getCodexPlanUsage())!;
    expect(second.windows).toEqual(first.windows);
    expect(readAccountRateLimits).toHaveBeenCalledTimes(1);
  });

  it("shares one app-server between concurrent pollers", async () => {
    writeLogin();
    readAccountRateLimits.mockResolvedValue({ data: RESULT });
    const [a, b] = await Promise.all([getCodexPlanUsage(), getCodexPlanUsage()]);
    expect(readAccountRateLimits).toHaveBeenCalledTimes(1);
    expect(a!.windows).toEqual(b!.windows);
  });

  it("surfaces the not-logged-in RPC error rather than an empty meter", async () => {
    writeLogin();
    readAccountRateLimits.mockResolvedValue({ error: "codex account authentication required to read rate limits" });
    const snap = (await getCodexPlanUsage())!;
    expect(snap.available).toBe(false);
    expect(snap.reason).toMatch(/authentication required/);
    expect(snap.windows).toEqual([]);
  });

  it("backs off after a failed read instead of respawning at the poll rate", async () => {
    writeLogin();
    readAccountRateLimits.mockResolvedValue({ error: "codex app-server exited without answering" });
    await getCodexPlanUsage();
    await getCodexPlanUsage();
    expect(readAccountRateLimits).toHaveBeenCalledTimes(1);
  });

  it("serves stale windows when a later read fails", async () => {
    writeLogin();
    readAccountRateLimits.mockResolvedValueOnce({ data: RESULT });
    const fresh = (await getCodexPlanUsage())!;
    expect(fresh.stale).toBe(false);

    // Past the floor, so the next call really does try again — and fails.
    vi.spyOn(Date, "now").mockReturnValue(fresh.fetchedAt! + 10 * 60_000);
    readAccountRateLimits.mockResolvedValueOnce({ error: "boom" });
    const stale = (await getCodexPlanUsage())!;
    expect(readAccountRateLimits).toHaveBeenCalledTimes(2);
    expect(stale.available).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe("boom");
    expect(stale.windows.map((w) => w.utilization)).toEqual([18, 46]);
  });

  it("names the fullest window as the binding one when a limit is reached", async () => {
    writeLogin();
    readAccountRateLimits.mockResolvedValue({
      data: {
        rateLimits: {
          ...RESULT.rateLimits,
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESETS_PRIMARY },
          rateLimitReachedType: "rate_limit_reached",
        },
      },
    });
    const snap = (await getCodexPlanUsage())!;
    expect(snap.status).toBe("rejected");
    expect(snap.statusWindow).toBe("primary");
    expect(snap.statusResetsAt).toBe(RESETS_PRIMARY * 1000);
  });

  it("treats an unrecognized auth.json as maybe-logged-in and lets the RPC decide", async () => {
    writeLogin({ something: "new" });
    readAccountRateLimits.mockResolvedValue({ data: RESULT });
    expect((await getCodexPlanUsage())!.available).toBe(true);
  });

  it("treats an auth.json with no tokens as no login", async () => {
    writeLogin({ OPENAI_API_KEY: null, tokens: null });
    expect(await getCodexPlanUsage()).toBeNull();
    expect(readAccountRateLimits).not.toHaveBeenCalled();
  });
});
