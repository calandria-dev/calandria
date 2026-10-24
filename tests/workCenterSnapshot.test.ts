import { describe, it, expect, vi, beforeEach } from "vitest";

// Work Center stage 1 backend: the attention adapters, the snapshot, its
// transport and the compatibility surfaces (contract work-center/1 with
// amendment 1). Sources are the real registries and rows; only the GitHub
// calls are mocked.
const { prMock, evidenceMock } = vi.hoisted(() => ({ prMock: vi.fn(), evidenceMock: vi.fn() }));

vi.mock("@/lib/github", async (orig) => ({
  ...(await orig<typeof import("@/lib/github")>()),
  fetchPrState: prMock,
  fetchCheckEvidence: evidenceMock,
}));

import {
  createProject, createTask, updateTask, getTask, updateProject, recordAgentEdit, listOutstandingAgentEdits,
  setTaskPrState, setTaskPrEvidence, setCiRecovery, finalizeTurnRecord, beginTurnRecord, listAgentEdits, workCenterInstanceId,
} from "@/lib/store";
import { getDb } from "@/lib/db";
import { submitAnswer } from "@/lib/asks";
import { publishGlobal } from "@/lib/events";
import { assembleSnapshot, SnapshotBusy, ScopeError } from "@/lib/workCenter/snapshot";
import { bumpWorkCenter, workCenterEpoch, workCenterSequence } from "@/lib/workCenter/execution";
import { needsYouRows, awaitingCountFor } from "@/lib/workCenter/compat";
import { registerProposal, settleProposal } from "@/lib/workCenter/proposals";
import { refreshPrState } from "@/lib/prState";
import { parkAsk, parkPermission } from "./helpers";
import { GET as snapshotRoute } from "@/app/api/work-center/route";
import { GET as needsYouRoute } from "@/app/api/needs-you/route";
import { GET as eventsRoute } from "@/app/api/events/route";
import { POST as answerRoute } from "@/app/api/tasks/[id]/answer/route";
import { POST as failureAckRoute } from "@/app/api/tasks/[id]/failure-ack/route";
import { POST as agentEditsRoute } from "@/app/api/tasks/[id]/agent-edits/route";
import { POST as fixCiRoute } from "@/app/api/tasks/[id]/pr/fix-ci/route";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new Request("http://test", { method: "POST", body: JSON.stringify(body) });

let n = 0;
function fresh(name = `P${++n}`) {
  const project = createProject({ name });
  const task = (title = "T", over: Record<string, unknown> = {}) => {
    const t = createTask({ project_id: project.id, title });
    updateTask(t.id, { status: "in_progress", started: 1, ...over });
    return t;
  };
  return { project, task };
}

function redPr(taskId: string, over: Record<string, unknown> = {}) {
  updateTask(taskId, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7 });
  setTaskPrState(taskId, { state: "open", checks: "failing", review: "", merged_at: 0, synced_at: Date.now() });
  if (over.episode !== undefined) {
    setTaskPrEvidence(taskId, { head_sha: "h1", repository_id: "42", episode_id: over.episode as string, episode_fingerprint: "fp", snapshot_json: "[]", episode_started_at: 1234 });
  }
}

const rowOf = (snap: ReturnType<typeof assembleSnapshot>, id: string) => snap.tasks.find((t) => t.taskId === id);
const projectSummary = (snap: ReturnType<typeof assembleSnapshot>, id: string) => snap.projects.find((p) => p.projectId === id)!.summary;

beforeEach(() => {
  prMock.mockReset();
  evidenceMock.mockReset();
});

