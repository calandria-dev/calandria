import { describe, it, expect, beforeEach, vi } from "vitest";

// Background linger: each turn is one SDK query whose CLI process owns both
// the run_in_background children and the in-memory registry that promises
// "you'll be notified when it completes" — so ending the query at result time
// kills the work silently (measured on CLI 2.1.240: the CLI gives tasks a ~5s
// grace after the result, then kills them). The driver therefore runs every
// turn in streaming-input mode, holds the prompt iterable open, and decides at
// each result — from the Stop hook's `background_tasks` payload, the
// SDK-documented "session is paused waiting for background work" signal —
// whether to close the input or linger for the task_notification wake.
//
// The SDK is mocked at its module boundary, so the REAL driver runs the real
// state machine and the mock plays the CLI's measured behavior back at it:
// Stop hook before every result, notification → wake turn with no user
// message, input close → exit. The runner half of the file feeds the same mock
// through lib/runner.ts and asserts the persisted background_pending state.

// Shrink the linger window BEFORE the module graph loads (lib/config.ts reads
// env at import): the expiry test waits this long for real.
const { queryMock } = vi.hoisted(() => {
  process.env.ORCH_BACKGROUND_LINGER_MS = "500";
  return { queryMock: vi.fn() };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => ({ type: "sdk", ...(cfg as object) }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { claudeDriver } from "@/lib/agents/claude/driver";
import { sendTurnInput } from "@/lib/turnInput";
import { createProject, createTask, getTask, listMessages, getTaskUsage } from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import type { Project, Task, StreamEvent, TaskStreamEvent } from "@/lib/types";

// --- the scripted CLI ---

type StopHook = (input: unknown) => Promise<unknown>;
type QueryArgs = {
  prompt: AsyncIterable<unknown>;
  options: { hooks?: { Stop?: { hooks: StopHook[] }[] } };
};
type CliIo = {
  /** Fire the driver's Stop hook — the CLI does this before every result,
   *  carrying both the in-flight background tasks and the session crons. */
  stop: (tasks?: unknown[], crons?: unknown[]) => Promise<void>;
  /** Read the streaming prompt. The second read resolves `{done: true}` only
   *  when the driver releases the held-open iterable — the close signal. */
  nextInput: () => Promise<IteratorResult<unknown>>;
};

function mockCli(run: (io: CliIo) => AsyncGenerator<unknown>): void {
  queryMock.mockImplementation((args: QueryArgs) => {
    const it = (args.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    const hooks = args.options.hooks?.Stop?.[0]?.hooks ?? [];
    return run({
      stop: async (tasks = [], crons = []) => {
        for (const h of hooks) await h({ background_tasks: tasks, session_crons: crons });
      },
      nextInput: () => it.next(),
    });
  });
}

// A one-shot ScheduleWakeup as the Stop hook reports it (measured): only the
// wall-clock minute is encoded, local time, so it fires at a minute boundary
// — which on this file's 500ms-bounded instance is ALWAYS beyond the window.
// That makes this suite the "won't be honored" half of the cron policy; the
// wake path needs the unbounded default and lives in claudeCronLinger.test.ts.
function oneShotIn(minutes: number) {
  const d = new Date(Date.now() + minutes * 60_000);
  return { id: "w1", schedule: `${d.getMinutes()} ${d.getHours()} * * *`, recurring: false, prompt: "WAKE: check the build" };
}

const BG = [{ id: "bg1", type: "shell", status: "running", description: "sleep 5", command: "sleep 5" }];
const init = { type: "system", subtype: "init", session_id: "sess-1" };
const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const result = (cost: number, usage: Record<string, number>) => ({ type: "result", subtype: "success", result: "ok", total_cost_usd: cost, usage });
const notification = (status: string, summary: string) => ({ type: "system", subtype: "task_notification", task_id: "bg1", status, summary, output_file: "/x" });

const project = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "" } as Project;
const task = { id: "t1", agent: "claude", title: "T", description: "", session_id: null, worktree_path: "", generation: 1 } as unknown as Task;

async function drain(): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of claudeDriver.runTurn(task, project, "go")) events.push(ev);
  return events;
}

beforeEach(() => {
  queryMock.mockReset();
});

describe("claude driver background linger", () => {
  it("holds the query open past a result with pending work, and surfaces the wake", async () => {
    // Asserted from inside the mock: input must NOT close while work is
    // pending, and MUST close after the empty-pending result.
    let inputClosedEarly = false;
    let lingerOver = false;
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput(); // CLI reads the user message
      yield init;
      yield text("started");
      await stop(BG); // turn ends with a background task running
      yield result(0.05, { input_tokens: 4, output_tokens: 120 });
      // The driver is now lingering: this read must stay parked until the
      // legitimate close at the end (async generators queue next() calls, so
      // the final read below still resolves too). Settling before the
      // notification is the bug this feature exists to fix.
      void nextInput().then(() => { if (!lingerOver) inputClosedEarly = true; });
      await Promise.resolve(); // give a wrongly-closed input a chance to settle
      lingerOver = true;
      yield notification("completed", "Background command completed (exit code 0)");
      yield init; // the wake re-inits the same session (measured)
      yield text("bg done");
      await stop([]); // wake turn ends with nothing pending
      yield result(0.06, { input_tokens: 2, output_tokens: 11 });
      const end = await nextInput(); // resolves once the driver closes the input
      expect(end.done).toBe(true);
    });

    const events = await drain();
    expect(inputClosedEarly).toBe(false);

    const pending = events.find((e) => e.type === "background_pending");
    expect(pending).toEqual({
      type: "background_pending",
      tasks: [{ id: "bg1", kind: "shell", description: "sleep 5" }],
      note: "working in background",
    });
    const resumed = events.find((e) => e.type === "background_resumed");
    expect(resumed).toEqual({
      type: "background_resumed",
      status: "completed",
      summary: "Background command completed (exit code 0)",
    });
    // Ordering: linger enters after the first turn's usage, wake precedes the
    // continuation's text.
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf("background_pending")).toBeGreaterThan(kinds.indexOf("usage"));
    expect(kinds.indexOf("background_resumed")).toBeLessThan(kinds.lastIndexOf("assistant"));
    expect(kinds[kinds.length - 1]).toBe("done");

    // Cost is a cumulative session total on the wire (measured), per-segment
    // tokens — the driver must report the DELTA or wake turns re-bill the
    // whole session.
    const usages = events.filter((e): e is Extract<StreamEvent, { type: "usage" }> => e.type === "usage");
    expect(usages).toHaveLength(2);
    expect(usages[0].usage.cost_usd).toBeCloseTo(0.05);
    expect(usages[1].usage.cost_usd).toBeCloseTo(0.01);
    expect(usages[1].usage.output_tokens).toBe(11);
  });

  it("closes the input straight away when nothing is pending", async () => {
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("hi");
      await stop([]);
      yield result(0.01, { input_tokens: 1, output_tokens: 2 });
      const end = await nextInput();
      expect(end.done).toBe(true);
    });
    const events = await drain();
    expect(events.some((e) => e.type === "background_pending")).toBe(false);
    expect(events.some((e) => e.type === "background_resumed")).toBe(false);
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("gives up at the linger deadline with a transcript notice, and mutes the kill notifications", async () => {
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("started");
      await stop(BG);
      yield result(0.05, { input_tokens: 4, output_tokens: 9 });
      // Never send the completion. The driver must cut the linger at the
      // deadline (500ms here) by closing the input...
      const end = await nextInput();
      expect(end.done).toBe(true);
      // ...upon which the real CLI kills the task and reports it — noise the
      // driver must not re-surface as a wake.
      yield notification("stopped", "Background command killed");
    });
    const events = await drain();
    const notice = events.find((e) => e.type === "notice");
    expect(notice && "content" in notice ? notice.content : "").toMatch(/exceeded the linger window/);
    expect(notice && "content" in notice ? notice.content : "").toMatch(/sleep 5/);
    expect(events.some((e) => e.type === "background_resumed")).toBe(false);
    expect(events[events.length - 1]?.type).toBe("done");
  }, 10_000);

  it("restarts the deadline when the user speaks mid-linger", async () => {
    // The deadline is fixed from the FIRST linger entry on purpose (a wake
    // turn must not let a task chain sleeps forever) — but a message from the
    // user is not the session extending itself, it's a human sitting there
    // watching. Cutting their reply off 300ms into it, because a clock started
    // before they spoke, is the auto-cut destroying work nobody asked it to.
    let firstLingerAt = 0;
    let closedAt = 0;
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("started");
      await stop(BG);
      yield result(0.05, { input_tokens: 4, output_tokens: 9 });
      firstLingerAt = Date.now();
      // Speak 200ms into a 500ms window, so a deadline that did NOT reset
      // would cut the injected turn's own linger 300ms later.
      await new Promise((r) => setTimeout(r, 200));
      expect(sendTurnInput("t1", "how is it going?")).toBe(true);
      expect((await nextInput()).done).toBe(false);
      yield init;
      yield text("still running");
      await stop(BG);
      yield result(0.06, { input_tokens: 2, output_tokens: 11 });
      const end = await nextInput();
      closedAt = Date.now();
      expect(end.done).toBe(true);
    });
    const events = await drain();
    // A window anchored at the first entry would have closed at +500ms.
    expect(closedAt - firstLingerAt).toBeGreaterThan(620);
    // Still bounded, just from the new anchor — the work is cut and named.
    const notice = events.find((e) => e.type === "notice");
    expect(notice && "content" in notice ? notice.content : "").toMatch(/exceeded the linger window/);
  }, 10_000);
});

