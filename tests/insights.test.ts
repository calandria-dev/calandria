import { describe, expect, it } from "vitest";
import { ensureWorktree, mergeTask } from "../lib/git";
import {
  addUsage,
  createTag,
  createProject,
  createTask,
  deleteTask,
  getInsightsData,
  getTaskUsage,
  recordTaskMerge,
  updateTask,
} from "../lib/store";
import { commitFile, makeRepoWithWorktree, tmpDir, writeFile } from "./helpers";
import { addInternalUsage } from "../lib/internalUsage";
import type { TurnUsage } from "../lib/types";

const DAY = 24 * 60 * 60 * 1000;
// Pinned to TurnUsage rather than derived from addUsage's param: the ledger
// accepts a null cost (an unpriced endpoint — see LedgerUsage) and internal
// usage does not, so deriving would make every one of these rows nullable for
// no reason. Everything here is ordinary priced cloud spend.
const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  cost_usd: 1.5, input_tokens: 100, output_tokens: 50, cache_read_tokens: 1000, cache_creation_tokens: 200,
  ...over,
});

function makeProjectTask(agent = "claude") {
  const project = createProject({ name: `p-${Math.random().toString(36).slice(2, 8)}`, repo_path: tmpDir() });
  const task = createTask({ project_id: project.id, title: "t", description: "", agent });
  return { project, task };
}

// The dashboard reads `cost` as the period's spend, so a bucket that quietly
// omitted an unpriced turn would be the same under-report this feature exists
// to end — just one layer further out. `unp` is what lets the KPI and the
// leaderboards mark the figure as a floor.
describe("unpriced turns in the insights aggregates", () => {
  it("counts a null-cost turn without letting it touch the spend or the tokens", () => {
    const { project } = makeProjectTask();
    const tag = createTag({ project_id: project.id, name: "feature" });
    const task = createTask({ project_id: project.id, title: "t", description: "", tag_ids: [tag.id] });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "claude", usage: usage({ cost_usd: 2 }) });
    addUsage({
      project_id: project.id, task_id: task.id, generation: 1, agent: "claude",
      provider: "openrouter.ai",
      // What lib/runner.ts writes for a custom base URL: tokens measured, price
      // unknown. NOT 0 — that would assert the turn was free.
      usage: { ...usage({ input_tokens: 7 }), cost_usd: null },
    });

    const data = getInsightsData(Date.now() - DAY);
    const mine = data.usage.filter((r) => r.p === project.id);
    expect(mine).toHaveLength(1);
    // Two turns, one price. The dollar figure is the priced turn alone, and the
    // tokens are both — an unpriced turn still filled a context window.
    expect(mine[0].cost).toBe(2);
    expect(mine[0].unp).toBe(1);
    expect(mine[0].inp).toBe(107);

    const mineTag = data.tagUsage.filter((r) => r.p === project.id && r.g === tag.id);
    expect(mineTag).toHaveLength(1);
    expect(mineTag[0]).toMatchObject({ cost: 2, unp: 1 });
  });

  it("reports no unpriced turns when every row carries a price, zero included", () => {
    const { project, task } = makeProjectTask();
    // A local model server's 0 is a MEASUREMENT and must not be confused for an
    // unknown: it belongs in the total, and it isn't counted here.
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "claude", provider: "localhost:11434", usage: usage({ cost_usd: 0 }) });
    const mine = getInsightsData(Date.now() - DAY).usage.filter((r) => r.p === project.id);
    expect(mine[0]).toMatchObject({ cost: 0, unp: 0 });
  });
});

describe("merge line stats", () => {
  it("mergeTask reports the additions/deletions the merge landed", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "a.txt", "one\ntwo\nthree\n", "add a");
    writeFile(wt.path, "b.txt", "x\n"); // uncommitted — committed by mergeTask

    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch,
      baseBranch: "main", message: "land",
    });

    expect(res.ok).toBe(true);
    expect(res.additions).toBe(4); // 3 lines in a.txt + 1 in b.txt
    expect(res.deletions).toBe(0);
  });

  it("omits stats when there was nothing to land", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch,
      baseBranch: "main", message: "noop",
    });
    expect(res.ok).toBe(true);
    expect(res.alreadyMerged).toBe(true);
    expect(res.additions).toBeUndefined();
  });
});