describe("attention counts", () => {
  it("two asks plus CI on one task count as one task and three items", async () => {
    const { project, task } = fresh();
    const a = task("Busy");
    await parkAsk(a.id);
    await parkAsk(a.id);
    redPr(a.id, { episode: "ep-1" });
    const b = task("Other");
    await parkPermission(b.id);

    const s = projectSummary(assembleSnapshot({ projectId: project.id }), project.id);
    expect(s.needsYouTaskCount).toEqual({ value: 2, known: 2 });
    expect(s.attentionItemCount).toEqual({ value: 4, known: 4 });
    expect(s.visibleNeedsYouTaskCount).toEqual({ value: 2, known: 2 });
  });

  it("counts a done task with a red PR and ignores generic turn-end awaiting", () => {
    const { project, task } = fresh();
    const done = task("Done+red", { status: "done" });
    redPr(done.id, { episode: "ep" });
    const idle = task("Idle");
    updateTask(idle.id, { awaiting_input: 1 }); // the old flag, with no live ask behind it

    const snap = assembleSnapshot({ projectId: project.id });
    expect(projectSummary(snap, project.id).needsYouTaskCount.known).toBe(1);
    expect(rowOf(snap, done.id)?.attention.map((a) => a.kind)).toEqual(["ci"]);
    expect(rowOf(snap, idle.id)?.attention ?? []).toEqual([]);
  });

  it("snoozing subtracts from the visible counts and leaves the unsubtracted ones", async () => {
    const { project, task } = fresh();
    const a = task("A");
    const b = task("B");
    await parkAsk(a.id);
    await parkAsk(b.id);
    await parkAsk(b.id);
    const now = Date.now();
    updateTask(a.id, { snoozed_until: now + 3_600_000 });

    const s = projectSummary(assembleSnapshot({ projectId: project.id, now }), project.id);
    expect(s.needsYouTaskCount.value).toBe(2);
    expect(s.attentionItemCount.value).toBe(3);
    expect(s.snoozedNeedsYouTaskCount).toEqual({ value: 1, known: 1 });
    expect(s.visibleNeedsYouTaskCount).toEqual({ value: 1, known: 1 });
    expect(s.visibleAttentionItemCount).toEqual({ value: 2, known: 2 });
    // A snoozed task leaves the lists while it is hidden.
    expect(rowOf(assembleSnapshot({ projectId: project.id, now }), a.id)).toBeUndefined();

    // The same data past the deadline: visible again, no side effect needed.
    const later = assembleSnapshot({ projectId: project.id, now: now + 3_600_001 });
    expect(projectSummary(later, project.id).visibleNeedsYouTaskCount.value).toBe(2);
    expect(rowOf(later, a.id)).toBeDefined();
  });

  it("every item snoozed: totals stay, visible counts are zero", async () => {
    const { project, task } = fresh();
    const a = task("A");
    await parkAsk(a.id);
    updateTask(a.id, { snoozed_until: Date.now() + 60_000 });
    const s = projectSummary(assembleSnapshot({ projectId: project.id }), project.id);
    expect(s.needsYouTaskCount.value).toBe(1);
    expect(s.visibleNeedsYouTaskCount).toEqual({ value: 0, known: 0 });
    expect(s.visibleAttentionItemCount).toEqual({ value: 0, known: 0 });
    bumpWorkCenter();
    expect(awaitingCountFor(project.id)).toBe(0);
  });

  it("an open PR nobody has observed makes the totals unknown, keeping the known items", async () => {
    const { project, task } = fresh();
    const a = task("A");
    const b = task("B");
    await parkAsk(a.id);
    await parkAsk(b.id);
    updateTask(a.id, { snoozed_until: Date.now() + 60_000 });
    const c = task("Unobserved");
    updateTask(c.id, { pr_url: "https://github.com/o/r/pull/9", pr_number: 9, pr_state: "open" });

    const snap = assembleSnapshot({ projectId: project.id });
    const s = projectSummary(snap, project.id);
    expect(s.needsYouTaskCount).toEqual({ value: null, known: 2 });
    expect(s.snoozedNeedsYouTaskCount).toEqual({ value: null, known: 1 });
    expect(s.visibleNeedsYouTaskCount).toEqual({ value: null, known: 1 });
    expect(snap.coverage).toContainEqual({ source: "ci", taskId: c.id, state: "unavailable", reason: "never_observed" });
  });

  it("a cancelled task with a live ask stays actionable", async () => {
    const { project, task } = fresh();
    const a = task("Cancelled", { status: "cancelled" });
    await parkAsk(a.id);
    expect(projectSummary(assembleSnapshot({ projectId: project.id }), project.id).needsYouTaskCount.known).toBe(1);
  });
});