describe("session crons on a bounded instance (won't be honored)", () => {
  // Measured: a cron fires only while the CLI is alive, and closing the input
  // exits it within ~300ms with the wake simply gone. So a wakeup the driver
  // won't wait for must be NAMED when the input closes, or the model's next
  // turn and the user both sit waiting on a wake that died with the process.
  it("closes at result time and appends a notice naming the cancelled wakeup", async () => {
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("SCHEDULED");
      await stop([], [oneShotIn(2)]); // nothing in flight, one wakeup two minutes out
      yield result(0.01, { input_tokens: 1, output_tokens: 2 });
      const end = await nextInput();
      expect(end.done).toBe(true);
    });
    const events = await drain();
    expect(events.some((e) => e.type === "background_pending")).toBe(false);
    const notice = events.find((e) => e.type === "notice");
    const content = notice && "content" in notice ? notice.content : "";
    expect(content).toMatch(/^⏰ Scheduled wakeup cancelled — beyond this instance's 0-minute linger window: at \d\d:\d\d — "WAKE: check the build"\. It will not fire/);
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("still lingers for background work, naming the out-of-window wakeup beside the wait", async () => {
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("started");
      await stop(BG, [oneShotIn(2)]);
      yield result(0.05, { input_tokens: 4, output_tokens: 9 });
      yield notification("completed", "Background command completed (exit code 0)");
      yield init;
      yield text("bg done");
      await stop([], [oneShotIn(2)]); // the wake is still registered on the wake turn
      yield result(0.06, { input_tokens: 2, output_tokens: 11 });
      const end = await nextInput();
      expect(end.done).toBe(true);
    });
    const events = await drain();
    const pending = events.find((e): e is Extract<StreamEvent, { type: "background_pending" }> => e.type === "background_pending");
    // The wait is for the shell task only — the cron isn't in the pending set.
    expect(pending?.tasks.map((t) => t.kind)).toEqual(["shell"]);
    expect(pending?.note).toBe("working in background");
    // Named ONCE, at linger entry (nothing later re-plans it) — the wake turn's
    // Stop reports the same doomed cron again and its close must not repeat
    // the notice.
    const notices = events.filter((e) => e.type === "notice").map((e) => ("content" in e ? e.content : ""));
    expect(notices.filter((n) => n.includes("Scheduled wakeup cancelled"))).toHaveLength(1);
    expect(events.find((e) => e.type === "background_resumed")).toMatchObject({ status: "completed" });
  });
});

