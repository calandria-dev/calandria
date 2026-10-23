import { describe, expect, it } from "vitest";
import type { Attention, Snapshot, Summary, WorkRow } from "@/lib/workCenter/types";
import {
  chipMeta, countView, failText, groupRows, headline, inlineActionsFor, isStale, lifecycleLabel, liveItems, sheetActionsFor, waitingText,
} from "@/app/shell/workCenter";
import { snoozeChoices } from "@/app/shell/WorkCenter";
import { backoffDelay } from "@/app/shell/useWorkCenter";
import { pushWorkCenterDestination, wcReturnOf, type HistoryLike } from "@/app/shell/navHistory";

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const FRESH = { state: "fresh" as const, observedAt: NOW, lastAttemptAt: NOW, errorCode: null };

const item = (id: string, kind: Attention["kind"], o: Partial<Attention> = {}): Attention => ({
  id, sourceRevision: id, kind, firstOccurredAt: NOW - 60_000, actionable: true, title: `${kind} ${id}`,
  action: "answer", destination: { projectId: "p1", taskId: "t1", sessionId: "s1", messageId: "m1", requestId: "r1", reviewRequestId: null, submissionId: null, surface: "transcript" },
  freshness: FRESH, snoozedUntil: null, recoveryActionId: null, inlineDecision: null, ...o,
});

const row = (taskId: string, o: Partial<WorkRow> & { working?: boolean; waiting?: WorkRow["execution"]["waitingReasons"] } = {}): WorkRow => ({
  taskId, projectId: "p1", title: taskId, projectName: "Proj", lifecycle: "in_progress",
  execution: {
    turnId: null, sessionId: null, foreground: "none", background: [], backgroundCoverage: "complete", wakeups: [], externalWait: null,
    queuedStart: null, queuedFollowupCount: 0, blockerTaskIds: [], lastActivityAt: NOW - 120_000, isWorking: o.working ?? false, waitingReasons: o.waiting ?? [],
  },
  attention: [], latestResult: null, snoozedUntil: null, ...o,
});

const summary = (over: Partial<Summary> = {}): Summary => ({
  workingTaskCount: { value: 1, known: 1 }, needsYouTaskCount: { value: 2, known: 2 }, attentionItemCount: { value: 3, known: 3 },
  snoozedNeedsYouTaskCount: { value: 1, known: 1 }, visibleNeedsYouTaskCount: { value: 1, known: 1 }, visibleAttentionItemCount: { value: 1, known: 1 },
  suggestedTaskCount: 0, ...over,
});

describe("countView", () => {
  it("draws the dash before any snapshot and never a zero", () => {
    expect(countView(undefined)).toMatchObject({ txt: "\u2014", kind: "loading", title: "not loaded" });
  });
  it("draws known+ for a null value", () => {
    expect(countView({ value: null, known: 3 })).toMatchObject({ txt: "3+", kind: "unknown" });
  });
  it("draws a real zero as zero", () => {
    expect(countView({ value: 0, known: 0 })).toMatchObject({ txt: "0", kind: "zero" });
  });
});

describe("headline", () => {
  it("uses the visible counts, not the unsubtracted ones", () => {
    const h = headline(summary({ needsYouTaskCount: { value: 5, known: 5 }, visibleNeedsYouTaskCount: { value: 2, known: 2 }, visibleAttentionItemCount: { value: 4, known: 4 } }));
    expect(h.need.txt).toBe("2");
    expect(h.items).toBe("4");
  });
  it("hides the item figure when it equals the task count or either is unknown", () => {
    expect(headline(summary()).items).toBeNull();
    expect(headline(summary({ visibleNeedsYouTaskCount: { value: null, known: 1 }, visibleAttentionItemCount: { value: 3, known: 3 } })).items).toBeNull();
    expect(headline(summary({ visibleNeedsYouTaskCount: { value: 2, known: 2 }, visibleAttentionItemCount: { value: null, known: 3 } })).items).toBeNull();
  });
  it("is loading with no summary", () => {
    expect(headline(null).need.kind).toBe("loading");
    expect(headline(null).working.kind).toBe("loading");
  });
});

