// Pins "start at the usage-window reset": tasks.start_at and the sweep that
// honors it (lib/deferredStart.ts). Pinned at the runner boundary, like
// tests/autoStart: this module's job is deciding what to launch when a
// deadline passes and handing the runner a correctly prepared launch; the turn
// itself is the driver-contract test's problem.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runner", () => ({ startTurn: vi.fn(), startResumeTurn: vi.fn(), publishTurnError: vi.fn() }));

import { startTurn, startResumeTurn, publishTurnError } from "@/lib/runner";
import {
  createProject,
  createTask,
  getTask,
  listMessages,
  listPendingMessages,
  addPendingMessage,
  setSetting,
  setTaskDeps,
  updateTask,
  listDueDeferredStarts,
} from "@/lib/store";
import { resetNotificationDedupe } from "@/lib/notifications/notify";
import type { NotificationPayload } from "@/lib/notifications/types";
import {
  sweepDeferredStarts,
  stopDeferredStartTicker,
  DEFERRED_START_NOTE,
  DEFERRED_RESUME_NOTE,
  DEFERRED_RESUME_PROMPT,
} from "@/lib/deferredStart";
import { claimTurn, hasTurn, unregisterTurn } from "@/lib/abort";
import { INITIAL_TASK_PROMPT } from "@/lib/agents/shared";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import { tmpDir } from "./helpers";

const startTurnMock = vi.mocked(startTurn);
const startResumeTurnMock = vi.mocked(startResumeTurn);
const publishTurnErrorMock = vi.mocked(publishTurnError);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

// A plain (non-git) working dir: ensureWorktree falls back to repo_path, which
// keeps real git out of these tests (same trick as tests/autoStart.test.ts).
const makeProject = (repo_path = tmpDir("deferred-")) => createProject({ name: "Deferred", repo_path });

function queued(patch: Parameters<typeof updateTask>[1] = {}, at = Date.now() - 1_000) {
  const project = makeProject();
  const task = createTask({ project_id: project.id, title: "Q", description: "queued work" });
  updateTask(task.id, { start_at: at, ...patch });
  return { project, task: getTask(task.id)! };
}

const systemLines = (id: string) => listMessages(id).filter((m) => m.role === "system").map((m) => m.content);

async function busEventsFor(taskId: string, fn: () => Promise<unknown>): Promise<BusEvent[]> {
  const seen: BusEvent[] = [];
  const unsub = subscribeGlobal((tid, ev) => { if (tid === taskId) seen.push(ev); });
  try { await fn(); } finally { unsub(); }
  return seen;
}

const notificationsIn = (events: BusEvent[]): NotificationPayload[] =>
  events.flatMap((e) => (e.type === "notification" ? [e.payload] : []));

beforeEach(() => {
  startTurnMock.mockReset();
  startResumeTurnMock.mockReset();
  publishTurnErrorMock.mockReset();
  resetNotificationDedupe();
});

// The PATCH route lazily starts the real ticker when a deadline is set; don't
// leave it sweeping (unref'd, but still) behind this file.
afterAll(() => stopDeferredStartTicker());

describe("listDueDeferredStarts (selection rules)", () => {
  it("selects only deadlines that have passed, oldest first", () => {
    const now = Date.now();
    const project = makeProject();
    const later = createTask({ project_id: project.id, title: "later" });
    const earlier = createTask({ project_id: project.id, title: "earlier" });
    const future = createTask({ project_id: project.id, title: "future" });
    const never = createTask({ project_id: project.id, title: "never" });
    updateTask(later.id, { start_at: now - 1_000 });
    updateTask(earlier.id, { start_at: now - 5_000 });
    updateTask(future.id, { start_at: now + 60_000 });
    // Filtered to this test's rows: the file shares one DB, and the sweep
    // tests below leave due rows of their own.
    const mine = new Set([later.id, earlier.id, future.id, never.id]);
    const due = listDueDeferredStarts(now).map((t) => t.id).filter((id) => mine.has(id));
    expect(due).toEqual([earlier.id, later.id]);
    // Cleaned up so the sweep tests don't launch these.
    for (const id of mine) updateTask(id, { start_at: 0 });
  });

  it("skips tray suggestions and finished tasks, but not on_hold ones (the user queued it)", () => {
    const now = Date.now();
    const project = makeProject();
    const mk = (title: string, patch: Parameters<typeof updateTask>[1]) => {
      const t = createTask({ project_id: project.id, title });
      updateTask(t.id, { start_at: now - 1_000, ...patch });
      return t.id;
    };
    const suggestion = mk("still a suggestion", { suggested: 1 });
    const done = mk("finished", { status: "done" });
    const cancelled = mk("abandoned", { status: "cancelled" });
    const held = mk("parked", { status: "on_hold" });
    const due = listDueDeferredStarts(now).map((t) => t.id);
    expect(due).toContain(held);
    for (const id of [suggestion, done, cancelled]) expect(due).not.toContain(id);
    for (const id of [suggestion, done, cancelled, held]) updateTask(id, { start_at: 0 });
  });
});