describe("source settlement", () => {
  it("an answered ask disappears from the next snapshot and moves the sequence", async () => {
    const { project, task } = fresh();
    const a = task("A");
    const { askId } = await parkAsk(a.id);
    const before = assembleSnapshot({ projectId: project.id });
    expect(rowOf(before, a.id)?.attention[0]).toMatchObject({ kind: "question", action: "answer", sourceRevision: askId });

    expect(submitAnswer(a.id, askId, [["A"]])).toBe(true);
    publishGlobal(a.id, { type: "task_edited" });
    const after = assembleSnapshot({ projectId: project.id });
    expect(rowOf(after, a.id)?.attention ?? []).toEqual([]);
    expect(after.sequence).toBeGreaterThan(before.sequence);
  });

  it("an unresolved card with no live waiter (after a restart) produces nothing", async () => {
    const { project, task } = fresh();
    const a = task("A");
    const { askId } = await parkAsk(a.id);
    submitAnswer(a.id, askId, [["A"]]);
    // The persisted card still has no `answers` here, exactly like a card the
    // previous process left behind; with no registry entry it is not live.
    expect(rowOf(assembleSnapshot({ projectId: project.id }), a.id)?.attention ?? []).toEqual([]);
  });

  it("stable identity: the same ask keeps its id across snapshots", async () => {
    const { project, task } = fresh();
    const a = task("A");
    await parkAsk(a.id);
    const one = rowOf(assembleSnapshot({ projectId: project.id }), a.id)!.attention[0];
    const two = rowOf(assembleSnapshot({ projectId: project.id }), a.id)!.attention[0];
    expect(one.id).toBe(two.id);
    expect(one.destination).toMatchObject({ taskId: a.id, requestId: one.sourceRevision, surface: "transcript" });
    expect(one.destination.messageId).toBeTruthy();
  });
});

describe("inline permission decisions", () => {
  it("is offered only for a live, scope-free, non-drift Claude permission", async () => {
    const { project, task } = fresh();
    const claude = task("claude");
    updateTask(claude.id, { agent: "claude" });
    const scoped = task("scoped");
    updateTask(scoped.id, { agent: "claude" });
    const drift = task("drift");
    updateTask(drift.id, { agent: "claude" });
    const codex = task("codex");
    updateTask(codex.id, { agent: "codex" });
    await parkPermission(claude.id);
    await parkPermission(scoped.id, { scope: { scope: "project", match_kind: "bash_prefix", value: "ls", label: "ls" } });
    await parkPermission(drift.id, { kind: "settings" });
    await parkPermission(codex.id);

    const snap = assembleSnapshot({ projectId: project.id });
    const inline = (id: string) => rowOf(snap, id)!.attention[0].inlineDecision;
    expect(inline(claude.id)).toBe("allow_once_or_deny");
    expect(inline(scoped.id)).toBeNull();
    expect(inline(drift.id)).toBeNull();
    expect(inline(codex.id)).toBeNull();
    expect(rowOf(snap, drift.id)!.attention[0].kind).toBe("permission");
  });

  it("an Advanced Settings proposal is one settings_proposal item with no payload", async () => {
    const { project, task } = fresh();
    const a = task("env");
    const { requestId } = await parkPermission(a.id, { requestId: "env:xyz", kind: "environment" });
    registerProposal({ taskId: a.id, sessionId: null, messageId: null, requestId, expectedRevision: "3", operation: "update", label: "Environment setting change", createdAt: Date.now() });
    try {
      const items = rowOf(assembleSnapshot({ projectId: project.id }), a.id)!.attention;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: "settings_proposal", action: "decide_proposal", sourceRevision: "env:xyz", inlineDecision: null, title: "Environment setting change" });
      expect(JSON.stringify(items)).not.toContain("expectedRevision");
    } finally {
      settleProposal(requestId);
    }
  });
});

