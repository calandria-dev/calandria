import { describe, expect, it, beforeEach } from "vitest";
import {
  SCHEDULED_RUN_CONTEXT, clearRunContext, getRunContext, interactionDenied, setRunContext,
} from "@/lib/runContext";
import { waitForPermission } from "@/lib/permissions";

describe("run context", () => {
  beforeEach(() => clearRunContext("t1"));

  it("remembers a scheduled turn's context for the life of the turn", () => {
    const ctx = { ...SCHEDULED_RUN_CONTEXT, scheduleRunId: "run-1" };
    setRunContext("t1", ctx);
    expect(getRunContext("t1")?.origin).toBe("schedule");
    expect(getRunContext("t1")?.scheduleRunId).toBe("run-1");
    expect(interactionDenied("t1")).toBe(true);
  });

  it("defaults to interactive for an ordinary turn", () => {
    expect(getRunContext("t-unknown")).toBeUndefined();
    expect(interactionDenied("t-unknown")).toBe(false);
  });

  it("only the owning context may clear it, so a later turn's entry survives", () => {
    const first = { ...SCHEDULED_RUN_CONTEXT };
    const second = { ...SCHEDULED_RUN_CONTEXT };
    setRunContext("t1", first);
    setRunContext("t1", second);
    clearRunContext("t1", first); // the stale turn settling late
    expect(getRunContext("t1")).toBe(second);
    clearRunContext("t1", second);
    expect(getRunContext("t1")).toBeUndefined();
  });

  it("denies a permission request immediately for a scheduled turn, however many tabs are open", async () => {
    setRunContext("t1", SCHEDULED_RUN_CONTEXT);
    const started = Date.now();
    // A generous attended cap that a watched turn WOULD park on.
    const result = await waitForPermission({
      taskId: "t1", id: "ask-1", attendedMs: 60_000, unattendedMs: 45_000,
    });
    expect(result).toEqual({ expired: "unattended" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
