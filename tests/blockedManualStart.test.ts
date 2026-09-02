import { describe, it, expect, beforeEach, vi } from "vitest";

// Regression coverage for the manual-start dependency gate: POST /messages
// used to be the one launcher that never checked blockers (the deferred-start
// sweep and the auto-start dependent sweep both did), so a stale tab, a
// second tab, or a scripted call could start a task whose blockers were still
// open. The route now runs the same `blocks()` predicate, first-turn only.
// Same scripted-driver seam as tests/turnRace.test.ts and tests/taskLock.test.ts.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: AbortController) =>
      runTurnMock(task, project, userText, ac),
  },
}));

import { createProject, createTask, getTask, setTaskDeps, updateTask } from "@/lib/store";
import { hasTurn } from "@/lib/abort";
import { POST as messagesPost } from "@/app/api/tasks/[id]/messages/route";
import { tmpDir } from "./helpers";

function post(taskId: string, text?: string) {
  return messagesPost(new Request("http://test/messages", { method: "POST", body: JSON.stringify({ text }) }), {
    params: Promise.resolve({ id: taskId }),
  });
}

// A plain (non-git) working dir keeps ensureWorktree's git side out of these
// tests (same trick as tests/deferredStart.test.ts / tests/turnRace.test.ts).
const makeProject = () => createProject({ name: "BlockedStart", repo_path: tmpDir("blocked-") });

beforeEach(() => {
  runTurnMock.mockReset();
  runTurnMock.mockImplementation(async function* () {
    yield { type: "session", sessionId: "s1" };
    yield { type: "done", sessionId: "s1" };
  });
});

describe("POST /messages — blocked-by gate on manual start", () => {
  it("refuses the first turn while a blocker is open", async () => {
    const project = makeProject();
    const blocker = createTask({ project_id: project.id, title: "Do the prerequisite thing" });
    updateTask(blocker.id, { status: "in_progress" });
    const task = createTask({ project_id: project.id, title: "Dependent" });
    setTaskDeps(task.id, [blocker.id]);

    const res = await post(task.id, "");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Blocked until");
    expect(body.error).toContain(blocker.title);
    expect(body.blockedBy).toEqual([blocker.id]);
    expect(runTurnMock).not.toHaveBeenCalled();

    const fresh = getTask(task.id)!;
    expect(fresh.started).toBeFalsy();
    expect(fresh.running).toBe(0);
  });

  it("releases the turn claim on refusal", async () => {
    const project = makeProject();
    const blocker = createTask({ project_id: project.id, title: "Blocker" });
    updateTask(blocker.id, { status: "in_progress" });
    const task = createTask({ project_id: project.id, title: "Dependent" });
    setTaskDeps(task.id, [blocker.id]);

    const res = await post(task.id, "");
    expect(res.status).toBe(409);
    // The claim taken at the top of the route (before the lock body runs the
    // dependency check) must be freed by the finally, or every later POST
    // queues into the void instead of ever launching.
    expect(hasTurn(task.id)).toBe(false);
  });

  it("allows the start once every blocker is terminal (done or cancelled)", async () => {
    const project = makeProject();
    const doneBlocker = createTask({ project_id: project.id, title: "Finished prereq" });
    updateTask(doneBlocker.id, { status: "done" });
    const cancelledBlocker = createTask({ project_id: project.id, title: "Abandoned prereq" });
    updateTask(cancelledBlocker.id, { status: "cancelled" });
    const task = createTask({ project_id: project.id, title: "Dependent" });
    setTaskDeps(task.id, [doneBlocker.id, cancelledBlocker.id]);

    const res = await post(task.id, "");
    expect(res.status).not.toBe(409);
    expect(res.status).toBe(202);
    expect(runTurnMock).toHaveBeenCalledTimes(1);
  });

  it("does not gate a follow-up on an already-started task", async () => {
    const project = makeProject();
    const blocker = createTask({ project_id: project.id, title: "Still open" });
    updateTask(blocker.id, { status: "in_progress" });
    const task = createTask({ project_id: project.id, title: "Dependent" });
    updateTask(task.id, { started: 1, status: "in_progress" });
    setTaskDeps(task.id, [blocker.id]);

    const res = await post(task.id, "a follow-up message");
    expect(res.status).not.toBe(409);
  });

  it("a task with no dependencies is unaffected", async () => {
    const project = makeProject();
    const task = createTask({ project_id: project.id, title: "Standalone" });

    const res = await post(task.id, "");
    expect(res.status).not.toBe(409);
    expect(res.status).toBe(202);
  });
});
