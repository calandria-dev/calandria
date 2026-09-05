import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTag, createProject, createTask, getTag, getTask, getTaskDeps, getTaskTagIds, listAgentEdits, listTags, listTasks, setTaskTags, updateTask } from "@/lib/store";
import { createSuggestedTask } from "@/lib/agentTools";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { ensureWorktree } from "@/lib/git";
import { POST as updateTaskEp } from "@/app/api/internal/agent-tools/update-task/route";
import { POST as suggestTaskEp } from "@/app/api/internal/agent-tools/suggest-task/route";
import { POST as listTagsEp } from "@/app/api/internal/agent-tools/list-tags/route";
import { POST as setBaseBranchEp } from "@/app/api/internal/agent-tools/set-base-branch/route";
import { POST as updateTagEp } from "@/app/api/internal/agent-tools/update-tag/route";
import { git, makeRepo, uid } from "./helpers";

// update_task's cross-task policy, proved end to end on the Codex path.
//
// tests/calandriaMcp.test.ts drives the same bridge against a fake app server,
// so it can only show what the bridge forwards. This file closes the loop:
// the real scripts/calandria-mcp.mjs runs as its own process and its calls
// are served by the real route handler against the real database.
//
// This is the path where the model names the write target. On the Claude
// side the driver closes over the task and the id never leaves the process;
// here it crosses a wire, so "the bridge doesn't enforce it" and "the server
// does" must be demonstrated together, not assumed. Every case below asks
// the bridge to write a row it must not, and checks the DB afterwards: a
// refusal that still wrote would pass a text-only assertion.

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "calandria-mcp.mjs");