describe("scope", () => {
  it("excludes a deprecated project globally and serves it only on explicit request", async () => {
    const { project, task } = fresh("Archived");
    const a = task("A");
    await parkAsk(a.id);
    updateProject(project.id, { deprecated: 1 });

    const global = assembleSnapshot({});
    expect(global.projects.find((p) => p.projectId === project.id)).toBeUndefined();
    expect(rowOf(global, a.id)).toBeUndefined();

    expect(() => assembleSnapshot({ projectId: project.id })).toThrow(ScopeError);
    const explicit = assembleSnapshot({ projectId: project.id, includeDeprecated: true });
    expect(rowOf(explicit, a.id)?.attention).toHaveLength(1);
    // The explicit view never changes what the global scope counts.
    expect(assembleSnapshot({}).summary.needsYouTaskCount.known).toBe(global.summary.needsYouTaskCount.known);
  });

  it("unknown project and bad parameters are 404 and 400 with the error envelope", async () => {
    const miss = await snapshotRoute(new Request("http://test/api/work-center?project=nope"));
    expect(miss.status).toBe(404);
    expect(await miss.json()).toMatchObject({ error: { code: "not_found", retryable: false } });
    for (const q of ["include_deprecated=2", "recent_limit=0", "recent_limit=101", "recent_cursor=garbage"]) {
      const res = await snapshotRoute(new Request(`http://test/api/work-center?${q}`));
      expect(res.status, q).toBe(400);
    }
    const ok = await snapshotRoute(new Request("http://test/api/work-center?recent_limit=5"));
    expect(ok.status).toBe(200);
    const snap = await ok.json();
    expect(snap).toMatchObject({ version: 1, scope: { projectId: null, includeDeprecated: false } });
    expect(snap.instanceId).toBe(workCenterInstanceId());
  });
});

describe("transport", () => {
  it("epoch is stable within a process and the instance id persists", () => {
    const a = assembleSnapshot({});
    const b = assembleSnapshot({});
    expect(a.instanceEpoch).toBe(workCenterEpoch());
    expect(b.instanceEpoch).toBe(a.instanceEpoch);
    expect(a.instanceId).toBe(b.instanceId);
  });

  it("retries a read that raced a mutation, then gives up with snapshot_busy", () => {
    let calls = 0;
    const snap = assembleSnapshot({ onRead: () => { if (calls++ === 0) bumpWorkCenter(); } });
    expect(calls).toBe(2);
    expect(snap.sequence).toBe(workCenterSequence());
    expect(() => assembleSnapshot({ onRead: () => bumpWorkCenter() })).toThrow(SnapshotBusy);
  });

  it("answers 503 snapshot_busy with Retry-After when the read never settles", async () => {
    const mod = await import("@/lib/workCenter/snapshot");
    const spy = vi.spyOn(mod, "assembleSnapshot").mockImplementation(() => { throw new mod.SnapshotBusy(); });
    try {
      const res = await snapshotRoute(new Request("http://test/api/work-center"));
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("1");
      expect((await res.json()).error).toMatchObject({ code: "snapshot_busy", retryable: true });
    } finally {
      spy.mockRestore();
    }
  });

  it("hydrates a new SSE connection and announces a source change with the new sequence", async () => {
    const { task } = fresh();
    const t = task("A");
    const ac = new AbortController();
    const res = await eventsRoute(new Request("http://test/api/events", { signal: ac.signal }));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const next = async (): Promise<Record<string, unknown>> => {
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("closed");
        buf += dec.decode(value);
      }
    };
    try {
      const hello = await next();
      expect(hello).toMatchObject({ type: "work_center_changed", version: 1, instanceEpoch: workCenterEpoch() });
      publishGlobal(t.id, { type: "task_edited" });
      let changed = await next();
      while (changed.type !== "work_center_changed") changed = await next();
      expect(changed.sequence as number).toBeGreaterThan(hello.sequence as number);
    } finally {
      ac.abort();
    }
  });
});

