// Tests for "Refresh tag" (lib/tagRefresh.ts), the button that reads a plan's
// tasks against the code and fixes what drifted. Two halves are covered:
//
//   - the detached-job state machine, the same shape contextRefresh.test.ts
//     pins for the project draft;
//   - applyTagPlan, the feature's policy for what a model's judgement may do
//     to a real row. That half runs without an agent, so the rules are
//     assertable from a plain object.
import { describe, expect, it, beforeEach, vi } from "vitest";

// The plan comes from the utility agent (lib/agents/oneshots.ts → the Claude
// driver). Stub the driver so these tests exercise the job, not an agent.
const planText = vi.fn(async () => "<<<TAG_PLAN>>>\n{\"description\":\"Fresh.\",\"tasks\":[]}\n<<<END_TAG_PLAN>>>");
vi.mock("../lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Claude Code",
    planTagRefresh: (...a: unknown[]) => planText(...(a as [])),
  },
}));

import { getDb } from "@/lib/db";
import { createProject, createTask, createTag, getTag, getTask, setTaskTags, setTagRefresh, updateTask } from "@/lib/store";
import { parseTagPlan } from "@/lib/agents/shared";
import {
  startTagRefreshJob, getTagRefreshState, clearTagRefresh, isTagRefreshing, applyTagPlan, tagMembers,
} from "@/lib/tagRefresh";
import { setAgentConnection } from "@/lib/agents/connections";
import type { AgentEditActor } from "@/lib/agentTools";

// Utility-agent resolution is connected-first: with nothing on record the job
// fails fast with "connect an agent" instead of reaching the stub.
setAgentConnection("claude", { method: "subscription", email: null, plan: null });

const ACTOR: AgentEditActor = { id: "tag:x", title: "Refresh of tag \"T\"", agent: "claude" };

async function waitDone(tagId: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (getTagRefreshState(tagId)?.status !== "running") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("tag refresh never settled");
}

// A project with a repo_path (the job refuses without one) plus a tag.
function fixture(name = `tr-${Math.random().toString(36).slice(2)}`) {
  const project = createProject({ name, repo_path: "/tmp/not-a-real-repo-xyz" });
  const tag = createTag({ project_id: project.id, name: `plan-${name}`, description: "old" });
  return { project, tag };
}

// A member in a given lifecycle state: what applyTagPlan may do to a task
// depends on whether there is work in it.
function member(projectId: string, tagId: string, title: string, fields: Record<string, unknown> = {}) {
  const t = createTask({ project_id: projectId, title, description: `brief for ${title}` });
  setTaskTags([t.id], [tagId]);
  if (Object.keys(fields).length) updateTask(t.id, fields);
  return getTask(t.id)!;
}

const edits = (taskId: string) =>
  getDb().prepare("SELECT * FROM task_agent_edits WHERE task_id = ?").all(taskId) as { changes: string }[];

