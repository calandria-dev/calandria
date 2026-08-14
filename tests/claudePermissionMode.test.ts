import { describe, it, expect, beforeEach, vi } from "vitest";

// The Claude driver's permission-MODE resolution, and what each mode does to
// the canUseTool gate. tests/permissionGate.test.ts covers the runner side of a
// prompt (persistence, "needs you", the unattended park) with a scripted
// driver; this covers the half above that seam, where the mode is chosen and
// handed to the SDK.
//
// The REAL lib/agents/claude/driver.ts runs — only @anthropic-ai/claude-agent-sdk
// is swapped, so permissionModeFor(), the gate, and the message pump are all
// exercised. The fake query() records the options it was handed and replays a
// scripted message stream, which is also how a `system/permission_denied`
// message gets in front of the pump without a live CLI.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  // The driver builds its orchestrator MCP server at query time; the fake
  // query() never looks at it, so these only have to not throw.
  createSdkMcpServer: (cfg: unknown) => cfg,
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import type { CanUseTool, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { claudeDriver } from "@/lib/agents/claude/driver";
import { CLAUDE_CAPABILITIES } from "@/lib/agents/claude/capabilities";
import { createProject, createTask, getTask, updateTask, setSetting, addPermissionRule } from "@/lib/store";
import { submitAnswer } from "@/lib/asks";
import type { Project, StreamEvent, Task } from "@/lib/types";

type QueryArgs = { prompt: string; options: Record<string, unknown> };

/** Script the fake SDK: yield `messages`, optionally running `mid` first. */
function scriptSdk(messages: unknown[] = [], mid?: (opts: Record<string, unknown>) => Promise<void>) {
  queryMock.mockImplementation((args: QueryArgs) => ({
    async *[Symbol.asyncIterator]() {
      if (mid) await mid(args.options);
      for (const m of messages) yield m;
    },
  }));
}

function fixture(over: Partial<Task> = {}): { project: Project; task: Task } {
  const project = createProject({ name: `PermMode ${Math.random().toString(36).slice(2)}`, repo_path: "" });
  const task = createTask({ project_id: project.id, title: "Moded task", description: "" });
  if (Object.keys(over).length) updateTask(task.id, over as Record<string, unknown>);
  return { project, task: getTask(task.id)! };
}

/** Run one turn to completion and return the events plus the SDK options used. */
async function runTurn(task: Task, project: Project): Promise<{ events: StreamEvent[]; options: Record<string, unknown> }> {
  const events: StreamEvent[] = [];
  for await (const ev of claudeDriver.runTurn(task, project, "go")) events.push(ev);
  return { events, options: (queryMock.mock.calls.at(-1)![0] as QueryArgs).options };
}

const modeOf = async (permission_mode: string | null, appDefault?: string): Promise<unknown> => {
  const { project, task } = fixture(permission_mode === null ? {} : { permission_mode });
  if (appDefault !== undefined) setSetting("default_permission_mode:claude", appDefault);
  scriptSdk();
  const { options } = await runTurn(task, project);
  return options.permissionMode;
};

beforeEach(() => {
  queryMock.mockReset();
  setSetting("default_permission_mode:claude", null);
  setSetting("default_permission_mode", null);
});

describe("which permission modes the driver offers", () => {
  it("honors exactly the modes the picker offers — no entry that silently means something else", async () => {
    // The bug this guards: adding a mode to the capability list that
    // permissionModeFor() doesn't recognize gives the user a picker entry that
    // quietly runs as the default instead. Every offered value must survive the
    // round trip to the SDK unchanged.
    for (const { value } of CLAUDE_CAPABILITIES.permissionModes) {
      expect(await modeOf(value), `picker offers "${value}"`).toBe(value);
    }
  });

  it("offers the five SDK modes worth surfacing, and not dontAsk", () => {
    expect(CLAUDE_CAPABILITIES.permissionModes.map((p) => p.value)).toEqual([
      "bypassPermissions",
      "auto",
      "acceptEdits",
      "default",
      "plan",
    ]);
  });

  it("labels every mode distinctly, and never 'Default' — the picker's inherit head owns that word", () => {
    const labels = CLAUDE_CAPABILITIES.permissionModes.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain("Default");
    for (const p of CLAUDE_CAPABILITIES.permissionModes) expect(p.sub.trim()).not.toBe("");
  });
});

describe("resolving a task's permission mode", () => {
  it("falls back to auto when the task says nothing and no app default is set", async () => {
    expect(await modeOf(null)).toBe("auto");
  });

  it("coerces an unknown value to auto rather than passing it to the CLI", async () => {
    // A mode from another agent's list, or a row written by an older build.
    // The CLI rejects unknown --permission-mode values, so this must not pass through.
    expect(await modeOf("dontAsk")).toBe("auto");
    expect(await modeOf("workspace-write")).toBe("auto");
    expect(await modeOf("")).toBe("auto");
  });

  it("inherits the agent-scoped app default when the task defers", async () => {
    expect(await modeOf(null, "plan")).toBe("plan");
  });

  it("runs in the mode the task was CREATED with, without a follow-up edit", async () => {
    // The New-task dialog sets this up front rather than PATCHing after, because
    // "Start session immediately" launches the first turn — a mode applied
    // afterwards would miss the very turn it was picked for. So createTask has
    // to persist it, not just updateTask.
    const project = createProject({ name: `CreateMode ${Math.random().toString(36).slice(2)}`, repo_path: "" });
    const created = createTask({ project_id: project.id, title: "Unattended", description: "", permission_mode: "bypassPermissions" });
    expect(created.permission_mode).toBe("bypassPermissions");

    scriptSdk();
    const { options } = await runTurn(getTask(created.id)!, project);
    expect(options.permissionMode).toBe("bypassPermissions");
  });

  it("still defers to the default when created without a mode", async () => {
    const project = createProject({ name: `NoMode ${Math.random().toString(36).slice(2)}`, repo_path: "" });
    const created = createTask({ project_id: project.id, title: "Plain", description: "" });
    expect(created.permission_mode).toBeNull();

    scriptSdk();
    const { options } = await runTurn(getTask(created.id)!, project);
    expect(options.permissionMode).toBe("auto");
  });

  it("lets the task's own choice beat the app default", async () => {
    const { project, task } = fixture({ permission_mode: "acceptEdits" });
    setSetting("default_permission_mode:claude", "plan");
    scriptSdk();
    const { options } = await runTurn(task, project);
    expect(options.permissionMode).toBe("acceptEdits");
  });
});

describe("what each mode does to the gate", () => {
  /**
   * Run a turn, calling canUseTool mid-stream, and report what it decided.
   * `answer`, when given, is submitted as soon as the gate has actually parked —
   * the driver keys its waiter on `perm:<toolUseID>`, so submitAnswer only
   * succeeds once the card is live, which makes the retry the synchronization.
   */
  async function gate(
    mode: PermissionMode,
    tool: string,
    input: Record<string, unknown>,
    answer?: string[][]
  ) {
    const { project, task } = fixture({ permission_mode: mode });
    let result: Awaited<ReturnType<CanUseTool>> | undefined;
    const events: StreamEvent[] = [];
    scriptSdk([], async (options) => {
      const pending = (options.canUseTool as CanUseTool)(tool, input, {
        signal: new AbortController().signal,
        suggestions: [],
        toolUseID: "tu_1",
      } as unknown as Parameters<CanUseTool>[2]);
      if (answer) await vi.waitFor(() => expect(submitAnswer(task.id, "perm:tu_1", answer)).toBe(true));
      result = await pending;
    });
    // Collected concurrently: a parked gate pushes its `permission` event onto
    // the same queue this generator is draining.
    for await (const ev of claudeDriver.runTurn(task, project, "go")) events.push(ev);
    return { result, events };
  }

  it("blanket-allows under Auto-run — the gate is never consulted", async () => {
    // Not just "allows": bypassPermissions must short-circuit BEFORE any card,
    // because the SDK never calls the callback in that mode anyway.
    const { result, events } = await gate("bypassPermissions", "Bash", { command: "rm -rf /tmp/x" });
    expect(result).toMatchObject({ behavior: "allow" });
    expect(events.some((e) => e.type === "permission")).toBe(false);
  });

  for (const mode of ["auto", "default"] as const) {
    it(`raises a real permission card under ${mode}, and the user's allow lets the call run`, async () => {
      // The regression this pins: before the gate was real, every mode behaved
      // like Auto-run. A command in a prompting mode has to reach the user, and
      // their answer has to be what decides it.
      const { result, events } = await gate(mode, "Bash", { command: "curl -s https://example.com" }, [["allow_once"]]);
      const card = events.find((e) => e.type === "permission");
      expect(card, `${mode} must prompt, not auto-run`).toBeDefined();
      expect((card as Extract<StreamEvent, { type: "permission" }>).request.detail).toBe("curl -s https://example.com");
      expect(result).toMatchObject({ behavior: "allow" });
      expect(events.some((e) => e.type === "permission_decided")).toBe(true);
    });

    it(`denies the call when the user declines under ${mode}`, async () => {
      const { result } = await gate(mode, "Bash", { command: "curl -s https://example.com" }, [["deny"]]);
      expect(result).toMatchObject({ behavior: "deny" });
    });

    it(`still passes read-only tools straight through under ${mode}`, async () => {
      // Otherwise a prompting mode costs a click per Read and is unusable.
      const { result, events } = await gate(mode, "Read", { file_path: "/tmp/notes.txt" });
      expect(result).toMatchObject({ behavior: "allow" });
      expect(events.some((e) => e.type === "permission")).toBe(false);
    });
  }

  it("honors a remembered project rule under a prompting mode", async () => {
    const project = createProject({ name: `RuleProj ${Math.random().toString(36).slice(2)}`, repo_path: "" });
    const created = createTask({ project_id: project.id, title: "Ruled", description: "" });
    updateTask(created.id, { permission_mode: "auto" });
    const task = getTask(created.id)!;
    addPermissionRule({ project_id: project.id, tool: "Bash", match_kind: "bash_prefix", value: "npm test" });

    let result: Awaited<ReturnType<CanUseTool>> | undefined;
    scriptSdk([], async (options) => {
      result = await (options.canUseTool as CanUseTool)("Bash", { command: "npm test -- --watch=false" }, {
        signal: new AbortController().signal,
        suggestions: [],
        toolUseID: "tu_rule",
      } as unknown as Parameters<CanUseTool>[2]);
    });
    const events: StreamEvent[] = [];
    for await (const ev of claudeDriver.runTurn(task, project, "go")) events.push(ev);

    expect(result).toMatchObject({ behavior: "allow" });
    expect(events.some((e) => e.type === "permission")).toBe(false);
  });
});

describe("a call the CLI denies without asking", () => {
  it("surfaces the classifier's veto as a notice instead of a bare tool failure", async () => {
    // Reachable in normal use now that "auto" is the default: the classifier can
    // deny without ever calling canUseTool, and the only other trace the user
    // gets is an is_error tool_result that reads like the command simply failed.
    const { project, task } = fixture({ permission_mode: "auto" });
    scriptSdk([
      {
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "tu_9",
        decision_reason_type: "classifier",
        decision_reason: "Command could exfiltrate credentials",
        message: "Permission to use Bash has been denied.",
        uuid: "u1",
        session_id: "s1",
      },
    ]);

    const { events } = await runTurn(task, project);
    const notice = events.find((e) => e.type === "notice");
    expect(notice).toBeDefined();
    const content = (notice as Extract<StreamEvent, { type: "notice" }>).content;
    expect(content).toContain("Bash");
    expect(content).toContain("classifier");
    expect(content).toContain("Command could exfiltrate credentials");
  });
});
