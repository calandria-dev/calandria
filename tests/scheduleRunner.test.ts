import { describe, expect, it, beforeEach, vi } from "vitest";

// Mirror tests/agentDriver.test.ts: mock the driver registry so the runner
// drives a scripted agent instead of a real CLI.
const events: Record<string, unknown>[] = [];
vi.mock("@/lib/agents/registry", () => ({
  getDriver: () => ({
    id: "mock",
    label: "Mock",
    async *runTurn() {
      yield { type: "session", sessionId: "s1" };
      for (const e of events) yield e;
      yield { type: "done", sessionId: "s1" };
    },
  }),
}));

import { createProject, createTask, getProject, getTask } from "@/lib/store";
import { isUnreadRun } from "@/app/shell/format";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import type { TaskRow } from "@/app/shell/types";
import { claimRun, createSchedule, getRun, startRun } from "@/lib/schedule/store";
import { startTurn } from "@/lib/runner";
import { SCHEDULED_RUN_CONTEXT, getRunContext, recordUnattendedDenial } from "@/lib/runContext";
import { hasTurn } from "@/lib/abort";

const settled = async () => {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (!hasTurn(taskId)) return;
  }
  throw new Error("turn never settled");
};

let taskId = "";

describe("scheduled turns in the runner", () => {
  let projectId = "";
  let runId = "";

  beforeEach(() => {
    events.length = 0;
    const p = createProject({ name: `runner-${Math.random().toString(36).slice(2)}` });
    projectId = p.id;
    const s = createSchedule({
      project_id: projectId, name: "n", prompt: "/x",
      days_mask: 62, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    runId = claimRun(s.id, Date.now(), "scheduled")!.id;
    taskId = createTask({ project_id: projectId, title: "scheduled run" }).id;
    startRun(runId, taskId);
  });

  const scheduled = () => ({ ...SCHEDULED_RUN_CONTEXT, scheduleRunId: runId });

  it("settles the run as succeeded and leaves 'needs you' alone", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    expect(getRun(runId)!.status).toBe("succeeded");
    // Success is quiet: a scheduled run must not park in the "N need you"
    // pill forever.
    expect(getTask(taskId)!.awaiting_input).toBe(0);
  });

  // ---------- where a clean scheduled run comes to rest (issue #28) ----------
  //
  // Quiet is not the same as invisible. The mark below (unread_run_at) is the
  // state a clean scheduled run rests in: outside the NEEDS_YOU predicate, so
  // the pill stays quiet, but with a category of its own on the board and a
  // way out of it. Without it a clean run lands on running=0 / awaiting_input=0
  // / status=in_progress with nothing to distinguish it from live work.

  it("marks a clean scheduled run as ran-and-unread instead of leaving it 'In progress' forever", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    const t = getTask(taskId)!;
    expect(t.running).toBe(0);
    expect(t.awaiting_input).toBe(0);
    // The status is untouched: like a snooze, this is a state over the status,
    // which is what makes acknowledging it an ordinary write.
    expect(t.status).toBe("in_progress");
    expect(t.unread_run_at).toBeGreaterThan(0);
    // The board draws it in its own group, separate from live work.
    expect(isUnreadRun(t as unknown as TaskRow)).toBe(true);
  });

  it("does NOT mark a scheduled run that failed — that one raises its hand instead", async () => {
    events.push({ type: "error", content: "boom" });
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    const t = getTask(taskId)!;
    expect(t.awaiting_input).toBe(1);
    // Two resting states for one run would put the same task in two groups.
    expect(t.unread_run_at).toBe(0);
    expect(isUnreadRun(t as unknown as TaskRow)).toBe(false);
  });

  it("never marks an ordinary, watched turn — nobody needs telling their own turn ended", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "hello", "");
    await settled();
    expect(getTask(taskId)!.unread_run_at).toBe(0);
  });

  it("clears the mark when the next turn opens a session on the task", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    expect(getTask(taskId)!.unread_run_at).toBeGreaterThan(0);
    // Reading it by replying is the other way out: the row is working again,
    // so it belongs under "In progress" from the moment the session opens.
    startTurn(getTask(taskId)!, getProject(projectId)!, "thanks, carry on", "");
    await settled();
    expect(getTask(taskId)!.unread_run_at).toBe(0);
    // ...and it lands back on the ordinary end-of-turn state.
    expect(getTask(taskId)!.awaiting_input).toBe(1);
  });

  it("clears the mark when the user acknowledges the run with a status write", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    expect(getTask(taskId)!.unread_run_at).toBeGreaterThan(0);
    // What the card's "Mark done" sends. The status write is what clears the
    // mark: the state has no third place to fall back to, and clearing it
    // alone would drop the row back into the ordinary in-progress pile it was
    // pulled out of.
    const res = await patchTask(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "done" }) }),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(res.status).toBe(200);
    const t = getTask(taskId)!;
    expect(t.status).toBe("done");
    expect(t.unread_run_at).toBe(0);
    expect(isUnreadRun(t as unknown as TaskRow)).toBe(false);
  });

  it("settles a failed run and DOES surface it", async () => {
    events.push({ type: "error", content: "boom" });
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    const run = getRun(runId)!;
    expect(run.status).toBe("failed");
    expect(run.detail).toContain("boom");
    expect(getTask(taskId)!.awaiting_input).toBe(1);
  });

  it("settles a run whose tool calls were auto-denied as FAILED, not as a green 'ran'", async () => {
    // Under any mode but bypassPermissions, a scheduled turn's permission
    // prompts are declined automatically because nobody is there to answer, so
    // the agent can stop partway with the job half done. The run must not
    // record `succeeded` for that: its status has to account for an
    // auto-denied tool call, and the schedule card has to be told, not just
    // the pending queue.
    events.push({
      type: "permission",
      request: { id: "perm:tu_1", tool: "Bash", title: "npm run deploy", detail: "npm run deploy", expiresAt: 0 },
    });
    events.push({
      type: "permission_decided",
      id: "perm:tu_1",
      outcome: { decision: "deny", auto: true, reason: "unattended", note: "Nobody was watching." },
    });
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();

    const run = getRun(runId)!;
    expect(run.status).toBe("failed");
    expect(run.detail).toMatch(/needed approval and nobody was watching/i);
    // This surfaces like every other scheduled failure.
    expect(getTask(taskId)!.awaiting_input).toBe(1);
  });

  it("a run denied through the ask_user bridge settles the same way", async () => {
    // The Codex path has no permission event stream of its own; the bridge
    // records the denial on the RunContext instead (lib/agentTools.ts). Both
    // roads have to reach the same verdict, or "the turn stopped short because
    // nobody was there" would mean different things per agent.
    const ctx = scheduled();
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, ctx);
    recordUnattendedDenial(taskId);
    await settled();

    expect(getRun(runId)!.status).toBe("failed");
    expect(getTask(taskId)!.awaiting_input).toBe(1);
  });

  it("clears the run context when the turn ends", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    expect(getRunContext(taskId)).toBeUndefined();
  });

  it("leaves an ordinary turn's awaiting_input behaviour untouched", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "hello", "");
    await settled();
    expect(getTask(taskId)!.awaiting_input).toBe(1);
  });

  it("still settles the schedule run and clears the run context on a clean finish", async () => {
    // A crash that escapes run()'s own finally (see tests/runnerEarlyThrow.test.ts
    // for how that's provoked) would leave settling the run and clearing the
    // context to the last-resort `.catch` on startTurn's detached run() promise.
    // This confirms the ordinary, non-crashing path reaches the same terminal
    // state via run()'s own finally.
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    const run = getRun(runId)!;
    // Terminal, not stuck at "claimed"/"running" forever.
    expect(run.status).not.toBe("claimed");
    expect(run.status).not.toBe("running");
    expect(run.finished_at).toBeGreaterThan(0);
    // The stale RunContext must not survive: otherwise a later, ordinary turn
    // on this same task would inherit interactionPolicy: "deny" without
    // warning and have its own permission prompts auto-deny with no
    // explanation.
    expect(getRunContext(taskId)).toBeUndefined();
  });
});