describe("compatibility surfaces", () => {
  it("/api/needs-you keeps its shape and lists only visible tasks", async () => {
    const { project, task } = fresh("Compat");
    const a = task("Asks");
    await parkAsk(a.id);
    const ci = task("Red", { status: "done" });
    redPr(ci.id, { episode: "e" });
    const hidden = task("Snoozed");
    await parkAsk(hidden.id);
    updateTask(hidden.id, { snoozed_until: Date.now() + 60_000 });

    const rows = (await (await needsYouRoute()).json()).tasks as ReturnType<typeof needsYouRows>;
    const mine = rows.filter((r) => r.project_id === project.id);
    expect(mine.map((r) => r.id).sort()).toEqual([a.id, ci.id].sort());
    expect(mine.find((r) => r.id === ci.id)).toMatchObject({ reason: "ci", pr_number: 7, pr_url: "https://github.com/o/r/pull/7", project_name: "Compat" });
    expect(mine.find((r) => r.id === a.id)?.reason).toBe("input");
    expect(Object.keys(mine[0]).sort()).toEqual(["id", "pr_number", "pr_url", "project_color", "project_icon", "project_id", "project_name", "reason", "title", "waiting_since"]);
    bumpWorkCenter(); // the count is cached per sequence; mutations through routes publish
    expect(awaitingCountFor(project.id)).toBe(2);
  });
});

