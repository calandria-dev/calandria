// The notification emitter is the ONLY place a notification is minted, so it is
// the only place the policy can be pinned: which events are worth a buzz, which
// rows must stay quiet (snoozed, suggested, already-settled), and the dedupe
// window that stops one assistant message opening two cards from sending two.
// Composed server-side on purpose — the browser is a channel, not the author —
// so these assertions are what the webhook channel will inherit.
import { beforeEach, describe, expect, it } from "vitest";
import { createProject, createTask, setSetting, updateTask } from "@/lib/store";
import { publish, subscribeGlobal, watcherCount, type BusEvent } from "@/lib/events";
import {
  emitAwaitingInput, emitScheduleFailed, emitTestNotification, emitTurnFailed,
  resetNotificationDedupe,
} from "@/lib/notifications/notify";
import { ensureNotifier, stopNotifier } from "@/lib/notifications/dispatcher";
import type { NotificationPayload } from "@/lib/notifications/types";
import { GET as eventsRoute } from "@/app/api/events/route";

// Every notification published while `fn` runs, in order.
function notificationsDuring(fn: () => void): NotificationPayload[] {
  const seen: NotificationPayload[] = [];
  const unsub = subscribeGlobal((_taskId, ev: BusEvent) => {
    if (ev.type === "notification") seen.push(ev.payload);
  });
  try { fn(); } finally { unsub(); }
  return seen;
}

// A task parked on a question: in_progress + awaiting_input, not suggested,
// not snoozed — the same shape the NEEDS_YOU predicate recognizes.
function parkedTask(projectId: string, title = "Parked") {
  const t = createTask({ project_id: projectId, title });
  updateTask(t.id, { status: "in_progress", running: 1, awaiting_input: 1 });
  return t;
}

let projectId: string;

beforeEach(() => {
  resetNotificationDedupe();
  for (const k of ["notifications", "notify_awaiting_input", "notify_turn_failed", "notify_schedule_failed"])
    setSetting(k, null);
  projectId = createProject({ name: `Notify ${Math.random().toString(36).slice(2, 8)}` }).id;
});

