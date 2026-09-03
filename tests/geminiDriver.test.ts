// Driver-level tests for the Antigravity (Gemini) driver.
//
// There is no SDK to mock here — this driver spawns the `agy` CLI itself — so
// the seam under test is `node:child_process.spawn`. The fake child replays the
// same recorded NDJSON the event tests use, which means these exercise the real
// argv construction, the real stream parsing, the real usage-baseline
// persistence and the real abort path without needing a binary or a login.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import { createProject, createTask, updateTask, getThreadUsageCum, recordSession, setSetting } from "@/lib/store";
import { geminiDriver, turnArgs, permissionFlags } from "@/lib/agents/gemini/driver";
import { bridgeConfig, BRIDGE_SERVER_NAME } from "@/lib/agents/gemini/mcp";
import { prepareTaskHome } from "@/lib/agents/gemini/home";
import { gatewayPresetEnv, serializeAgentEnv } from "@/lib/agentEnv";
import type { GeminiCum } from "@/lib/agents/gemini/events";
import type { StreamEvent, Project, Task } from "@/lib/types";

function fixtureText(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", "gemini", name), "utf8");
}

/** A stand-in for the spawned CLI: replays `stdout`, then exits with `code`. */
function fakeChild(opts: { stdout?: string; stderr?: string; code?: number; hang?: boolean }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: (sig?: string) => boolean;
    exitCode: number | null;
    killed: boolean;
  };
  child.stdout = Readable.from(opts.hang ? [] : [opts.stdout ?? ""]);
  child.stderr = Readable.from([opts.stderr ?? ""]);
  child.exitCode = null;
  child.killed = false;
  child.kill = (_sig?: string) => {
    child.killed = true;
    child.exitCode = 143;
    setImmediate(() => child.emit("close", 143));
    return true;
  };
  // Settle once the replay has been consumed.
  setImmediate(() => {
    child.exitCode = opts.code ?? 0;
    child.emit("close", opts.code ?? 0);
  });
  return child;
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/**
 * Drain a turn the way lib/runner.ts does, persisting the session row as soon as
 * the driver announces one. The usage baseline lives on that row
 * (setThreadUsageCum is a documented no-op without it), so a test that skipped
 * this step would "prove" the baseline is never written.
 */
async function drainAsRunner(
  gen: AsyncGenerator<StreamEvent>,
  project: Project,
  task: Task
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) {
    if (ev.type === "session") {
      recordSession({ project_id: project.id, task_id: task.id, generation: 0, claude_session_id: ev.sessionId });
    }
    out.push(ev);
  }
  return out;
}

