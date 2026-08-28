import { describe, it, expect, beforeEach, vi } from "vitest";

// Session-scoped wakeups (ScheduleWakeup / CronCreate / /loop) under the
// UNBOUNDED linger default — its own file because claudeBackgroundLinger.test.ts
// pins CALANDRIA_BACKGROUND_LINGER_MS=500 at module load, and a cron fires at a
// minute boundary, so on that instance no wakeup can ever fit the window.
//
// Measured on claude CLI 2.1.240 / SDK 0.3.159 (record in the commit): with
// the prompt iterable held open a session cron DOES fire; the wake arrives as
// a bare second `init` on the same session — no user message, no
// task_notification — followed by a fresh assistant turn; the Stop hook
// reports the cron before the first result and `[]` after a one-shot wakes,
// while a recurring cron is reported again on every wake turn. Closing the
// input with a cron pending exits the CLI in ~300ms and the wake is gone.
const { queryMock } = vi.hoisted(() => {
  delete process.env.CALANDRIA_BACKGROUND_LINGER_MS;
  delete process.env.CALANDRIA_BACKGROUND_LINGER;
  return { queryMock: vi.fn() };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => ({ type: "sdk", ...(cfg as object) }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { claudeDriver } from "@/lib/agents/claude/driver";
import { buildProjectContext } from "@/lib/agents/shared";
import { createProject, createTask, getTask, listMessages } from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import type { Project, Task, StreamEvent, TaskStreamEvent } from "@/lib/types";

type StopHook = (input: unknown) => Promise<unknown>;
type QueryArgs = { prompt: AsyncIterable<unknown>; options: { hooks?: { Stop?: { hooks: StopHook[] }[] } } };
type CliIo = {
  stop: (tasks?: unknown[], crons?: unknown[]) => Promise<void>;
  nextInput: () => Promise<IteratorResult<unknown>>;
};

function mockCli(run: (io: CliIo) => AsyncGenerator<unknown>): void {
  queryMock.mockImplementation((args: QueryArgs) => {
    const it = args.prompt[Symbol.asyncIterator]();
    const hooks = args.options.hooks?.Stop?.[0]?.hooks ?? [];
    return run({
      stop: async (tasks = [], crons = []) => {
        for (const h of hooks) await h({ background_tasks: tasks, session_crons: crons });
      },
      nextInput: () => it.next(),
    });
  });
}

const init = { type: "system", subtype: "init", session_id: "sess-1" };
const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const result = (cost: number) => ({ type: "result", subtype: "success", result: "ok", total_cost_usd: cost, usage: { input_tokens: 1, output_tokens: 2 } });
const BG = [{ id: "bg1", type: "shell", status: "running", description: "sleep 5", command: "sleep 5" }];
// One-shot as the Stop hook reports it: wall-clock minute only, local time.
function oneShotIn(minutes: number, id = "w1") {
  const d = new Date(Date.now() + minutes * 60_000);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return { cron: { id, schedule: `${d.getMinutes()} ${d.getHours()} * * *`, recurring: false, prompt: "WAKE: check the build" }, hhmm };
}
const LOOP = { id: "l1", schedule: "* * * * *", recurring: true, prompt: "TICK: poll CI" };

const project = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "" } as Project;
const task = { id: "t1", agent: "claude", title: "T", description: "", session_id: null, worktree_path: "", generation: 1 } as unknown as Task;

async function drain(): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of claudeDriver.runTurn(task, project, "go")) events.push(ev);
  return events;
}
const pendings = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { type: "background_pending" }> => e.type === "background_pending");
const resumes = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { type: "background_resumed" }> => e.type === "background_resumed");
const notices = (events: StreamEvent[]) => events.filter((e) => e.type === "notice").map((e) => ("content" in e ? e.content : ""));

beforeEach(() => {
  queryMock.mockReset();
});

describe("one-shot wakeup (unbounded linger)", () => {
  it("lingers on the wakeup and treats the bare wake init as the resume signal", async () => {
    const { cron, hhmm } = oneShotIn(2);
    let inputClosedEarly = false;
    let lingerOver = false;
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("SCHEDULED");
      await stop([], [cron]);
      yield result(0.03);
      void nextInput().then(() => { if (!lingerOver) inputClosedEarly = true; });
      await Promise.resolve();
      lingerOver = true;
      // The wake: a second init on the same session, nothing else (measured).
      yield init;
      yield text("DONE");
      await stop([], []); // the one-shot is consumed
      yield result(0.04);
      const end = await nextInput();
      expect(end.done).toBe(true);
    });
    const events = await drain();
    expect(inputClosedEarly).toBe(false);

    const [pending] = pendings(events);
    expect(pending.tasks).toEqual([{ id: "w1", kind: "wakeup", description: "WAKE: check the build", wakeAt: expect.any(Number) }]);
    expect(pending.note).toBe(`waiting to wake at ${hhmm}`);
    const [resumed] = resumes(events);
    expect(resumed).toEqual({ type: "background_resumed", status: "woke", summary: `Scheduled wakeup fired (${hhmm}): WAKE: check the build` });
    // Wake precedes the continuation's text; nothing was cancelled.
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf("background_resumed")).toBeLessThan(kinds.lastIndexOf("assistant"));
    expect(notices(events)).toEqual([]);
    expect(kinds[kinds.length - 1]).toBe("done");
  });

  it("names the wakeup when the session dies under it (transport error → close)", async () => {
    const { cron, hhmm } = oneShotIn(3);
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("SCHEDULED");
      await stop([], [cron]);
      yield result(0.03);
      throw new Error("transport died");
    });
    const events = await drain();
    expect(pendings(events)).toHaveLength(1);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(notices(events)).toEqual([
      `⏰ Scheduled wakeup cancelled (the session closed before it fired): at ${hhmm}, "WAKE: check the build". It will not fire; nothing re-invokes this session on its own.`,
    ]);
  });

  it("does not mistake a background task's wake init for a cron wake", async () => {
    // Order measured for background tasks: task_notification, THEN init. The
    // notification is that path's resume; the init behind it must be inert,
    // and with no cron in the wait it can't be claimed as a "woke".
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("started");
      await stop(BG, []);
      yield result(0.05);
      yield { type: "system", subtype: "task_notification", task_id: "bg1", status: "completed", summary: "Background command completed (exit code 0)", output_file: "/x" };
      yield init;
      yield text("bg done");
      await stop([], []);
      yield result(0.06);
      await nextInput();
    });
    const events = await drain();
    expect(resumes(events).map((r) => r.status)).toEqual(["completed"]);
  });
});