describe("detached tag refresh job", () => {
  beforeEach(() => {
    planText.mockClear();
  });

  it("errors immediately when the project has no working directory", () => {
    const project = createProject({ name: `norepo-${Math.random()}` });
    const tag = createTag({ project_id: project.id, name: "p" });
    const state = startTagRefreshJob(tag.id);
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/working directory/);
    expect(isTagRefreshing(tag.id)).toBe(false);
  });

  it("runs in the background, applies the plan and persists a summary", async () => {
    const { project, tag } = fixture();
    const m = member(project.id, tag.id, "step one");
    planText.mockResolvedValueOnce(
      `narration first\n<<<TAG_PLAN>>>\n${JSON.stringify({
        description: "What this plan is now.",
        tasks: [{ id: m.id, description: "rewritten brief" }],
      })}\n<<<END_TAG_PLAN>>>`
    );

    expect(startTagRefreshJob(tag.id).status).toBe("running");
    await waitDone(tag.id);

    const done = getTagRefreshState(tag.id)!;
    expect(done.status).toBe("done");
    expect(done.stage).toBe("");
    expect(done.summary).toMatch(/description rewritten/);
    expect(done.summary).toMatch(/1 task reworded/);
    expect(isTagRefreshing(tag.id)).toBe(false);

    expect(getTag(tag.id)!.description).toBe("What this plan is now.");
    expect(getTask(m.id)!.description).toBe("rewritten brief");

    // Dismissing clears the report, never the edits it reports on.
    expect(clearTagRefresh(tag.id)).toMatchObject({ status: "idle", summary: "" });
    expect(getTask(m.id)!.description).toBe("rewritten brief");
  });

  it("says so plainly when the plan is already fresh", async () => {
    const { project, tag } = fixture();
    member(project.id, tag.id, "step one");
    planText.mockResolvedValueOnce("<<<TAG_PLAN>>>\n{\"description\":\"\",\"tasks\":[]}\n<<<END_TAG_PLAN>>>");
    startTagRefreshJob(tag.id);
    await waitDone(tag.id);
    // A healthy plan must not read like a failure, or the button stops being
    // worth pressing on work you believe in.
    expect(getTagRefreshState(tag.id)!.summary).toMatch(/Nothing needed changing/);
    expect(getTag(tag.id)!.description).toBe("old");
  });

  it("settles as an error and keeps the tag usable when the agent fails", async () => {
    const { tag } = fixture();
    planText.mockRejectedValueOnce(new Error("agent exploded"));
    startTagRefreshJob(tag.id);
    await waitDone(tag.id);
    expect(getTagRefreshState(tag.id)).toMatchObject({ status: "error", error: "agent exploded", stage: "" });
    expect(isTagRefreshing(tag.id)).toBe(false);
  });

  it("ignores a double-click while a job is genuinely running", () => {
    const { tag } = fixture();
    setTagRefresh(tag.id, { refresh_status: "running", refresh_started_at: Date.now() });
    expect(startTagRefreshJob(tag.id).status).toBe("running");
    expect(planText).not.toHaveBeenCalled();
  });

  it("unsticks a 'running' row left orphaned by a server restart", () => {
    const project = createProject({ name: `stale-${Math.random()}` }); // no repo_path
    const tag = createTag({ project_id: project.id, name: "p" });
    setTagRefresh(tag.id, { refresh_status: "running", refresh_started_at: Date.now() - 21 * 60 * 1000 });
    // A poll of the orphan settles as an error immediately, so the bar does not
    // read as still moving, and the next click re-evaluates instead of short-circuiting.
    expect(getTagRefreshState(tag.id)).toMatchObject({ status: "error" });
    expect(startTagRefreshJob(tag.id).status).toBe("error");
  });

  it("returns null state for an unknown tag", () => {
    expect(getTagRefreshState("nope")).toBeNull();
  });
});

