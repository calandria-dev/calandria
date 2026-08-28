import { describe, expect, it, beforeEach, vi } from "vitest";

const started: { taskId: string; text: string; note: string }[] = [];
vi.mock("@/lib/runner", () => ({
  startTurn: (task: { id: string }, _p: unknown, userText: string, note: string) => {
    started.push({ taskId: task.id, text: userText, note });
  },
}));

// The real validator spawns a CLI session to read the command registry; drive
// it from the test so the unknown-command branch is reachable offline.
let promptCheck: { ok: boolean; error?: string; suggestions?: string[] } = { ok: true };
vi.mock("@/lib/schedule/commands", () => ({
  validatePrompt: async () => promptCheck,
}));

import { createProject, getTask, listTasks } from "@/lib/store";
import { createRunbook } from "@/lib/runbooks/store";
import { dispatchPromptTask } from "@/lib/dispatch";
import { setAgentConnection } from "@/lib/agents/connections";
import { makeRepo } from "./helpers";

async function projectWithRepo() {
  const repo = await makeRepo();
  return createProject({ name: `disp-${Math.random().toString(36).slice(2)}`, repo_path: repo });
}

const base = {
  title: "Push & babysit CI",
  description: "Push everything unpushed, then watch the pipeline.",
  prompt: "/push-and-watch",
  agent: "claude",
  permission_mode: "bypassPermissions" as string | null,
  send_context: true,
  priority: "hi" as const,
  note: "▶ Runbook: Push & babysit CI.",
};

describe("dispatchPromptTask", () => {
  beforeEach(() => {
    started.length = 0;
    promptCheck = { ok: true };
    setAgentConnection("claude", { method: "subscription", email: null, plan: null });
  });

  it("mints a task carrying the dispatch config and launches its first turn", async () => {
    const p = await projectWithRepo();
    const res = await dispatchPromptTask({ ...base, project_id: p.id });

    expect(res.ok).toBe(true);
    const task = getTask(res.task!.id)!;
    expect(task.title).toBe("Push & babysit CI");
    expect(task.description).toBe(base.description);
    expect(task.priority).toBe("hi");
    expect(task.permission_mode).toBe("bypassPermissions");
    expect(task.running).toBe(1);
    // The prompt is the first USER message, not the description — a slash
    // command only expands when it arrives as one.
    expect(started).toHaveLength(1);
    expect(started[0].text).toBe("/push-and-watch");
    expect(started[0].note).toBe(base.note);
  });

  it("tags the task with whatever dispatched it", async () => {
    const p = await projectWithRepo();
    // A real row: tasks.runbook_id is a foreign key, so a made-up id is
    // rejected by the insert rather than stored as a dangling tag.
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/sweep" });
    const res = await dispatchPromptTask({ ...base, project_id: p.id, runbook_id: rb.id });
    expect(getTask(res.task!.id)!.runbook_id).toBe(rb.id);
  });

  it("calls onTaskCreated with the new id BEFORE the launch", async () => {
    const p = await projectWithRepo();
    const seen: string[] = [];
    const res = await dispatchPromptTask({
      ...base, project_id: p.id,
      // A crash mid-launch has to stay attributable, so the ledger link lands
      // before startTurn, not after the dispatch returns.
      onTaskCreated: (id) => { seen.push(id); expect(started).toHaveLength(0); },
    });
    expect(seen).toEqual([res.task!.id]);
  });

  it("refuses before minting when the project has no working directory", async () => {
    const p = createProject({ name: `norepo-${Math.random().toString(36).slice(2)}` });
    const res = await dispatchPromptTask({ ...base, project_id: p.id });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/working directory/i);
    expect(listTasks(p.id)).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("refuses before minting when the named agent is not connected, and never falls back", async () => {
    const p = await projectWithRepo();
    const res = await dispatchPromptTask({ ...base, project_id: p.id, agent: "codex" });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("codex");
    expect(listTasks(p.id)).toHaveLength(0);
  });

  it("refuses before minting on an unknown slash command", async () => {
    const p = await projectWithRepo();
    promptCheck = { ok: false, error: "/nope is not a command", suggestions: ["nope-real"] };
    const res = await dispatchPromptTask({ ...base, project_id: p.id });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("/nope-real");
    expect(listTasks(p.id)).toHaveLength(0);
  });

  it("refuses before minting when the project no longer exists", async () => {
    const res = await dispatchPromptTask({ ...base, project_id: "gone" });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/no longer exists/i);
  });
});
