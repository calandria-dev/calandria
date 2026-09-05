import { beforeEach, describe, expect, it, vi } from "vitest";

// Pins the launch at the runner boundary: auto-start decides WHEN to start a
// task and hands the runner a prepared launch. The turn itself is covered by
// tests/agentDriver.test.ts.
vi.mock("@/lib/runner", () => ({ startTurn: vi.fn(), publishTurnError: vi.fn() }));

import { startTurn, publishTurnError } from "@/lib/runner";
import {
  createProject,
  createTask,
  getTask,
  listMessages,
  setTaskDeps,
  updateTask,
} from "../lib/store";
import { maybeAutoStartDependents, readyAutoStartDependents } from "../lib/autoStart";
import { hasTurn } from "../lib/abort";
import { INITIAL_TASK_PROMPT, buildProjectContext } from "../lib/agents/shared";
import { tmpDir } from "./helpers";
import type { Task } from "../lib/types";

const startTurnMock = vi.mocked(startTurn);
const publishTurnErrorMock = vi.mocked(publishTurnError);

function makeProject() {
  // A plain, non-git working dir makes ensureWorktree fall back to
  // repo_path, keeping that launch path out of these tests.
  return createProject({ name: "Pipeline", repo_path: tmpDir("pipeline-") });
}

/** A blocks B; B has opted into auto-start unless told otherwise. */
function makeChain(autoStart = true) {
  const project = makeProject();
  const a = createTask({ project_id: project.id, title: "A" });
  const b = createTask({ project_id: project.id, title: "B", description: "build on A" });
  setTaskDeps(b.id, [a.id]);
  if (autoStart) updateTask(b.id, { auto_start: 1 });
  return { project, a, b };
}

// The mocked runner never releases the claimed turn slot. Each test uses
// fresh task ids, so clearing the mock between tests is enough.
beforeEach(() => {
  startTurnMock.mockReset();
  publishTurnErrorMock.mockReset();
});

describe("readyAutoStartDependents (selection rules)", () => {
  it("a dependent with the toggle on is ready once its only blocker is done", () => {
    const { a, b } = makeChain();
    updateTask(a.id, { status: "done" });
    expect(readyAutoStartDependents(a.id).map((t) => t.id)).toEqual([b.id]);
  });

  it("toggle off = today's behavior: never selected", () => {
    const { a } = makeChain(false);
    updateTask(a.id, { status: "done" });
    expect(readyAutoStartDependents(a.id)).toEqual([]);
  });

  it("waits for the LAST blocker: an unfinished second dep keeps it back", () => {
    const { project, a, b } = makeChain();
    const c = createTask({ project_id: project.id, title: "C" });
    setTaskDeps(b.id, [a.id, c.id]);
    updateTask(a.id, { status: "done" });
    expect(readyAutoStartDependents(a.id)).toEqual([]);

    updateTask(c.id, { status: "done" });
    expect(readyAutoStartDependents(c.id).map((t) => t.id)).toEqual([b.id]);
  });

  it("a cancelled co-blocker doesn't hold the dependent back (matches the UI's blocked rule)", () => {
    const { project, a, b } = makeChain();
    const c = createTask({ project_id: project.id, title: "C" });
    setTaskDeps(b.id, [a.id, c.id]);
    updateTask(c.id, { status: "cancelled" });
    updateTask(a.id, { status: "done" });
    expect(readyAutoStartDependents(a.id).map((t) => t.id)).toEqual([b.id]);
  });

  it("never selects started, suggested, on-hold, or cancelled dependents", () => {
    const project = makeProject();
    const a = createTask({ project_id: project.id, title: "A" });
    const mk = (title: string, patch: Partial<Task>) => {
      const t = createTask({ project_id: project.id, title });
      setTaskDeps(t.id, [a.id]);
      updateTask(t.id, { auto_start: 1, ...patch });
      return t;
    };
    mk("already started", { started: 1 });
    mk("still a suggestion", { suggested: 1 });
    mk("parked by the user", { status: "on_hold" });
    mk("abandoned", { status: "cancelled" });
    updateTask(a.id, { status: "done" });
    expect(readyAutoStartDependents(a.id)).toEqual([]);
  });
});