describe("the notification emitter", () => {
  it("publishes an awaiting_input notification naming the task and its project", () => {
    const project = createProject({ name: "Inbox Zero" });
    const task = parkedTask(project.id, "Review the migration");

    const sent = notificationsDuring(() => emitAwaitingInput(task.id));

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("awaiting_input");
    expect(sent[0].taskId).toBe(task.id);
    expect(sent[0].projectId).toBe(project.id);
    expect(sent[0].title).toBe("Waiting for input");
    expect(sent[0].body).toContain("Review the migration");
    expect(sent[0].body).toContain("Inbox Zero");
    // The id doubles as the browser Notification tag, so it must be STABLE per
    // (kind, task) — a timestamped id would stack toasts instead of replacing.
    expect(sent[0].id).toBe(`awaiting_input:${task.id}`);
  });

  it("stays quiet for a row that does not actually need the user", () => {
    const snoozed = parkedTask(projectId, "Snoozed");
    updateTask(snoozed.id, { snoozed_until: Date.now() + 60_000 });
    const suggested = createTask({ project_id: projectId, title: "Suggested", suggested: true });
    updateTask(suggested.id, { status: "in_progress", awaiting_input: 1 });
    // Settled between the runner's publish and our read — an ask that
    // auto-denied on an unattended turn looks exactly like this.
    const settled = createTask({ project_id: projectId, title: "Settled" });
    updateTask(settled.id, { status: "in_progress", awaiting_input: 0 });

    const sent = notificationsDuring(() => {
      emitAwaitingInput(snoozed.id);
      emitAwaitingInput(suggested.id);
      emitAwaitingInput(settled.id);
      emitAwaitingInput("no-such-task");
    });

    expect(sent).toEqual([]);
  });

  it("collapses a repeat inside the dedupe window but not a different kind or task", () => {
    const a = parkedTask(projectId, "A");
    const b = parkedTask(projectId, "B");

    const sent = notificationsDuring(() => {
      emitAwaitingInput(a.id);
      emitAwaitingInput(a.id); // one message opened an ask AND a permission card
      emitTurnFailed(a.id, "⚠ boom");
      emitAwaitingInput(b.id);
    });

    expect(sent.map((n) => `${n.kind}:${n.taskId}`)).toEqual([
      `awaiting_input:${a.id}`, `turn_failed:${a.id}`, `awaiting_input:${b.id}`,
    ]);
  });

  it("honors the master switch and the per-kind switch", () => {
    const task = parkedTask(projectId, "Quiet please");

    setSetting("notifications", "off");
    expect(notificationsDuring(() => emitAwaitingInput(task.id))).toEqual([]);

    setSetting("notifications", null);
    setSetting("notify_awaiting_input", "off");
    resetNotificationDedupe();
    expect(notificationsDuring(() => emitAwaitingInput(task.id))).toEqual([]);

    // The other kinds are unaffected by one kind's opt-out.
    resetNotificationDedupe();
    expect(notificationsDuring(() => emitTurnFailed(task.id, "⚠ boom"))).toHaveLength(1);
  });

  it("carries the first line of a turn error, and fires for an unclassified one", () => {
    const task = parkedTask(projectId, "Crashed");

    const sent = notificationsDuring(() =>
      emitTurnFailed(task.id, "⚠ ENOSPC: no space left on device\n\nsecond line"));

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("turn_failed");
    expect(sent[0].title).toBe("Turn failed");
    expect(sent[0].body).toContain("Crashed");
    expect(sent[0].body).toContain("ENOSPC: no space left on device");
    expect(sent[0].body).not.toContain("second line");
    expect(sent[0].body).not.toContain("⚠");
  });

  it("emits a schedule failure that names the schedule, with or without a task", () => {
    const withTask = parkedTask(projectId, "Morning sweep");
    const sent = notificationsDuring(() => {
      emitScheduleFailed({ scheduleName: "Morning sweep", projectId, taskId: withTask.id, detail: "Unknown command: /x" });
      emitScheduleFailed({ scheduleName: "Nightly", projectId, taskId: "", detail: "no agent connected" });
    });

    expect(sent).toHaveLength(2);
    expect(sent[0].kind).toBe("schedule_failed");
    expect(sent[0].taskId).toBe(withTask.id);
    expect(sent[0].body).toContain("Morning sweep");
    expect(sent[0].body).toContain("Unknown command: /x");
    // A run that failed before minting a task still notifies — that is the
    // silent failure this kind exists for.
    expect(sent[1].taskId).toBe("");
    expect(sent[1].body).toContain("Nightly");
  });

  it("sends a test notification past the per-kind switches and the dedupe window", () => {
    setSetting("notify_awaiting_input", "off");

    const sent = notificationsDuring(() => { emitTestNotification(); emitTestNotification(); });

    expect(sent).toHaveLength(2); // a diagnostic that silently self-suppresses is a lie
    expect(sent[0].kind).toBe("test");
    expect(sent[0].taskId).toBe("");

    // …but the master switch still governs it.
    setSetting("notifications", "off");
    expect(notificationsDuring(() => emitTestNotification())).toEqual([]);
  });
});

