import { describe, it, expect, beforeEach, vi } from "vitest";

// Sending a message into a LINGERING session: the follow-up to
// linger-until-quiet. A message sent while the turn is lingering is
// injected directly into the driver's still-open prompt iterable instead of
// being parked in pending_messages, since nothing is in flight and the
// linger may have no deadline.
//
// The injected turn announces itself as a bare second `init` with no user
// echo on the wire, identical in shape to a scheduled wakeup's init, which
// is the hazard the third test in this file pins: an injected turn must
// never be read as a wakeup firing. The injected turn's own Stop hook still
// reports whatever work the session was lingering on, so the driver
// re-enters the linger instead of closing the input while that work is
// still running, and a pending wakeup is not consumed by the injected turn,
// so it still fires afterward.
//
// This file uses an unbounded linger (the default), so it deletes the
// bounded override that claudeBackgroundLinger.test.ts sets, since env
// leaks across files sharing a worker.
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
import { createProject, createTask, getTask, listMessages, listPendingMessages, addPendingMessage } from "@/lib/store";
import { startResumeTurn, sendToLingeringTurn } from "@/lib/runner";
import { sendTurnInput } from "@/lib/turnInput";
import { subscribe, publish } from "@/lib/events";
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
const notification = (status: string, summary: string) => ({ type: "system", subtype: "task_notification", task_id: "bg1", status, summary, output_file: "/x" });
const BG = [{ id: "bg1", type: "shell", status: "running", description: "sleep 600", command: "sleep 600" }];
function oneShotIn(minutes: number) {
  const d = new Date(Date.now() + minutes * 60_000);
  return { id: "w1", schedule: `${d.getMinutes()} ${d.getHours()} * * *`, recurring: false, prompt: "WAKE: check the build" };
}

// What the CLI read off the wire, as text. The injected message must arrive
// in exactly the shape the opening prompt does.
const sent = (r: IteratorResult<unknown>): string =>
  (r.value as { message?: { content?: string } } | undefined)?.message?.content ?? "";

const project = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "" } as Project;
const task = { id: "t1", agent: "claude", title: "T", description: "", session_id: null, worktree_path: "", generation: 1 } as unknown as Task;

async function drain(): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of claudeDriver.runTurn(task, project, "go")) events.push(ev);
  return events;
}
const resumes = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { type: "background_resumed" }> => e.type === "background_resumed");
const pendings = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { type: "background_pending" }> => e.type === "background_pending");

beforeEach(() => {
  queryMock.mockReset();
});

