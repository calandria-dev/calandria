// What POST /api/tasks/reorder announces on the bus.
//
// A board drag rewrites every task's `position`, and `position` is a fact the
// coarse /api/events payload can't carry — it isn't on the wire, or even on the
// client's TaskRow; the list endpoint just returns rows already sorted. So a
// drop in one tab left every OTHER tab drawing the old card order until it
// reloaded. It can't ride on task_edited either: the fact is project-wide, not
// about the dragged row, so it gets its own project-keyed event that skips the
// relay's re-read-the-task enrichment (like task_deleted).
//
// The other half is volume: the client fires reorder on EVERY drop, including
// one that changes nothing, so the store only reports the projects whose
// rendered order actually moved — see lib/store.ts reorderTasks.
import { afterEach, describe, expect, it } from "vitest";
import { POST as reorderRoute } from "@/app/api/tasks/reorder/route";
import { GET as eventsRoute } from "@/app/api/events/route";
import { createProject, createTask, deleteTask, listTasks } from "@/lib/store";
import { publishGlobal, subscribeGlobal, type BusEvent } from "@/lib/events";

async function reorder(ids: string[]) {
  return reorderRoute(new Request("http://test/api/tasks/reorder", { method: "POST", body: JSON.stringify({ ids }) }));
}

let unsub = () => {};
afterEach(() => unsub());

/** Mutation events published while `run` was in flight. */
async function published(run: () => Promise<unknown>): Promise<BusEvent[]> {
  const seen: BusEvent[] = [];
  unsub = subscribeGlobal((_id, ev) => seen.push(ev));
  try {
    await run();
  } finally {
    unsub();
    unsub = () => {};
  }
  return seen;
}

describe("POST /api/tasks/reorder mutation events", () => {
  it("publishes tasks_reordered, keyed on the project, when a card moves", async () => {
    const project = createProject({ name: "Drag" });
    const a = createTask({ project_id: project.id, title: "A" });
    const b = createTask({ project_id: project.id, title: "B" });
    const c = createTask({ project_id: project.id, title: "C" });

    const seen = await published(() => reorder([c.id, a.id, b.id]));

    expect(seen).toEqual([{ type: "tasks_reordered", projectId: project.id }]);
    // The order the other tabs will refetch.
    expect(listTasks(project.id).map((t) => t.title)).toEqual(["C", "A", "B"]);
  });

  it("stays silent when the drop lands the card back where it started", async () => {
    // The client POSTs the whole list on every drop, so a picked-up-and-put-back
    // card submits the order it already had. Publishing on the submission rather
    // than the change would cost every open tab a tray refetch for nothing.
    const project = createProject({ name: "No-op drop" });
    const a = createTask({ project_id: project.id, title: "A" });
    const b = createTask({ project_id: project.id, title: "B" });

    expect(await published(() => reorder([a.id, b.id]))).toEqual([]);
  });

  it("stays silent when renumbering gap-filled positions moves no card", async () => {
    // Positions go non-contiguous when a task is deleted (0, 1, 3), so the next
    // drop rewrites a row's position without changing what anyone renders.
    const project = createProject({ name: "Gaps" });
    const a = createTask({ project_id: project.id, title: "A" });
    const b = createTask({ project_id: project.id, title: "B" });
    const c = createTask({ project_id: project.id, title: "C" });
    deleteTask(b.id);
    expect([a.position, c.position]).toEqual([0, 2]);

    expect(await published(() => reorder([a.id, c.id]))).toEqual([]);
    // The write still happened — it just wasn't news.
    expect(listTasks(project.id).map((t) => t.position)).toEqual([0, 1]);
  });

  it("compares per suggested group, the way the tray reads it", async () => {
    // The board submits ONE flat list with the Suggested column at the FRONT,
    // while listTasks sorts suggestions LAST. Comparing the raw sequences would
    // call every drop a change.
    const project = createProject({ name: "Grouped" });
    const a = createTask({ project_id: project.id, title: "A" });
    const b = createTask({ project_id: project.id, title: "B" });
    const s1 = createTask({ project_id: project.id, title: "S1", suggested: true });
    const s2 = createTask({ project_id: project.id, title: "S2", suggested: true });
    expect(listTasks(project.id).map((t) => t.title)).toEqual(["A", "B", "S1", "S2"]);

    // Suggested first, as the board flattens it — same rendered order.
    expect(await published(() => reorder([s1.id, s2.id, a.id, b.id]))).toEqual([]);
    // Interleaved: still only the within-group order counts.
    expect(await published(() => reorder([a.id, s1.id, b.id, s2.id]))).toEqual([]);
    // Moving a card WITHIN the suggested group is a real change.
    expect(await published(() => reorder([s2.id, s1.id, a.id, b.id]))).toEqual([
      { type: "tasks_reordered", projectId: project.id },
    ]);
    expect(listTasks(project.id).map((t) => t.title)).toEqual(["A", "B", "S2", "S1"]);
  });

  it("names each project it moved, and only those", async () => {
    // The UI can only ever submit one project's tasks; a hand-crafted call
    // spanning projects gets an event per project rather than a wrong guess
    // from ids[0] — and the untouched project stays quiet.
    const p1 = createProject({ name: "Mixed 1" });
    const p2 = createProject({ name: "Mixed 2" });
    const a = createTask({ project_id: p1.id, title: "A" });
    const b = createTask({ project_id: p1.id, title: "B" });
    const c = createTask({ project_id: p2.id, title: "C" });
    const d = createTask({ project_id: p2.id, title: "D" });

    expect(await published(() => reorder([b.id, a.id, c.id, d.id]))).toEqual([
      { type: "tasks_reordered", projectId: p1.id },
    ]);
    expect(await published(() => reorder([b.id, a.id, d.id, c.id]))).toEqual([
      { type: "tasks_reordered", projectId: p2.id },
    ]);
  });

  it("stays silent on an empty or unrecognized list", async () => {
    const project = createProject({ name: "Nothing" });
    createTask({ project_id: project.id, title: "A" });

    expect(await published(() => reorder([]))).toEqual([]);
    expect(await published(() => reorder(["gone", "also-gone"]))).toEqual([]);
  });

  it("rejects a body that isn't a list of ids", async () => {
    const res = await reorderRoute(
      new Request("http://test/api/tasks/reorder", { method: "POST", body: JSON.stringify({ ids: [1, 2] }) })
    );
    expect(res.status).toBe(400);
  });

  it("relays project-keyed, skipping the relay's task re-read", async () => {
    // GET /api/events normally re-reads the task the event is keyed on and
    // drops the event when the row is gone. This one is about a project, so the
    // bus key is an arbitrary member of the reordered set — it has to bypass
    // that read, or a task deleted between the drag and the relay would swallow
    // every other tab's redraw.
    const project = createProject({ name: "Relay" });
    const ac = new AbortController();
    const res = await eventsRoute(new Request("http://test/api/events", { signal: ac.signal }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const nextData = async (): Promise<Record<string, unknown>> => {
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
      publishGlobal("a-task-that-no-longer-exists", { type: "tasks_reordered", projectId: project.id });
      expect(await nextData()).toEqual({ type: "tasks_reordered", projectId: project.id });
    } finally {
      ac.abort();
    }
  });
});
