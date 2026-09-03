// `move_task` — re-parenting tasks between projects from an agent (issue #24).
//
// The operation itself is lib/taskMove.ts's and is pinned by tests/taskMove.ts
// and tests/taskMoveWorktree.test.ts. What this file pins is the AGENT-facing
// half, which is where the interesting refusals live:
//
//   - a started task is refused rather than acknowledged away. The bulk route
//     takes its two discard acknowledgements as LISTS OF IDS because each
//     destroyed checkout is a separate irreversible answer; the whole point of
//     this tool is that it must not become the shortcut past that question, so
//     the endpoint ignores one even when a caller sends it.
//   - dependency edges are never dropped silently — the issue's one named
//     failure mode, since a task that looks ready and isn't is worse than a
//     refusal.
//   - the move of a task the user had already accepted is recorded and can be
//     reverted, on update_task's rule.
//
// The last case runs END TO END over the real stdio bridge against the real
// endpoint, because Codex is the path where the MODEL names the targets and
// they cross a wire — "the bridge doesn't enforce it" and "the server does"
// have to be shown together (same reasoning as tests/codexUpdateTaskPolicy.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createProject, createTask, getTask, getTaskDeps, listAgentEdits, setTaskDeps, updateTask } from "@/lib/store";
import { createSuggestedTask, moveTasksForAgent } from "@/lib/agentTools";
import { ensureWorktree } from "@/lib/git";
import { POST as moveTaskEp } from "@/app/api/internal/agent-tools/move-task/route";
import { POST as agentEditsPost } from "@/app/api/tasks/[id]/agent-edits/route";
import type { Project } from "@/lib/types";
import { makeRepo, uid } from "./helpers";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "calandria-mcp.mjs");

type ToolResult = { isError?: boolean; content: { text: string }[] };

/** Two projects and a caller session in the first one. */
function board() {
  const here = createProject({ name: `Move-Here-${uid()}` });
  const there = createProject({ name: `Move-There-${uid()}` });
  const caller = createTask({ project_id: here.id, title: "Caller", description: "" });
  return { here, there, caller };
}

/** A task the user has already accepted: out of the tray, not started, not running. */
function accepted(project: Project, title: string) {
  const t = createSuggestedTask(project, { title, description: "" }).task!;
  updateTask(t.id, { suggested: 0 });
  return getTask(t.id)!;
}