describe("getInsightsData", () => {
  it("buckets usage by local day and stamps the agent", () => {
    const { project, task } = makeProjectTask();
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "claude", usage: usage() });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "codex", usage: usage({ cost_usd: 0.5 }) });
    // A third agent id is a third bucket and nothing else: the ledger stores
    // whatever the driver is called, and the view reads the ids back off the
    // rows rather than from a fixed pair (app/shell/InsightsView.tsx).
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "gemini", usage: usage({ cost_usd: 0.25 }) });

    const data = getInsightsData(Date.now() - DAY);
    const mine = data.usage.filter((u) => u.p === project.id);
    expect(mine).toHaveLength(3); // grouped by (day, project, agent)
    expect(mine.find((u) => u.a === "gemini")!.cost).toBeCloseTo(0.25);
    const claude = mine.find((u) => u.a === "claude")!;
    expect(claude.cost).toBeCloseTo(1.5);
    expect(claude.inp).toBe(100);
    expect(claude.cr).toBe(1000);
    expect(mine.find((u) => u.a === "codex")!.cost).toBeCloseTo(0.5);
    // local-day key, not UTC: matches what the client generates from new Date()
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(claude.d).toBe(key);
  });

  it("aggregates merges and shipped tasks, and honors the since cutoff", () => {
    const { project, task } = makeProjectTask("codex");
    updateTask(task.id, { merged_at: Date.now() });
    recordTaskMerge({ project_id: project.id, task_id: task.id, agent: "codex", additions: 120, deletions: 30 });
    recordTaskMerge({ project_id: project.id, task_id: task.id, agent: "codex", additions: 10, deletions: 5 });

    const data = getInsightsData(Date.now() - DAY);
    const m = data.merges.filter((r) => r.p === project.id);
    expect(m).toHaveLength(1); // same day+agent → one grouped row
    expect(m[0].add).toBe(130);
    expect(m[0].del).toBe(35);
    expect(m[0].a).toBe("codex");
    const s = data.shipped.filter((r) => r.p === project.id);
    expect(s).toHaveLength(1);
    expect(s[0].n).toBe(1);

    // a cutoff in the future excludes everything
    const later = getInsightsData(Date.now() + DAY);
    expect(later.merges.filter((r) => r.p === project.id)).toHaveLength(0);
    expect(later.shipped.filter((r) => r.p === project.id)).toHaveLength(0);
  });

  it("groups Calandria usage by job and keeps project-less runs separate from task usage", () => {
    const { project, task } = makeProjectTask("codex");
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "codex", usage: usage() });
    addInternalUsage({
      job: "draftProjectContext", agent: "codex", requested_agent: "codex",
      project_id: project.id, usage: usage({ cost_usd: 0.4, input_tokens: 20, output_tokens: 10 }),
    });
    addInternalUsage({
      job: "draftProjectContext", agent: "codex", requested_agent: "codex",
      project_id: project.id, usage: usage({ cost_usd: 0.6, input_tokens: 30, output_tokens: 15 }),
    });
    addInternalUsage({
      job: "summarizeProjectRecap", agent: "codex", requested_agent: "codex",
      project_id: project.id, usage: usage({ cost_usd: 0.2 }),
    });
    addInternalUsage({
      job: "verify", agent: "claude", requested_agent: "claude",
      usage: usage({ cost_usd: 0.05, input_tokens: 5, output_tokens: 1 }),
    });

    const data = getInsightsData(Date.now() - DAY);
    const mine = data.internal.filter((r) => r.p === project.id);
    expect(mine).toHaveLength(2);
    const drafts = mine.find((r) => r.job === "draftProjectContext")!;
    expect(drafts.n).toBe(2);
    expect(drafts.cost).toBeCloseTo(1);
    expect(drafts.inp).toBe(50);
    expect(drafts.out).toBe(25);

    const verify = data.internal.find((r) => r.job === "verify" && r.a === "claude")!;
    expect(verify.p).toBe("");
    expect(verify.n).toBe(1);

    // Calandria convenience work must never change the existing task-turn cube.
    const taskRows = data.usage.filter((r) => r.p === project.id);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].cost).toBeCloseTo(1.5);
    expect(taskRows[0].inp).toBe(100);
  });

  // The Tags leaderboard ("what did the auth migration cost") reads a SEPARATE
  // cube (tagUsage), one dimension finer than `usage` — folding it into `usage`
  // would double-count a task carrying more than one tag.
  it("attributes spend to tags in a separate cube, leaving `usage` untouched and unsummed", () => {
    const { project, task } = makeProjectTask();
    const tag = createTag({ project_id: project.id, name: "Auth migration" });
    const member = createTask({ project_id: project.id, title: "member", tag_ids: [tag.id] });
    const doomed = createTask({ project_id: project.id, title: "doomed", tag_ids: [tag.id] });
    addUsage({ project_id: project.id, task_id: member.id, generation: 1, agent: "claude", usage: usage() });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "claude", usage: usage({ cost_usd: 2 }) });
    addUsage({ project_id: project.id, task_id: doomed.id, generation: 1, agent: "claude", usage: usage({ cost_usd: 4 }) });
    // A deleted task takes its usage with it (ON DELETE CASCADE), so this row
    // is gone from both buckets — what matters is that the JOIN doesn't drop
    // spend that IS still there.
    deleteTask(doomed.id);

    const data = getInsightsData(Date.now() - DAY);
    // `usage` (the existing task-turn cube) has no `g` field at all any more —
    // it must not change shape just because tags exist.
    expect((data.usage[0] as unknown as { g?: unknown }).g).toBeUndefined();
    const usageRows = data.usage.filter((r) => r.p === project.id);
    expect(usageRows.reduce((n, r) => n + r.cost, 0)).toBeCloseTo(3.5);

    const tagRows = data.tagUsage.filter((r) => r.p === project.id);
    expect(tagRows.find((r) => r.g === tag.id)!.cost).toBeCloseTo(1.5);
    // Untagged spend keys on "" rather than vanishing — the day/project/agent
    // totals every chart above the leaderboard is built on must not change.
    expect(tagRows.find((r) => r.g === "")!.cost).toBeCloseTo(2);
    expect(tagRows.reduce((n, r) => n + r.cost, 0)).toBeCloseTo(3.5);
    // The tag itself rides along so the leaderboard has a label for that key.
    expect(data.tags.find((g) => g.id === tag.id)).toMatchObject({ name: "Auth migration", project_id: project.id });
  });

  it("a task with two tags contributes usage to BOTH — tagUsage does not sum to `usage`", () => {
    const { project } = makeProjectTask();
    const first = createTag({ project_id: project.id, name: "Auth migration" });
    const second = createTag({ project_id: project.id, name: "Flaky tests" });
    const both = createTask({ project_id: project.id, title: "both", tag_ids: [first.id, second.id] });
    addUsage({ project_id: project.id, task_id: both.id, generation: 1, agent: "claude", usage: usage({ cost_usd: 3 }) });

    const data = getInsightsData(Date.now() - DAY);
    const usageRows = data.usage.filter((r) => r.p === project.id);
    expect(usageRows.reduce((n, r) => n + r.cost, 0)).toBeCloseTo(3);

    const tagRows = data.tagUsage.filter((r) => r.p === project.id);
    // Both tags get the full $3 — the row genuinely belongs to both plans.
    expect(tagRows.find((r) => r.g === first.id)!.cost).toBeCloseTo(3);
    expect(tagRows.find((r) => r.g === second.id)!.cost).toBeCloseTo(3);
    // So the tag cube's total (6) does NOT equal the task cube's total (3).
    expect(tagRows.reduce((n, r) => n + r.cost, 0)).toBeCloseTo(6);
  });
});
// SUM() over zero rows is NULL, not 0, and `unpriced_turns` is typed a number.
// A task nobody has run yet is the commonest row in the table.
describe("usage totals with no rows at all", () => {
  it("reports zeroes, not nulls, for a task that has never run", () => {
    const { task } = makeProjectTask();
    const totals = getTaskUsage(task.id);
    expect(totals.unpriced_turns).toBe(0);
    expect(totals).toMatchObject({ cost_usd: 0, turns: 0, unpriced_turns: 0 });
  });
});
