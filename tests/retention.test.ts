import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { createProject, createTask, updateTask } from "@/lib/store";
import { createSchedule, claimRun } from "@/lib/schedule/store";
import { prunableTaskIds, sweepRetention } from "@/lib/retention";
import { taskUploadsDir } from "@/lib/uploads";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-27T12:00:00Z");
const YEAR = 365 * DAY;

// updateTask() always stamps updated_at = Date.now(), which is exactly what
// the predicate reads, so "cold" has to be written underneath it.
const age = (id: string, ms: number) =>
  getDb().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(NOW - ms, id);

function project() {
  return createProject({ name: `ret-${Math.random().toString(36).slice(2)}` }).id;
}

/** A task that has been done and untouched for `days`, i.e. the base case. */
function coldDone(pid: string, days = 365) {
  const t = createTask({ project_id: pid, title: "old work" });
  updateTask(t.id, { status: "done" });
  age(t.id, days * DAY);
  return t.id;
}

const message = (taskId: string, generation = 1) =>
  getDb()
    .prepare("INSERT INTO messages (id, task_id, generation, role, content, created_at) VALUES (?, ?, ?, 'user', 'hi', ?)")
    .run(nanoid(), taskId, generation, NOW - YEAR);

const session = (pid: string, taskId: string, generation: number, agentSessionId: string) =>
  getDb()
    .prepare("INSERT INTO sessions (id, project_id, task_id, generation, claude_session_id, started_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(nanoid(), pid, taskId, generation, agentSessionId, NOW - YEAR);

const usage = (pid: string, taskId: string, at: number) =>
  getDb()
    .prepare("INSERT INTO task_usage (id, project_id, task_id, generation, cost_usd, created_at) VALUES (?, ?, ?, 1, 1.5, ?)")
    .run(nanoid(), pid, taskId, at);

const merge = (pid: string, taskId: string, at: number) =>
  getDb()
    .prepare("INSERT INTO task_merges (id, project_id, task_id, agent, additions, deletions, merged_at) VALUES (?, ?, ?, 'claude', 3, 1, ?)")
    .run(nanoid(), pid, taskId, at);

const internal = (at: number) =>
  getDb()
    .prepare("INSERT INTO internal_usage (id, job, agent, requested_agent, created_at) VALUES (?, 'recap', 'claude', 'claude', ?)")
    .run(nanoid(), at);

const count = (table: string, taskId: string) =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ?`).get(taskId) as { n: number }).n;

describe("retention predicate", () => {
  let pid: string;
  beforeEach(() => {
    // The predicate is global (the sweep scans every project), so a leftover
    // task from another case would show up in every assertion.
    getDb().prepare("DELETE FROM tasks").run();
    getDb().prepare("DELETE FROM schedules").run();
    getDb().prepare("DELETE FROM internal_usage").run();
    pid = project();
  });

  it("takes a terminal task that has gone cold", () => {
    const id = coldDone(pid);
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([id]);
  });

  it("takes a cancelled task too — terminal is not just 'done'", () => {
    const t = createTask({ project_id: pid, title: "abandoned" });
    updateTask(t.id, { status: "cancelled" });
    age(t.id, YEAR);
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([t.id]);
  });

  it("leaves a task that is not terminal, however old", () => {
    for (const status of ["not_started", "in_progress", "on_hold"] as const) {
      const t = createTask({ project_id: pid, title: status });
      updateTask(t.id, { status });
      age(t.id, 10 * YEAR);
    }
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([]);
  });

  it("leaves a terminal task inside the window", () => {
    const t = createTask({ project_id: pid, title: "finished yesterday" });
    updateTask(t.id, { status: "done" });
    age(t.id, 1 * DAY);
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([]);
  });

  it("dates from updated_at, not created_at — a long task finished recently stays", () => {
    const id = coldDone(pid);
    getDb().prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?")
      .run(NOW - 3 * YEAR, NOW - 10 * DAY, id);
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([]);
  });

  // Every one of these is a way a `done` row is still somebody's live concern.
  it("leaves a task with a turn in flight", () => {
    const id = coldDone(pid);
    getDb().prepare("UPDATE tasks SET running = 1 WHERE id = ?").run(id);
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([]);
  });

  it("leaves a task parked on the user", () => {
    const id = coldDone(pid);
    getDb().prepare("UPDATE tasks SET awaiting_input = 1 WHERE id = ?").run(id);
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([]);
  });

  it("leaves a clean scheduled run nobody has read — the mark sits over the status", () => {
    const id = coldDone(pid);
    getDb().prepare("UPDATE tasks SET unread_run_at = ? WHERE id = ?").run(NOW - YEAR, id);
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([]);
  });

  it("leaves a task snoozed into the future", () => {
    const id = coldDone(pid);
    getDb().prepare("UPDATE tasks SET snoozed_until = ? WHERE id = ?").run(NOW + 7 * DAY, id);
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([]);
    // An EXPIRED snooze is not a reason to keep anything.
    getDb().prepare("UPDATE tasks SET snoozed_until = ? WHERE id = ?").run(NOW - 7 * DAY, id);
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([id]);
  });

  it("leaves a task with a follow-up still parked in the queue", () => {
    const id = coldDone(pid);
    getDb()
      .prepare("INSERT INTO pending_messages (id, task_id, generation, content, created_at) VALUES (?, ?, 1, 'next', ?)")
      .run(nanoid(), id, NOW - YEAR);
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([]);
  });

  it("leaves a task an in-flight schedule run still points at", () => {
    const id = coldDone(pid);
    const s = createSchedule({
      project_id: pid, name: "nightly", prompt: "/sweep",
      days_mask: 127, time_of_day: "08:30", timezone: "UTC",
    });
    const run = claimRun(s.id, NOW - YEAR, "scheduled")!;
    getDb().prepare("UPDATE schedule_runs SET status = 'running', task_id = ? WHERE id = ?").run(id, run.id);
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([]);
    // Settled, the ledger is an audit record and holds nothing back.
    getDb().prepare("UPDATE schedule_runs SET status = 'ok' WHERE id = ?").run(run.id);
    expect(prunableTaskIds(NOW - 180 * DAY, NOW)).toEqual([id]);
  });
});

describe("retention sweep", () => {
  let pid: string;
  beforeEach(() => {
    getDb().prepare("DELETE FROM tasks").run();
    getDb().prepare("DELETE FROM schedules").run();
    getDb().prepare("DELETE FROM internal_usage").run();
    pid = project();
  });

  it("prunes a cold task's record and leaves a live task's alone", () => {
    const old = coldDone(pid, 365);
    const live = createTask({ project_id: pid, title: "current" }).id;
    for (const id of [old, live]) {
      message(id);
      getDb()
        .prepare("INSERT INTO task_comments (id, task_id, file, side, line_start, line_end, body, sent_to_agent, created_at) VALUES (?, ?, 'a.ts', 'new', 1, 1, 'why?', 0, ?)")
        .run(nanoid(), id, NOW - YEAR);
      getDb()
        .prepare("INSERT INTO task_doc_comments (id, task_id, file, quote, body, sent_to_agent, created_at) VALUES (?, ?, 'r.md', 'q', 'b', 0, ?)")
        .run(nanoid(), id, NOW - YEAR);
    }

    const res = sweepRetention(NOW, { transcriptMs: 180 * DAY, usageMs: 400 * DAY });

    expect(res.messages).toBe(1);
    expect(res.task_comments).toBe(1);
    expect(res.task_doc_comments).toBe(1);
    expect(count("messages", old)).toBe(0);
    expect(count("messages", live)).toBe(1);
    expect(count("task_comments", live)).toBe(1);
    expect(count("task_doc_comments", live)).toBe(1);
  });

  it("keeps the session a pruned task would resume into, and drops the retired ones", () => {
    const id = coldDone(pid);
    // Two /clear generations behind the live one; tasks.session_id names the
    // third, whose usage_cum is the Codex per-thread billing baseline.
    session(pid, id, 1, "sess-1");
    session(pid, id, 2, "sess-2");
    session(pid, id, 3, "sess-live");
    updateTask(id, { session_id: "sess-live", generation: 3 });
    age(id, YEAR);

    const res = sweepRetention(NOW, { transcriptMs: 180 * DAY, usageMs: 0 });

    expect(res.sessions).toBe(2);
    const left = getDb()
      .prepare("SELECT claude_session_id FROM sessions WHERE task_id = ?")
      .all(id) as { claude_session_id: string }[];
    expect(left.map((r) => r.claude_session_id)).toEqual(["sess-live"]);
  });

  it("holds spend rows past the transcript window and takes them at the usage window", () => {
    const id = coldDone(pid, 200); // past 180d, inside 400d
    message(id);
    usage(pid, id, NOW - 200 * DAY);
    merge(pid, id, NOW - 200 * DAY);

    const first = sweepRetention(NOW, { transcriptMs: 180 * DAY, usageMs: 400 * DAY });
    expect(first.messages).toBe(1);
    expect(first.task_usage).toBe(0);
    expect(first.task_merges).toBe(0);
    expect(count("task_usage", id)).toBe(1);

    age(id, 500 * DAY);
    const second = sweepRetention(NOW, { transcriptMs: 180 * DAY, usageMs: 400 * DAY });
    expect(second.task_usage).toBe(1);
    expect(second.task_merges).toBe(1);
  });

  it("prunes internal_usage by row age — it has no task to hang a lifecycle on", () => {
    internal(NOW - 500 * DAY);
    internal(NOW - 10 * DAY);
    const res = sweepRetention(NOW, { transcriptMs: 0, usageMs: 400 * DAY });
    expect(res.internal_usage).toBe(1);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM internal_usage").get() as { n: number }).n).toBe(1);
  });

  it("removes the attachment dir of a task whose transcript aged out", () => {
    const id = coldDone(pid);
    message(id);
    const dir = taskUploadsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "shot.png"), "x");

    const res = sweepRetention(NOW, { transcriptMs: 180 * DAY, usageMs: 0 });

    expect(res.uploads).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("a window of 0 turns that half off", () => {
    const id = coldDone(pid);
    message(id);
    usage(pid, id, NOW - YEAR);
    internal(NOW - 3 * YEAR);

    expect(sweepRetention(NOW, { transcriptMs: 0, usageMs: 0 })).toMatchObject({ rows: 0, checkpointed: false });
    expect(count("messages", id)).toBe(1);
    expect(count("task_usage", id)).toBe(1);
  });

  it("checkpoints the WAL only when something was actually deleted", () => {
    expect(sweepRetention(NOW, { transcriptMs: 180 * DAY, usageMs: 400 * DAY }).checkpointed).toBe(false);
    const id = coldDone(pid);
    message(id);
    expect(sweepRetention(NOW, { transcriptMs: 180 * DAY, usageMs: 400 * DAY }).checkpointed).toBe(true);
  });
});