function postEdits(id: string, body: unknown) {
  return agentEditsPost(
    new NextRequest(`http://127.0.0.1:3000/api/tasks/${id}/agent-edits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

describe("move_task", () => {
  it("moves a chain whole, keeps the edge inside it, and names the one it had to drop", async () => {
    const { here, there, caller } = board();
    const a = accepted(here, "A");
    const b = accepted(here, "B");
    const stays = accepted(here, "Stays behind");
    // A is blocked by B (both moving) and by `stays` (which isn't).
    setTaskDeps(a.id, [b.id, stays.id]);

    const res = await moveTasksForAgent(caller, [a.id, b.id], there.name);
    expect(res.ok).toBe(true);
    expect(res.moved.map((t) => t.title).sort()).toEqual(["A", "B"]);
    expect(getTask(a.id)!.project_id).toBe(there.id);
    expect(getTask(b.id)!.project_id).toBe(there.id);
    expect(getTask(stays.id)!.project_id).toBe(here.id);

    // The edge whose ends both moved survives; the one that would now span
    // projects is gone — and, the part that matters, it is SAID so. A dropped
    // blocker nobody mentions leaves a task that looks ready and isn't.
    expect(getTaskDeps(a.id)).toEqual([b.id]);
    expect(res.text).toContain('"A" was blocked by "Stays behind"');
    expect(res.text).toContain("update_task");
  });

  it("refuses a started task, leaves its checkout standing, and ignores a discard acknowledgement", async () => {
    const repo = await makeRepo();
    const here = createProject({ name: `Move-Started-${uid()}`, repo_path: repo, branch: "main" });
    const there = createProject({ name: `Move-Dest-${uid()}` });
    const caller = createTask({ project_id: here.id, title: "Caller", description: "" });
    const started = accepted(here, "Started");
    const wt = (await ensureWorktree(repo, started.id, "main"))!;
    updateTask(started.id, { started: 1, worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha });

    // Straight through the shared implementation: no acknowledgement parameter
    // exists to pass, which is the design.
    const res = await moveTasksForAgent(caller, [started.id], there.id);
    expect(res.ok).toBe(true); // a well-formed answer, not a broken call
    expect(res.moved).toEqual([]);
    expect(res.text).toContain("a started task can't be moved");
    expect(res.text).toContain("only the user can approve");
    expect(getTask(started.id)!.project_id).toBe(here.id);
    expect(fs.existsSync(wt.path)).toBe(true);

    // And the endpoint the bridge posts to ignores one that is sent anyway —
    // the bulk route demands lists of ids precisely so a single flag can never
    // stand in for eleven irreversible answers, and this tool must not reopen
    // that as a boolean on a JSON body.
    const out = await moveTaskEp(
      new NextRequest("http://127.0.0.1/api/internal/agent-tools/move-task", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskId: caller.id,
          tasks: [started.id],
          project: there.id,
          discard_worktree: true,
          discard_unsafe: true,
        }),
      })
    );
    expect(out.status).toBe(200);
    expect((await out.json()).moved).toEqual([]);
    expect(getTask(started.id)!.project_id).toBe(here.id);
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it("refuses a task with a turn running in it, and moves its neighbours anyway", async () => {
    const { here, there, caller } = board();
    const running = accepted(here, "Running");
    updateTask(running.id, { running: 1 });
    const idle = accepted(here, "Idle");

    const res = await moveTasksForAgent(caller, [running.id, idle.id], there.id);
    expect(res.ok).toBe(true);
    expect(res.moved.map((t) => t.title)).toEqual(["Idle"]);
    expect(res.text).toContain("running turn");
    expect(getTask(running.id)!.project_id).toBe(here.id);
    expect(getTask(idle.id)!.project_id).toBe(there.id);
  });

  it("refuses an unrecognized destination outright rather than filing anywhere", async () => {
    const { here, caller } = board();
    const task = accepted(here, "Orphan");

    const res = await moveTasksForAgent(caller, [task.id], "no-such-project");
    expect(res.ok).toBe(false);
    expect(res.text).toContain("Nothing was moved.");
    expect(res.text).not.toContain("Nothing was created.");
    expect(getTask(task.id)!.project_id).toBe(here.id);

    // An empty selection and a blank destination are the other two whole-call
    // failures; neither is "nothing moved", which is a legitimate answer.
    expect((await moveTasksForAgent(caller, [], "x")).ok).toBe(false);
    expect((await moveTasksForAgent(caller, [task.id], "  ")).ok).toBe(false);
  });

  it("reports a task it never found instead of silently shortening the selection", async () => {
    const { here, there, caller } = board();
    const task = accepted(here, "Real");

    const res = await moveTasksForAgent(caller, [task.id, "ghost"], there.id);
    expect(res.ok).toBe(true);
    expect(res.moved.map((t) => t.title)).toEqual(["Real"]);
    expect(res.text).toContain("ghost");
    expect(res.text).toContain("task not found");
  });

  it("records an accepted task's move but not an unreviewed suggestion's, and Revert moves it back", async () => {
    const { here, there, caller } = board();
    const inert = createSuggestedTask(here, { title: "Inert", description: "" }).task!;
    const seen = accepted(here, "Accepted");

    const res = await moveTasksForAgent(caller, [inert.id, seen.id], there.id);
    expect(res.ok).toBe(true);
    expect(res.moved).toHaveLength(2);

    // Nobody has looked at a tray suggestion the agent filed itself, so moving
    // it surprises no one — the same rule update_task records by.
    expect(listAgentEdits(inert.id)).toEqual([]);
    expect(getTask(inert.id)!.agent_edited_at).toBe(0);

    const edits = listAgentEdits(seen.id);
    expect(edits).toHaveLength(1);
    expect(edits[0].actor_task_id).toBe(caller.id);
    expect(edits[0].changes).toHaveLength(1);
    expect(edits[0].changes[0]).toMatchObject({
      field: "project",
      before: here.name,
      after: there.name,
      before_value: here.id,
      after_value: there.id,
    });
    expect(getTask(seen.id)!.agent_edited_at).toBeGreaterThan(0);
    expect(res.text).toContain("one-click revert");

    // Revert re-runs the move backwards rather than writing project_id, so the
    // task's sessions, usage and merges follow it home too.
    const undo = await postEdits(seen.id, { action: "revert", edit_id: edits[0].id });
    expect(undo.status).toBe(200);
    expect(getTask(seen.id)!.project_id).toBe(here.id);
    expect(listAgentEdits(seen.id)[0].reverted_at).toBeGreaterThan(0);
  });

  it("refuses to revert a move whose task has been started since, leaving the checkout alone", async () => {
    const repo = await makeRepo();
    const here = createProject({ name: `Move-Undo-${uid()}`, repo_path: repo, branch: "main" });
    const there = createProject({ name: `Move-Undo-Dest-${uid()}`, repo_path: await makeRepo(), branch: "main" });
    const caller = createTask({ project_id: here.id, title: "Caller", description: "" });
    const task = accepted(here, "Moved then started");

    const res = await moveTasksForAgent(caller, [task.id], there.id);
    expect(res.moved).toHaveLength(1);
    const edit = listAgentEdits(task.id)[0];

    // The user accepted the move and started the task in its new home. Undoing
    // it now would mean destroying that checkout, which is still their answer
    // to give from the board — not something an undo button takes on their
    // behalf.
    updateTask(task.id, { started: 1, work_branch: "calandria/x" });
    const undo = await postEdits(task.id, { action: "revert", edit_id: edit.id });
    expect(undo.status).toBe(409);
    expect((await undo.json()).error).toContain("a started task can't be moved");
    expect(getTask(task.id)!.project_id).toBe(there.id);
    expect(listAgentEdits(task.id)[0].reverted_at).toBe(0);
  });
});

// The Codex half: the real bridge process, the real endpoint, the real DB. The
// bridge holds no policy — it forwards whatever the model named — so this is
// where "the server decides" is demonstrated rather than assumed.
describe("move_task, end to end over the Codex bridge", () => {
  const ROUTES: Record<string, (req: NextRequest) => Promise<Response>> = {
    "/api/internal/agent-tools/move-task": moveTaskEp,
  };
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        void (async () => {
          const handler = ROUTES[(req.url || "").split("?")[0]];
          if (!handler) {
            res.statusCode = 404;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: `no test route for ${req.url}` }));
            return;
          }
          const out = await handler(
            new NextRequest(`http://127.0.0.1${req.url}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: raw,
            })
          );
          res.statusCode = out.status;
          res.setHeader("content-type", "application/json");
          res.end(await out.text());
        })();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  /** Spawn the real bridge with `callerId` as its env-injected CALANDRIA_TASK_ID. */
  async function connectBridge(callerId: string, projectId: string) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SCRIPT],
      env: {
        CALANDRIA_TASK_ID: callerId,
        CALANDRIA_PROJECT_ID: projectId,
        CALANDRIA_BASE_URL: baseUrl,
        SERVICE_TOKEN: "move-token",
        PATH: process.env.PATH || "",
      },
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    return { client, close: () => client.close() };
  }

  it("moves what the model named, refuses a started row, and reports both in one answer", async () => {
    const { here, there, caller } = board();
    const movable = accepted(here, "Movable");
    const started = accepted(here, "Started");
    updateTask(started.id, { started: 1 });

    const { client, close } = await connectBridge(caller.id, here.id);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("move_task");

      const ok = (await client.callTool({
        name: "move_task",
        arguments: { tasks: [movable.id, started.id], project: there.name },
      })) as ToolResult;
      expect(ok.isError).toBeFalsy();
      expect(getTask(movable.id)!.project_id).toBe(there.id);
      expect(getTask(started.id)!.project_id).toBe(here.id);
      expect(ok.content[0].text).toContain("a started task can't be moved");

      // A destination the model invented is a refusal, never a fallback to the
      // session's own project — resolveTargetProject's rule, reached through
      // the wire this time.
      const bad = (await client.callTool({
        name: "move_task",
        arguments: { tasks: [movable.id], project: "Somewhere Else" },
      })) as ToolResult;
      expect(bad.isError).toBe(true);
      expect(getTask(movable.id)!.project_id).toBe(there.id);
    } finally {
      await close();
    }
  });
});