describe("recurring cron (/loop shape)", () => {
  it("re-enters the linger after every wake, and is reported as a loop on the row", async () => {
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("SCHEDULED");
      await stop([], [LOOP]);
      yield result(0.01);
      for (const n of [1, 2]) {
        yield init; // tick
        yield text(`TICKED ${n}`);
        await stop([], [LOOP]); // survives its own wake (measured)
        yield result(0.01 * (n + 1));
      }
      // The model finally deletes it (CronDelete) — Stop reports nothing.
      yield init;
      yield text("stopping the loop");
      await stop([], []);
      yield result(0.05);
      const end = await nextInput();
      expect(end.done).toBe(true);
    });
    const events = await drain();
    expect(pendings(events)).toHaveLength(3);
    for (const p of pendings(events)) {
      expect(p.tasks[0]).toMatchObject({ id: "l1", kind: "cron", description: "TICK: poll CI" });
      expect(p.note).toMatch(/^wakes on `\* \* \* \* \*`, next \d\d:\d\d$/);
    }
    expect(resumes(events).map((r) => r.status)).toEqual(["woke", "woke", "woke"]);
    expect(resumes(events)[0].summary).toBe("Scheduled wakeup fired (`* * * * *`): TICK: poll CI");
    expect(notices(events)).toEqual([]);
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("tells the model the unbounded wakeup policy up front", () => {
    const ctx = buildProjectContext(project, task);
    expect(ctx).toContain("keep running after your turn ends");
    expect(ctx).toContain("Scheduled wakeups (ScheduleWakeup, CronCreate) are honored the same way");
    expect(ctx).toContain("a recurring one keeps it open until you delete it or the user stops the session");
    // The self-matching watcher loop belongs to the unbounded branch: nothing
    // cuts it, so it holds the session open indefinitely.
    expect(ctx).toContain(`while pgrep -f "vitest"; do sleep 20; done`);
    expect(ctx).toContain("matches ITSELF and never exits");
  });
});

describe("runner + driver cron linger (persisted state)", () => {
  it("persists the wake note on the row, clears it on wake, and records the wake as a system line", async () => {
    const proj = createProject({ name: "Cron" });
    const row = createTask({ project_id: proj.id, title: "T", description: "" });
    const { cron, hhmm } = oneShotIn(2);

    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("SCHEDULED");
      await stop([], [cron]);
      yield result(0.03);
      yield init;
      yield text("DONE");
      await stop([], []);
      yield result(0.04);
      await nextInput();
    });

    const seen: Record<string, { background_pending: number; background_note: string; running: number; awaiting_input: number }> = {};
    const snap = (label: string) => {
      const t = getTask(row.id)!;
      seen[label] = { background_pending: t.background_pending, background_note: t.background_note, running: t.running, awaiting_input: t.awaiting_input };
    };
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const unsub = subscribe(row.id, (ev: TaskStreamEvent) => {
      if (ev.type === "background_pending") snap("pending");
      if (ev.type === "background_resumed") snap("resumed");
      if (ev.type === "turn_end") resolveDone();
    });
    await startResumeTurn(getTask(row.id)!, proj, "go");
    await done;
    unsub();

    expect(seen.pending).toEqual({ background_pending: 1, background_note: `waiting to wake at ${hhmm}`, running: 1, awaiting_input: 0 });
    expect(seen.resumed).toEqual({ background_pending: 0, background_note: "", running: 1, awaiting_input: 0 });
    const after = getTask(row.id)!;
    expect(after.background_pending).toBe(0);
    expect(after.background_note).toBe("");
    expect(after.running).toBe(0);

    const messages = listMessages(row.id);
    expect(messages.some((m) => m.role === "system" && m.content.includes(`Scheduled wakeup fired (${hhmm}): WAKE: check the build`))).toBe(true);
    expect(messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["SCHEDULED", "DONE"]);
  });
});
