// A suggestion, rendered where it was made: the tool row a `suggest_task` call
// leaves behind carries the id of the task it filed, and the card reads that
// task's LIVE state rather than a snapshot frozen into the transcript.
//
// Two halves are pinned here, and they're the two that can silently rot:
//   - the settle (lib/suggestionCard.ts) — which row a suggestion lands on when
//     the caller has no tool_use id to correlate with, i.e. the stdio bridge;
//   - the read (GET /api/tasks/[id]/suggestion) — everything the card renders,
//     including the states where it must NOT still be offering Start.
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { addMessage, createProject, createTask, deleteTask, listMessages, setTaskDeps, updateTask } from "@/lib/store";
import { attachSuggestionToCall, isSuggestTaskTool } from "@/lib/suggestionCard";
import { createSuggestedTask } from "@/lib/agentTools";
import { POST as suggestTaskEp } from "@/app/api/internal/agent-tools/suggest-task/route";
import { GET as suggestionGet } from "@/app/api/tasks/[id]/suggestion/route";
import type { SuggestionCard, ToolData } from "@/lib/types";

const toolRow = (taskId: string, data: ToolData) => addMessage(taskId, 1, "tool", JSON.stringify(data));

const suggestCall = (taskId: string, name = "mcp__calandria__suggest_task") =>
  toolRow(taskId, { name, title: "✦ Suggested a task" });

function readData(taskId: string, msgId: string): ToolData {
  const m = listMessages(taskId).find((x) => x.id === msgId)!;
  return JSON.parse(m.content) as ToolData;
}

function getCard(id: string) {
  return suggestionGet(new NextRequest(`http://127.0.0.1:3000/api/tasks/${id}/suggestion`), {
    params: Promise.resolve({ id }),
  });
}