describe("the driver's mid-turn input channel", () => {
  it("yields a message sent mid-linger straight into the open session", async () => {
    let accepted: boolean | null = null;
    mockCli(async function* ({ stop, nextInput }) {
      expect(sent(await nextInput())).toBe("go");
      yield init;
      yield text("started the build");
      await stop(BG);
      yield result(0.05);
      // The driver is lingering now: nothing is in flight, the input is open.
      accepted = sendTurnInput("t1", "while that runs, check the logs too");
      const injected = await nextInput();
      expect(injected.done).toBe(false);
      expect(sent(injected)).toBe("while that runs, check the logs too");
      // The injected turn announces itself as a bare second init.
      yield init;
      yield text("on it");
      await stop(BG); // the background task is still running
      yield result(0.06);
      // ...so the session lingers again, and the eventual completion still wakes it.
      yield notification("completed", "Background command completed (exit code 0)");
      yield init;
      yield text("build is green");
      await stop([]);
      yield result(0.07);
      expect((await nextInput()).done).toBe(true);
    });

    const events = await drain();
    expect(accepted).toBe(true);
    // Two lingers: the original one the message interrupted, and the one the
    // injected turn re-entered because the work is still running.
    expect(pendings(events)).toHaveLength(2);
    // The injected turn is the user's, not a wake: the only resume on the
    // stream is the background task's own completion. A second "⏵ …" line
    // would be the transcript narrating the user's own message back at them.
    expect(resumes(events)).toEqual([
      { type: "background_resumed", status: "completed", summary: "Background command completed (exit code 0)" },
    ]);
    const texts = events.filter((e) => e.type === "assistant").map((e) => ("content" in e ? e.content : ""));
    expect(texts).toEqual(["started the build", "on it", "build is green"]);
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("refuses a message while the model is mid-turn, and once the turn is over", async () => {
    let midTurn: boolean | null = null;
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("thinking");
      // Mid-thought: the message must go to the queue, not into the middle of
      // the model's reasoning. That is what pending_messages is for.
      midTurn = sendTurnInput("t1", "nope");
      await stop([]);
      yield result(0.01);
      expect((await nextInput()).done).toBe(true);
    });
    await drain();
    expect(midTurn).toBe(false);
    // The handle is off the registry once the turn ends, so a late send is
    // refused instead of reaching a session that is gone.
    expect(sendTurnInput("t1", "too late")).toBe(false);
  });

  it("does not read the injected turn's init as a scheduled wakeup firing", async () => {
    // A session lingering on a wakeup reads a bare init as "the wakeup
    // fired". An injected message produces an identical init, so the
    // transcript must not claim a wakeup fired while it is still pending;
    // the re-linger below is what keeps the real wakeup honored.
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("scheduled a wakeup");
      await stop([], [oneShotIn(30)]);
      yield result(0.01);
      expect(sendTurnInput("t1", "actually, do it now")).toBe(true);
      expect(sent(await nextInput())).toBe("actually, do it now");
      yield init;
      yield text("doing it now");
      await stop([], [oneShotIn(30)]); // the wakeup is still registered
      yield result(0.02);
      // ...and the session goes back to waiting for it, on the fresh wait
      // the injected turn re-entered, so the wake still arrives.
      yield init;
      yield text("woke up");
      await stop([], []); // a one-shot is consumed by its wake
      yield result(0.03);
      expect((await nextInput()).done).toBe(true);
    });
    const events = await drain();
    // Exactly one resume: the wakeup's. The injected turn's identical init
    // produces none; otherwise the transcript would announce a wakeup that
    // is still pending.
    expect(resumes(events)).toHaveLength(1);
    expect(resumes(events)[0].status).toBe("woke");
    expect(resumes(events)[0].summary).toMatch(/^Scheduled wakeup fired/);
    // Both lingers name the wakeup. The second is the fresh wait the
    // injected turn re-entered, not a leftover.
    expect(pendings(events).map((p) => p.tasks.map((t) => t.kind))).toEqual([["wakeup"], ["wakeup"]]);
  });
});

