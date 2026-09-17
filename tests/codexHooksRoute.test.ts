// GET/POST /api/agents/[id]/hooks, driven end to end through the real route
// against a scripted driver in the codex slot (the same pattern
// tests/slashCommandsRoute.test.ts uses for claude): which cwd the route
// resolves for a taskId versus a projectId, the worktree-path/repo_path
// fallback, request validation, and that an agent with no listHooks/reviewHooks
// (every agent but Codex) reports unsupported instead of a 404 or 500.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { listHooksMock, reviewHooksMock } = vi.hoisted(() => ({
  listHooksMock: vi.fn(),
  reviewHooksMock: vi.fn(),
}));

vi.mock("@/lib/agents/codex/driver", () => ({
  codexDriver: {
    id: "codex",
    label: "Scripted Fake",
    runTurn: () => {},
    listHooks: (...args: unknown[]) => listHooksMock(...args),
    reviewHooks: (...args: unknown[]) => reviewHooksMock(...args),
  },
}));

import { createProject, createTask, updateTask } from "@/lib/store";
import { GET as hooksGet, POST as hooksPost } from "@/app/api/agents/[id]/hooks/route";
import { makeRepo, uid } from "./helpers";
import type { CodexHookInventory } from "@/lib/agents/codex/hooks";

async function get(id: string, query: string) {
  const res = await hooksGet(new Request(`http://x/api${query}`), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

async function post(id: string, body: unknown) {
  const res = await hooksPost(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: await res.json() };
}

const emptyInventory: CodexHookInventory = { scopes: [] };

let projectId: string;
let repoPath: string;

beforeEach(async () => {
  listHooksMock.mockReset();
  reviewHooksMock.mockReset();
  repoPath = await makeRepo();
  projectId = createProject({ name: `hooks-${uid()}`, repo_path: repoPath, branch: "main" }).id;
});

describe("GET /api/agents/[id]/hooks", () => {
  it("404s an unknown agent", async () => {
    expect((await get("nope", "")).status).toBe(404);
  });

  it("reports unsupported for an agent with no listHooks, instead of erroring", async () => {
    const { status, body } = await get("claude", "");
    expect(status).toBe(200);
    expect(body).toEqual({ supported: false });
  });

  it("400s with neither taskId nor projectId", async () => {
    const { status, body } = await get("codex", "");
    expect(status).toBe(400);
    expect(body.error).toContain("taskId or projectId");
  });

  it("resolves a projectId straight to the project's repo_path", async () => {
    listHooksMock.mockResolvedValue({ inventory: emptyInventory });
    const { status } = await get("codex", `?projectId=${projectId}`);
    expect(status).toBe(200);
    expect(listHooksMock).toHaveBeenCalledWith(repoPath);
  });

  it("404s an unknown projectId", async () => {
    const { status, body } = await get("codex", "?projectId=nope");
    expect(status).toBe(400);
    expect(body.error).toContain("no such project");
  });

  it("resolves a taskId with a cut worktree to the worktree path, not the project's repo_path", async () => {
    const task = createTask({ project_id: projectId, title: "T" });
    updateTask(task.id, { worktree_path: "/tmp/some-worktree" });
    listHooksMock.mockResolvedValue({ inventory: emptyInventory });
    await get("codex", `?taskId=${task.id}`);
    expect(listHooksMock).toHaveBeenCalledWith("/tmp/some-worktree");
  });

  it("resolves a taskId with no worktree yet to its project's repo_path", async () => {
    const task = createTask({ project_id: projectId, title: "T" });
    listHooksMock.mockResolvedValue({ inventory: emptyInventory });
    await get("codex", `?taskId=${task.id}`);
    expect(listHooksMock).toHaveBeenCalledWith(repoPath);
  });

  it("404-shapes (400) an unknown taskId", async () => {
    const { status, body } = await get("codex", "?taskId=nope");
    expect(status).toBe(400);
    expect(body.error).toContain("no such task");
  });

  it("returns the inventory and derived skippedHooks together", async () => {
    const inventory: CodexHookInventory = {
      scopes: [
        {
          cwd: repoPath,
          hooks: [
            {
              key: "k1",
              eventName: "preToolUse",
              matcher: null,
              handlerType: "command",
              command: "/bin/true",
              sourcePath: "/proj/.codex/hooks.json",
              source: "project",
              pluginId: null,
              timeoutSec: 600,
              statusMessage: null,
              displayOrder: 0,
              enabled: true,
              isManaged: false,
              currentHash: "sha256:x",
              trustStatus: "untrusted",
            },
          ],
          warnings: [],
          errors: [],
        },
      ],
    };
    listHooksMock.mockResolvedValue({ inventory });
    const { status, body } = await get("codex", `?projectId=${projectId}`);
    expect(status).toBe(200);
    expect(body.supported).toBe(true);
    expect(body.inventory.scopes[0].hooks[0].key).toBe("k1");
    expect(body.skippedHooks).toEqual([{ hook: body.inventory.scopes[0].hooks[0], reason: "never reviewed" }]);
  });

  it("surfaces a driver error as 502, not a thrown exception", async () => {
    listHooksMock.mockResolvedValue({ error: "codex app-server did not answer hooks/list in time" });
    const { status, body } = await get("codex", `?projectId=${projectId}`);
    expect(status).toBe(502);
    expect(body.error).toContain("did not answer");
  });
});

describe("POST /api/agents/[id]/hooks", () => {
  it("400s for an agent with no reviewHooks", async () => {
    const { status, body } = await post("claude", { projectId, reviews: [] });
    expect(status).toBe(400);
    expect(body.error).toContain("claude");
  });

  it("400s a body that fails the schema (bad action)", async () => {
    const { status } = await post("codex", { projectId, reviews: [{ key: "k1", action: "delete" }] });
    expect(status).toBe(400);
    expect(reviewHooksMock).not.toHaveBeenCalled();
  });

  it("400s a body with an unrecognized field (schema is strict)", async () => {
    const { status } = await post("codex", { projectId, reviews: [], extra: true });
    expect(status).toBe(400);
  });

  it("resolves the same cwd as GET, and forwards the reviews verbatim", async () => {
    reviewHooksMock.mockResolvedValue({ ok: true });
    const reviews = [{ key: "k1", action: "trust" }];
    const { status, body } = await post("codex", { projectId, reviews });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(reviewHooksMock).toHaveBeenCalledWith(repoPath, reviews);
  });

  it("surfaces a driver refusal as 400 with its reason", async () => {
    reviewHooksMock.mockResolvedValue({ ok: false, error: "no such hook: nope" });
    const { status, body } = await post("codex", { projectId, reviews: [{ key: "nope", action: "trust" }] });
    expect(status).toBe(400);
    expect(body.error).toBe("no such hook: nope");
  });

  it("400s when neither taskId nor projectId is given, before calling the driver", async () => {
    const { status } = await post("codex", { reviews: [] });
    expect(status).toBe(400);
    expect(reviewHooksMock).not.toHaveBeenCalled();
  });
});
