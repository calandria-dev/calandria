import { describe, expect, it, beforeEach, vi } from "vitest";

// Antigravity's half of the titlebar plan meter, plus the two capability facts
// the generic connect card branches on for this agent.
//
// The payload below is a real `agy -p "/usage" --output-format json` capture,
// trimmed only of prose fields the parser ignores. It is the evidence for the
// two claims the driver makes about this command: it reports REMAINING
// fraction (the snapshot wants percent SPENT), and it spends nothing doing so,
// `num_turns: 0` with an all-zero usage block, which is why polling it from
// the UI is acceptable at all.

// `promisify(execFile)` is bound at module load, so the seam has to be the
// module itself, the same `vi.mock("node:child_process")` shape the driver
// tests use for `spawn`.
const execFileMock = vi.hoisted(() => {
  const fn = vi.fn();
  // The real execFile carries a promisify hook that resolves { stdout, stderr };
  // a bare mock would resolve the first callback value instead, so the module
  // under test would destructure a string. Mirror Node's own contract.
  (fn as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = (cmd: string, args: string[], opts: unknown) =>
    new Promise((resolve, reject) => {
      fn(cmd, args, opts, (e: Error | null, stdout: string, stderr: string) => (e ? reject(e) : resolve({ stdout, stderr })));
    });
  return fn;
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

import { parseUsagePayload, getGeminiPlanUsage, resetGeminiPlanUsageForTests } from "@/lib/agents/gemini/planUsage";
import { parseJsonResult, isAuthFailure } from "@/lib/agents/gemini/auth";
import { GEMINI_CAPABILITIES } from "@/lib/agents/gemini/capabilities";
import { setAgentConnection } from "@/lib/agents/connections";
import { setSetting } from "@/lib/store";

const CAPTURE = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t99%\t2026-09-09T15:11:12Z\n",
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.9909957051277161, reset_time: "2026-09-09T15:11:12Z" },
            { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.75, reset_time: "2026-09-02T20:11:12Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-09-09T15:47:03Z" },
            { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-09-02T20:47:03Z" },
          ],
        },
      ],
    },
  },
});

describe("parseUsagePayload (Antigravity /usage)", () => {
  it("turns remaining fraction into percent spent, per group and window", () => {
    const windows = parseUsagePayload(parseJsonResult(CAPTURE));
    expect(windows.map((w) => w.id)).toEqual(["gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h"]);
    const session = windows.find((w) => w.id === "gemini-5h")!;
    expect(session.utilization).toBeCloseTo(25, 6);
    expect(session.kind).toBe("session");
    expect(session.resetsAt).toBe(Date.parse("2026-09-02T20:11:12Z"));
    expect(windows.find((w) => w.id === "gemini-weekly")!.utilization).toBeCloseTo(0.9004, 3);
  });

  it("keeps BOTH model groups, since an Antigravity task can spend either", () => {
    const windows = parseUsagePayload(parseJsonResult(CAPTURE));
    // The labels mirror Claude's so one popover reads as one feature, and the
    // group name is what tells the two 5-hour rows apart.
    expect(windows.map((w) => w.label)).toEqual([
      "Current week (Gemini Models)",
      "Current session (Gemini Models)",
      "Current week (Claude and GPT models)",
      "Current session (Claude and GPT models)",
    ]);
    expect(windows.filter((w) => w.kind === "week")).toHaveLength(2);
  });

  it("is empty rather than wrong on anything that isn't this payload", () => {
    expect(parseUsagePayload(null)).toEqual([]);
    expect(parseUsagePayload({ command: { data: {} } })).toEqual([]);
    // A bucket with no fraction is skipped; its siblings still land.
    expect(
      parseUsagePayload({ command: { data: { groups: [{ name: "G", buckets: [{ id: "a" }, { id: "b", window: "5h", remaining_fraction: 0.5 }] }] } } }),
    ).toHaveLength(1);
  });
});

describe("getGeminiPlanUsage (the cached read GET /api/plan-usage serves)", () => {
  beforeEach(() => {
    resetGeminiPlanUsageForTests();
    execFileMock.mockReset();
    setAgentConnection("gemini", { method: "subscription", email: null, plan: null });
  });

  /** `promisify` calls back with (err, stdout, stderr). */
  const answers = (impl: (cb: (e: Error | null, out: string, err: string) => void) => void) =>
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      impl(cb);
      return {};
    });

  it("never spawns for an agent this instance hasn't connected", async () => {
    setSetting("agent_conn_gemini", null);
    answers((cb) => cb(null, CAPTURE, ""));
    expect(await getGeminiPlanUsage()).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns null until something has been read, so the meter simply doesn't render", async () => {
    answers((cb) => cb(Object.assign(new Error("agy: not found"), { stdout: "", stderr: "" }), "", ""));
    expect(await getGeminiPlanUsage()).toBeNull();
  });

  it("serves the parsed windows and spawns the CLI once for concurrent readers", async () => {
    answers((cb) => setTimeout(() => cb(null, CAPTURE, ""), 0));

    const [a, b] = await Promise.all([getGeminiPlanUsage(), getGeminiPlanUsage()]);
    expect(execFileMock).toHaveBeenCalledTimes(1); // several tabs must not spawn several CLIs
    expect(execFileMock.mock.calls[0][1]).toEqual(["-p", "/usage", "--output-format", "json"]);
    expect(a?.available).toBe(true);
    expect(a?.windows).toHaveLength(4);
    expect(b?.windows).toHaveLength(4);
    // No passive telemetry exists on this agent's turn stream.
    expect(a?.status).toBeNull();
    expect(a?.stale).toBe(false);

    // Inside the fetch floor, a third read is served from cache.
    await getGeminiPlanUsage();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("what the connect card needs from this driver", () => {
  it("declares the two facts the generic card branches on", () => {
    // Google's callback page can finish the login without the code box, so the
    // card polls authStatus alongside its login poll.
    expect(GEMINI_CAPABILITIES.loginCompletesOutOfBand).toBe(true);
    // And the container caveat is stated on the card, not only in the docs.
    expect(GEMINI_CAPABILITIES.connectHint).toMatch(/keyring/i);
    expect(GEMINI_CAPABILITIES.connectHint).toMatch(/GEMINI_API_KEY/);
    expect(GEMINI_CAPABILITIES.loginStyle).toBe("paste_code");
  });

  it("recognizes the failure the CLI prints without exiting", () => {
    // Exact wording the CLI prints; the login flips to `error` on it so the
    // card offers Start again instead of a paste box that can never work.
    expect(isAuthFailure("Error: authentication failed or timed out")).toBe(true);
    expect(isAuthFailure("Error: authentication timed out")).toBe(true);
    expect(isAuthFailure("Paste the authorization code here:")).toBe(false);
  });
});