describe("runner: a message sent into a lingering turn", () => {
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

  it("persists + publishes it as an ordinary user message and drops the background flag", async () => {
    const proj = createProject({ name: "Inject" });
    const row = createTask({ project_id: proj.id, title: "T", description: "" });

    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("started");
      await stop(BG);
      yield result(0.05);
      // Parked here until the test sends, which it does once the runner has
      // PERSISTED the linger (the runner consumes the driver's events on its
      // own tick, so the row lags the driver's state by one hop).
      expect(sent(await nextInput())).toBe("check the logs too");
      yield init;
      yield text("checked");
      await stop([]);
      yield result(0.06);
      await nextInput();
    });

    const { events, done } = collect(row.id);
    const lingered = new Promise<void>((resolve) => {
      const un = subscribe(row.id, (ev) => {
        if (ev.type !== "background_pending") return;
        un();
        resolve();
      });
    });
    await startResumeTurn(getTask(row.id)!, proj, "go");
    await lingered;

    expect(getTask(row.id)!.background_pending).toBe(1);
    expect(sendToLingeringTurn(row.id, "check the logs too")).toBe(true);
    // Read inside the same tick as the send: the row must already say "not
    // lingering", because every surface that shows it re-reads the row
    // instead of holding the event. `running` stays 1 since the turn never
    // stopped.
    const atSend = getTask(row.id)!;
    expect({ background_pending: atSend.background_pending, background_note: atSend.background_note, running: atSend.running })
      .toEqual({ background_pending: 0, background_note: "", running: 1 });

    await done;

    // On the durable transcript it is exactly a user message: no "queued"
    // bubble, nothing to dequeue, and nothing left parked.
    const messages = listMessages(row.id);
    expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["go", "check the logs too"]);
    expect(listPendingMessages(row.id)).toEqual([]);
    const userEvents = events.filter((e) => e.type === "user").map((e) => ("content" in e ? e.content : ""));
    expect(userEvents).toEqual(["go", "check the logs too"]);
    expect(events.some((e) => e.type === "queued")).toBe(false);
    // Settled like any other turn once the session closes.
    const after = getTask(row.id)!;
    expect(after.running).toBe(0);
    expect(after.background_pending).toBe(0);
  });

  it("drains a follow-up parked mid-thought as soon as the turn starts lingering", async () => {
    // The other half of the order rule: a message queued while the model was
    // thinking is promised delivery at turn end, and a linger is the end of
    // the model's turn. Left parked, it would wait out an unbounded linger
    // for no reason, and a message sent mid-linger would then arrive first.
    const proj = createProject({ name: "Drain" });
    const row = createTask({ project_id: proj.id, title: "T", description: "" });

    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("started");
      await stop(BG);
      yield result(0.05);
      expect(sent(await nextInput())).toBe("also fix the tests");
      yield init;
      yield text("fixing");
      await stop([]);
      yield result(0.06);
      await nextInput();
    });

    const { events, done } = collect(row.id);
    await startResumeTurn(getTask(row.id)!, proj, "go");
    // Parked while the model is still talking, exactly as POST /messages does
    // when the turn slot is claimed and the session isn't lingering.
    const parked = addPendingMessage(row.id, getTask(row.id)!.generation, "also fix the tests");
    publish(row.id, { type: "queued", msgId: parked.id, content: parked.content, generation: parked.generation, ts: parked.created_at });
    await done;

    // It ran inside the lingering session instead of as a fresh turn after
    // it: the queue is empty, its bubble was dequeued, and it reads as a
    // plain user message in the order it was typed.
    expect(listPendingMessages(row.id)).toEqual([]);
    expect(events.some((e) => e.type === "dequeued" && e.msgId === parked.id)).toBe(true);
    expect(listMessages(row.id).filter((m) => m.role === "user").map((m) => m.content)).toEqual(["go", "also fix the tests"]);
    // And with something already parked, a message sent now waits its turn
    // instead of jumping ahead of it. Checking while the queue is non-empty
    // is impossible after the fact, so the rule is pinned on the empty
    // queue's inverse: nothing is left behind.
    expect(getTask(row.id)!.background_pending).toBe(0);
  });

  it("parks a message behind anything already queued rather than jumping it", async () => {
    const proj = createProject({ name: "Order" });
    const row = createTask({ project_id: proj.id, title: "T", description: "" });
    let refused: boolean | null = null;

    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield text("started");
      await stop(BG);
      yield result(0.05);
      // The linger-entry drain takes the FIRST parked message; the second one
      // (sent while the first was still queued) must not overtake it.
      expect(sent(await nextInput())).toBe("first");
      yield init;
      yield text("ok");
      await stop([]);
      yield result(0.06);
      await nextInput();
    });

    const { done } = collect(row.id);
    await startResumeTurn(getTask(row.id)!, proj, "go");
    const gen = getTask(row.id)!.generation;
    addPendingMessage(row.id, gen, "first");
    refused = sendToLingeringTurn(row.id, "second");
    await done;

    expect(refused).toBe(false);
    // "second" never became a user message out of order; it is still queued
    // (the caller, POST /messages, parks it when this returns false).
    expect(listMessages(row.id).filter((m) => m.role === "user").map((m) => m.content)).toEqual(["go", "first"]);
  });

  it("refuses (so the caller queues) when the task has no live turn", () => {
    const proj = createProject({ name: "Idle" });
    const row = createTask({ project_id: proj.id, title: "T", description: "" });
    expect(sendToLingeringTurn(row.id, "hello")).toBe(false);
    expect(sendToLingeringTurn("nope-not-a-task", "hello")).toBe(false);
    expect(listMessages(row.id)).toEqual([]);
  });
});
