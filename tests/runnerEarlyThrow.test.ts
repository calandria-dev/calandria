import { afterEach, describe, expect, it, vi } from "vitest";

// Regression: run() used to execute setup (settings funnel, syncNote
// persistence) BEFORE its try block. A throw there — SQLite I/O error, disk
// full — skipped the finally entirely: the turn never unregistered, running
// never settled, and the detached promise rejected unhandled (Node's default
// policy: exit). The fix moves all of run()'s body inside the try, and gives
// the startTurn launch a .catch that settles the task as a last resort.
//
// getSetting("first_task_started") runs on every turn in run()'s setup, so a
// throwing getSetting is a deterministic stand-in for any early failure. The
// finally's own throw vector is getTask(id) (lib/runner.ts:531) — the first
// call it makes, before it flips running off — made to throw exactly once so
// the finally itself dies without settling the task, forcing the last-resort
// .catch on startTurn's detached run() promise (whose own getTask call comes
// after the throw-once counter is spent) to be the one that settles it.
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

    // The finally settled the row (pre-fix: stuck at running=1 forever).
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
    // Row is gone, so nothing to assert on the task itself — reaching here
    // without vitest flagging an unhandled rejection is the regression check.
  });

  it("even a throw from the finally itself is settled by the launch .catch", async () => {
    const project = createProject({ name: "FinallyThrow" });
    let task = createTask({ project_id: project.id, title: "T", description: "" });
    task = updateTask(task.id, { running: 1 })!;

    const seen: { type?: string }[] = [];
    const unsub = subscribe(task.id, (e) => seen.push(e as { type?: string }));

    // Early throw aborts the turn before the driver runs; then the finally's
    // own first getTask() throws too (once), before it can flip running off —
    // so the rejection escapes run() and only the .catch on the launch, whose
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
