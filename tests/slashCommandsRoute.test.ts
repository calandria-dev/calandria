// GET /api/tasks/[id]/commands — the discovery half of the composer's "/" menu,
// driven end to end through the real route and the real driver seam.
//
// Regression this guards: the menu used to be a hardcoded one-element array, so
// every command the agent actually expands except /clear was undiscoverable.
// The route is what closes that, and its contract is narrow — ask the task's
// own driver, filter, never throw at the composer.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { listCommandsMock } = vi.hoisted(() => ({ listCommandsMock: vi.fn() }));

// A scripted driver in the claude slot, the same seam tests/clearMidTurn.ts uses
// — so this exercises the route's real getDriver() path without a CLI.
vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: () => {},
    listCommands: (...args: unknown[]) => listCommandsMock(...args),
  },
}));

import { createProject, createTask, getTask } from "@/lib/store";
import { GET as commandsRoute } from "@/app/api/tasks/[id]/commands/route";
import { makeRepo, uid } from "./helpers";

async function get(id: string) {
  const res = await commandsRoute(new Request("http://x/api"), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

let taskId: string;
let projectId: string;

beforeEach(async () => {
  listCommandsMock.mockReset();
  const dir = await makeRepo();
  projectId = createProject({ name: `slash-${uid()}`, repo_path: dir, branch: "main" }).id;
  taskId = createTask({ project_id: projectId, title: "T" }).id;
});

describe("GET /api/tasks/[id]/commands", () => {
  it("returns the driver's commands, filtered", async () => {
    listCommandsMock.mockResolvedValue([
      { name: "simplify", description: "tidy up", argumentHint: "<path>" },
      { name: "clear", description: "the CLI's own clear" }, // Operator owns /clear
      { name: "__internal", description: "hidden" },
      { name: "superpowers:writing-plans", description: "plan", aliases: ["writing-plans"] },
    ]);
    const { status, body } = await get(taskId);
    expect(status).toBe(200);
    expect(body.commands.map((c: { name: string }) => c.name)).toEqual(["simplify", "superpowers:writing-plans"]);
    // Aliases survive the trip — the menu matches on them.
    expect(body.commands[1].aliases).toEqual(["writing-plans"]);
  });

  it("asks the driver about THIS task, so a worktree's own commands count", async () => {
    listCommandsMock.mockResolvedValue([]);
    await get(taskId);
    const [task, project] = listCommandsMock.mock.calls[0];
    expect((task as { id: string }).id).toBe(taskId);
    expect((project as { id: string }).id).toBe(projectId);
  });

  it("degrades to an empty list when discovery throws, instead of erroring", async () => {
    // A missing CLI or a dead login must cost the menu its long tail and
    // nothing else — typing a command in full still works.
    listCommandsMock.mockRejectedValue(new Error("no CLI on PATH"));
    const { status, body } = await get(taskId);
    expect(status).toBe(200);
    expect(body.commands).toEqual([]);
  });

  it("returns an empty list for a driver with no command surface", async () => {
    // listCommands is optional on AgentDriver (Codex omits it).
    const mod = await import("@/lib/agents/claude/driver");
    const driver = mod.claudeDriver as unknown as { listCommands?: unknown };
    const saved = driver.listCommands;
    delete driver.listCommands;
    try {
      const { status, body } = await get(taskId);
      expect(status).toBe(200);
      expect(body.commands).toEqual([]);
    } finally {
      driver.listCommands = saved;
    }
  });

  it("404s an unknown task rather than guessing a cwd", async () => {
    expect((await get("nope")).status).toBe(404);
  });

  it("is never cached by the browser", async () => {
    listCommandsMock.mockResolvedValue([{ name: "run", description: "run it" }]);
    const res = await commandsRoute(new Request("http://x/api"), { params: Promise.resolve({ id: taskId }) });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not run a turn or touch the task row", async () => {
    listCommandsMock.mockResolvedValue([{ name: "run", description: "run it" }]);
    const before = getTask(taskId);
    await get(taskId);
    const after = getTask(taskId);
    expect(after?.session_id).toBe(before?.session_id);
    expect(after?.running).toBe(before?.running);
    expect(after?.generation).toBe(before?.generation);
  });
});