describe("sweepDeferredStarts, a never-started task", () => {
  it("launches its first turn like Start session would, then consumes the deadline", async () => {
    const { task } = queued();
    const events = await busEventsFor(task.id, () => sweepDeferredStarts());

    const calls = startTurnMock.mock.calls.filter((c) => c[0].id === task.id);
    expect(calls).toHaveLength(1);
    const [launched, project, userText, note, controller] = calls[0];
    expect(launched.id).toBe(task.id);
    expect(project.id).toBe(task.project_id);
    // Same generic opener the POST route sends: the brief travels in the
    // injected project context, never in the prompt.
    expect(userText).toBe(INITIAL_TASK_PROMPT);
    expect(note).toBe(DEFERRED_START_NOTE);
    expect(controller).toBeInstanceOf(AbortController);
    expect(hasTurn(task.id)).toBe(true);

    const fresh = getTask(task.id)!;
    expect(fresh.running).toBe(1);
    expect(fresh.started).toBe(0); // deferred until the agent opens a session, as every launch path does
    expect(fresh.start_at).toBe(0);
    // Other tabs learn the chip is gone: the coarse turn events don't carry start_at.
    expect(events.some((e) => e.type === "task_edited")).toBe(true);
    expect(listMessages(task.id).map((m) => [m.role, m.content])).toEqual([["user", INITIAL_TASK_PROMPT]]);
  });

  it("leaves a deadline still in the future alone", async () => {
    const { task } = queued({}, Date.now() + 3_600_000);
    expect(await sweepDeferredStarts()).toBe(0);
    expect(startTurnMock).not.toHaveBeenCalled();
    expect(hasTurn(task.id)).toBe(false);
    expect(getTask(task.id)!.start_at).toBeGreaterThan(0);
  });

  it("won't start a task another task still blocks, dropping the deadline and saying why", async () => {
    const { project, task } = queued();
    const blocker = createTask({ project_id: project.id, title: "first" });
    setTaskDeps(task.id, [blocker.id]);
    expect(await sweepDeferredStarts()).toBe(0);
    expect(startTurnMock).not.toHaveBeenCalled();
    expect(hasTurn(task.id)).toBe(false);
    expect(getTask(task.id)!.start_at).toBe(0);
    expect(systemLines(task.id)).toEqual([expect.stringContaining("still blocked")]);
  });

  it("won't start into a project with no working directory, the same drop for a different reason", async () => {
    const project = makeProject("");
    const task = createTask({ project_id: project.id, title: "nowhere" });
    updateTask(task.id, { start_at: Date.now() - 1 });
    expect(await sweepDeferredStarts()).toBe(0);
    expect(startTurnMock).not.toHaveBeenCalled();
    expect(getTask(task.id)!.start_at).toBe(0);
    expect(systemLines(task.id)).toEqual([expect.stringContaining("working directory")]);
  });
});

