import { describe, expect, it, beforeEach, vi } from "vitest";

// The run-now route reaches lib/scheduler → lib/runner + lib/schedule/commands.
// Mocked the same way tests/scheduler.test.ts drives the ticker: startTurn is
// stubbed so no CLI is spawned, and validatePrompt is a controllable stub so
// the validate route's registered/unregistered branches are reachable offline.
const started: { taskId: string; text: string }[] = [];
vi.mock("@/lib/runner", () => ({
  startTurn: (task: { id: string }, _p: unknown, userText: string) => {
    started.push({ taskId: task.id, text: userText });
  },
}));

let promptCheck: { ok: boolean; error?: string; suggestions?: string[] } = { ok: true };
vi.mock("@/lib/schedule/commands", () => ({
  validatePrompt: async () => promptCheck,
}));

import { createProject } from "@/lib/store";
import { getSchedule, listSchedules } from "@/lib/schedule/store";
import { setAgentConnection } from "@/lib/agents/connections";
import { GET as listSchedulesRoute, POST as createRoute } from "@/app/api/projects/[id]/schedules/route";
import { DELETE as deleteRoute, PATCH as patchRoute } from "@/app/api/schedules/[id]/route";
import { POST as runRoute } from "@/app/api/schedules/[id]/run/route";
import { POST as validateRoute } from "@/app/api/schedules/validate/route";
import { makeRepo } from "./helpers";

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

  it("rejects a non-string name or prompt with a 400, not a 500", async () => {
    // Optional chaining (`body?.name?.trim()`) only guards nullish values. A
    // number sails past it into `.trim()`, which throws outside any try/catch.
    const badName = await createRoute(post("http://x/api", { ...body, name: 42 }), { params: Promise.resolve({ id: pid }) });
    expect(badName.status).toBe(400);
    expect((await badName.json()).error).toMatch(/name/);

    const badPrompt = await createRoute(post("http://x/api", { ...body, prompt: 42 }), { params: Promise.resolve({ id: pid }) });
    expect(badPrompt.status).toBe(400);
    expect((await badPrompt.json()).error).toMatch(/prompt/);

    expect(listSchedules(pid)).toHaveLength(0);
  });

  it("rejects an out-of-range priority at creation, and leaves it out entirely otherwise", async () => {
    const bad = await createRoute(post("http://x/api", { ...body, priority: "urgent" }), { params: Promise.resolve({ id: pid }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/priority/);
    expect(listSchedules(pid)).toHaveLength(0);

    const ok = await createRoute(post("http://x/api", { ...body, priority: "hi" }), { params: Promise.resolve({ id: pid }) });
    expect(ok.status).toBe(201);
    expect((await ok.json()).priority).toBe("hi");
  });

  it("rejects an out-of-range priority on PATCH, WITHOUT committing it", async () => {
    const created = await (await createRoute(post("http://x/api", body), { params: Promise.resolve({ id: pid }) })).json();
    const before = getSchedule(created.id)!;
    const bad = await patchRoute(patch("http://x/api", { priority: "urgent" }), { params: Promise.resolve({ id: created.id }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/priority/);
    expect(getSchedule(created.id)).toEqual(before);
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

  it("rejects a PATCH that would make the spec unusable, WITHOUT committing it", async () => {
    // A PATCH that fails validation must not commit the bad value or leave
    // next_fire_at stale, so this asserts the row is byte-for-byte unchanged,
    // not just that the response was a 400.
    const created = await (await createRoute(post("http://x/api", body), { params: Promise.resolve({ id: pid }) })).json();
    const before = getSchedule(created.id)!;

    const badTz = await patchRoute(patch("http://x/api", { timezone: "Mars/Olympus" }), { params: Promise.resolve({ id: created.id }) });
    expect(badTz.status).toBe(400);
    expect((await badTz.json()).error).toMatch(/timezone/);
    expect(getSchedule(created.id)).toEqual(before);

    const badMask = await patchRoute(patch("http://x/api", { days_mask: 0 }), { params: Promise.resolve({ id: created.id }) });
    expect(badMask.status).toBe(400);
    expect((await badMask.json()).error).toMatch(/days_mask/);
    expect(getSchedule(created.id)).toEqual(before);
  });

  it("deletes", async () => {
    const created = await (await createRoute(post("http://x/api", body), { params: Promise.resolve({ id: pid }) })).json();
    await deleteRoute(new Request("http://x/api", { method: "DELETE" }), { params: Promise.resolve({ id: created.id }) });
    expect(getSchedule(created.id)).toBeNull();
  });
});

describe("schedules API — run now", () => {
  let pid = "";
  let scheduleId = "";

  beforeEach(async () => {
    started.length = 0;
    promptCheck = { ok: true };
    // fireSchedule's preflight checks this schedule's agent is connected and
    // never falls back. Mirrors tests/scheduler.test.ts's setup.
    setAgentConnection("claude", { method: "subscription", email: null, plan: null });
    const repo = await makeRepo();
    pid = createProject({ name: `api-run-${Math.random().toString(36).slice(2)}`, repo_path: repo }).id;
    const created = await (
      await createRoute(
        post("http://x/api", {
          name: "Jira triage", prompt: "/jira-tasks", days_mask: 62,
          time_of_day: "08:30", timezone: "America/Los_Angeles",
        }),
        { params: Promise.resolve({ id: pid }) }
      )
    ).json();
    scheduleId = created.id;
  });

  it("404s for a schedule that doesn't exist", async () => {
    const res = await runRoute(new Request("http://x/api", { method: "POST" }), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("fires immediately without moving next_fire_at", async () => {
    const before = getSchedule(scheduleId)!.next_fire_at;
    const res = await runRoute(new Request("http://x/api", { method: "POST" }), { params: Promise.resolve({ id: scheduleId }) });
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run.trigger).toBe("manual");
    expect(started).toHaveLength(1);
    // "Run now" fires out of band and leaves the regularly scheduled
    // occurrence exactly where it was.
    expect(getSchedule(scheduleId)!.next_fire_at).toBe(before);
  });

  it("409s when two runs claim the identical scheduled_for millisecond", async () => {
    // runScheduleNow does not consult activeRun/hasTurn. It relies solely on
    // the UNIQUE(schedule_id, scheduled_for) claim, keyed on Date.now(), so the
    // 409 in practice only fires on an exact-millisecond collision; it does not
    // detect a run that is genuinely still in flight (a manual run started
    // while a ticked run is mid-turn is not blocked by this path). Freezing
    // Date.now() makes that collision reproducible in a test.
    const fixed = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(fixed);
    try {
      const first = await runRoute(new Request("http://x/api", { method: "POST" }), { params: Promise.resolve({ id: scheduleId }) });
      expect(first.status).toBe(201);
      const second = await runRoute(new Request("http://x/api", { method: "POST" }), { params: Promise.resolve({ id: scheduleId }) });
      expect(second.status).toBe(409);
      expect((await second.json()).error).toMatch(/already starting/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("schedules API — validate", () => {
  let pid = "";
  beforeEach(() => { pid = createProject({ name: `api-validate-${Math.random().toString(36).slice(2)}` }).id; });

  it("400s without a resolvable project_id", async () => {
    const res = await validateRoute(post("http://x/api", { project_id: "no-such-project", prompt: "/jira-tasks" }));
    expect(res.status).toBe(400);
  });

  it("passes through an ok result for a registered command", async () => {
    promptCheck = { ok: true };
    const res = await validateRoute(post("http://x/api", { project_id: pid, prompt: "/jira-tasks" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("passes through the not-ok shape, with suggestions, for an unregistered command", async () => {
    promptCheck = { ok: false, error: "/jira-task is not a command this project's sessions have.", suggestions: ["jira-tasks"] };
    const res = await validateRoute(post("http://x/api", { project_id: pid, prompt: "/jira-task" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.suggestions).toEqual(["jira-tasks"]);
  });
});