describe("applyTagPlan", () => {
  it("records a reword as a revertable agent edit", () => {
    const { project, tag } = fixture();
    const m = member(project.id, tag.id, "old title");
    const out = applyTagPlan(tag, tagMembers(tag), { description: "", tasks: [{ id: m.id, title: "new title" }] }, ACTOR);
    expect(out.reworded).toBe(1);
    expect(getTask(m.id)!.title).toBe("new title");
    // The chip is the review surface: without the row there is no Revert, which
    // is what lets this job apply changes instead of only proposing them.
    const rows = edits(m.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].changes)).toEqual([
      expect.objectContaining({ field: "title", before: "old title", after: "new title" }),
    ]);
    expect(getTask(m.id)!.agent_edited_at).toBeGreaterThan(0);
  });

  it("leaves a task alone when the plan repeats what it already says", () => {
    const { project, tag } = fixture();
    const m = member(project.id, tag.id, "step");
    const out = applyTagPlan(
      tag, tagMembers(tag),
      { description: tag.description, tasks: [{ id: m.id, title: "step", description: m.description }] },
      ACTOR
    );
    expect(out).toMatchObject({ reworded: 0, descriptionRewritten: false });
    expect(edits(m.id)).toHaveLength(0);
  });

  it("withdraws an unreviewed suggestion, keeping it in the tray with its reason", () => {
    const { project, tag } = fixture();
    const m = member(project.id, tag.id, "already shipped", { suggested: 1 });
    const out = applyTagPlan(
      tag, tagMembers(tag),
      { description: "", tasks: [{ id: m.id, retire: true, reason: "lib/x.ts already does this" }] },
      ACTOR
    );
    expect(out.retired).toBe(1);
    const after = getTask(m.id)!;
    expect(after.status).toBe("cancelled");
    expect(after.suggested).toBe(1); // stays in the tray, struck through
    expect(after.withdrawn_reason).toBe("lib/x.ts already does this");
  });

  it("cancels an accepted-but-never-started task and records it so Revert works", () => {
    const { project, tag } = fixture();
    const m = member(project.id, tag.id, "overtaken"); // accepted (suggested 0), started 0
    const out = applyTagPlan(
      tag, tagMembers(tag),
      { description: "", tasks: [{ id: m.id, retire: true, reason: "landed in #77" }] },
      ACTOR
    );
    expect(out.retired).toBe(1);
    expect(getTask(m.id)!.status).toBe("cancelled");
    // Nothing was in it, so cancelling destroys nothing. A cancel nobody can
    // undo still should not rest on a model's reading alone, hence the edit row.
    expect(JSON.parse(edits(m.id)[0].changes)).toEqual([
      expect.objectContaining({ field: "status", before: "not_started", after: "cancelled" }),
    ]);
  });

  it("refuses to retire a STARTED task and flags it for the user instead", () => {
    const { project, tag } = fixture();
    const m = member(project.id, tag.id, "half done", { started: 1, worktree_path: "/tmp/wt" });
    const out = applyTagPlan(
      tag, tagMembers(tag),
      { description: "", tasks: [{ id: m.id, retire: true, reason: "looks redundant" }] },
      ACTOR
    );
    // It has a checkout and probably a diff; reading main tells you nothing
    // about what is in it.
    expect(out.retired).toBe(0);
    expect(out.flagged).toEqual(["half done — looks redundant"]);
    expect(getTask(m.id)!.status).toBe("not_started");
    expect(out.summary).toMatch(/left alone for you to judge/);
  });

  it("never touches a task a turn is streaming in", () => {
    const { project, tag } = fixture();
    const m = member(project.id, tag.id, "live", { running: 1 });
    const out = applyTagPlan(
      tag, tagMembers(tag),
      { description: "", tasks: [{ id: m.id, retire: true, reason: "x" }, { id: m.id, title: "renamed" }] },
      ACTOR
    );
    expect(out.retired).toBe(0);
    expect(out.reworded).toBe(0);
    expect(getTask(m.id)!.title).toBe("live");
  });

  it("ignores ids that don't carry this tag, and retirements with no reason", () => {
    const { project, tag } = fixture();
    const outsider = createTask({ project_id: project.id, title: "not a member" });
    const m = member(project.id, tag.id, "member", { suggested: 1 });
    const out = applyTagPlan(
      tag, tagMembers(tag),
      { description: "", tasks: [{ id: outsider.id, title: "hijacked" }, { id: "made-up" }, { id: m.id, retire: true }] },
      ACTOR
    );
    expect(out.ignored).toBe(3);
    expect(out.retired).toBe(0);
    expect(getTask(outsider.id)!.title).toBe("not a member");
    expect(getTask(m.id)!.status).toBe("not_started");
  });
});

describe("parseTagPlan", () => {
  it("takes the wrapped object, a fenced one, and one buried in narration", () => {
    const plan = { description: "d", tasks: [{ id: "a", title: "t" }] };
    const body = JSON.stringify(plan);
    expect(parseTagPlan(`chat\n<<<TAG_PLAN>>>\n${body}\n<<<END_TAG_PLAN>>>\nmore`)).toEqual(plan);
    expect(parseTagPlan(`<<<TAG_PLAN>>>\n\`\`\`json\n${body}\n\`\`\`\n<<<END_TAG_PLAN>>>`)).toEqual(plan);
    expect(parseTagPlan(`Here is the plan: ${body} — hope that helps`)).toEqual(plan);
  });

  it("degrades to an empty plan rather than throwing", () => {
    // A model that emitted prose has justified no change; the caller reports
    // "nothing needed changing", which is honest since a check was made.
    for (const raw of ["", "no json here", "<<<TAG_PLAN>>>{ nope }<<<END_TAG_PLAN>>>", "[1,2]"]) {
      expect(parseTagPlan(raw)).toEqual({ description: "", tasks: [] });
    }
  });

  it("drops entries with no id and blank rewrites, and only honours retire === true", () => {
    const parsed = parseTagPlan(JSON.stringify({
      description: "  d  ",
      tasks: [
        { title: "no id" },
        { id: " a ", title: "  ", description: "", retire: "yes", reason: " r " },
        { id: "b", retire: true, reason: "why" },
      ],
    }));
    expect(parsed.description).toBe("d");
    // "" is a field the model left blank, not a proposed rewrite. Applying it
    // as one would blank a real brief.
    expect(parsed.tasks).toEqual([{ id: "a", reason: "r" }, { id: "b", retire: true, reason: "why" }]);
  });
});