describe("sweepDeferredStarts, a started task", () => {
  it("resumes with the oldest parked follow-up, popping it from the queue", async () => {
    const { task } = queued({ started: 1, status: "in_progress" });
    addPendingMessage(task.id, task.generation, "first queued");
    addPendingMessage(task.id, task.generation, "second queued");

    expect(await sweepDeferredStarts()).toBe(1);
    expect(startResumeTurnMock).toHaveBeenCalledTimes(1);
    const [fresh, project, text, controller] = startResumeTurnMock.mock.calls[0];
    expect(fresh.id).toBe(task.id);
    expect(project.id).toBe(task.project_id);
    expect(text).toBe("first queued");
    expect(controller).toBeInstanceOf(AbortController);
    expect(hasTurn(task.id)).toBe(true);
    // The popped one is gone; the rest wait for that turn's own drain.
    expect(listPendingMessages(task.id).map((m) => m.content)).toEqual(["second queued"]);
    expect(getTask(task.id)!.start_at).toBe(0);
    // The transcript says why the session moved on its own.
    expect(systemLines(task.id)).toEqual([DEFERRED_RESUME_NOTE]);
  });

  it("resumes with a continue prompt when nothing was queued", async () => {
    queued({ started: 1, status: "in_progress" });
    expect(await sweepDeferredStarts()).toBe(1);
    expect(startResumeTurnMock.mock.calls[0][2]).toBe(DEFERRED_RESUME_PROMPT);
    expect(startTurnMock).not.toHaveBeenCalled();
  });

  it("defers to a turn that is already live: the deadline is dropped, not re-fired", async () => {
    const { task } = queued({ started: 1, status: "in_progress" });
    const live = claimTurn(task.id)!;
    try {
      expect(await sweepDeferredStarts()).toBe(0);
      expect(startResumeTurnMock).not.toHaveBeenCalled();
      expect(getTask(task.id)!.start_at).toBe(0);
      expect(systemLines(task.id)).toEqual([expect.stringContaining("already running")]);
    } finally {
      unregisterTurn(task.id, live);
    }
  });

  it("a failed launch lands on the transcript, releases the claim, and can't repeat next tick", async () => {
    const { task } = queued({ started: 1, status: "in_progress" });
    startResumeTurnMock.mockRejectedValueOnce(new Error("git exploded"));
    expect(await sweepDeferredStarts()).toBe(0);
    expect(publishTurnErrorMock).toHaveBeenCalledWith(task.id, task.generation, "git exploded");
    expect(hasTurn(task.id)).toBe(false);
    expect(getTask(task.id)!.start_at).toBe(0);
    // A second sweep finds nothing to do.
    expect(await sweepDeferredStarts()).toBe(0);
    expect(startResumeTurnMock).toHaveBeenCalledTimes(1);
  });
});

