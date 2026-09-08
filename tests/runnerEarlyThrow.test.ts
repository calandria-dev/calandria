import { afterEach, describe, expect, it, vi } from "vitest";

// run()'s whole body runs inside its try block, so a throw during setup
// (settings funnel, syncNote persistence) still hits the finally: the turn
// unregisters, running settles, and the startTurn launch has a .catch that
// settles the task as a last resort if even the finally throws.
//
// getSetting("first_task_started") runs on every turn in run()'s setup, so a
// throwing getSetting is a deterministic stand-in for any early failure. The
// finally's own throw vector is getTask(id) (lib/runner.ts:531), the first
// call it makes, before it flips running off. It's made to throw exactly
// once so the finally itself dies without settling the task, forcing the
// last-resort .catch on startTurn's detached run() promise (whose own
// getTask call comes after the throw-once counter is spent) to settle it.
const state = vi.hoisted(() => ({ failGetSetting: false, getTaskThrows: 0 }));
vi.mock("../lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/store")>();
  return {
    ...actual,
    getSetting: (key: string) => {
      if (state.failGetSetting && key === "first_task_started")
        throw new Error("simulated setup failure (getSetting)");
      return actual.getSetting(key);
    },
    getTask: (id: string) => {
      if (state.getTaskThrows > 0) {
        state.getTaskThrows--;
        throw new Error("simulated finally failure (getTask)");
      }
      return actual.getTask(id);
    },
  };
});

import { createProject, createTask, deleteProject, getTask, updateTask, listMessages } from "../lib/store";
import { startTurn } from "../lib/runner";
import { hasTurn } from "../lib/abort";
import { subscribe } from "../lib/events";

afterEach(() => {
  state.failGetSetting = false;
  state.getTaskThrows = 0;
});

describe("runner early-throw hardening", () => {
  it("a throw in run()'s setup still hits the finally: turn unregisters, running settles, error is persisted", async () => {
    const project = createProject({ name: "EarlyThrow" });
    let task = createTask({ project_id: project.id, title: "T", description: "" });
    task = updateTask(task.id, { running: 1 })!;

    const seen: { type?: string }[] = [];
    const unsub = subscribe(task.id, (e) => seen.push(e as { type?: string }));

    state.failGetSetting = true;
    startTurn(task, project, "hi", "");

    await vi.waitFor(() => {
      expect(hasTurn(task.id)).toBe(false);
      expect(seen.some((e) => e.type === "turn_end")).toBe(true);
    });
    unsub();

    // The finally settles the row (running flips back to 0).
    expect(getTask(task.id)!.running).toBe(0);
    // The failure is on the transcript, not just in a log.
    const msgs = listMessages(task.id);
    expect(msgs.some((m) => m.role === "system" && /simulated setup failure/.test(m.content))).toBe(true);
  });

  it("syncNote persistence throwing (task row deleted) unwinds cleanly instead of rejecting unhandled", async () => {
    const project = createProject({ name: "EarlySyncNote" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    deleteProject(project.id); // cascade-drops the task row → addMessage hits FOREIGN KEY

    const seen: { type?: string }[] = [];
    const unsub = subscribe(task.id, (e) => seen.push(e as { type?: string }));

    startTurn(task, project, "hi", "✓ Caught up to main.");

    await vi.waitFor(() => {
      expect(hasTurn(task.id)).toBe(false);
      expect(seen.some((e) => e.type === "turn_end")).toBe(true);
    });
    unsub();
    // Row is gone, so nothing to assert on the task itself. Reaching here
    // without vitest flagging an unhandled rejection is what this pins.
  });

  it("even a throw from the finally itself is settled by the launch .catch", async () => {
    const project = createProject({ name: "FinallyThrow" });
    let task = createTask({ project_id: project.id, title: "T", description: "" });
    task = updateTask(task.id, { running: 1 })!;

    const seen: { type?: string }[] = [];
    const unsub = subscribe(task.id, (e) => seen.push(e as { type?: string }));

    // Early throw aborts the turn before the driver runs; then the finally's
    // own first getTask() throws too (once), before it can flip running off.
    // The rejection escapes run(), so only the .catch on the launch, whose
    // getTask call comes after the throw-once counter is spent, can settle it.
    state.failGetSetting = true;
    state.getTaskThrows = 1;
    startTurn(task, project, "hi", "");

    await vi.waitFor(() => {
      expect(hasTurn(task.id)).toBe(false);
      expect(seen.some((e) => e.type === "turn_end")).toBe(true);
    });
    unsub();

    expect(getTask(task.id)!.running).toBe(0);
  });
});
