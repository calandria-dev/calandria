import { describe, it, expect } from "vitest";

// Pure Work Center arithmetic and CI identity (contract work-center/1 with
// amendment 1): no database, no clock, no git.
import { inlineDecisionOf, summarize, type TaskTally } from "@/lib/workCenter/counts";
import { legacyEpisodeId, parseSourceId, sourceId } from "@/lib/workCenter/ids";
import {
  canonicalJson,
  coherent,
  failingFingerprint,
  selectLatest,
  stepEpisode,
  type CheckEvidence,
} from "@/lib/workCenter/ciEvidence";

const t = (taskId: string, items: number, snoozed = false, over: Partial<TaskTally> = {}): TaskTally => ({
  taskId, items, snoozed, working: false, workUnknown: false, ...over,
});

describe("summarize", () => {
  it("counts a task once however many items it has", () => {
    const s = summarize([t("a", 3), t("b", 1)], { attentionComplete: true }, 0);
    expect(s.needsYouTaskCount).toEqual({ value: 2, known: 2 });
    expect(s.attentionItemCount).toEqual({ value: 4, known: 4 });
    expect(s.visibleNeedsYouTaskCount).toEqual({ value: 2, known: 2 });
  });

  it("subtracts snoozed tasks from the visible counts and leaves the totals alone", () => {
    const s = summarize([t("a", 3, true), t("b", 1, true)], { attentionComplete: true }, 0);
    expect(s.needsYouTaskCount.value).toBe(2);
    expect(s.attentionItemCount.value).toBe(4);
    expect(s.snoozedNeedsYouTaskCount).toEqual({ value: 2, known: 2 });
    expect(s.visibleNeedsYouTaskCount).toEqual({ value: 0, known: 0 });
    expect(s.visibleAttentionItemCount).toEqual({ value: 0, known: 0 });
  });

  it("one snoozed of two, with a missing adapter: every needs-you value is null, known subtracts exactly", () => {
    const s = summarize([t("a", 3, true), t("b", 1)], { attentionComplete: false }, 0);
    expect(s.needsYouTaskCount).toEqual({ value: null, known: 2 });
    expect(s.snoozedNeedsYouTaskCount).toEqual({ value: null, known: 1 });
    expect(s.visibleNeedsYouTaskCount).toEqual({ value: null, known: 1 });
    expect(s.visibleAttentionItemCount).toEqual({ value: null, known: 1 });
  });

  it("working is unknown only when an unobserved task might be working", () => {
    expect(summarize([t("a", 0, false, { working: true })], { attentionComplete: true }, 0).workingTaskCount).toEqual({ value: 1, known: 1 });
    expect(summarize([t("a", 0, false, { workUnknown: true })], { attentionComplete: true }, 0).workingTaskCount).toEqual({ value: null, known: 0 });
    // A task that is known to be working is not made unknown by a sibling.
    expect(summarize([t("a", 0, false, { working: true, workUnknown: true })], { attentionComplete: true }, 0).workingTaskCount.value).toBe(1);
  });
});

describe("inlineDecision", () => {
  const base = { kind: "permission" as const, live: true, agent: "claude", requestKind: undefined, offersScope: false };
  it("is offered only for a live, scope-free, ordinary Claude permission", () => {
    expect(inlineDecisionOf(base)).toBe("allow_once_or_deny");
    expect(inlineDecisionOf({ ...base, offersScope: true })).toBeNull();
    expect(inlineDecisionOf({ ...base, requestKind: "settings" })).toBeNull();
    expect(inlineDecisionOf({ ...base, requestKind: "environment" })).toBeNull();
    expect(inlineDecisionOf({ ...base, agent: "codex" })).toBeNull();
    expect(inlineDecisionOf({ ...base, agent: "gemini" })).toBeNull();
    expect(inlineDecisionOf({ ...base, live: false })).toBeNull();
    expect(inlineDecisionOf({ ...base, kind: "question" })).toBeNull();
  });
});

describe("source ids", () => {
  it("round-trips a tuple and keeps delimiter-bearing ids distinct", () => {
    const a = sourceId("ci", ["t1", "repo:1", 7, "abc", "ep"]);
    expect(parseSourceId(a)).toEqual({ kind: "ci", tuple: ["t1", "repo:1", 7, "abc", "ep"] });
    expect(sourceId("question", ["a:b", "c"])).not.toBe(sourceId("question", ["a", "b:c"]));
    expect(parseSourceId("nonsense")).toBeNull();
  });
  it("derives a stable legacy episode", () => {
    expect(legacyEpisodeId("t", 5)).toBe(legacyEpisodeId("t", 5));
    expect(legacyEpisodeId("t", 5)).not.toBe(legacyEpisodeId("t", 6));
  });
});

