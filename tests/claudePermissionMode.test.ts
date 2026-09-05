import { describe, it, expect, beforeEach, vi } from "vitest";

// Pins the Claude driver's permission-MODE resolution and what each mode does
// to the canUseTool gate. tests/permissionGate.test.ts covers the runner side
// of a prompt (persistence, "needs you", the unattended park) with a scripted
// driver; this covers the mode selection and its handoff to the SDK.
//
// The real lib/agents/claude/driver.ts runs; only @anthropic-ai/claude-agent-sdk
// is swapped, so permissionModeFor(), the gate, and the message pump are all
// exercised. The fake query() records the options it was handed and replays a
// scripted message stream, which also puts a `system/permission_denied`
// message in front of the pump without a live CLI.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  // The driver builds its Calandria MCP server at query time; the fake
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
    // Every mode the capability list offers must survive the round trip to
    // the SDK unchanged, since an unrecognized value falls back to the
    // default.
    for (const { value } of CLAUDE_CAPABILITIES.permissionModes) {
      expect(await modeOf(value), `picker offers "${value}"`).toBe(value);
    }
  });

  it("offers the five SDK modes worth surfacing, and not dontAsk", () => {
    // dontAsk is excluded because it never invokes canUseTool, so the
    // permission gate in lib/permissions.ts (the read-only allowlist,
    // remembered project rules, the card) never runs under it. See the note
    // in capabilities.ts.
    expect(CLAUDE_CAPABILITIES.permissionModes.map((p) => p.value)).toEqual([
      "bypassPermissions",
      "auto",
      "acceptEdits",
      "default",
      "plan",
    ]);
  });

  it("labels every mode with Anthropic's own spelling, and never 'Inherit' — the picker's head owns that word", () => {
    // Provider-native labels: the picker shows exactly the strings
    // `--permission-mode` takes, so label equals value for every entry,
    // including the mode Anthropic spells "default". Calandria's synthetic
    // head is "Inherit" so it isn't mistaken for that one;
    // tests/pickerInheritHead.test.ts pins the head end of that separation
    // for every driver.
    for (const p of CLAUDE_CAPABILITIES.permissionModes) expect(p.label).toBe(p.value);
    const labels = CLAUDE_CAPABILITIES.permissionModes.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.map((l) => l.toLowerCase())).not.toContain("inherit");
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
    // The New-task dialog sets the mode up front instead of PATCHing after
    // creation, because "Start session immediately" launches the first turn
    // and a mode applied afterward would miss it. createTask must persist it,
    // not just updateTask.
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
   * `answer`, when given, is submitted once the gate has parked: the driver
   * keys its waiter on `perm:<toolUseID>`, so submitAnswer only succeeds once
   * the card is live, and the retry provides the synchronization.
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

  it("blanket-allows under bypassPermissions — the gate is never consulted", async () => {
    // Not just "allows": bypassPermissions must short-circuit BEFORE any card,
    // because the SDK never calls the callback in that mode anyway.
    const { result, events } = await gate("bypassPermissions", "Bash", { command: "rm -rf /tmp/x" });
    expect(result).toMatchObject({ behavior: "allow" });
    expect(events.some((e) => e.type === "permission")).toBe(false);
  });

  for (const mode of ["auto", "default"] as const) {
    it(`raises a real permission card under ${mode}, and the user's allow lets the call run`, async () => {
      // A command in a prompting mode must reach the user, and the user's
      // answer must be what decides it.
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

// Two `system`/`permission_denied` messages captured verbatim from the Agent
// SDK against the real CLI, not written from sdk.d.ts. Both matter, since the
// type alone gets both wrong:
//
//  - `decision_reason`, the field the SDK documents as "human-readable reason
//    from the deciding component", is absent on both. Only `message` is set,
//    and it is the text handed to the model: the `mode` one is a long
//    "IMPORTANT: You *may* attempt to accomplish this action using other
//    tools..." instruction. Pasting it at the user is what blockedReason()
//    exists to stop.
//  - `decision_reason_type` is open-ended. `subcommandResults` is a value the
//    CLI emits that the SDK's own doc comment doesn't list, so the
//    discriminator is persisted raw and phrased at render time.
const DENIED_BY_MODE = {
  type: "system",
  subtype: "permission_denied",
  tool_name: "Bash",
  tool_use_id: "toolu_vrtx_01UxKcWBfEyFD8aroDF1oJqs",
  decision_reason_type: "mode",
  message:
    "Permission to use Bash has been denied because Claude Code is running in don't ask mode. " +
    "IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used " +
    "to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around " +
    "this denial in malicious ways, e.g. do not use your ability to run tests to execute non-test actions. " +
    "You should only try to work around this restriction in reasonable ways that do not attempt to bypass " +
    "the intent behind this denial. If you believe this capability is essential to complete the user's " +
    "request, STOP and explain to the user what you were trying to do and why you need this permission. " +
    "Let the user decide how to proceed.",
  uuid: "9037688e-d43c-4e33-a483-dbb6d95fe243",
  session_id: "af043550-a616-4165-aecc-116cb332b2c3",
};

const DENIED_BY_SUBCOMMAND = {
  type: "system",
  subtype: "permission_denied",
  tool_name: "Bash",
  tool_use_id: "toolu_vrtx_01PpCVdJemHsETBimMJh2rfE",
  decision_reason_type: "subcommandResults",
  message: "Permission to use Bash with command rm -f /tmp/permprobe/scratch.txt has been denied.",
  uuid: "586db46d-3e59-43d9-b892-baccc7330754",
  session_id: "e6b5da72-2ff1-4f13-ac9f-b9274892e794",
};

describe("a call the CLI denies without asking", () => {
  const denialOf = (events: StreamEvent[]) =>
    events.find((e) => e.type === "permission_denied") as Extract<StreamEvent, { type: "permission_denied" }> | undefined;

  it("reports the refusal against the tool_use it killed, not as a loose notice", async () => {
    // Reachable in normal use since "auto" is the default: the classifier can
    // deny without calling canUseTool, and the only other trace is an
    // is_error tool_result that reads like the command failed on its own.
    // Carrying the tool_use id lets the runner settle a decided permission
    // card onto that call (tests/permissionGate.test.ts).
    const { project, task } = fixture({ permission_mode: "auto" });
    scriptSdk([DENIED_BY_SUBCOMMAND]);

    const { events } = await runTurn(task, project);
    expect(denialOf(events)).toEqual({
      type: "permission_denied",
      id: "toolu_vrtx_01PpCVdJemHsETBimMJh2rfE",
      tool: "Bash",
      reasonType: "subcommandResults",
      reason: "Permission to use Bash with command rm -f /tmp/permprobe/scratch.txt has been denied.",
    });
    // A denial must not also emit a separate notice event.
    expect(events.some((e) => e.type === "notice")).toBe(false);
  });

  it("keeps the instruction the CLI wrote for the MODEL out of the user's reason", async () => {
    const { project, task } = fixture({ permission_mode: "auto" });
    scriptSdk([DENIED_BY_MODE]);

    const { events } = await runTurn(task, project);
    const reason = denialOf(events)!.reason!;
    expect(reason).toBe("Permission to use Bash has been denied because Claude Code is running in don't ask mode.");
    expect(reason).not.toContain("IMPORTANT");
    expect(reason).not.toContain("head instead of cat");
  });

  it("prefers decision_reason when the CLI does supply one", async () => {
    // Not observed live, but it's the field the SDK documents as the
    // human-readable one, so it must win over `message` if a build starts
    // filling it.
    const { project, task } = fixture({ permission_mode: "auto" });
    scriptSdk([{ ...DENIED_BY_MODE, decision_reason_type: "classifier", decision_reason: "Command could exfiltrate credentials" }]);

    const { events } = await runTurn(task, project);
    expect(denialOf(events)).toMatchObject({ reasonType: "classifier", reason: "Command could exfiltrate credentials" });
  });

  it("gives each denial in a turn its own id, so three refusals aren't one card", async () => {
    const { project, task } = fixture({ permission_mode: "auto" });
    scriptSdk([
      { ...DENIED_BY_SUBCOMMAND, tool_use_id: "tu_a" },
      { ...DENIED_BY_SUBCOMMAND, tool_use_id: "tu_b" },
      { ...DENIED_BY_SUBCOMMAND, tool_use_id: "tu_c" },
    ]);

    const { events } = await runTurn(task, project);
    const ids = events.filter((e) => e.type === "permission_denied").map((e) => (e as { id: string }).id);
    expect(ids).toEqual(["tu_a", "tu_b", "tu_c"]);
  });

  it("still yields a distinct id when the CLI omits tool_use_id", async () => {
    // Required by the SDK type, so this is a build-shipped-something-odd guard:
    // a shared undefined id would collapse the whole turn onto one card.
    const { project, task } = fixture({ permission_mode: "auto" });
    const { tool_use_id: _drop, ...noId } = DENIED_BY_SUBCOMMAND;
    scriptSdk([noId, noId]);

    const { events } = await runTurn(task, project);
    const ids = events.filter((e) => e.type === "permission_denied").map((e) => (e as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((i) => i.startsWith("denied-"))).toBe(true);
  });

  it("marks a refusal that happened inside a subagent", async () => {
    // A subagent's tool_use blocks never reach this stream, so there is no
    // transcript card to settle onto. The runner needs to know why.
    const { project, task } = fixture({ permission_mode: "auto" });
    scriptSdk([{ ...DENIED_BY_SUBCOMMAND, agent_id: "agent_7" }]);

    const { events } = await runTurn(task, project);
    expect(denialOf(events)).toMatchObject({ agentId: "agent_7" });
  });
});