describe("the notification dispatcher", () => {
  it("translates the runner's own events, and ignores its own", () => {
    const task = parkedTask(projectId, "Parked by the runner");
    ensureNotifier();
    try {
      const sent = notificationsDuring(() => {
        publish(task.id, { type: "ask", id: "a1", questions: [] });
        publish(task.id, { type: "assistant", content: "thinking out loud" });
        publish(task.id, { type: "notice", content: "caught up to main" });
      });
      expect(sent.map((n) => n.kind)).toEqual(["awaiting_input"]);
    } finally {
      stopNotifier();
    }
  });

  it("maps a permission card and a turn error", () => {
    const a = parkedTask(projectId, "Permission");
    const b = parkedTask(projectId, "Boom");
    ensureNotifier();
    try {
      const sent = notificationsDuring(() => {
        publish(a.id, { type: "permission", request: { id: "p1", tool: "Bash", title: "Run npm run lint", detail: "npm run lint", expiresAt: 0 } });
        publish(b.id, { type: "error", content: "⚠ the session ended unexpectedly" });
      });
      expect(sent.map((n) => `${n.kind}:${n.taskId}`)).toEqual([
        `awaiting_input:${a.id}`, `turn_failed:${b.id}`,
      ]);
    } finally {
      stopNotifier();
    }
  });

  it("subscribes at most once however many callers start it", () => {
    const task = parkedTask(projectId, "Once only");
    // watcherCount() counts global bus subscribers, and the notifier is one —
    // measuring it catches a broken idempotency guard directly, unlike a
    // notification count, which the emitter's own dedupe window would collapse
    // to 1 even with three live subscribers. It also counts open SSE streams
    // (GET /api/events), so the assertion is a DELTA off a baseline, not an
    // absolute count.
    const baseline = watcherCount();
    ensureNotifier();
    ensureNotifier();
    ensureNotifier();
    expect(watcherCount() - baseline).toBe(1);
    try {
      const sent = notificationsDuring(() => publish(task.id, { type: "ask", id: "a1", questions: [] }));
      expect(sent).toHaveLength(1); // three subscribers would send three
    } finally {
      stopNotifier();
    }
    expect(watcherCount()).toBe(baseline);
  });
});

describe("the /api/events relay", () => {
  it("streams a notification payload verbatim, task row or not", async () => {
    const task = parkedTask(projectId, "Streamed");
    const ac = new AbortController();
    const res = await eventsRoute(new Request("http://localhost/api/events", { signal: ac.signal }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    try {
      // Drain the ": connected" preamble so the assertion below can't read it.
      await reader.read();

      emitAwaitingInput(task.id);
      emitTestNotification();

      let buf = "";
      const frames: string[] = [];
      // A short LOCAL timeout per read, well under vitest's global 30s one:
      // these SSE writes are in-process and synchronous, so 2s is generous.
      // Without this, a misplaced relay branch fails as a bare "Test timed out
      // in 30000ms" that names nothing — this instead names which frame never
      // showed up, so the failure points straight at the missing branch.
      const readOrTimeout = (): Promise<{ done: boolean; value?: Uint8Array }> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`expected 2 frames, got ${frames.length} — frame ${frames.length} never arrived`)),
            2000,
          );
          reader.read().then(
            (r) => { clearTimeout(timer); resolve(r); },
            (e) => { clearTimeout(timer); reject(e); },
          );
        });
      while (frames.length < 2) {
        const { value, done } = await readOrTimeout();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (const chunk of buf.split("\n\n")) if (chunk.startsWith("data: ")) frames.push(chunk.slice(6));
        buf = "";
      }

      const payloads = frames.map((f) => JSON.parse(f));
      expect(payloads[0].type).toBe("notification");
      expect(payloads[0].payload.taskId).toBe(task.id);
      // The task-less test notification must survive the relay: the branch must
      // sit BEFORE coarse(ev) is even called, not merely before the getTask
      // re-read further down — coarse() returns null for "notification" and
      // swallows the event right there, so anywhere after coarse(ev) reproduces
      // this same failure, not just placement below the re-read.
      expect(payloads[1].payload.kind).toBe("test");
    } finally {
      // ensureNotifier() was started indirectly by eventsRoute() above; undo it
      // like every sibling test does, and make sure a failing assertion above
      // still tears down the stream instead of leaving a live reader.
      ac.abort();
      stopNotifier();
    }
  });
});
