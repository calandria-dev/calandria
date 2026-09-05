import { describe, it, expect, beforeEach, vi } from "vitest";

// Pins the model a turn actually asks for, end to end: the task's own pick (the
// New/Edit dialogs and the session rail all write tasks.model), else the
// agent's Settings default ("default_model:<agent>"), else no override at all,
// which is what "Default" in every picker promises.
//
// Both drivers are exercised through their real runTurn(); only the two agent
// SDKs are swapped, so the resolution, the omit-when-unset branch, and the
// options object handed to the CLI are all covered.
//
// The third fallback matters as much as the first two: an instance that has
// never opened Settings must keep sending no model override, so a user's
// ~/.claude or ~/.codex default keeps winning.

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => cfg,
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

// Records the ThreadOptions the driver builds, then replays an empty stream.
const { codexThreadOptions } = vi.hoisted(() => ({ codexThreadOptions: { last: null as Record<string, unknown> | null } }));

vi.mock("@openai/codex-sdk", () => {
  class FakeThread {
    id: string | null = null;
    async runStreamed() {
      return { events: (async function* () {})() };
    }
  }
  class Codex {
    startThread(options: Record<string, unknown>) {
      codexThreadOptions.last = options;
      return new FakeThread();
    }
    resumeThread(_id: string, options: Record<string, unknown>) {
      codexThreadOptions.last = options;
      return new FakeThread();
    }
  }
  return { Codex };
});

import { claudeDriver } from "@/lib/agents/claude/driver";
import { codexDriver } from "@/lib/agents/codex/driver";
import { DEFAULT_CODEX_MODEL } from "@/lib/agents/codex/pricing";
import { PATCH as patchSettings } from "@/app/api/settings/route";
import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { createProject, createTask, getTask, updateTask, setSetting } from "@/lib/store";
import type { Project, StreamEvent, Task } from "@/lib/types";

function fixture(agent: string, over: Partial<Task> = {}): { project: Project; task: Task } {
  const project = createProject({ name: `Model ${Math.random().toString(36).slice(2)}`, repo_path: "" });
  const task = createTask({ project_id: project.id, title: "Modeled task", description: "", agent });
  if (Object.keys(over).length) updateTask(task.id, over as Record<string, unknown>);
  return { project, task: getTask(task.id)! };
}

/** The `model` key the Claude driver handed the SDK (absent = inherit the CLI's). */
async function claudeModel(taskModel: string | null, appDefault: string | null): Promise<unknown> {
  const { project, task } = fixture("claude", taskModel ? { model: taskModel } : {});
  setSetting("default_model:claude", appDefault);
  queryMock.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {} }));
  for await (const _ of claudeDriver.runTurn(task, project, "go")) void _;
  const options = (queryMock.mock.calls.at(-1)![0] as { options: Record<string, unknown> }).options;
  return "model" in options ? options.model : undefined;
}

/** The `model` the Codex driver asked for, plus the model it reported for the turn. */
async function codexModel(taskModel: string | null, appDefault: string | null): Promise<{ asked: unknown; reported: string | undefined }> {
  const { project, task } = fixture("codex", taskModel ? { model: taskModel } : {});
  setSetting("default_model:codex", appDefault);
  codexThreadOptions.last = null;
  const events: StreamEvent[] = [];
  for await (const ev of codexDriver.runTurn(task, project, "go")) events.push(ev);
  const options = codexThreadOptions.last!;
  return {
    asked: "model" in options ? options.model : undefined,
    reported: events.find((e): e is Extract<StreamEvent, { type: "model" }> => e.type === "model")?.model,
  };
}

beforeEach(() => {
  queryMock.mockReset();
  setSetting("default_model:claude", null);
  setSetting("default_model:codex", null);
});

describe("resolving a turn's model", () => {
  it("sends nothing when neither the task nor Settings chose — the CLI's own default keeps winning", async () => {
    expect(await claudeModel(null, null)).toBeUndefined();
    const codex = await codexModel(null, null);
    expect(codex.asked).toBeUndefined();
    // Codex emits no model event of its own, so the driver still reports the
    // CLI default it assumes; that is what prices the estimate and fills the
    // badge. Asking for nothing and reporting an assumption are separate acts.
    expect(codex.reported).toBe(DEFAULT_CODEX_MODEL);
  });

  it("falls back to the agent's Settings default when the task inherited", async () => {
    expect(await claudeModel(null, "haiku")).toBe("haiku");
    const codex = await codexModel(null, "gpt-5.6-luna");
    expect(codex.asked).toBe("gpt-5.6-luna");
    expect(codex.reported).toBe("gpt-5.6-luna");
  });

  it("lets the task's own pick beat the Settings default", async () => {
    expect(await claudeModel("opus", "haiku")).toBe("opus");
    const codex = await codexModel("gpt-5.6-sol", "gpt-5.6-luna");
    expect(codex.asked).toBe("gpt-5.6-sol");
  });

  it("keeps the default agent-scoped — one agent's default never leaks onto the other", async () => {
    // A model id names one provider's catalog: "opus" is a value Codex could
    // never run, so there is no un-suffixed key to read.
    setSetting("default_model:claude", "opus");
    expect((await codexModel(null, null)).asked).toBeUndefined();
    setSetting("default_model:codex", "gpt-5.6-luna");
    expect(await claudeModel(null, null)).toBeUndefined();
  });
});

describe("PATCH /api/settings — the default-model key", () => {
  const patch = async (body: Record<string, string | null>) =>
    (await (await patchSettings(new Request("http://test/api/settings", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }))).json()) as Record<string, string>;

  it("accepts an agent-scoped key for any agent id", async () => {
    expect((await patch({ "default_model:claude": "sonnet" }))["default_model:claude"]).toBe("sonnet");
    expect((await patch({ "default_model:codex": "gpt-5.5" }))["default_model:codex"]).toBe("gpt-5.5");
  });

  it("refuses an un-scoped default_model rather than storing a key no driver reads", async () => {
    const settings = await patch({ default_model: "opus" });
    expect(settings.default_model).toBeUndefined();
  });
});

describe("POST /api/tasks — model at creation", () => {
  const post = async (body: Record<string, unknown>) => {
    const res = await createTaskRoute(new Request("http://test/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return (await res.json()) as Task;
  };

  it("persists the model chosen in the New-task dialog", async () => {
    // It rides the create call rather than a follow-up PATCH because the dialog
    // can launch the first turn in the same gesture, and a PATCH would land
    // behind it.
    const project = createProject({ name: `Create ${Math.random().toString(36).slice(2)}`, repo_path: "" });
    const task = await post({ project_id: project.id, title: "Pinned", model: "haiku" });
    expect(getTask(task.id)!.model).toBe("haiku");
  });

  it("leaves the model null when the dialog stayed on Default", async () => {
    const project = createProject({ name: `Create ${Math.random().toString(36).slice(2)}`, repo_path: "" });
    const task = await post({ project_id: project.id, title: "Inherited" });
    expect(getTask(task.id)!.model).toBeNull();
  });

  it("drops a model that isn't a usable string instead of writing junk to the row", async () => {
    // Same shape check the PATCH route applies: content stays the driver's
    // problem (the catalog is instance config), but a control character or a
    // 2KB blob must never reach the CLI's argv.
    const project = createProject({ name: `Create ${Math.random().toString(36).slice(2)}`, repo_path: "" });
    for (const model of ["  ", "opus\nsonnet", "x".repeat(3000), 42, null]) {
      const task = await post({ project_id: project.id, title: "Junk", model });
      expect(getTask(task.id)!.model, JSON.stringify(model)).toBeNull();
    }
  });
});
