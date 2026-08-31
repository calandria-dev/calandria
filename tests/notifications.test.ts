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
import { clearRunContext, setRunContext, SCHEDULED_RUN_CONTEXT } from "@/lib/runContext";
import type { NotificationPayload } from "@/lib/notifications/types";
import { GET as eventsRoute } from "@/app/api/events/route";
import { claimRun, createSchedule, settleRun, startRun } from "@/lib/schedule/store";
import { PATCH as patchSettings } from "@/app/api/settings/route";
import { POST as testNotification } from "@/app/api/notifications/test/route";
import { classifyNotificationSupport, isDesktopShell, isMacDesktopShell, shouldDisplay } from "@/app/shell/useNotifications";

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
    // The obvious instrument is ruled out by design: the notifier subscribes as
    // INTERNAL, so it is invisible to watcherCount() (the permission gate's
    // presence heuristic — see tests/permissions.test.ts). A notification count
    // is no good either, since the emitter's dedupe window would collapse three
    // live subscribers to one toast.
    //
    // What does measure the guard is TEARDOWN. stopNotifier() remembers exactly
    // ONE unsubscribe function, so a second subscription could never be removed:
    // if ensureNotifier() ever subscribed twice, the extra listener would
    // outlive stopNotifier() and keep notifying forever. So publish after
    // teardown and require silence.
    const baseline = watcherCount();
    ensureNotifier();
    ensureNotifier();
    ensureNotifier();
    expect(watcherCount()).toBe(baseline); // internal: not a watching human
    try {
      const sent = notificationsDuring(() => publish(task.id, { type: "ask", id: "a1", questions: [] }));
      expect(sent).toHaveLength(1);
    } finally {
      stopNotifier();
    }
    const orphan = parkedTask(projectId, "After teardown");
    const after = notificationsDuring(() => publish(orphan.id, { type: "ask", id: "a2", questions: [] }));
    expect(after).toEqual([]); // a leaked second subscription would still fire
  });

  it("notifies on the turn-end settle, which is the commonest 'your move'", () => {
    const parked = parkedTask(projectId, "Handed back");
    // Same event, but the runner settled this one: awaiting_input is 0, so the
    // turn ended with nothing owed to the user. turn_end must NOT become a
    // "turn finished" notification — the row decides, exactly as it does for a
    // card.
    const done = createTask({ project_id: projectId, title: "Ran to completion" });
    updateTask(done.id, { status: "in_progress", awaiting_input: 0 });
    ensureNotifier();
    try {
      const sent = notificationsDuring(() => {
        publish(parked.id, { type: "turn_end" });
        publish(done.id, { type: "turn_end" });
      });
      expect(sent.map((n) => `${n.kind}:${n.taskId}`)).toEqual([`awaiting_input:${parked.id}`]);
    } finally {
      stopNotifier();
    }
  });

  it("does not follow a failed turn with a 'waiting for input' about the same task", () => {
    // The real order inside the runner's finally, on ONE task: publishTurnError
    // emits `error`, then the row is settled with awaiting_input = 1 (any turn
    // that opened a session and ended mid-task), then turn_end. Two kinds means
    // two ids, so neither the dedupe window nor the browser tag would collapse
    // them — the user would get two stacked toasts about one death, the second
    // of them claiming a dead session is waiting on them.
    const task = parkedTask(projectId, "Died mid-turn");
    ensureNotifier();
    try {
      const sent = notificationsDuring(() => {
        publish(task.id, { type: "error", content: "⚠ the session ended unexpectedly" });
        publish(task.id, { type: "turn_end" });
      });
      expect(sent.map((n) => n.kind)).toEqual(["turn_failed"]);
    } finally {
      stopNotifier();
    }
    // …and the stand-down is bounded by the same 10s window, not permanent: a
    // genuine later question on a task that failed earlier still gets through.
    resetNotificationDedupe();
    ensureNotifier();
    try {
      const sent = notificationsDuring(() => publish(task.id, { type: "ask", id: "a1", questions: [] }));
      expect(sent.map((n) => n.kind)).toEqual(["awaiting_input"]);
    } finally {
      stopNotifier();
    }
  });

  it("collapses the card-then-turn_end pair one parked turn produces", () => {
    const task = parkedTask(projectId, "Asked then ended");
    ensureNotifier();
    try {
      const sent = notificationsDuring(() => {
        publish(task.id, { type: "ask", id: "a1", questions: [] });
        publish(task.id, { type: "turn_end" });
      });
      expect(sent).toHaveLength(1);
    } finally {
      stopNotifier();
    }
  });

  it("stays quiet for a turn that declared nobody can answer it", () => {
    // A scheduled run: the driver publishes the permission card BEFORE
    // waitForPermission() auto-settles it, so the row genuinely reads
    // awaiting_input = 1 for an instant. Telling the user a task is waiting on
    // them that by design never will is the same false "N need you" item the
    // scheduler works to avoid.
    const task = parkedTask(projectId, "08:30 sweep");
    setRunContext(task.id, SCHEDULED_RUN_CONTEXT);
    try {
      expect(notificationsDuring(() => emitAwaitingInput(task.id))).toEqual([]);
      // A turn the user launched on that same row is unaffected.
      clearRunContext(task.id);
      expect(notificationsDuring(() => emitAwaitingInput(task.id))).toHaveLength(1);
    } finally {
      clearRunContext(task.id);
    }
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

describe("a failed scheduled run", () => {
  it("notifies once, only on the transition, and only for failure", () => {
    const schedule = createSchedule({
      project_id: projectId,
      name: "Morning sweep",
      prompt: "/sweep",
      days_mask: 127,
      time_of_day: "08:30",
      timezone: "America/Los_Angeles",
      agent: "claude",
    });

    const failed = claimRun(schedule.id, 1, "scheduled")!;
    const sent = notificationsDuring(() => {
      settleRun(failed.id, "failed", "no agent connected");
      // Idempotent re-settle: the UPDATE matches no row, so no second buzz.
      settleRun(failed.id, "failed", "no agent connected");
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("schedule_failed");
    expect(sent[0].body).toContain("Morning sweep");
    expect(sent[0].body).toContain("no agent connected");
    expect(sent[0].projectId).toBe(projectId);

    // A run that succeeded is not news.
    const ok = claimRun(schedule.id, 2, "scheduled")!;
    expect(notificationsDuring(() => settleRun(ok.id, "succeeded", ""))).toEqual([]);

    // A run that DID mint a task carries it, so clicking the toast can open it.
    const task = parkedTask(projectId, "08:30 sweep");
    const withTask = claimRun(schedule.id, 3, "scheduled")!;
    startRun(withTask.id, task.id);
    resetNotificationDedupe();
    const second = notificationsDuring(() => settleRun(withTask.id, "failed", "Unknown command: /x"));
    expect(second[0].taskId).toBe(task.id);
  });

  it("stands down when the turn error already said the same thing", () => {
    const schedule = createSchedule({
      project_id: projectId, name: "Nightly", prompt: "/sweep", days_mask: 127,
      time_of_day: "02:00", timezone: "America/Los_Angeles", agent: "claude",
    });
    const task = parkedTask(projectId, "02:00 sweep");

    // The real sequence for a scheduled turn that CRASHES: the runner publishes
    // `error` during the turn, then settles the run from its finally with the
    // same text. Two kinds, two ids, so nothing else would collapse them — the
    // user would get two toasts naming one failure.
    const run = claimRun(schedule.id, 10, "scheduled")!;
    startRun(run.id, task.id);
    const sent = notificationsDuring(() => {
      emitTurnFailed(task.id, "⚠ the session ended unexpectedly");
      // The turn-end settle sits BETWEEN them in the runner's finally, and the
      // run context has already been cleared by the time it publishes — so this
      // is the third toast the same death would produce, not a hypothetical.
      emitAwaitingInput(task.id);
      settleRun(run.id, "failed", "the session ended unexpectedly");
    });
    expect(sent.map((n) => n.kind)).toEqual(["turn_failed"]);

    // …but a run that failed with NO turn error still fires: a preflight
    // failure or an unknown command is the silent case this kind exists for,
    // and suppressing it would restore the bug the feature was built to fix.
    resetNotificationDedupe();
    const other = parkedTask(projectId, "02:00 sweep, take two");
    const dry = claimRun(schedule.id, 11, "scheduled")!;
    startRun(dry.id, other.id);
    const quiet = notificationsDuring(() => settleRun(dry.id, "failed", "Unknown command: /x"));
    expect(quiet.map((n) => n.kind)).toEqual(["schedule_failed"]);
  });
});

describe("notification settings", () => {
  it("persists the four keys through PATCH /api/settings", async () => {
    const res = await patchSettings(new Request("http://localhost/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ notifications: "off", notify_turn_failed: "off", bogus_key: "off" }),
    }));
    const saved = await res.json();
    expect(saved.notifications).toBe("off");
    expect(saved.notify_turn_failed).toBe("off");
    expect(saved.bogus_key).toBeUndefined();
  });

  it("sends a test notification through the real bus, and reports the master switch", async () => {
    // Subscribed by hand rather than through notificationsDuring: the route is
    // async, and that helper only spans a synchronous callback.
    const sent: NotificationPayload[] = [];
    const unsub = subscribeGlobal((_id, ev) => { if (ev.type === "notification") sent.push(ev.payload); });
    try {
      const ok = await (await testNotification()).json();
      expect(ok.ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0].kind).toBe("test");

      setSetting("notifications", "off");
      const off = await (await testNotification()).json();
      expect(off.ok).toBe(false); // the button can say WHY nothing appeared
      expect(sent).toHaveLength(1);
    } finally {
      unsub();
    }
  });
});

describe("the browser channel's display rule", () => {
  const payload = (taskId: string): NotificationPayload => ({
    id: `awaiting_input:${taskId}`, kind: "awaiting_input", taskId,
    projectId: "p1", title: "Waiting for input", body: "x", ts: 1,
  });

  it("stays silent only when you are demonstrably looking at that very task", () => {
    expect(shouldDisplay(payload("t1"), { visible: true, selectedTaskId: "t1" })).toBe(false);
    // Tab open but on another task, or hidden behind twelve other tabs: notify.
    expect(shouldDisplay(payload("t1"), { visible: true, selectedTaskId: "t2" })).toBe(true);
    expect(shouldDisplay(payload("t1"), { visible: false, selectedTaskId: "t1" })).toBe(true);
    expect(shouldDisplay(payload("t1"), { visible: true, selectedTaskId: null })).toBe(true);
  });

  it("always shows a test notification, which belongs to no task", () => {
    const test: NotificationPayload = { id: "test", kind: "test", taskId: "", projectId: "", title: "t", body: "b", ts: 1 };
    expect(shouldDisplay(test, { visible: true, selectedTaskId: null })).toBe(true);
  });
});

describe("the browser channel's support classifier", () => {
  it("reads an insecure origin as insecure, not as the user having blocked the site", () => {
    // The bug this pins: on plain-http LAN origins Chrome reports permission
    // "denied" without ever prompting. That "denied" must not surface as
    // "you blocked notifications — unblock in site settings", which can't work.
    expect(classifyNotificationSupport({ desktopShell: false, secureContext: false, hasNotificationApi: true, permission: "denied" }))
      .toBe("insecure");
    // Some browsers hide the API entirely on insecure origins; same diagnosis.
    expect(classifyNotificationSupport({ desktopShell: false, secureContext: false, hasNotificationApi: false, permission: null }))
      .toBe("insecure");
  });

  it("reads a missing API on a SECURE origin as genuinely unsupported", () => {
    expect(classifyNotificationSupport({ desktopShell: false, secureContext: true, hasNotificationApi: false, permission: null }))
      .toBe("unsupported");
  });

  it("passes the browser's real permission through on a secure origin", () => {
    for (const p of ["granted", "denied", "default"] as const) {
      expect(classifyNotificationSupport({ desktopShell: false, secureContext: true, hasNotificationApi: true, permission: p })).toBe(p);
    }
  });

  it("reads the desktop shell's denial as the desktop app owning the channel", () => {
    // The exact state desktop/main.js produces: setPermissionCheckHandler
    // answers `notifications` false, so the page reads "denied" on a perfectly
    // secure 127.0.0.1 origin while the Electron main process is raising the
    // toasts. Reported as "denied", Settings tells the user to unblock the site
    // in a browser settings page the shell has no way to open.
    expect(classifyNotificationSupport({ desktopShell: true, secureContext: true, hasNotificationApi: true, permission: "denied" }))
      .toBe("desktop_shell");
    // It outranks every other signal, including "insecure": whatever the page's
    // own channel could or couldn't do, it is not the one the user hears.
    expect(classifyNotificationSupport({ desktopShell: true, secureContext: false, hasNotificationApi: false, permission: null }))
      .toBe("desktop_shell");
  });
});

describe("spotting the desktop shell from the user agent", () => {
  const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

  it("matches the token the shell appends, and Electron's own", () => {
    // What desktop/main.js announceShell() actually produces.
    expect(isDesktopShell(`${CHROME} Electron/44.0.0 Calandria-Desktop/0.3.0`)).toBe(true);
    // A packaged build predating the token still gets the right copy.
    expect(isDesktopShell(`${CHROME} Electron/44.0.0`)).toBe(true);
    // And the token alone, if Electron's own ever stops being part of it.
    expect(isDesktopShell(`${CHROME} Calandria-Desktop/0.3.0`)).toBe(true);
  });

  it("does not match an ordinary browser", () => {
    expect(isDesktopShell(CHROME)).toBe(false);
    expect(isDesktopShell("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe(false);
    // The word boundary matters: a UA carrying an unrelated product whose name
    // merely ENDS in one of ours is not the shell.
    expect(isDesktopShell(`${CHROME} NotElectron/1.0 MyCalandria-Desktop/1.0`)).toBe(false);
  });

  // The macOS narrowing, which decides whether the app's own titlebar has to
  // stand in for a native one it no longer has (padding for the traffic lights,
  // and a drag region). Both halves have to be true, and neither implies the
  // other: the shell on Windows keeps its native frame, and a Mac browser tab
  // has a real window around it.
  it("narrows to the macOS shell, where hiddenInset takes the native bar away", () => {
    const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

    expect(isMacDesktopShell(`${MAC} Electron/44.0.0 Calandria-Desktop/0.3.0`)).toBe(true);
    // Native frame intact — padding it would inset the logo for nothing.
    expect(isMacDesktopShell(`${WIN} Electron/44.0.0 Calandria-Desktop/0.3.0`)).toBe(false);
    expect(isMacDesktopShell(`${CHROME} Electron/44.0.0 Calandria-Desktop/0.3.0`)).toBe(false);
    // A Mac browser tab is a page, not a window.
    expect(isMacDesktopShell(MAC)).toBe(false);
    // An iPhone's "like Mac OS X" reaches this predicate only through a shell
    // that can't run there, but the platform half must not be what lets it in.
    expect(isMacDesktopShell("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe(false);
  });
});