describe("CI source", () => {
  it("an authorized recovery suppresses only its own episode while it is queued or executing", async () => {
    const { project, task } = fresh();
    const a = task("A");
    redPr(a.id, { episode: "ep-1" });
    expect(rowOf(assembleSnapshot({ projectId: project.id }), a.id)?.attention).toHaveLength(1);

    // Stamped but nothing executing or queued: still actionable.
    setCiRecovery(a.id, "ep-1");
    expect(rowOf(assembleSnapshot({ projectId: project.id }), a.id)?.attention).toHaveLength(1);

    // Durably queued: suppressed for that episode.
    const { addPendingMessage } = await import("@/lib/store");
    addPendingMessage(a.id, getTask(a.id)!.generation, "fix it");
    expect(rowOf(assembleSnapshot({ projectId: project.id }), a.id)?.attention ?? []).toEqual([]);

    // A different episode is actionable again.
    setTaskPrEvidence(a.id, { head_sha: "h2", repository_id: "42", episode_id: "ep-2", episode_fingerprint: "fp2", snapshot_json: "[]", episode_started_at: 5 });
    expect(rowOf(assembleSnapshot({ projectId: project.id }), a.id)?.attention[0].sourceRevision).toBe("ep-2");
  });

  it("an unrelated running turn keeps the CI action", () => {
    const { project, task } = fresh();
    const a = task("A");
    redPr(a.id, { episode: "ep-1" });
    // No ci_recovery stamp: a running turn alone must not suppress the item.
    const snap = assembleSnapshot({ projectId: project.id });
    expect(rowOf(snap, a.id)?.attention[0]).toMatchObject({ kind: "ci", action: "fix_ci" });
  });

  it("item identity includes repository, PR, head and episode", () => {
    const { project, task } = fresh();
    const a = task("A");
    redPr(a.id, { episode: "ep-1" });
    const first = rowOf(assembleSnapshot({ projectId: project.id }), a.id)!.attention[0];
    setTaskPrEvidence(a.id, { head_sha: "h2", repository_id: "42", episode_id: "ep-1", episode_fingerprint: "fp", snapshot_json: "[]", episode_started_at: 1234 });
    const second = rowOf(assembleSnapshot({ projectId: project.id }), a.id)!.attention[0];
    expect(second.id).not.toBe(first.id);
    expect(second.sourceRevision).toBe(first.sourceRevision);
  });

  it("a failed refresh keeps the last coherent value, marks it stale and records the attempt", async () => {
    const { project, task } = fresh();
    const a = task("A");
    redPr(a.id, { episode: "ep-1" });
    const synced = getTask(a.id)!.pr_synced_at;
    updateProject(project.id, { repo_path: process.cwd() });
    prMock.mockResolvedValue({ ok: false, error: "network down" });

    const out = await refreshPrState(a.id, { force: true });
    expect(out).toMatchObject({ ok: false, reason: "failed" });
    const row = getTask(a.id)!;
    expect(row.pr_synced_at).toBe(synced);
    expect(row.pr_refresh_error).toBe("network down");
    expect(row.pr_ci_episode_id).toBe("ep-1");
    const item = rowOf(assembleSnapshot({ projectId: project.id }), a.id)!.attention[0];
    expect(item.freshness).toMatchObject({ state: "stale", errorCode: "refresh_failed", observedAt: synced });
  });

  it("a successful refresh stores the episode; a same-head rerun starts a new one; green settles", async () => {
    const { project, task } = fresh();
    const a = task("A");
    updateTask(a.id, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7 });
    updateProject(project.id, { repo_path: process.cwd() });
    const snapshot = (checks: string) => ({ ok: true, snapshot: { number: 7, state: "open", checks, review: "", mergedAt: 0, mergeState: "", draft: false, failing: [] } });
    const check = (id: string, conclusion: string, startedAt: number) => ({
      kind: "check_run", id: `n${id}`, headSha: "h1", name: "test", workflowRunId: "1", attempt: null, status: "completed", conclusion, url: null,
      startedAt, completedAt: startedAt + 1, providerAppId: "1", workflowId: null, checkSuiteId: "9", context: "test", sortId: id,
    });

    prMock.mockResolvedValue(snapshot("failing"));
    evidenceMock.mockResolvedValue({ ok: true, headSha: "h1", repositoryId: "42", checks: [check("10", "failure", 1000)], complete: true });
    await refreshPrState(a.id, { force: true });
    const first = getTask(a.id)!;
    expect(first).toMatchObject({ pr_head_sha: "h1", pr_repository_id: "42", pr_refresh_error: null });
    expect(first.pr_ci_episode_id).toBeTruthy();

    // Same refresh again: identical observation keeps the episode.
    await refreshPrState(a.id, { force: true });
    expect(getTask(a.id)!.pr_ci_episode_id).toBe(first.pr_ci_episode_id);

    // Same head, rerun that failed again under a new check id: new episode.
    evidenceMock.mockResolvedValue({ ok: true, headSha: "h1", repositoryId: "42", checks: [check("11", "failure", 2000)], complete: true });
    await refreshPrState(a.id, { force: true });
    const rerun = getTask(a.id)!;
    expect(rerun.pr_ci_episode_id).not.toBe(first.pr_ci_episode_id);
    expect(rowOf(assembleSnapshot({ projectId: project.id }), a.id)!.attention[0].sourceRevision).toBe(rerun.pr_ci_episode_id);

    // A torn collection never clears the red episode.
    evidenceMock.mockResolvedValue({ ok: true, headSha: "h1", repositoryId: "42", checks: [], complete: false });
    await refreshPrState(a.id, { force: true });
    expect(getTask(a.id)!.pr_ci_episode_id).toBe(rerun.pr_ci_episode_id);

    // Green settles it; a later failure is a new episode.
    prMock.mockResolvedValue(snapshot("passing"));
    await refreshPrState(a.id, { force: true });
    expect(getTask(a.id)!.pr_ci_episode_id).toBeNull();
    expect(rowOf(assembleSnapshot({ projectId: project.id }), a.id)?.attention ?? []).toEqual([]);
  });

  it("Fix CI revalidates the episode: a stale click is a 409 source_changed", async () => {
    const { task } = fresh();
    const a = task("A");
    redPr(a.id, { episode: "ep-now" });
    setTaskPrState(a.id, { state: "open", checks: "failing", review: "", merged_at: 0, synced_at: Date.now(), failing: JSON.stringify([{ name: "test", url: "", workflow: "", verdict: "FAILURE" }]) });
    prMock.mockResolvedValue({ ok: true, snapshot: { number: 7, state: "open", checks: "failing", review: "", mergedAt: 0, mergeState: "", draft: false, failing: [] } });
    evidenceMock.mockResolvedValue({ ok: false, error: "offline" });
    const res = await fixCiRoute(post({ episodeId: "ep-old" }), params(a.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("source_changed");
    expect(getTask(a.id)!.ci_recovery_episode_id).toBeNull();
  });
});

describe("agent edits", () => {
  it("lists outstanding edits and an older acknowledgement leaves a newer edit (equal timestamps) visible", () => {
    const { project, task } = fresh();
    const target = task("Target");
    const actor = task("Actor");
    const edit = (title: string) => recordAgentEdit({ task_id: target.id, project_id: project.id, actor_task_id: actor.id, actor_title: "Actor", actor_agent: "claude", changes: [{ field: "title", before: "a", after: title } as never] });
    const first = edit("one");
    const second = edit("two");
    // Force an equal timestamp so only the rowid separates them.
    getDb().prepare("UPDATE task_agent_edits SET created_at = 5000 WHERE task_id = ?").run(target.id);
    expect(listOutstandingAgentEdits().filter((e) => e.task_id === target.id)).toHaveLength(2);

    return agentEditsRoute(post({ action: "ack", edit_id: first.id }), params(target.id)).then(async (res) => {
      expect(res.status).toBe(200);
      const left = listAgentEdits(target.id).filter((e) => e.acknowledged_at === 0 && e.reverted_at === 0);
      expect(left.map((e) => e.id)).toEqual([second.id]);
      expect(getTask(target.id)!.agent_edited_at).toBeGreaterThan(0); // still flagged
      const items = rowOf(assembleSnapshot({ projectId: project.id }), target.id)!.attention;
      expect(items.map((i) => i.sourceRevision)).toEqual([second.id]);

      const all = await agentEditsRoute(post({ action: "ack", edit_id: second.id }), params(target.id));
      expect(all.status).toBe(200);
      expect(getTask(target.id)!.agent_edited_at).toBe(0);
      expect(rowOf(assembleSnapshot({ projectId: project.id }), target.id)?.attention ?? []).toEqual([]);
      const bad = await agentEditsRoute(post({ action: "ack", edit_id: "missing" }), params(target.id));
      expect(bad.status).toBe(404);
    });
  });
});

describe("turn failure source and acknowledgement", () => {
  function failedTurn(taskId: string, code: "execution" | "auth") {
    const t = getTask(taskId)!;
    const turnId = `turn-${taskId}-${code}`;
    beginTurnRecord(taskId, { turnId, sessionId: null, generation: t.generation, startedAt: Date.now() - 10 });
    finalizeTurnRecord(taskId, turnId, { outcome: "failed", endedAt: Date.now(), failureCode: code });
    return turnId;
  }

  it("a failed turn is one actionable item; a stopped turn is only a recent result", () => {
    const { project, task } = fresh();
    const a = task("Failed");
    const turnId = failedTurn(a.id, "execution");
    const stopped = task("Stopped");
    beginTurnRecord(stopped.id, { turnId: "s1", sessionId: null, generation: 0, startedAt: Date.now() - 5 });
    finalizeTurnRecord(stopped.id, "s1", { outcome: "stopped", endedAt: Date.now() });

    const snap = assembleSnapshot({ projectId: project.id });
    expect(rowOf(snap, a.id)!.attention[0]).toMatchObject({ kind: "turn_failure", action: "recover_turn", sourceRevision: turnId });
    expect(rowOf(snap, stopped.id)?.attention ?? []).toEqual([]);
    expect(snap.recentlyFinished.rows.map((r) => r.taskId)).toContain(stopped.id);
  });

  it("failure-ack validates the turn, refuses other recovery kinds and clears only the item", async () => {
    const { project, task } = fresh();
    const a = task("Exec");
    const turnId = failedTurn(a.id, "execution");

    const stale = await failureAckRoute(post({ turnId: "old" }), params(a.id));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("source_changed");
    expect((await failureAckRoute(post({}), params(a.id))).status).toBe(400);
    expect((await failureAckRoute(post({ turnId }), params("missing"))).status).toBe(404);

    const ok = await failureAckRoute(post({ turnId }), params(a.id));
    expect(ok.status).toBe(200);
    expect(getTask(a.id)).toMatchObject({ failure_ack_turn_id: turnId });
    expect(getTask(a.id)!.latest_turn_failure_resolved_at).toBeGreaterThan(0);
    expect(rowOf(assembleSnapshot({ projectId: project.id }), a.id)?.attention ?? []).toEqual([]);

    const auth = task("Auth");
    const authTurn = failedTurn(auth.id, "auth");
    const res = await failureAckRoute(post({ turnId: authTurn }), params(auth.id));
    expect(res.status).toBe(400);
    expect(rowOf(assembleSnapshot({ projectId: project.id }), auth.id)!.attention).toHaveLength(1);
  });
});

describe("answer preconditions", () => {
  it("answers the exact request, and a mismatch is 409 request_expired without answering", async () => {
    const { task } = fresh();
    const a = task("A");
    const first = await parkAsk(a.id);
    const second = await parkAsk(a.id);
    const row = (await import("@/lib/store")).getTask(a.id)!;
    const sessionId = (await import("@/lib/store")).sessionRowId(a.id, row.generation) ?? undefined;

    const wrong = await answerRoute(post({ askId: second.askId, answers: [["A"]], sessionId, messageId: first.messageId, requestId: second.askId }), params(a.id));
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error.code).toBe("request_expired");

    // The old client path still answers by askId alone.
    const legacy = await answerRoute(post({ askId: second.askId, answers: [["A"]] }), params(a.id));
    expect((await legacy.json()).resolved).toBe(true);

    // A request settled in another tab (the legacy answer above): the precondition path says expired.
    const gone = await answerRoute(post({ askId: second.askId, answers: [["A"]], sessionId, messageId: second.messageId, requestId: second.askId }), params(a.id));
    expect(gone.status).toBe(409); // settled elsewhere: expired, never answered against another request
    expect((await gone.json()).error.code).toBe("request_expired");
    expect(first.askId).not.toBe(second.askId);
  });
});