function rows(): { project: Project; task: Task } {
  const project = createProject({ name: `Gem-${Math.random().toString(36).slice(2, 8)}`, repo_path: "/tmp" });
  const task = createTask({ project_id: project.id, title: "T", description: "" });
  return { project, task };
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("argv", () => {
  it("asks for the streaming format and skips permissions by default", () => {
    const args = turnArgs({ prompt: "hi", conversationId: null, model: null, permission: null });
    expect(args.slice(0, 4)).toEqual(["-p", "hi", "--output-format", "stream-json"]);
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--conversation");
    // Nothing chose a model, so the CLI's own default keeps winning.
    expect(args).not.toContain("--model");
  });

  it("resumes by conversation id", () => {
    const args = turnArgs({ prompt: "hi", conversationId: "c-1", model: null, permission: null });
    expect(args).toContain("--conversation");
    expect(args[args.indexOf("--conversation") + 1]).toBe("c-1");
  });

  it("never sends --effort, because effort is part of the model slug", () => {
    const args = turnArgs({
      prompt: "hi",
      conversationId: null,
      model: "gemini-3.8-flash-high",
      permission: "bypassPermissions",
    });
    expect(args).not.toContain("--effort");
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
  });

  it("maps the permission modes the descriptor advertises", () => {
    expect(permissionFlags("plan")).toEqual(["--mode", "plan"]);
    expect(permissionFlags("acceptEdits")).toEqual(["--mode", "accept-edits"]);
    expect(permissionFlags("bypassPermissions")).toEqual(["--dangerously-skip-permissions"]);
    // The CLI's own default mode auto-denies every tool in headless mode, so an
    // unknown/absent choice must not fall back to it.
    expect(permissionFlags(null)).toEqual(["--dangerously-skip-permissions"]);
  });
});

describe("runTurn", () => {
  it("streams a recorded turn through to done", async () => {
    const { project, task } = rows();
    spawnMock.mockReturnValue(fakeChild({ stdout: fixtureText("mcp-tool-call.jsonl") }));

    const events = await drain(geminiDriver.runTurn(task, project, "go"));

    expect(events[0]).toEqual({ type: "model", model: "gemini-3.8-flash-high" });
    expect(events.some((e) => e.type === "session")).toBe(true);
    expect(events.filter((e) => e.type === "assistant")).toHaveLength(1);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("runs in the task's worktree under a HOME of its own", async () => {
    const { project, task } = rows();
    updateTask(task.id, { worktree_path: "/tmp" });
    spawnMock.mockReturnValue(fakeChild({ stdout: fixtureText("mcp-tool-call.jsonl") }));

    await drain(geminiDriver.runTurn({ ...task, worktree_path: "/tmp" }, project, "go"));

    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.cwd).toBe("/tmp");
    // The whole reason for the override: a per-task MCP config the CLI will read.
    expect(opts.env.HOME).toContain(task.id);
    // A self-update mid-turn would swap the pinned binary out from under us.
    expect(opts.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
  });

  it("persists the cumulative usage baseline so the next turn isn't re-billed", async () => {
    const { project, task } = rows();
    spawnMock.mockReturnValue(fakeChild({ stdout: fixtureText("mcp-tool-call.jsonl") }));

    await drainAsRunner(geminiDriver.runTurn(task, project, "go"), project, task);

    const conv = "a619d7dd-760a-49fa-a581-8ffef68d4cb9";
    expect(getThreadUsageCum<GeminiCum>(conv)?.input).toBe(45546);
  });

  it("bills only the new turn when resuming against that baseline", async () => {
    const { project, task } = rows();
    spawnMock.mockReturnValue(fakeChild({ stdout: fixtureText("mcp-tool-call.jsonl") }));
    await drainAsRunner(geminiDriver.runTurn(task, project, "go"), project, task);

    const conv = "a619d7dd-760a-49fa-a581-8ffef68d4cb9";
    spawnMock.mockReturnValue(fakeChild({ stdout: fixtureText("resume-cumulative-usage.jsonl") }));
    const events = await drainAsRunner(
      geminiDriver.runTurn({ ...task, session_id: conv }, project, "again"),
      project,
      task
    );

    const usage = events.find((e) => e.type === "usage") as Extract<StreamEvent, { type: "usage" }>;
    expect(usage.usage.input_tokens).toBe(15811);
  });

  it("surfaces a soft denial the stream itself never reports", async () => {
    // Measured: the CLI auto-denies a tool it cannot prompt about, says so only
    // on stderr, and still exits 0. Without this the turn would look successful
    // while having done nothing.
    const { project, task } = rows();
    spawnMock.mockReturnValue(
      fakeChild({
        stdout: fixtureText("tool-auto-denied.jsonl"),
        stderr: 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.',
        code: 0,
      })
    );

    const events = await drain(geminiDriver.runTurn(task, project, "go"));
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toMatch(/auto-denied/);
  });

  it("treats our own Stop as teardown, not an error, and still settles", async () => {
    const { project, task } = rows();
    const child = fakeChild({ stdout: fixtureText("tool-auto-denied.jsonl"), hang: true });
    spawnMock.mockReturnValue(child);

    const abort = new AbortController();
    abort.abort();
    const events = await drain(geminiDriver.runTurn(task, project, "go", abort));

    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("reports a CLI that died before saying anything", async () => {
    const { project, task } = rows();
    spawnMock.mockReturnValue(fakeChild({ stdout: "", stderr: "agy: command not found", code: 127 }));

    const events = await drain(geminiDriver.runTurn(task, project, "go"));
    const err = events.find((e) => e.type === "error") as Extract<StreamEvent, { type: "error" }>;
    expect(err.content).toContain("command not found");
  });

  it("always yields a done even when the CLI never wrote a result", async () => {
    const { project, task } = rows();
    spawnMock.mockReturnValue(fakeChild({ stdout: "", code: 0 }));
    const events = await drain(geminiDriver.runTurn(task, project, "go"));
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });
});

describe("per-task MCP bridge", () => {
  it("carries this task's identity, which is what makes parallel tasks safe", () => {
    const { project, task } = rows();
    const cfg = bridgeConfig(project, task);
    const server = cfg.mcpServers[BRIDGE_SERVER_NAME];
    expect(server.env.CALANDRIA_TASK_ID).toBe(task.id);
    expect(server.env.CALANDRIA_PROJECT_ID).toBe(project.id);
    // Absolute node binary, so the spawn doesn't depend on PATH surviving.
    expect(server.command).toBe(process.execPath);
  });

  it("writes that config where the CLI actually reads MCP servers from", () => {
    const { project, task } = rows();
    const { home } = prepareTaskHome(project, task);
    const file = path.join(home, ".gemini", "config", "mcp_config.json");
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.mcpServers[BRIDGE_SERVER_NAME].env.CALANDRIA_TASK_ID).toBe(task.id);
  });

  it("gives two tasks different homes, so neither steals the other's identity", () => {
    const { project, task } = rows();
    const other = createTask({ project_id: project.id, title: "T2", description: "" });
    const a = prepareTaskHome(project, task);
    const b = prepareTaskHome(project, other);
    expect(a.home).not.toBe(b.home);

    const read = (home: string) =>
      JSON.parse(fs.readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf8"))
        .mcpServers[BRIDGE_SERVER_NAME].env.CALANDRIA_TASK_ID;
    expect(read(a.home)).toBe(task.id);
    expect(read(b.home)).toBe(other.id);
  });

  it("rewrites the config every turn, since its values can change between them", () => {
    const { project, task } = rows();
    const { home } = prepareTaskHome(project, task);
    const file = path.join(home, ".gemini", "config", "mcp_config.json");
    fs.writeFileSync(file, "{}");
    prepareTaskHome(project, task);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers).toBeDefined();
  });
});

describe("capabilities", () => {
  it("offers no reasoning picker, because the model slug already carries effort", () => {
    expect(geminiDriver.capabilities.reasoningOptions).toEqual([]);
    expect(geminiDriver.capabilities.models.every((m) => m.value.length > 0)).toBe(true);
  });

  it("does not offer the CLI's default permission mode, which cannot complete work", () => {
    const values = geminiDriver.capabilities.permissionModes.map((m) => m.value);
    expect(values).toContain("bypassPermissions");
    expect(values).not.toContain("default");
    expect(values).not.toContain("auto");
  });

  it("is honest that cost is estimated and MCP servers are not inherited", () => {
    expect(geminiDriver.capabilities.reportsCostUsd).toBe(false);
    expect(geminiDriver.capabilities.costIsEstimated).toBe(true);
    expect(geminiDriver.capabilities.inheritsUserMcpServers).toBe(false);
  });

  it("watches the worktree hooks file, which executes shell commands", () => {
    expect(geminiDriver.watchedSettingsFiles).toContain(".agents/hooks.json");
  });
});

// The LiteLLM gateway (docs/design/litellm.md, "Antigravity driver"): a
// gateway-kind turn carries GOOGLE_GEMINI_BASE_URL and GEMINI_API_KEY, and
// prepareTaskHome() writes {"modelProvider":"gemini"} into the CLI's own
// settings — the one thing that makes it read GEMINI_API_KEY at all. That
// file is shared process-wide (see lib/agents/gemini/home.ts and auth.ts's
// writeModelProviderSetting), so every case here redirects HOME to a throwaway
// directory rather than touching the real one running this suite.
describe("gateway routing", () => {
  const GW = "http://gw.example.com:4000";
  let realHome: string | undefined;
  let realUserProfile: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    realUserProfile = process.env.USERPROFILE;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-gemini-gw-"));
    process.env.HOME = tmpHome;
    // os.homedir() reads USERPROFILE on Windows, not HOME.
    process.env.USERPROFILE = tmpHome;
    process.env.CALANDRIA_LITELLM_BASE_URL = GW;
    process.env.CALANDRIA_LITELLM_KEY = "sk-litellm";
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    delete process.env.CALANDRIA_LITELLM_BASE_URL;
    delete process.env.CALANDRIA_LITELLM_KEY;
    setSetting("gemini_api_key", "");
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function gatewayRows(): { project: Project; task: Task } {
    const project = createProject({ name: `Gem-gw-${Math.random().toString(36).slice(2, 8)}`, repo_path: "/tmp" });
    const task = createTask({
      project_id: project.id,
      title: "T",
      description: "",
      agent: "gemini",
      agent_env: serializeAgentEnv(gatewayPresetEnv({ baseUrl: GW, billing: "key" })),
    });
    return { project, task };
  }

  it("carries the gateway address and the instance key into the spawned CLI's env", async () => {
    const { project, task } = gatewayRows();
    spawnMock.mockReturnValue(fakeChild({ stdout: fixtureText("mcp-tool-call.jsonl") }));

    await drain(geminiDriver.runTurn(task, project, "go"));

    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.env.GOOGLE_GEMINI_BASE_URL).toBe(GW);
    expect(opts.env.GEMINI_API_KEY).toBe("sk-litellm");
  });

  it("does not let a stored personal API key overwrite the gateway's", async () => {
    setSetting("gemini_api_key", "personal-key-should-not-win");
    const { project, task } = gatewayRows();
    spawnMock.mockReturnValue(fakeChild({ stdout: fixtureText("mcp-tool-call.jsonl") }));

    await drain(geminiDriver.runTurn(task, project, "go"));

    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.env.GEMINI_API_KEY).toBe("sk-litellm");
  });

  it("leaves GEMINI_API_KEY unset for a non-gateway turn with no personal key", async () => {
    const { project, task } = rows();
    spawnMock.mockReturnValue(fakeChild({ stdout: fixtureText("mcp-tool-call.jsonl") }));

    await drain(geminiDriver.runTurn(task, project, "go"));

    const [, , opts] = spawnMock.mock.calls[0];
    expect("GEMINI_API_KEY" in opts.env).toBe(false);
  });

  it("writes modelProvider: gemini into the CLI's settings for a gateway task", () => {
    const { project, task } = gatewayRows();
    prepareTaskHome(project, task);
    const file = path.join(tmpHome, ".gemini", "antigravity-cli", "settings.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ modelProvider: "gemini" });
  });

  it("does not write the settings file for a non-gateway task", () => {
    const { project, task } = rows();
    prepareTaskHome(project, task);
    const file = path.join(tmpHome, ".gemini", "antigravity-cli", "settings.json");
    expect(fs.existsSync(file)).toBe(false);
  });
});
