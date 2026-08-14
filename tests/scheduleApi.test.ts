import { describe, expect, it, beforeEach } from "vitest";
import { createProject } from "@/lib/store";
import { getSchedule, listSchedules } from "@/lib/schedule/store";
import { GET as listSchedulesRoute, POST as createRoute } from "@/app/api/projects/[id]/schedules/route";
import { DELETE as deleteRoute, PATCH as patchRoute } from "@/app/api/schedules/[id]/route";

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (url: string, body: unknown) =>
  new Request(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("schedules API", () => {
  let pid = "";
  beforeEach(() => { pid = createProject({ name: `api-${Math.random().toString(36).slice(2)}` }).id; });

  const body = {
    name: "Jira triage", prompt: "/jira-tasks", days_mask: 62,
    time_of_day: "08:30", timezone: "America/Los_Angeles",
  };

  it("creates a schedule and lists it", async () => {
    const created = await createRoute(post("http://x/api", body), { params: Promise.resolve({ id: pid }) });
    expect(created.status).toBe(201);
    const listed = await listSchedulesRoute(new Request("http://x/api"), { params: Promise.resolve({ id: pid }) });
    const json = await listed.json();
    expect(json.schedules).toHaveLength(1);
    expect(json.schedules[0].name).toBe("Jira triage");
    expect(json.scheduler).toBeDefined();
  });

  it("rejects an unusable spec at creation rather than never firing", async () => {
    const res = await createRoute(
      post("http://x/api", { ...body, timezone: "Mars/Olympus" }),
      { params: Promise.resolve({ id: pid }) }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/timezone/);
    expect(listSchedules(pid)).toHaveLength(0);
  });

  it("pauses and resumes", async () => {
    const created = await (await createRoute(post("http://x/api", body), { params: Promise.resolve({ id: pid }) })).json();
    await patchRoute(patch("http://x/api", { enabled: false }), { params: Promise.resolve({ id: created.id }) });
    expect(getSchedule(created.id)!.enabled).toBe(0);
    await patchRoute(patch("http://x/api", { enabled: true }), { params: Promise.resolve({ id: created.id }) });
    const resumed = getSchedule(created.id)!;
    expect(resumed.enabled).toBe(1);
    expect(resumed.next_fire_at).toBeGreaterThan(Date.now());
  });

  it("deletes", async () => {
    const created = await (await createRoute(post("http://x/api", body), { params: Promise.resolve({ id: pid }) })).json();
    await deleteRoute(new Request("http://x/api", { method: "DELETE" }), { params: Promise.resolve({ id: created.id }) });
    expect(getSchedule(created.id)).toBeNull();
  });
});