describe("base rewrite source", () => {
  it("a legacy flag gets a stable episode with limited provenance; a stamped one is structured", () => {
    const { project, task } = fresh();
    const legacy = task("Legacy");
    updateTask(legacy.id, { base_rewritten_at: 4242 });
    const stamped = task("Stamped");
    updateTask(stamped.id, { base_rewritten_at: 5000 });
    getDb().prepare("UPDATE tasks SET base_rewrite_episode_id = 'ep-b', base_rewrite_message_id = 'm1', base_rewrite_base_sha = 'abc' WHERE id = ?").run(stamped.id);

    const one = assembleSnapshot({ projectId: project.id });
    const two = assembleSnapshot({ projectId: project.id });
    expect(rowOf(one, legacy.id)!.attention[0].id).toBe(rowOf(two, legacy.id)!.attention[0].id);
    expect(one.coverage).toContainEqual({ source: "base_rewrite", taskId: legacy.id, state: "partial", reason: "legacy_provenance" });
    expect(rowOf(one, stamped.id)!.attention[0]).toMatchObject({ kind: "base_rewrite", action: "repair_base", sourceRevision: "ep-b" });
    expect(rowOf(one, stamped.id)!.attention[0].destination).toMatchObject({ messageId: "m1", surface: "base_sync" });
  });
});