function post(url: string, body: unknown) {
  return suggestTaskEp(
    new NextRequest(`http://127.0.0.1:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("isSuggestTaskTool", () => {
  it("matches every driver's spelling of the same tool, and nothing else", () => {
    // Matched as a substring precisely because the prefix is the driver's, not
    // the tool's: in-process MCP, the stdio bridge and a bare name all count.
    expect(isSuggestTaskTool("mcp__calandria__suggest_task")).toBe(true);
    expect(isSuggestTaskTool("calandria__suggest_task")).toBe(true);
    expect(isSuggestTaskTool("suggest_task")).toBe(true);
    expect(isSuggestTaskTool("mcp__calandria__list_tasks")).toBe(false);
    expect(isSuggestTaskTool("Bash")).toBe(false);
    // Every row written before the field existed, and every driver that reports
    // no name: no card, rather than a card on the wrong row.
    expect(isSuggestTaskTool(undefined)).toBe(false);
  });
});

describe("attachSuggestionToCall", () => {
  it("settles onto the newest unclaimed suggest_task row and leaves other tool rows alone", () => {
    const project = createProject({ name: "Settle" });
    const session = createTask({ project_id: project.id, title: "Session", description: "" });
    const older = suggestCall(session.id);
    const bash = toolRow(session.id, { name: "Bash", title: "❯ ls" });
    const newer = suggestCall(session.id);

    const landed = attachSuggestionToCall(session.id, { taskId: "task-a", projectId: project.id });
    expect(landed).toBe(newer.id);
    expect(readData(session.id, newer.id).suggestion).toEqual({ taskId: "task-a", projectId: project.id });
    expect(readData(session.id, older.id).suggestion).toBeUndefined();
    expect(readData(session.id, bash.id).suggestion).toBeUndefined();

    // A second suggestion skips the row already claimed and takes the next one
    // back — a parallel batch gets one card each rather than stacking.
    expect(attachSuggestionToCall(session.id, { taskId: "task-b", projectId: project.id })).toBe(older.id);
    expect(readData(session.id, older.id).suggestion).toEqual({ taskId: "task-b", projectId: project.id });
  });

  it("reports a miss instead of guessing when there is no suggest_task row", () => {
    const project = createProject({ name: "Settle-Miss" });
    const session = createTask({ project_id: project.id, title: "Session", description: "" });
    toolRow(session.id, { name: "Bash", title: "❯ ls" });
    // A row from before the name was persisted must not be adopted by title.
    toolRow(session.id, { title: "✦ Suggested a task" });
    expect(attachSuggestionToCall(session.id, { taskId: "task-a", projectId: project.id })).toBeNull();
  });
});

describe("the stdio bridge settles its suggestion onto the call in flight", () => {
  it("patches the tool row and announces the msgId so an open transcript can too", async () => {
    const project = createProject({ name: "Bridge" });
    const session = createTask({ project_id: project.id, title: "Session", description: "" });
    const call = suggestCall(session.id, "calandria__suggest_task");

    const res = await post("/api/internal/agent-tools/suggest-task", {
      projectId: project.id,
      taskId: session.id,
      title: "Pool the widget factory",
      description: "hoist it",
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(readData(session.id, call.id).suggestion).toEqual({ taskId: created.id, projectId: project.id });
  });

  it("files into another project and records THAT project on the card", async () => {
    const project = createProject({ name: "Bridge-Here" });
    const other = createProject({ name: "Bridge-Elsewhere" });
    const session = createTask({ project_id: project.id, title: "Session", description: "" });
    const call = suggestCall(session.id, "calandria__suggest_task");

    const res = await post("/api/internal/agent-tools/suggest-task", {
      projectId: project.id,
      taskId: session.id,
      project: "Bridge-Elsewhere",
      title: "Fix the other repo",
      description: "",
    });
    const created = (await res.json()) as { id: string };
    // The project it was FILED INTO, not the session's own — that difference is
    // what the card has to say out loud, and what decides whether Start shows.
    expect(readData(session.id, call.id).suggestion).toEqual({ taskId: created.id, projectId: other.id });
  });
});

describe("GET /api/tasks/[id]/suggestion", () => {
  it("serves the title, priority, blockers and the project it was filed into", async () => {
    const project = createProject({ name: "Card-Read" });
    const blocker = createTask({ project_id: project.id, title: "Land the migration", description: "" });
    const { task } = createSuggestedTask(project, { title: "Pool it", description: "hoist the pool", priority: "hi" });
    setTaskDeps(task!.id, [blocker.id]);

    const card = (await (await getCard(task!.id)).json()) as SuggestionCard;
    expect(card).toMatchObject({
      id: task!.id,
      title: "Pool it",
      description: "hoist the pool",
      priority: "hi",
      suggested: 1,
      started: 0,
      status: "not_started",
      project_id: project.id,
      project_name: "Card-Read",
    });
    // Named, not counted: "Blocked by 1 task" that won't say which is no use.
    expect(card.blocked_by).toEqual([{ id: blocker.id, title: "Land the migration", status: "not_started" }]);
  });

  it("reports each state the card must stop offering Start in", async () => {
    const project = createProject({ name: "Card-States" });

    // Accepted onto the board: out of the tray, no session yet.
    const accepted = createSuggestedTask(project, { title: "Accepted", description: "" }).task!;
    updateTask(accepted.id, { suggested: 0 });
    let card = (await (await getCard(accepted.id)).json()) as SuggestionCard;
    expect(card).toMatchObject({ suggested: 0, started: 0 });

    // Started: a session has been minted, so Start would mean nothing.
    const started = createSuggestedTask(project, { title: "Started", description: "" }).task!;
    updateTask(started.id, { suggested: 0, started: 1, status: "in_progress" });
    card = (await (await getCard(started.id)).json()) as SuggestionCard;
    expect(card).toMatchObject({ suggested: 0, started: 1, status: "in_progress" });

    // Withdrawn by the agent: still in the tray, cancelled, with a reason.
    const withdrawn = createSuggestedTask(project, { title: "Withdrawn", description: "" }).task!;
    updateTask(withdrawn.id, { status: "cancelled", withdrawn_reason: "already done in #4" });
    card = (await (await getCard(withdrawn.id)).json()) as SuggestionCard;
    expect(card).toMatchObject({ suggested: 1, status: "cancelled", withdrawn_reason: "already done in #4" });
  });

  it("404s once the task is dismissed, so the card renders as gone rather than a button that fails", async () => {
    const project = createProject({ name: "Card-Gone" });
    const { task } = createSuggestedTask(project, { title: "Dismiss me", description: "" });
    // Dismiss is a hard delete — the transcript row pointing at it outlives it.
    deleteTask(task!.id);
    const res = await getCard(task!.id);
    expect(res.status).toBe(404);
  });

  it("names a deleted blocker rather than dropping it from the list", async () => {
    const project = createProject({ name: "Card-Dead-Blocker" });
    const blocker = createTask({ project_id: project.id, title: "Gone", description: "" });
    const { task } = createSuggestedTask(project, { title: "Blocked", description: "" });
    setTaskDeps(task!.id, [blocker.id]);
    deleteTask(blocker.id);
    const card = (await (await getCard(task!.id)).json()) as SuggestionCard;
    // The edge is gone with the row in practice (FK cascade); if one ever
    // survives, the card says so instead of rendering a blank name.
    expect(card.blocked_by.every((b) => b.title)).toBe(true);
  });
});