describe("groupRows", () => {
  it("puts a task in one group: needs-you over working over waiting", () => {
    const a = row("a", { working: true, attention: [item("i1", "question")] });
    const b = row("b", { working: true });
    const c = row("c", { waiting: ["no_live_turn"] });
    const g = groupRows([a, b, c], NOW);
    expect(g.need.map((r) => r.taskId)).toEqual(["a"]);
    expect(g.work.map((r) => r.taskId)).toEqual(["b"]);
    expect(g.wait.map((r) => r.taskId)).toEqual(["c"]);
  });
  it("keeps an in-progress task with no live turn discoverable under Waiting", () => {
    const g = groupRows([row("quiet")], NOW);
    expect(g.wait.map((r) => r.taskId)).toEqual(["quiet"]);
  });
  it("hides a snoozed task and one whose every item is snoozed or cleared", () => {
    const snoozedTask = row("s", { snoozedUntil: NOW + 3_600_000, attention: [item("i", "question")] });
    const snoozedItems = row("si", { attention: [item("j", "question", { snoozedUntil: NOW + 1000 })] });
    const cleared = row("c", { attention: [item("k", "question")] });
    const g = groupRows([snoozedTask, snoozedItems, cleared], NOW, new Set(["k"]));
    expect(g.need).toEqual([]);
    expect(g.wait.map((r) => r.taskId).sort()).toEqual(["c", "si"]);
  });
  it("shows a task again once its snooze deadline passes", () => {
    const r = row("w", { snoozedUntil: NOW + 1000, attention: [item("i", "question")] });
    expect(groupRows([r], NOW).need).toEqual([]);
    expect(groupRows([r], NOW + 2000).need.map((x) => x.taskId)).toEqual(["w"]);
  });
  it("sorts needs-you by oldest unresolved item and the rest by newest activity", () => {
    const young = row("young", { attention: [item("1", "question", { firstOccurredAt: NOW - 1000 })] });
    const old = row("old", { attention: [item("2", "question", { firstOccurredAt: NOW - 9000 })] });
    expect(groupRows([young, old], NOW).need.map((r) => r.taskId)).toEqual(["old", "young"]);
    const w1 = row("w1", { working: true }); w1.execution.lastActivityAt = NOW - 5000;
    const w2 = row("w2", { working: true }); w2.execution.lastActivityAt = NOW - 1000;
    expect(groupRows([w1, w2], NOW).work.map((r) => r.taskId)).toEqual(["w2", "w1"]);
  });
});

describe("liveItems", () => {
  it("orders chips by the fixed kind order and keeps every reason visible", () => {
    const r = row("t", { attention: [item("a", "agent_edit"), item("b", "ci"), item("c", "permission"), item("d", "question")] });
    expect(liveItems(r, NOW).map((a) => a.kind)).toEqual(["permission", "question", "ci", "agent_edit"]);
  });
  it("reads the PR number off a CI title", () => {
    expect(chipMeta(item("x", "ci", { title: "Checks failing on PR #41" }))).toBe("#41");
    expect(chipMeta(item("y", "question"))).toBe("");
  });
});

describe("inline actions", () => {
  it("offers Allow once and Deny only when the server says so", () => {
    expect(inlineActionsFor(item("p", "permission", { inlineDecision: "allow_once_or_deny" }))).toEqual(["allow", "deny"]);
    expect(inlineActionsFor(item("p", "permission"))).toEqual(["open"]);
  });
  it("offers Acknowledge on an agent edit and nothing inline for question, ci, base, proposal, failure", () => {
    expect(inlineActionsFor(item("e", "agent_edit"))).toEqual(["ack", "open"]);
    for (const k of ["question", "ci", "base_rewrite", "settings_proposal", "turn_failure"] as const) expect(inlineActionsFor(item("x", k))).toEqual(["open"]);
  });
  it("puts Acknowledge in the phone sheet only for an agent edit", () => {
    expect(sheetActionsFor(item("e", "agent_edit"))).toEqual(["open", "ack"]);
    expect(sheetActionsFor(item("p", "permission", { inlineDecision: "allow_once_or_deny" }))).toEqual(["open"]);
  });
});