describe("snooze through the existing route", () => {
  it("PATCH snoozed_until moves the sequence and hides the task", async () => {
    const { project, task } = fresh();
    const a = task("A");
    await parkAsk(a.id);
    const before = workCenterSequence();
    const res = await patchTask(new Request("http://test", { method: "PATCH", body: JSON.stringify({ snoozed_until: Date.now() + 120_000 }) }), params(a.id));
    expect(res.status).toBe(200);
    expect(workCenterSequence()).toBeGreaterThan(before);
    expect(projectSummary(assembleSnapshot({ projectId: project.id }), project.id).visibleNeedsYouTaskCount.value).toBe(0);
  });
});

describe("recent results", () => {
  it("lists a finished turn once and never duplicates a task within a page", () => {
    const { project, task } = fresh();
    const a = task("Done turn");
    beginTurnRecord(a.id, { turnId: "r1", sessionId: null, generation: 0, startedAt: Date.now() - 20 });
    finalizeTurnRecord(a.id, "r1", { outcome: "ok", endedAt: Date.now() - 10 });
    const snap = assembleSnapshot({ projectId: project.id });
    const ids = snap.recentlyFinished.rows.map((r) => r.taskId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(snap.recentlyFinished.rows.find((r) => r.taskId === a.id)?.latestResult).toMatchObject({ turnId: "r1", outcome: "ok" });
    // No invented review attention for a clean result.
    expect(snap.recentlyFinished.rows.find((r) => r.taskId === a.id)?.attention).toEqual([]);
  });
});