describe("maybeAutoStartDependents (the launch)", () => {
  it("marking A done starts B without user action", async () => {
    const { a, b } = makeChain();
    updateTask(a.id, { status: "done" });
    maybeAutoStartDependents(a.id);
    // The launch initializes a real git repo and worktree, so allow it a few
    // seconds.
    await vi.waitFor(() => expect(startTurnMock).toHaveBeenCalledTimes(1), { timeout: 10_000 });

    // The runner gets a generic opening turn plus the auto-start note; task
    // metadata lives only in the injected project context.
    const [task, project, userText, note, controller] = startTurnMock.mock.calls[0];
    expect(task.id).toBe(b.id);
    expect(project.id).toBe(b.project_id);
    expect(userText).toBe(INITIAL_TASK_PROMPT);
    expect(userText).not.toContain(b.title);
    expect(userText).not.toContain(b.description);
    const context = buildProjectContext(project, b);
    expect(context).toContain('The current task is: "B"');
    expect(context).toContain("Task details: build on A");
    expect(note).toContain('"A" is done');
    expect(controller).toBeInstanceOf(AbortController);
    expect(hasTurn(b.id)).toBe(true);

    // Same pre-launch state the POST route leaves: prompt echoed to the
    // transcript, running flagged, `started` deferred until a session opens.
    expect(listMessages(b.id).map((m) => [m.role, m.content])).toEqual([["user", INITIAL_TASK_PROMPT]]);
    const fresh = getTask(b.id)!;
    expect(fresh.running).toBe(1);
    expect(fresh.started).toBe(0);
  });

  it("toggle off preserves today's behavior: nothing launches", () => {
    const { a, b } = makeChain(false);
    updateTask(a.id, { status: "done" });
    maybeAutoStartDependents(a.id);
    // A launch claims the turn slot synchronously before its first await, so
    // no claim here proves no launch is in flight.
    expect(hasTurn(b.id)).toBe(false);
    expect(startTurnMock).not.toHaveBeenCalled();
    expect(listMessages(b.id)).toEqual([]);
    expect(getTask(b.id)!.running).toBe(0);
  });

  // Cancelling the last blocker must also start the dependent, since blocks()
  // treats a cancelled task as terminal. Both the user's PATCH
  // /api/tasks/[id] and the withdraw_suggestion tool cancel through this
  // path.
  it("cancelling the last blocker starts the dependent too, not just marking it done", async () => {
    const { a, b } = makeChain();
    updateTask(a.id, { status: "cancelled" });
    expect(readyAutoStartDependents(a.id).map((t) => t.id)).toEqual([b.id]);
    maybeAutoStartDependents(a.id);
    await vi.waitFor(() => expect(startTurnMock).toHaveBeenCalledTimes(1), { timeout: 10_000 });

    const [task, , , note] = startTurnMock.mock.calls[0];
    expect(task.id).toBe(b.id);
    // The transcript names the actual cause instead of flattening it to "is
    // done": an agent building on a cancelled blocker needs to know.
    expect(note).toContain('"A" was cancelled');
    expect(note).not.toContain("is done");
  });

  // An auto-start runs fire-and-forget behind another task's status change,
  // with nothing watching it. A launch that throws after the row is marked
  // running must not leave the task spinning on a turn that never started.
  it("a launch that throws unwinds the row instead of leaving it spinning", async () => {
    const { a, b } = makeChain();
    startTurnMock.mockImplementation(() => {
      throw new TypeError("(0 , n.startTurn) is not a function");
    });
    updateTask(a.id, { status: "done" });
    maybeAutoStartDependents(a.id);
    await vi.waitFor(() => expect(startTurnMock).toHaveBeenCalledTimes(1), { timeout: 10_000 });

    await vi.waitFor(() => expect(getTask(b.id)!.running).toBe(0), { timeout: 10_000 });
    const fresh = getTask(b.id)!;
    // Cleanly retryable: not started, not running, turn slot released, so the
    // user's Start button (and a later sweep) both still work.
    expect(fresh.started).toBe(0);
    expect(fresh.status).toBe("not_started");
    expect(hasTurn(b.id)).toBe(false);
    // The failure is published where the user sees it.
    expect(publishTurnErrorMock).toHaveBeenCalledTimes(1);
    const [id, gen, text] = publishTurnErrorMock.mock.calls[0];
    expect(id).toBe(b.id);
    expect(gen).toBe(fresh.generation);
    expect(text).toContain("(0 , n.startTurn) is not a function");
  });

  it("a task started in the race window isn't double-launched", () => {
    const { a, b } = makeChain();
    updateTask(a.id, { status: "done" });
    // Simulate the user pressing Start in the same instant (route marked it started).
    updateTask(b.id, { started: 1 });
    maybeAutoStartDependents(a.id);
    expect(hasTurn(b.id)).toBe(false);
    expect(startTurnMock).not.toHaveBeenCalled();
  });
});