// The real handlers, keyed by the path the bridge posts to. Only the endpoints
// these tests exercise are mounted: an unrouted path 404s loudly instead of
// being served by the wrong one.
const ROUTES: Record<string, (req: NextRequest) => Promise<Response>> = {
  "/api/internal/agent-tools/update-task": updateTaskEp,
  "/api/internal/agent-tools/suggest-task": suggestTaskEp,
  "/api/internal/agent-tools/list-tags": listTagsEp,
  "/api/internal/agent-tools/set-base-branch": setBaseBranchEp,
  "/api/internal/agent-tools/update-tag": updateTagEp,
};

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      void (async () => {
        // Hand the bridge's POST to the real handler for that path, unmodified.
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
      SERVICE_TOKEN: "policy-token",
      PATH: process.env.PATH || "",
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

interface ToolResult {
  content: { text: string }[];
  isError?: boolean;
}

describe("update_task policy, end to end over the Codex bridge", () => {
  it("writes any task the model names, records the ones the user had accepted, and refuses only a live turn", async () => {
    const project = createProject({ name: "Codex-Policy" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });

    // One row per rule, so a failure names which rule broke.
    const inert = createSuggestedTask(project, { title: "Inert", description: "" }).task!;
    const started = createSuggestedTask(project, { title: "Started", description: "" }).task!;
    updateTask(started.id, { suggested: 0, started: 1 });
    const running = createSuggestedTask(project, { title: "Running", description: "" }).task!;
    updateTask(running.id, { running: 1 });
    const accepted = createSuggestedTask(project, { title: "Accepted", description: "" }).task!;
    updateTask(accepted.id, { suggested: 0 });

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      // An unreviewed suggestion is writable. It never raises the "changed
      // since you accepted it" chip: nobody has accepted it yet, so there is
      // nothing to warn them changed.
      const ok = (await client.callTool({
        name: "update_task",
        arguments: { task: inert.id, title: "Sharpened", priority: "hi" },
      })) as ToolResult;
      expect(ok.isError).toBeFalsy();
      expect(getTask(inert.id)).toMatchObject({ title: "Sharpened", priority: "hi" });
      expect(listAgentEdits(inert.id)).toEqual([]);
      expect(getTask(inert.id)!.agent_edited_at).toBe(0);

      // These are writable, but the write is recorded, attributed to the
      // caller's session and naming the fields that moved, because the user
      // already accepted this row and needs to find out something changed
      // underneath them.
      for (const row of [started, accepted]) {
        const res = (await client.callTool({
          name: "update_task",
          arguments: { task: row.id, title: "Hijacked", status: "done" },
        })) as ToolResult;
        expect(res.isError, `${row.title} should have succeeded`).toBeFalsy();
        expect(getTask(row.id)).toMatchObject({ title: "Hijacked", status: "done" });
        expect(getTask(row.id)!.agent_edited_at).toBeGreaterThan(0);
        const edits = listAgentEdits(row.id);
        expect(edits, `${row.title} should have recorded exactly one edit`).toHaveLength(1);
        expect(edits[0].actor_task_id).toBe(caller.id);
        expect(edits[0].changes.map((c) => c.field).sort()).toEqual(["status", "title"]);
      }

      // A live turn in the target is refused, since that session may be
      // mid-read of the very fields this call would rewrite. Byte-identical
      // afterwards and nothing recorded: a refused write is not an edit.
      const before = getTask(running.id)!;
      const res = (await client.callTool({
        name: "update_task",
        arguments: { task: running.id, title: "Hijacked", status: "done" },
      })) as ToolResult;
      expect(res.isError, "a running task should have been refused").toBe(true);
      expect(res.content[0].text).toContain("a turn is streaming in it right now");
      expect(getTask(running.id)).toEqual(before);
      expect(listAgentEdits(running.id)).toEqual([]);

      // A row that doesn't exist is a refusal, never a fallback to the caller.
      const ghost = (await client.callTool({
        name: "update_task",
        arguments: { task: "ghost", title: "Hijacked" },
      })) as ToolResult;
      expect(ghost.isError).toBe(true);
      expect(getTask(caller.id)!.title).toBe("Caller");
    } finally {
      await close();
    }
  });

  it("defaults to the caller's own row, and keeps caller identity separate from the named target", async () => {
    const project = createProject({ name: "Codex-Own" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const bystander = createTask({ project_id: project.id, title: "Bystander", description: "" });

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      await client.callTool({ name: "update_task", arguments: { title: "Renamed", status: "in_progress" } });
      expect(getTask(caller.id)).toMatchObject({ title: "Renamed", status: "in_progress" });

      // `taskId` is not in the tool's schema, so the model cannot send one; the
      // bridge always forwards its own CALANDRIA_TASK_ID there. Post directly to
      // the endpoint to prove `taskId` (the trusted caller) and `task` (the
      // untrusted target) are not interchangeable: the request lands on the
      // named row, not on the identity in `taskId`, and the edit it leaves
      // behind is attributed to `taskId` regardless of which row it touched.
      const res = await fetch(`${baseUrl}/api/internal/agent-tools/update-task`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: caller.id, task: bystander.id, title: "Hijacked" }),
      });
      expect(res.status).toBe(200);
      expect(getTask(bystander.id)!.title).toBe("Hijacked");
      // The caller's own row is untouched by a call that named a different
      // target; `taskId` decides who gets credited, not who gets written.
      expect(getTask(caller.id)).toMatchObject({ title: "Renamed", status: "in_progress" });
      const edits = listAgentEdits(bystander.id);
      expect(edits).toHaveLength(1);
      expect(edits[0].actor_task_id).toBe(caller.id);

      // `taskId` still can't be faked into existence: the endpoint reads it
      // with getTask before it ever reaches updateTaskForAgent, so an unknown
      // caller id is a 404, not a write attributed to nobody.
      const ghostRes = await fetch(`${baseUrl}/api/internal/agent-tools/update-task`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: "ghost", task: bystander.id, title: "Nope" }),
      });
      expect(ghostRes.status).toBe(404);
      expect(getTask(bystander.id)!.title).toBe("Hijacked");
    } finally {
      await close();
    }
  });

  it("orders a plan in two phases, and refuses to order the caller's own row", async () => {
    // A planning turn files its tasks, gets ids back, and comes back to say
    // what waits on what. Driven over the real bridge because this is where
    // the model names the target, and asserted on the DB because a "Blocked
    // by 1 task(s)" note that wrote no edge is the failure this feature must
    // prevent.
    const project = createProject({ name: "Codex-Order" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const first = createSuggestedTask(project, { title: "Phase one", description: "" }).task!;
    const second = createSuggestedTask(project, { title: "Phase two", description: "" }).task!;

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      const ok = (await client.callTool({
        name: "update_task",
        arguments: { task: second.id, blocked_by: [first.id] },
      })) as ToolResult;
      expect(ok.isError).toBeFalsy();
      expect(getTaskDeps(second.id)).toEqual([first.id]);

      // The caller's own row is refused: it's already running, so an edge on it
      // would gate nothing and mislabel the board.
      const own = (await client.callTool({
        name: "update_task",
        arguments: { blocked_by: [first.id] },
      })) as ToolResult;
      expect(own.isError).toBe(true);
      expect(own.content[0].text).toContain("on_hold");
      expect(getTaskDeps(caller.id)).toEqual([]);

      // A ref the server can't use fails the whole call: the edge already there
      // survives instead of being replaced by the half that resolved.
      const bad = (await client.callTool({
        name: "update_task",
        arguments: { task: second.id, blocked_by: [first.id, "ghost"] },
      })) as ToolResult;
      expect(bad.isError).toBe(true);
      expect(getTaskDeps(second.id)).toEqual([first.id]);
    } finally {
      await close();
    }
  });

  it("refuses to cancel a suggestion it is otherwise allowed to edit", async () => {
    const project = createProject({ name: "Codex-Cancel" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const inert = createSuggestedTask(project, { title: "Inert", description: "" }).task!;

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      // "cancelled" isn't in the tool's status enum, so the MCP layer turns it
      // into a validation error and the bridge is never reached.
      const res = (await client.callTool({
        name: "update_task",
        arguments: { task: inert.id, status: "cancelled" },
      })) as ToolResult;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("status");
      expect(getTask(inert.id)!.status).toBe("not_started");

      // Neither layer alone is enough: bypass the schema entirely and prove
      // the endpoint refuses it too, on a row it would happily retitle.
      const direct = await fetch(`${baseUrl}/api/internal/agent-tools/update-task`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: caller.id, task: inert.id, status: "cancelled" }),
      });
      expect(direct.status).toBe(400);
      expect(getTask(inert.id)!.status).toBe("not_started");
    } finally {
      await close();
    }
  });
});