// The sweep fires at whatever hour the usage window happens to expire, so
// every outcome of a due deadline has to reach the user's phone: what ran, and
// what was queued and then ran nothing. Pinned on the bus, the single exit
// every channel (browser toast, Web Push) hangs off; tests/webpush.test.ts
// owns what the channels then do with a payload.
describe("sweepDeferredStarts notifications", () => {
  it("announces a first turn that fired at the reset", async () => {
    const { task } = queued();
    const sent = notificationsIn(await busEventsFor(task.id, () => sweepDeferredStarts()));
    expect(sent).toEqual([expect.objectContaining({
      id: `queued_start:${task.id}`,
      kind: "queued_start",
      taskId: task.id,
      projectId: task.project_id,
      title: "Started at the usage-window reset",
      body: "Q · Deferred",
    })]);
  });

  it("says resumed, not started, when the session was already open", async () => {
    const { task } = queued({ started: 1, status: "in_progress" });
    const sent = notificationsIn(await busEventsFor(task.id, () => sweepDeferredStarts()));
    expect(sent.map((p) => [p.kind, p.title])).toEqual([["queued_start", "Resumed at the usage-window reset"]]);
  });

  it("reports a skip with the same sentence the transcript got, so nobody finds it hours later", async () => {
    const { project, task } = queued();
    setTaskDeps(task.id, [createTask({ project_id: project.id, title: "first" }).id]);
    const sent = notificationsIn(await busEventsFor(task.id, () => sweepDeferredStarts()));
    expect(sent).toEqual([expect.objectContaining({
      id: `queued_start_skipped:${task.id}`,
      kind: "queued_start_skipped",
      title: "Queued start skipped",
      body: "Q · Deferred\nthis task is still blocked by another task",
    })]);
    expect(systemLines(task.id)).toEqual(["ℹ Queued start skipped: this task is still blocked by another task."]);
  });

  it("reports the other two skips the same way", async () => {
    const live = queued({ started: 1, status: "in_progress" });
    const claim = claimTurn(live.task.id)!;
    let sent: NotificationPayload[];
    try {
      sent = notificationsIn(await busEventsFor(live.task.id, () => sweepDeferredStarts()));
    } finally {
      unregisterTurn(live.task.id, claim);
    }
    expect(sent.map((p) => p.body)).toEqual(["Q · Deferred\na turn was already running"]);

    const project = makeProject("");
    const homeless = createTask({ project_id: project.id, title: "nowhere" });
    updateTask(homeless.id, { start_at: Date.now() - 1 });
    const second = notificationsIn(await busEventsFor(homeless.id, () => sweepDeferredStarts()));
    expect(second.map((p) => p.body)).toEqual(["nowhere · Deferred\nset this project's working directory first"]);
  });

  it("stays quiet when the user turned that kind off, and the other kind still speaks", async () => {
    setSetting("notify_queued_start", "off");
    try {
      const fired = queued();
      expect(notificationsIn(await busEventsFor(fired.task.id, () => sweepDeferredStarts()))).toEqual([]);
      // The launch itself is unaffected: a switch silences the toast, never the work.
      expect(startTurnMock.mock.calls.filter((c) => c[0].id === fired.task.id)).toHaveLength(1);

      const skipped = queued();
      setTaskDeps(skipped.task.id, [createTask({ project_id: skipped.project.id, title: "first" }).id]);
      const sent = notificationsIn(await busEventsFor(skipped.task.id, () => sweepDeferredStarts()));
      expect(sent.map((p) => p.kind)).toEqual(["queued_start_skipped"]);
    } finally {
      setSetting("notify_queued_start", null);
    }
  });

  it("obeys the master switch", async () => {
    setSetting("notifications", "off");
    try {
      const { task } = queued();
      expect(notificationsIn(await busEventsFor(task.id, () => sweepDeferredStarts()))).toEqual([]);
    } finally {
      setSetting("notifications", null);
    }
  });
});

describe("PATCH /api/tasks/[id] start_at", () => {
  it("stores the deadline and announces it as an edit; 0 cancels", async () => {
    const project = makeProject();
    const task = createTask({ project_id: project.id, title: "later" });
    const at = Date.now() + 3_600_000;
    const events = await busEventsFor(task.id, async () => {
      const res = await patchTask(new Request("http://x", { method: "PATCH", body: JSON.stringify({ start_at: at }) }), params(task.id));
      expect(res.status).toBe(200);
      expect((await res.json()).start_at).toBe(at);
    });
    expect(events.map((e) => e.type)).toEqual(["task_edited"]);
    expect(getTask(task.id)!.start_at).toBe(at);

    const res = await patchTask(new Request("http://x", { method: "PATCH", body: JSON.stringify({ start_at: 0 }) }), params(task.id));
    expect(res.status).toBe(200);
    expect(getTask(task.id)!.start_at).toBe(0);
    expect(listDueDeferredStarts(at + 1).map((t) => t.id)).not.toContain(task.id);
  });

  it("validates the shape and refuses to queue a finished task", async () => {
    const project = makeProject();
    const task = createTask({ project_id: project.id, title: "later" });
    for (const bad of [-1, 1.5, "soon", null]) {
      const res = await patchTask(new Request("http://x", { method: "PATCH", body: JSON.stringify({ start_at: bad }) }), params(task.id));
      expect(res.status).toBe(400);
    }
    updateTask(task.id, { status: "done" });
    const res = await patchTask(new Request("http://x", { method: "PATCH", body: JSON.stringify({ start_at: Date.now() + 1 }) }), params(task.id));
    expect(res.status).toBe(409);
    expect(getTask(task.id)!.start_at).toBe(0);
  });
});
