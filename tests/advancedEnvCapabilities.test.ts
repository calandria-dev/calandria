// lib/advanced-env/capabilities.ts: the task+turn capability token an
// internal mutation endpoint matches (task 9) alongside the per-instance
// service token, and the dedicated one-use decision waiter a mandatory
// permission prompt parks on instead of the generic ask registry.
//
// Synthetic tokens/ids throughout; nothing here is a real credential.

import { describe, expect, it } from "vitest";
import {
  hasMandatoryDecision,
  mintTurnCapability,
  revokeTurnCapability,
  submitMandatoryDecision,
  TURN_CAPABILITY_HEADER,
  verifyTurnCapability,
} from "@/lib/advanced-env/capabilities";
import { submitAnswer } from "@/lib/asks";

describe("turn capability tokens", () => {
  it("mints an unpredictable token that verifies back to its task and project", () => {
    const token = mintTurnCapability("task-1", "proj-1");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyTurnCapability(token)).toEqual({ taskId: "task-1", projectId: "proj-1" });
  });

  it("mints a different token per call, even for the same task", () => {
    const a = mintTurnCapability("task-2", "proj-1");
    const b = mintTurnCapability("task-2", "proj-1");
    expect(a).not.toBe(b);
  });

  it("rejects a spoofed or unminted token", () => {
    expect(verifyTurnCapability("not-a-real-token")).toBeNull();
    // Right shape, wrong value: a guesser can't brute-force plausible hex.
    expect(verifyTurnCapability("0".repeat(64))).toBeNull();
  });

  it("revokes cleanly, and a revoked token never verifies again", () => {
    const token = mintTurnCapability("task-3", "proj-1");
    expect(verifyTurnCapability(token)).not.toBeNull();
    revokeTurnCapability("task-3", token);
    expect(verifyTurnCapability(token)).toBeNull();
  });

  it("revoke is identity-checked: a stale token can't revoke a successor's live one", () => {
    const first = mintTurnCapability("task-4", "proj-1");
    const second = mintTurnCapability("task-4", "proj-1"); // supersedes `first`
    // The first turn's finally runs late and tries to revoke its own token.
    revokeTurnCapability("task-4", first);
    // The successor's capability, minted for the SAME task id, must survive.
    expect(verifyTurnCapability(second)).toEqual({ taskId: "task-4", projectId: "proj-1" });
  });

  it("minting a fresh token invalidates the prior one immediately, without an explicit revoke", () => {
    // Covers cross-turn use directly: turn A's token must stop working the
    // instant turn B (same task, later turn) mints its own, even if A's own
    // revoke call never runs (a crash before the finally, for instance).
    const stale = mintTurnCapability("task-5", "proj-1");
    expect(verifyTurnCapability(stale)).not.toBeNull();
    mintTurnCapability("task-5", "proj-1");
    expect(verifyTurnCapability(stale)).toBeNull();
  });

  it("scopes a token to the task it was minted for, not any task sharing a project", () => {
    const token = mintTurnCapability("task-6", "proj-shared");
    mintTurnCapability("task-7", "proj-shared");
    // task-7's mint must not disturb task-6's still-live token.
    expect(verifyTurnCapability(token)).toEqual({ taskId: "task-6", projectId: "proj-shared" });
  });

  it("exposes a stable header name for the bridge to carry the token on", () => {
    expect(TURN_CAPABILITY_HEADER).toBe("x-calandria-turn-capability");
  });
});

describe("the mandatory decision waiter", () => {
  it("resolves park() with exactly what submitMandatoryDecision sends", async () => {
    const { mandatoryDecisionWaiter } = await import("@/lib/advanced-env/capabilities");
    const p = mandatoryDecisionWaiter.park("task-8", "prop:1");
    expect(submitMandatoryDecision("task-8", "prop:1", "allow_once")).toBe(true);
    await expect(p).resolves.toEqual([["allow_once", ""]]);
  });

  it("carries an optional note through", async () => {
    const { mandatoryDecisionWaiter } = await import("@/lib/advanced-env/capabilities");
    const p = mandatoryDecisionWaiter.park("task-9", "prop:1");
    expect(submitMandatoryDecision("task-9", "prop:1", "deny", "not today")).toBe(true);
    await expect(p).resolves.toEqual([["deny", "not today"]]);
  });

  it("reports false when nothing is parked under that id", () => {
    expect(submitMandatoryDecision("task-10", "prop:missing", "allow_once")).toBe(false);
  });

  it("is a separate registry from the generic ask registry: /answer's submitAnswer can never settle it", async () => {
    const { mandatoryDecisionWaiter } = await import("@/lib/advanced-env/capabilities");
    const p = mandatoryDecisionWaiter.park("task-11", "prop:1");
    expect(hasMandatoryDecision("task-11", "prop:1")).toBe(true);
    // The generic path a POST /api/tasks/[id]/answer resolves through.
    expect(submitAnswer("task-11", "prop:1", [["allow_once"]])).toBe(false);
    // Still parked: the generic call above did nothing to it.
    expect(hasMandatoryDecision("task-11", "prop:1")).toBe(true);
    expect(submitMandatoryDecision("task-11", "prop:1", "deny")).toBe(true);
    await expect(p).resolves.toEqual([["deny", ""]]);
  });

  it("cancel() rejects the parked promise and clears the registry entry", async () => {
    const { mandatoryDecisionWaiter } = await import("@/lib/advanced-env/capabilities");
    const p = mandatoryDecisionWaiter.park("task-12", "prop:1");
    expect(mandatoryDecisionWaiter.cancel("task-12", "prop:1", "expired")).toBe(true);
    await expect(p).rejects.toThrow("expired");
    expect(hasMandatoryDecision("task-12", "prop:1")).toBe(false);
    // Cancelling again finds nothing parked.
    expect(mandatoryDecisionWaiter.cancel("task-12", "prop:1", "expired")).toBe(false);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { mandatoryDecisionWaiter } = await import("@/lib/advanced-env/capabilities");
    const ac = new AbortController();
    ac.abort();
    await expect(mandatoryDecisionWaiter.park("task-13", "prop:1", ac.signal)).rejects.toThrow("aborted");
  });

  it("aborting the signal after parking rejects and clears the entry", async () => {
    const { mandatoryDecisionWaiter } = await import("@/lib/advanced-env/capabilities");
    const ac = new AbortController();
    const p = mandatoryDecisionWaiter.park("task-14", "prop:1", ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
    expect(hasMandatoryDecision("task-14", "prop:1")).toBe(false);
  });
});