describe("runner + driver background linger (persisted state)", () => {
  // The same scripted CLI, now reached through the REAL runner via the real
  // registry — asserting what a reload or another tab would actually see:
  // the tasks row, the transcript, the usage ledger.
  function collect(taskId: string): { events: TaskStreamEvent[]; done: Promise<void> } {
    const events: TaskStreamEvent[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const unsub = subscribe(taskId, (ev) => {
      events.push(ev);
      if (ev.type === "turn_end") {
        unsub();
        resolve();
      }
    });
    return { events, done };
  }

  it("persists background_pending through the linger and settles it with the turn", async () => {
    const proj = createProject({ name: "Linger" });
    const row = createTask({ project_id: proj.id, title: "T", description: "" });

    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("started");
      await stop(BG);
      yield result(0.05, { input_tokens: 4, output_tokens: 120 });
      yield notification("completed", "Background command completed (exit code 0)");
      yield init;
      yield text("bg done");
      await stop([]);
      yield result(0.06, { input_tokens: 2, output_tokens: 11 });
      await nextInput();
    });

    // The runner persists BEFORE publishing, so the row read inside the
    // subscription callback is the authoritative mid-linger state.
    const seen: Record<string, { background_pending: number; running: number; awaiting_input: number }> = {};
    const snap = (label: string) => {
      const t = getTask(row.id)!;
      seen[label] = { background_pending: t.background_pending, running: t.running, awaiting_input: t.awaiting_input };
    };
    const { events, done } = collect(row.id);
    const unsub = subscribe(row.id, (ev) => {
      if (ev.type === "background_pending") snap("pending");
      if (ev.type === "background_resumed") snap("resumed");
    });
    await startResumeTurn(getTask(row.id)!, proj, "go");
    await done;
    unsub();

    // Mid-linger: a distinct "working in background" state — live (running
    // stays 1, so Stop and the SIGTERM drain still own it) but explicitly NOT
    // waiting on the user (awaiting_input 0 keeps it out of the "N need you"
    // pill).
    expect(seen.pending).toEqual({ background_pending: 1, running: 1, awaiting_input: 0 });
    // The wake clears the indicator before the continuation streams.
    expect(seen.resumed).toEqual({ background_pending: 0, running: 1, awaiting_input: 0 });
    // Settled: an ordinary ended turn.
    const after = getTask(row.id)!;
    expect(after.background_pending).toBe(0);
    expect(after.running).toBe(0);
    expect(after.awaiting_input).toBe(1);

    // The wake is on the durable transcript: a system line carrying the CLI's
    // own summary explains the continuation to a reload.
    const messages = listMessages(row.id);
    expect(messages.some((m) => m.role === "system" && m.content.includes("Background command completed"))).toBe(true);
    // Both turn segments' assistant text persisted in order.
    const texts = messages.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(texts).toEqual(["started", "bg done"]);

    // Spend: two usage rows whose costs are the session deltas, not the raw
    // cumulative totals (which would double-bill the first segment).
    const usage = getTaskUsage(row.id);
    expect(usage.cost_usd).toBeCloseTo(0.06);

    // The wire carried both linger boundaries for the global stream to coarsen.
    expect(events.some((e) => e.type === "background_pending")).toBe(true);
    expect(events.some((e) => e.type === "background_resumed")).toBe(true);
  });
});