function ev(over: Partial<CheckEvidence> & Pick<CheckEvidence, "sortId">): CheckEvidence {
  return {
    kind: "check_run", id: `node-${over.sortId}`, headSha: "h1", name: "test", workflowRunId: "9", attempt: null,
    status: "completed", conclusion: "failure", url: null, startedAt: 1000, completedAt: 2000,
    providerAppId: "15368", workflowId: null, checkSuiteId: "77", context: "test", ...over,
  };
}

describe("CI episodes", () => {
  const none = { episodeId: null, fingerprint: null, startedAt: null };
  let n = 0;
  const mint = () => `ep${++n}`;

  it("keeps the id for an identical failing observation", () => {
    const obs = { headSha: "h1", checks: [ev({ sortId: "10" })], complete: true };
    const a = stepEpisode(none, obs, 1, mint);
    const b = stepEpisode(a, obs, 2, mint);
    expect(b.episodeId).toBe(a.episodeId);
    expect(b.startedAt).toBe(1);
  });

  it("a same-head rerun with a new check id is a new episode", () => {
    const first = stepEpisode(none, { headSha: "h1", checks: [ev({ sortId: "10" })], complete: true }, 1, mint);
    const rerun = stepEpisode(first, { headSha: "h1", checks: [ev({ sortId: "11", startedAt: 3000 })], complete: true }, 2, mint);
    expect(rerun.episodeId).not.toBe(first.episodeId);
  });

  it("settles on green, and a later failure with the same fingerprint is still new", () => {
    const red = { headSha: "h1", checks: [ev({ sortId: "10" })], complete: true };
    const first = stepEpisode(none, red, 1, mint);
    const green = stepEpisode(first, { headSha: "h1", checks: [ev({ sortId: "11", startedAt: 3000, conclusion: "success" })], complete: true }, 2, mint);
    expect(green.episodeId).toBeNull();
    const again = stepEpisode(green, red, 3, mint);
    expect(again.episodeId).not.toBe(first.episodeId);
    expect(again.fingerprint).toBe(first.fingerprint);
  });

  it("a torn or incomplete observation never settles a red episode", () => {
    const first = stepEpisode(none, { headSha: "h1", checks: [ev({ sortId: "10" })], complete: true }, 1, mint);
    const torn = stepEpisode(first, { headSha: "h1", checks: [], complete: false }, 2, mint);
    expect(torn.authoritative).toBe(false);
    expect(torn.episodeId).toBe(first.episodeId);
  });

  it("selects the latest check per provider group, by start then numeric id", () => {
    const rows = [ev({ sortId: "9", startedAt: 1000 }), ev({ sortId: "100", startedAt: 1000, conclusion: "success" }), ev({ sortId: "20", startedAt: 900, name: "lint", context: "lint" })];
    const latest = selectLatest(rows);
    expect(latest.map((r) => r.sortId).sort()).toEqual(["100", "20"]);
  });

  it("groups a status by context and a check run by app, workflow or suite and context", () => {
    const a = ev({ sortId: "1", checkSuiteId: "A" });
    const b = ev({ sortId: "2", checkSuiteId: "B" });
    expect(selectLatest([a, b])).toHaveLength(2);
    const s1 = ev({ kind: "status", sortId: "3", context: "ci/x", providerAppId: null, checkSuiteId: null, status: "failure", conclusion: null });
    const s2 = ev({ kind: "status", sortId: "4", context: "ci/x", providerAppId: null, checkSuiteId: null, status: "success", conclusion: null, startedAt: 2000 });
    expect(selectLatest([s1, s2]).map((r) => r.sortId)).toEqual(["4"]);
  });

  it("fingerprints are order independent and canonical JSON sorts keys", () => {
    const a = ev({ sortId: "1" });
    const b = ev({ sortId: "2", name: "b", context: "b" });
    expect(failingFingerprint([a, b])).toBe(failingFingerprint([b, a]));
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });

  it("head must be the same before and after and on every row", () => {
    expect(coherent("h1", "h1", [ev({ sortId: "1" })])).toBe(true);
    expect(coherent("h1", "h2", [ev({ sortId: "1" })])).toBe(false);
    expect(coherent("h1", "h1", [ev({ sortId: "1", headSha: "other" })])).toBe(false);
  });
});
