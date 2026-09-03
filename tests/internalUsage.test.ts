import { beforeEach, describe, expect, it, vi } from "vitest";

const oneShot = vi.hoisted(() => vi.fn());

vi.mock("../lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Claude Code",
    draftProjectContext: oneShot,
  },
}));

import { getDb } from "../lib/db";
import { addUsage, createProject, createTask, getInstanceUsage, setSetting } from "../lib/store";
import { setAgentConnection } from "../lib/agents/connections";
import { draftProjectContext } from "../lib/agents/oneshots";
import {
  addInternalUsage,
  getClearEstimate,
  getContextDraftEstimate,
  internalUsageLast30Days,
} from "../lib/internalUsage";

const USAGE = {
  cost_usd: 0.25,
  input_tokens: 10,
  output_tokens: 20,
  cache_read_tokens: 30,
  cache_creation_tokens: 40,
};

describe("internal agent usage", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM internal_usage").run();
    getDb().prepare("DELETE FROM task_usage").run();
    setSetting("utility_agent", "codex");
    setSetting("default_agent", "claude");
    setSetting("agent_conn_codex", null);
    setAgentConnection("claude", { method: "subscription", email: null, plan: null });
    oneShot.mockReset();
  });

  it("records usage with the actual agent and fallback", async () => {
    oneShot.mockResolvedValue({ text: "draft", usage: USAGE });
    const project = createProject({ name: "Metered" });

    await expect(draftProjectContext(project, "digest")).resolves.toBe("draft");

    expect(getDb().prepare("SELECT * FROM internal_usage").get()).toMatchObject({
      job: "draftProjectContext",
      agent: "claude",
      requested_agent: "codex",
      fallback: 1,
      project_id: project.id,
      task_id: null,
      ok: 1,
      ...USAGE,
    });
  });

  it("records the model the driver says it RAN, not the one the setting asked for", async () => {
    // The whole point: a tier setting can only report what was requested, and
    // the interesting case is it being unset — the job then inherits the
    // driver's own default and only the driver can name it.
    oneShot.mockResolvedValue({ text: "draft", usage: USAGE, model: "claude-opus-5" });
    setSetting("job_model_heavy:claude", "sonnet");
    const project = createProject({ name: "Reported" });

    await draftProjectContext(project, "digest");

    expect(getDb().prepare("SELECT * FROM internal_usage").get()).toMatchObject({ model: "claude-opus-5" });
    setSetting("job_model_heavy:claude", null);
  });

  it("falls back to the requested model, then to null, when the driver can't report one", async () => {
    oneShot.mockResolvedValue({ text: "draft" });
    setSetting("job_model_heavy:claude", "sonnet");
    const asked = createProject({ name: "Asked" });
    await draftProjectContext(asked, "digest");
    expect(getDb().prepare("SELECT model FROM internal_usage WHERE project_id = ?").get(asked.id))
      .toMatchObject({ model: "sonnet" });

    // Nothing set and nothing reported: the row says it doesn't know rather
    // than naming a default it would only be guessing at.
    setSetting("job_model_heavy:claude", null);
    const inherited = createProject({ name: "Inherited" });
    await draftProjectContext(inherited, "digest");
    expect(getDb().prepare("SELECT model FROM internal_usage WHERE project_id = ?").get(inherited.id))
      .toMatchObject({ model: null });
  });

  it("records the requested model on a failed job, which is all that is known", async () => {
    oneShot.mockRejectedValue(new Error("boom"));
    setSetting("job_model_heavy:claude", "sonnet");
    const project = createProject({ name: "Failed model" });

    await expect(draftProjectContext(project, "digest")).rejects.toThrow("boom");

    expect(getDb().prepare("SELECT * FROM internal_usage").get()).toMatchObject({ ok: 0, model: "sonnet" });
    setSetting("job_model_heavy:claude", null);
  });

  it("records zero counters when a driver omits usage", async () => {
    oneShot.mockResolvedValue({ text: "draft" });
    const project = createProject({ name: "Unmetered" });
    await draftProjectContext(project, "digest");

    expect(getDb().prepare("SELECT * FROM internal_usage").get()).toMatchObject({
      ok: 1,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });

  it("records failed internal jobs", async () => {
    oneShot.mockRejectedValue(new Error("boom"));
    const project = createProject({ name: "Failed" });
    await expect(draftProjectContext(project, "digest")).rejects.toThrow("boom");

    expect(getDb().prepare("SELECT * FROM internal_usage").get()).toMatchObject({
      job: "draftProjectContext",
      agent: "claude",
      requested_agent: "codex",
      fallback: 1,
      ok: 0,
    });
  });

  it("keeps task and internal totals separate in instance usage", () => {
    const project = createProject({ name: "Totals" });
    const task = createTask({ project_id: project.id, title: "Task", description: "" });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "claude", usage: USAGE });
    getDb().prepare(
      `INSERT INTO internal_usage
       (id, job, agent, requested_agent, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
       VALUES ('internal-test', 'verify', 'claude', 'claude', 1.5, 1, 2, 3, 4, ?)`
    ).run(Date.now());

    expect(getInstanceUsage()).toMatchObject({
      cost_usd: 0.25,
      total_tokens: 100,
      turns: 1,
      subagent_tokens: 0,
      internal_cost_usd: 1.5,
      internal_tokens: 10,
      internal_jobs: 1,
    });
  });

  // InstanceUsage extends UsageTotals, so the rollup PROMISES this field. Its
  // query is hand-written rather than sharing sumUsage(), which is exactly how
  // a new column gets declared in the type and never selected — undefined at
  // runtime under a signature saying number.
  it("carries sidechain tokens in the instance rollup, not just the per-task one", () => {
    const project = createProject({ name: "Sidechains" });
    const task = createTask({ project_id: project.id, title: "Task", description: "" });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "claude", usage: { ...USAGE, subagent_tokens: 4_000 } });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "claude", usage: USAGE });

    const rollup = getInstanceUsage();
    expect(typeof rollup.subagent_tokens).toBe("number");
    expect(rollup.subagent_tokens).toBe(4_000);
  });

  it("groups the settings readout by job and excludes usage older than 30 days", () => {
    const insert = getDb().prepare(
      `INSERT INTO internal_usage (id, job, agent, requested_agent, cost_usd, created_at)
       VALUES (?, ?, 'claude', 'claude', ?, ?)`
    );
    insert.run("recent-recap", "summarizeProjectRecap", 0.19, Date.now());
    insert.run("recent-recap-2", "summarizeProjectRecap", 0.01, Date.now());
    insert.run("old-recap", "summarizeProjectRecap", 99, Date.now() - 31 * 24 * 60 * 60 * 1000);

    expect(internalUsageLast30Days()).toContainEqual({
      job: "summarizeProjectRecap",
      runs: 2,
      cost_usd: 0.2,
      models: [],
    });
  });

  it("names the models behind a job's runs, busiest first, without dropping unnamed ones", () => {
    const insert = getDb().prepare(
      `INSERT INTO internal_usage (id, job, agent, requested_agent, model, cost_usd, created_at)
       VALUES (?, 'summarizeProjectRecap', 'claude', 'claude', ?, 0.01, ?)`
    );
    insert.run("haiku-1", "claude-haiku-4-5", Date.now());
    insert.run("haiku-2", "claude-haiku-4-5", Date.now());
    insert.run("opus-1", "claude-opus-5", Date.now());
    // A run whose driver couldn't say still counts; it just isn't named.
    insert.run("unknown-1", null, Date.now());

    const [row] = internalUsageLast30Days();
    expect(row.runs).toBe(4);
    expect(row.models).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
  });

  it("uses a project's latest context draft, then the instance median", () => {
    const project = createProject({ name: "Estimated" });
    addInternalUsage({ job: "draftProjectContext", agent: "claude", requested_agent: "claude", project_id: project.id, usage: { ...USAGE, cost_usd: 0.11, input_tokens: 30_000, output_tokens: 8_000, cache_read_tokens: 0, cache_creation_tokens: 0 } });
    expect(getContextDraftEstimate(project.id)).toMatchObject({ tokens: 38_000, cost_usd: 0.11, source: "project_latest" });

    const other = createProject({ name: "Fallback" });
    addInternalUsage({ job: "draftProjectContext", agent: "claude", requested_agent: "claude", usage: { ...USAGE, cost_usd: 0.21, input_tokens: 58_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } });
    expect(getContextDraftEstimate(other.id)).toMatchObject({ tokens: 48_000, cost_usd: 0.16, source: "instance_median" });
  });

  it("scales /clear history to the current transcript and prefers the task agent", () => {
    addInternalUsage({ job: "summarizeTranscript", agent: "claude", requested_agent: "claude", usage: { ...USAGE, cost_usd: 0.12, input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 } });
    addInternalUsage({ job: "summarizeTranscript", agent: "codex", requested_agent: "codex", usage: { ...USAGE, cost_usd: 9, input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 } });

    expect(getClearEstimate(200, "claude")).toMatchObject({ tokens: 240, cost_usd: 0.24, source: "scaled_history" });
  });

  it("does not manufacture estimates without metered history", () => {
    expect(getContextDraftEstimate("missing")).toBeNull();
    expect(getClearEstimate(20_000, "claude")).toBeNull();
  });
});
