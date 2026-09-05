import { describe, it, expect } from "vitest";
import { PATCH as patchSettings } from "@/app/api/settings/route";

// Which titlebar usage trackers are shown is a per-agent preference
// ("plan_usage:<agent>", Settings -> Agents). It rides /api/settings, not
// browser storage, so the choice follows the instance to every device, and
// the client reads it as shown-unless-"off", so the write that HIDES a
// tracker is a value and the one that shows it again is a clear.
describe("PATCH /api/settings — the plan-usage key", () => {
  const patch = async (body: Record<string, string | null>) =>
    (await (await patchSettings(new Request("http://test/api/settings", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }))).json()) as Record<string, string>;

  it("stores and clears an agent-scoped key for any agent id", async () => {
    expect((await patch({ "plan_usage:claude": "off" }))["plan_usage:claude"]).toBe("off");
    expect((await patch({ "plan_usage:codex": "off" }))["plan_usage:codex"]).toBe("off");
    // Showing it again clears the row instead of storing "on": absent is the
    // default every instance that never opened the setting already has.
    expect((await patch({ "plan_usage:claude": null }))["plan_usage:claude"]).toBeUndefined();
    expect((await patch({}))["plan_usage:codex"]).toBe("off");
  });

  it("refuses an un-scoped plan_usage, which no surface would read", async () => {
    expect((await patch({ plan_usage: "off" })).plan_usage).toBeUndefined();
  });
});
