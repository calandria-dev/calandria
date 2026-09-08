// The titlebar pill count (countAwaiting, carried on /api/events payloads),
// its dropdown (listNeedsYou), and the project badges (listProjects'
// awaiting_count subquery) share one predicate in lib/store.ts and must agree,
// including for a turn parked mid-stream on an AskUserQuestion (running=1 +
// awaiting_input=1). The three mutation routes that settle or delete a task
// (status PATCH, /clear, DELETE) publish on the bus, and GET /api/events
// relays a deletion even though the row is gone.
import { describe, it, expect } from "vitest";
import {
  createProject, createTask, updateTask, getTask, deleteTask,
  listProjects, listNeedsYou, countAwaiting,
} from "@/lib/store";
import { subscribeGlobal, publishGlobal, type BusEvent } from "@/lib/events";
import { PATCH as patchTask, DELETE as deleteTaskRoute } from "@/app/api/tasks/[id]/route";
import { POST as clearRoute } from "@/app/api/tasks/[id]/clear/route";
import { GET as eventsRoute } from "@/app/api/events/route";
import type { Status } from "@/lib/types";

// Collect every bus event published for one task while `fn` runs.
async function busEventsFor(taskId: string, fn: () => Promise<unknown>): Promise<BusEvent[]> {
  const seen: BusEvent[] = [];
  const unsub = subscribeGlobal((tid, ev) => { if (tid === taskId) seen.push(ev); });
  try {
    await fn();
  } finally {
    unsub();
  }
  return seen;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("the shared needs-you predicate", () => {
  it("countAwaiting, listNeedsYou and listProjects agree across the full state matrix", () => {
    const project = createProject({ name: "NeedsMatrix" });
    const statuses: Status[] = ["not_started", "in_progress", "on_hold", "done", "cancelled"];
    const askParked: string[] = []; // the running=1 + awaiting=1 rows (turn parked on an ask)
    for (const status of statuses)
      for (const running of [0, 1])
        for (const awaiting of [0, 1])
          for (const suggested of [0, 1]) {
            const t = createTask({
              project_id: project.id,
              title: `${status}/r${running}/a${awaiting}/s${suggested}`,
              suggested: !!suggested,
            });
            updateTask(t.id, { status, running, awaiting_input: awaiting });
            if (status === "in_progress" && running === 1 && awaiting === 1 && suggested === 0) askParked.push(t.id);
          }

    // Real in_progress tasks with awaiting_input set count; running is
    // irrelevant (2 of the 40 rows: running 0 and 1).
    const n = countAwaiting(project.id);
    expect(n).toBe(2);

    // Dropdown rows and pill count are the same set…
    const dropdown = listNeedsYou().filter((r) => r.project_id === project.id);
    expect(dropdown).toHaveLength(n);
    // …including the mid-turn ask park.
    expect(dropdown.map((r) => r.id)).toContain(askParked[0]);

    // The project badge subquery agrees too.
    expect(listProjects().find((p) => p.id === project.id)!.awaiting_count).toBe(n);
  });
});

describe("mutation routes publish lifecycle events", () => {
  it("a manual status PATCH publishes task_updated (a plain field edit publishes task_edited)", async () => {
    const project = createProject({ name: "PatchPub" });
    const t = createTask({ project_id: project.id, title: "T" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1 });

    const seen = await busEventsFor(t.id, async () => {
      const res = await patchTask(
        new Request("http://test", { method: "PATCH", body: JSON.stringify({ status: "done" }) }),
        params(t.id)
      );
      expect(res.status).toBe(200);
    });
    expect(getTask(t.id)).toMatchObject({ status: "done", awaiting_input: 0 });
    expect(seen).toContainEqual({ type: "task_updated" });
    expect(countAwaiting(project.id)).toBe(0);

    // A non-status edit changes nothing awaiting-related, but it does change
    // what every other tab renders. The coarse payload can't carry a title, so
    // it goes out as the wider task_edited ("refetch the row").
    // tests/taskEditEvents.ts covers which patches earn which event.
    const renamed = await busEventsFor(t.id, async () => {
      await patchTask(new Request("http://test", { method: "PATCH", body: JSON.stringify({ title: "renamed" }) }), params(t.id));
    });
    expect(renamed).toEqual([{ type: "task_edited" }]);
  });

  it("/clear publishes task_updated after settling the row", async () => {
    const project = createProject({ name: "ClearPub" });
    const t = createTask({ project_id: project.id, title: "T" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1, started: 1 });

    const seen = await busEventsFor(t.id, async () => {
      const res = await clearRoute(new Request("http://test/clear", { method: "POST" }), params(t.id));
      expect(res.status).toBe(200);
    });
    // Row settled first (the /api/events payload re-reads it), then announced.
    expect(getTask(t.id)).toMatchObject({ generation: 2, running: 0, awaiting_input: 0, status: "in_progress" });
    expect(seen).toContainEqual({ type: "task_updated" });
  });

  it("DELETE publishes task_deleted AFTER the row is gone, with the recomputed count", async () => {
    const project = createProject({ name: "DelPub" });
    const t = createTask({ project_id: project.id, title: "Doomed" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1, running: 1 }); // parked on an ask
    const other = createTask({ project_id: project.id, title: "Still waiting" });
    updateTask(other.id, { status: "in_progress", awaiting_input: 1 });
    expect(countAwaiting(project.id)).toBe(2);

    const rowGoneAtPublish: boolean[] = [];
    const unsub = subscribeGlobal((tid, ev) => {
      if (tid === t.id && ev.type === "task_deleted") rowGoneAtPublish.push(!getTask(t.id));
    });
    const seen = await busEventsFor(t.id, async () => {
      const res = await deleteTaskRoute(new Request("http://test", { method: "DELETE" }), params(t.id));
      expect(res.status).toBe(200);
    });
    unsub();

    expect(seen).toContainEqual({ type: "task_deleted", projectId: project.id, awaiting_count: 1 });
    expect(rowGoneAtPublish).toEqual([true]); // published after the hard delete
  });
});

describe("GET /api/events wire relay", () => {
  it("relays task_updated as a coarse task snapshot and task_deleted without a row to re-read", async () => {
    const project = createProject({ name: "WireRelay" });
    const t = createTask({ project_id: project.id, title: "T" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1, running: 1 });

    const ac = new AbortController();
    const res = await eventsRoute(new Request("http://test/api/events", { signal: ac.signal }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Next `data:` frame off the stream, skipping comments/keep-alives.
    const nextData = async (): Promise<unknown> => {
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed before the expected frame");
        buf += decoder.decode(value);
      }
    };

    try {
      // A route settle on a live row produces the usual re-read-the-task
      // payload, with the mid-turn ask park (running + awaiting) counted.
      publishGlobal(t.id, { type: "task_updated" });
      expect(await nextData()).toMatchObject({
        type: "task", event: "task_updated", taskId: t.id, projectId: project.id,
        running: true, awaiting_input: true, awaiting_count: 1,
      });

      // Deletion: the getTask bail can't apply, since the event carries everything.
      deleteTask(t.id);
      publishGlobal(t.id, { type: "task_deleted", projectId: project.id, awaiting_count: 0 });
      expect(await nextData()).toEqual({ type: "task_deleted", taskId: t.id, projectId: project.id, awaiting_count: 0 });
    } finally {
      ac.abort();
    }
  });
});