describe("labels and text", () => {
  it("labels the lifecycle only when it is not in progress, amber when it contradicts live work", () => {
    expect(lifecycleLabel(row("a"), 0)).toBeNull();
    expect(lifecycleLabel(row("a", { lifecycle: "done" }), 1)).toEqual({ text: "Done", odd: true });
    expect(lifecycleLabel(row("a", { lifecycle: "done" }), 0)).toEqual({ text: "Done", odd: false });
    expect(lifecycleLabel(row("a", { lifecycle: "on_hold" }), 1)?.odd).toBe(true);
  });
  it("keeps several waiting reasons", () => {
    const r = row("w", { waiting: ["dependency", "review_required"] });
    r.execution.blockerTaskIds = ["x", "y"];
    expect(waitingText(r).map((w) => w.text)).toEqual(["Blocked by 2 tasks", "Required review unsatisfied"]);
  });
  it("puts the HTTP status in a failure message", () => {
    expect(failText("ack", 503)).toBe("Couldn't acknowledge (503).");
    expect(failText("allow", 409)).toBe("Decision not delivered (409).");
  });
});

describe("staleness", () => {
  const snap = {} as Snapshot;
  it("is stale only with data on screen and a failed fetch or a dropped feed", () => {
    expect(isStale({ loading: false, error: "HTTP 500", disconnected: false }, snap)).toBe(true);
    expect(isStale({ loading: false, error: null, disconnected: true }, snap)).toBe(true);
    expect(isStale({ loading: false, error: null, disconnected: false }, snap)).toBe(false);
    expect(isStale({ loading: false, error: "HTTP 500", disconnected: false }, null)).toBe(false);
  });
});

describe("snoozeChoices", () => {
  it("offers exactly 1 hour, Until tomorrow and Until Monday, resolved by the shared presets", () => {
    const now = new Date(2026, 9, 22, 8, 0, 0).getTime();
    const c = snoozeChoices(now);
    expect(c.map((x) => x.label)).toEqual(["1 hour", "Until tomorrow", "Until Monday"]);
    expect(c[0].until).toBe(now + 3_600_000);
    expect(new Date(c[1].until).getHours()).toBe(9);
    expect(new Date(c[2].until).getDay()).toBe(1);
  });
});

describe("backoff", () => {
  it("steps 1, 2, 4, 8, 16, then holds at 30 seconds with 20% jitter", () => {
    const at = (n: number, r: number) => backoffDelay(n, r);
    expect([1, 2, 3, 4, 5, 6, 9].map((n) => at(n, 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(at(1, 0)).toBe(800);
    expect(at(6, 1)).toBe(36000);
  });
});

describe("Work Center history entry", () => {
  const fake = (): HistoryLike & { stack: unknown[]; idx: number } => {
    const h = {
      stack: [null as unknown], idx: 0,
      get state() { return h.stack[h.idx]; },
      pushState(s: unknown, _u?: string, _url?: string) { h.stack = h.stack.slice(0, h.idx + 1); h.stack.push(s); h.idx++; },
      replaceState(s: unknown, _u?: string, _url?: string) { h.stack[h.idx] = s; },
      back() { h.idx--; },
    };
    return h;
  };
  it("stamps the entry being left and pushes exactly one new entry", () => {
    const h = fake();
    h.replaceState({ trap: false }, "", "/");
    pushWorkCenterDestination(h, "/?task=t", { proj: "p", task: "t0", rowId: "t1", scrollTop: 120, popoverOpen: true });
    expect(h.stack).toHaveLength(2);
    expect(wcReturnOf(h.stack[0])).toEqual({ proj: "p", task: "t0", rowId: "t1", scrollTop: 120, popoverOpen: true });
    expect((h.stack[0] as { trap: boolean }).trap).toBe(false);
    h.back();
    expect(wcReturnOf(h.state)?.rowId).toBe("t1");
  });
  it("reads no return from an ordinary entry", () => {
    expect(wcReturnOf({ trap: true })).toBeNull();
    expect(wcReturnOf(null)).toBeNull();
  });
});