// Tags over the same wire. The Codex path is where the model names both the
// project a task is filed into and the tags it carries, so the rules that
// make tagging safe must be shown together here, not assumed: suggest_task
// creates a tag in the project the task actually landed in, update_task
// refuses one it doesn't recognize instead of minting a near-twin, and,
// being many-to-many, replaces the whole set instead of adding to it.
describe("tags, end to end over the Codex bridge", () => {
  it("tags a cross-project suggestion in the TARGET project, creating the tag there", async () => {
    const here = createProject({ name: "Codex-TagHere" });
    const there = createProject({ name: "Codex-TagThere" });
    const caller = createTask({ project_id: here.id, title: "Planner", description: "" });
    // A same-named tag in the caller's project: if resolution ran before the
    // project did, the suggestion would be tagged into this one, a tag spanning
    // two repos, which the schema and the UI both forbid.
    const decoy = createTag({ project_id: here.id, name: "Auth migration" });

    const { client, close } = await connectBridge(caller.id, here.id);
    try {
      const res = (await client.callTool({
        name: "suggest_task",
        arguments: { title: "Ported route", description: "", project: "Codex-TagThere", tags: ["Auth migration"] },
      })) as ToolResult;
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('Created tag "Auth migration" in Codex-TagThere.');

      const landed = listTasks(there.id).find((t) => t.title === "Ported route")!;
      const made = listTags(there.id);
      expect(made).toHaveLength(1);
      expect(landed.tag_ids).toEqual([made[0].id]);
      expect(landed.tag_ids).not.toContain(decoy.id);
      // Provenance is the caller's task id, which the model never sends; the
      // bridge only forwards CALANDRIA_TASK_ID.
      expect(made[0].origin_task_id).toBe(caller.id);

      // The second step of the plan reuses it instead of minting a twin.
      const again = (await client.callTool({
        name: "suggest_task",
        arguments: { title: "Second step", description: "", project: "Codex-TagThere", tags: ["Auth migration"] },
      })) as ToolResult;
      expect(again.content[0].text).toContain('Tagged "Auth migration".');
      expect(listTags(there.id)).toHaveLength(1);

      // …and list_tags reads it back with the members, in one call.
      const listed = (await client.callTool({ name: "list_tags", arguments: { project: "Codex-TagThere" } })) as ToolResult;
      const parsed = JSON.parse(listed.content[0].text) as { tags: { name: string; counts: { total: number }; tasks: { title: string }[] }[] };
      expect(parsed.tags.map((g) => g.name)).toEqual(["Auth migration"]);
      expect(parsed.tags[0].counts.total).toBe(2);
      expect(parsed.tags[0].tasks.map((t) => t.title).sort()).toEqual(["Ported route", "Second step"]);
    } finally {
      await close();
    }
  });

  it("refuses an unknown tag on update_task, and the rest of that call never lands", async () => {
    const project = createProject({ name: "Codex-TagStrict" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const inert = createSuggestedTask(project, { title: "Inert", description: "" }).task!;
    const real = createTag({ project_id: project.id, name: "Auth migration" });

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      // Strict where suggest_task creates: the task already exists, so a typo
      // here would split a feature the user is filtering by in two.
      const bad = (await client.callTool({
        name: "update_task",
        arguments: { task: inert.id, title: "Sharpened", tags: ["Auth migraton"] },
      })) as ToolResult;
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain("Nothing was changed");
      // Neither half landed, and nothing was created for the misspelling.
      expect(getTask(inert.id)).toMatchObject({ title: "Inert" });
      expect(getTaskTagIds(inert.id)).toEqual([]);
      expect(listTags(project.id).map((g) => g.id)).toEqual([real.id]);

      // The exact name works, and [] takes it back out.
      const ok = (await client.callTool({
        name: "update_task",
        arguments: { task: inert.id, tags: ["Auth migration"] },
      })) as ToolResult;
      expect(ok.isError).toBeFalsy();
      expect(getTaskTagIds(inert.id)).toEqual([real.id]);

      const cleared = (await client.callTool({ name: "update_task", arguments: { task: inert.id, tags: [] } })) as ToolResult;
      expect(cleared.isError).toBeFalsy();
      expect(getTaskTagIds(inert.id)).toEqual([]);
    } finally {
      await close();
    }
  });

  it("update_task REPLACES the tag set rather than adding to it, over the real bridge", async () => {
    const project = createProject({ name: "Codex-TagReplace" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const inert = createSuggestedTask(project, { title: "Inert", description: "" }).task!;
    const a = createTag({ project_id: project.id, name: "Tag A" });
    const b = createTag({ project_id: project.id, name: "Tag B" });

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      const first = (await client.callTool({
        name: "update_task",
        arguments: { task: inert.id, tags: [a.id] },
      })) as ToolResult;
      expect(first.isError).toBeFalsy();
      expect(getTaskTagIds(inert.id)).toEqual([a.id]);

      // A second call naming only B drops A instead of adding B alongside it.
      const second = (await client.callTool({
        name: "update_task",
        arguments: { task: inert.id, tags: [b.id] },
      })) as ToolResult;
      expect(second.isError).toBeFalsy();
      expect(getTaskTagIds(inert.id)).toEqual([b.id]);
    } finally {
      await close();
    }
  });
});

// set_base_branch and update_tag over the same wire. Codex is the path where
// the model names the target, so the refusals must be shown to hold on the
// far side of a process boundary, against the DB, not assumed from the
// in-process policy (tests/agentToolsBaseBranch.test.ts).
describe("set_base_branch, end to end over the Codex bridge", () => {
  /** A project on a real repo with a `release` branch to aim at, plus a caller. */
  async function board() {
    const repo = await makeRepo();
    await git(repo, "branch", "release");
    const project = createProject({ name: `Codex-Base-${uid()}`, repo_path: repo, branch: "main" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    return { repo, project, caller };
  }

  /** Cut a worktree the way the launch paths do, pinning the base it used. */
  async function cut(repo: string, taskId: string, base: string) {
    const wt = (await ensureWorktree(repo, taskId, base))!;
    updateTask(taskId, {
      started: 1, worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha,
      ...(wt.baseBranch ? { base_branch: wt.baseBranch } : {}),
    });
    return getTask(taskId)!;
  }

  it("retargets the caller's own row mid-turn, and its worktree really moves", async () => {
    const { repo, project, caller } = await board();
    await cut(repo, caller.id, "main");
    await git(repo, "checkout", "release");
    const releaseTip = (await git(repo, "rev-parse", "HEAD")).trim();
    await git(repo, "checkout", "main");
    // A live turn in the caller's own session is exactly the state this tool
    // is called from, and the one case the liveness refusal must not fire on.
    updateTask(caller.id, { running: 1 });

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      const res = (await client.callTool({ name: "set_base_branch", arguments: { branch: "release" } })) as ToolResult;
      expect(res.isError, res.content[0].text).toBeFalsy();
      expect(res.content[0].text).toContain("Now based on release");
      const after = getTask(caller.id)!;
      expect(after.base_branch).toBe("release");
      // Nothing of its own in the worktree, so it was re-cut: up to date with
      // the new base, not merely pointed at it.
      expect(after.base_sha).toBe(releaseTip);
      expect((await git(after.worktree_path, "rev-parse", "HEAD")).trim()).toBe(releaseTip);
      // Its own row, so no "changed by an agent" chip; nobody to surprise.
      expect(listAgentEdits(caller.id)).toEqual([]);
    } finally {
      await close();
    }
  });

  it("records the retarget when the model names SOMEBODY ELSE's row", async () => {
    const { repo, project, caller } = await board();
    const other = createTask({ project_id: project.id, title: "Theirs", description: "" });
    await cut(repo, other.id, "main");

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      const res = (await client.callTool({ name: "set_base_branch", arguments: { task: other.id, branch: "release" } })) as ToolResult;
      expect(res.isError, res.content[0].text).toBeFalsy();
      expect(getTask(other.id)!.base_branch).toBe("release");
      const edits = listAgentEdits(other.id);
      expect(edits).toHaveLength(1);
      // Attributed to CALANDRIA_TASK_ID, which the model never sends.
      expect(edits[0].actor_task_id).toBe(caller.id);
      expect(edits[0].changes[0]).toMatchObject({ field: "base_branch", before: "main", after: "release" });
      expect(getTask(other.id)!.agent_edited_at).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it("refuses every case it must, with the DB byte-identical afterwards", async () => {
    const { repo, project, caller } = await board();
    const mine = await cut(repo, caller.id, "main");

    const running = createTask({ project_id: project.id, title: "Busy", description: "" });
    await cut(repo, running.id, "main");
    updateTask(running.id, { running: 1 });

    const neighbour = createTask({ project_id: project.id, title: "Neighbour", description: "" });
    const n = await cut(repo, neighbour.id, "main");

    const elsewhere = createProject({ name: `Codex-Elsewhere-${uid()}`, repo_path: await makeRepo(), branch: "main" });
    const foreign = createTask({ project_id: elsewhere.id, title: "Foreign", description: "" });

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      const cases: [string, Record<string, unknown>, string][] = [
        // A live turn in a row that isn't the caller's own: retargeting can
        // reset a worktree, and that session is working in it.
        ["running target", { task: running.id, branch: "release" }, "has a turn running"],
        // A branch is a name in ONE repository.
        ["another project", { task: foreign.id, branch: "release" }, "different project"],
        ["unknown task", { task: "ghost", branch: "release" }, 'No task with id "ghost"'],
        ["unusable name", { branch: "--upload-pack=evil" }, "isn't a usable git branch name"],
        ["absent branch", { branch: "does-not-exist" }, "does-not-exist"],
        ["own work branch", { branch: mine.work_branch }, "own work branch"],
        // The refusal that blocks basing on another task's calandria/… branch.
        ["occupied branch", { branch: n.work_branch }, "is checked out in"],
      ];
      const before = [running.id, foreign.id, caller.id, neighbour.id].map((id) => getTask(id)!);
      for (const [label, args, expected] of cases) {
        const res = (await client.callTool({ name: "set_base_branch", arguments: args })) as ToolResult;
        expect(res.isError, `${label} should have been refused`).toBe(true);
        expect(res.content[0].text, label).toContain(expected);
      }
      // Not one of the seven refusals wrote a row or recorded an edit.
      for (const row of before) expect(getTask(row.id), row.title).toEqual(row);
      for (const row of before) expect(listAgentEdits(row.id)).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("update_tag, end to end over the Codex bridge", () => {
  it("edits the tag itself, and a member cut later inherits its base branch", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "feature/auth");
    const project = createProject({ name: `Codex-TagEdit-${uid()}`, repo_path: repo, branch: "main" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const tag = createTag({ project_id: project.id, name: "Auth migration" });
    const member = createTask({ project_id: project.id, title: "Member", description: "" });
    setTaskTags([member.id], [tag.id]);

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      // By exact name, like every other tag reference, and setting three things
      // the tag itself owns, none of which update_task can reach.
      const res = (await client.callTool({
        name: "update_tag",
        arguments: { tag: "Auth migration", description: "Port every route.", color: "#3E7CA8", base_branch: "feature/auth" },
      })) as ToolResult;
      expect(res.isError, res.content[0].text).toBeFalsy();
      expect(getTag(tag.id)).toMatchObject({ description: "Port every route.", color: "#3E7CA8", base_branch: "feature/auth" });

      // The uncut member inherits it: that's the point of putting a base on a
      // tag instead of on N tasks. Membership itself is untouched.
      expect(resolveBaseBranch(getTask(member.id)!, project)).toBe("feature/auth");
      expect(getTaskTagIds(member.id)).toEqual([tag.id]);

      // "" clears it back to "members follow the project".
      const cleared = (await client.callTool({ name: "update_tag", arguments: { tag: tag.id, base_branch: "" } })) as ToolResult;
      expect(cleared.isError).toBeFalsy();
      expect(getTag(tag.id)!.base_branch).toBe("");
      expect(resolveBaseBranch(getTask(member.id)!, project)).toBe("main");
    } finally {
      await close();
    }
  });

  it("refuses a rename collision, a near-miss ref and a foreign tag, writing nothing", async () => {
    const project = createProject({ name: `Codex-TagRefuse-${uid()}` });
    const other = createProject({ name: `Codex-TagRefuse2-${uid()}` });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const a = createTag({ project_id: project.id, name: "Auth migration", description: "keep me" });
    createTag({ project_id: project.id, name: "Mobile PWA" });
    const foreign = createTag({ project_id: other.id, name: "Elsewhere" });

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      // Renaming onto a name another tag holds is refused BY NAME, and the
      // description that shared the call doesn't land under that refusal.
      const clash = (await client.callTool({
        name: "update_tag",
        arguments: { tag: a.id, name: "Mobile PWA", description: "rewritten" },
      })) as ToolResult;
      expect(clash.isError).toBe(true);
      expect(clash.content[0].text).toContain('A tag named "Mobile PWA" already exists');
      expect(getTag(a.id)).toMatchObject({ name: "Auth migration", description: "keep me" });

      // Exact names only: a near miss must not mint a near-duplicate of the tag
      // the user filters their board by.
      const nearMiss = (await client.callTool({ name: "update_tag", arguments: { tag: "auth migration", description: "nope" } })) as ToolResult;
      expect(nearMiss.isError).toBe(true);
      expect(listTags(project.id)).toHaveLength(2);

      // The endpoint resolves inside CALANDRIA_PROJECT_ID, so a tag in another
      // project is not there; there is no `project` param to redirect it.
      const cross = (await client.callTool({ name: "update_tag", arguments: { tag: foreign.id, description: "mine now" } })) as ToolResult;
      expect(cross.isError).toBe(true);
      expect(getTag(foreign.id)!.description).toBe("");

      const unsafe = (await client.callTool({ name: "update_tag", arguments: { tag: a.id, base_branch: "--upload-pack=evil" } })) as ToolResult;
      expect(unsafe.isError).toBe(true);
      expect(getTag(a.id)!.base_branch).toBe("");
    } finally {
      await close();
    }
  });
});
