import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One policy, two drivers. The Claude gate (canUseTool) and the Codex
// app-server's approval handler both call promptPermission()
// (lib/permissionPrompt.ts), so the same command in the same project has to be
// decided the same way: silently by a remembered rule, on the same card, with
// the same rule minted by "always allow", and auto-denied the same way when
// nobody is there to answer. Before that convergence the two carried separate
// copies of the decision half, which is what this file exists to stop.
//
// Both REAL drivers run; only the transports are faked. The Claude Agent SDK is
// mocked, and `codex` is tests/fixtures/codex/fake-app-server.mjs, whose
// `command` scenario asks to run `npm test` — the same command handed to the
// Claude gate below.

const { queryMock } = vi.hoisted(() => {
  process.env.CODEX_TRANSPORT = "app-server";
  // No imports are live inside vi.hoisted; the fixture path is spelled out.
  const sep = process.platform === "win32" ? "\\" : "/";
  process.env.CODEX_CLI_PATH = [__dirname, "fixtures", "codex", process.platform === "win32" ? "fake-app-server.cmd" : "fake-app-server.mjs"].join(sep);
  // Short enough to test the unattended grace, long enough that an attended
  // card (a subscriber is registered below) never trips it.
  process.env.CALANDRIA_PERMISSION_UNATTENDED_MS = "400";
  return { queryMock: vi.fn() };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => cfg,
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { claudeDriver } from "@/lib/agents/claude/driver";
import { codexDriver } from "@/lib/agents/codex/driver";
import { createProject, createTask, getTask, updateProject, listPermissionRules, addPermissionRule } from "@/lib/store";
import { submitAnswer } from "@/lib/asks";
import { subscribeGlobal } from "@/lib/events";
import { setRunContext, clearRunContext, SCHEDULED_RUN_CONTEXT } from "@/lib/runContext";
import type { Project, StreamEvent, Task } from "@/lib/types";

type Ev<T extends StreamEvent["type"]> = Extract<StreamEvent, { type: T }>;

/** What the fake app-server asks to run, and what the Claude gate is given. */
const COMMAND = "npm test";

const tmp: string[] = [];
let logFile = "";
let offWatcher: (() => void) | null = null;

beforeEach(() => {
  queryMock.mockReset();
  logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "perm-parity-log-")), "log.jsonl");
  tmp.push(path.dirname(logFile));
  process.env.FAKE_CODEX_LOG = logFile;
  process.env.FAKE_CODEX_SCENARIO = "command";
  // A watching client, so a card waits for an answer instead of auto-denying
  // on the unattended grace.
  offWatcher = subscribeGlobal(() => {});
});

afterEach(() => {
  offWatcher?.();
  offWatcher = null;
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_SCENARIO;
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});

/** One project with a real worktree, and a task per driver inside it. */
function fixture(): { project: Project; codex: Task; claude: Task } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "perm-parity-")));
  tmp.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  const wt = path.join(root, "wt");
  git(["worktree", "add", "-q", wt, "-b", "task"]);
  const project = createProject({ name: `Parity ${Math.random().toString(36).slice(2)}`, repo_path: wt });
  updateProject(project.id, { default_agent: "codex" });
  const codex = createTask({ project_id: project.id, title: "codex", description: "", permission_mode: "default" });
  const claude = createTask({ project_id: project.id, title: "claude", description: "", permission_mode: "default" });
  return { project, codex: getTask(codex.id)!, claude: getTask(claude.id)! };
}

type Log = { decision?: string };
/** The answer the fake app-server was given, as it recorded it. */
const codexAnswer = (): string | undefined =>
  (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Log) : [])
    .find((l) => l.decision !== undefined)?.decision;

async function codexTurn(task: Task, project: Project, answer?: string[]): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of codexDriver.runTurn(task, project, "go")) {
    out.push(ev);
    if (ev.type === "permission" && answer) {
      const id = ev.request.id;
      await vi.waitFor(() => expect(submitAnswer(task.id, id, [answer])).toBe(true));
    }
  }
  return out;
}

/**
 * The Claude half. The fake SDK hands back the real canUseTool the driver
 * built, and the card's id is derived from the toolUseID we pass, so the
 * answer can be submitted without watching the stream.
 */
async function claudeTurn(
  task: Task,
  project: Project,
  answer?: string[]
): Promise<{ result?: Awaited<ReturnType<CanUseTool>>; events: StreamEvent[] }> {
  let result: Awaited<ReturnType<CanUseTool>> | undefined;
  queryMock.mockImplementation((args: { options: Record<string, unknown> }) => ({
    async *[Symbol.asyncIterator]() {
      const call = (args.options.canUseTool as CanUseTool)("Bash", { command: COMMAND }, {
        signal: new AbortController().signal,
        suggestions: [],
        toolUseID: "tu_parity",
      } as unknown as Parameters<CanUseTool>[2]);
      if (answer) await vi.waitFor(() => expect(submitAnswer(task.id, "perm:tu_parity", [answer])).toBe(true));
      result = await call;
    },
  }));
  const events: StreamEvent[] = [];
  for await (const ev of claudeDriver.runTurn(task, project, "go")) events.push(ev);
  return { result, events };
}

const card = (events: StreamEvent[]) => (events.find((e) => e.type === "permission") as Ev<"permission"> | undefined)?.request;
const outcome = (events: StreamEvent[]) => (events.find((e) => e.type === "permission_decided") as Ev<"permission_decided"> | undefined)?.outcome;
const rules = (projectId: string) => listPermissionRules(projectId).map((r) => [r.tool, r.match_kind, r.value]);

describe("the two drivers decide the same call the same way", () => {
  it("honors one remembered rule for both, with no card either side", async () => {
    const { project, codex, claude } = fixture();
    addPermissionRule({ project_id: project.id, tool: "Bash", match_kind: "bash_prefix", value: "npm test" });

    const codexEvents = await codexTurn(codex, project);
    const { result, events } = await claudeTurn(claude, project);

    expect(card(codexEvents)).toBeUndefined();
    expect(card(events)).toBeUndefined();
    expect(codexAnswer()).toBe('"accept"');
    expect(result).toMatchObject({ behavior: "allow" });
  });

  it("raises the same card, and 'always allow' mints the identical rule", async () => {
    const a = fixture();
    const b = fixture();

    const codexEvents = await codexTurn(a.codex, a.project, ["allow_always"]);
    const { result, events } = await claudeTurn(b.claude, b.project, ["allow_always"]);

    const fromCodex = card(codexEvents)!;
    const fromClaude = card(events)!;
    // Description is caller-supplied (the CLI's own reason) and deliberately
    // differs; everything the gate itself derives must not.
    expect(fromClaude.tool).toBe(fromCodex.tool);
    expect(fromClaude.title).toBe(fromCodex.title);
    expect(fromClaude.detail).toBe(fromCodex.detail);
    expect(fromClaude.detail).toBe(COMMAND);
    expect(fromClaude.scope).toEqual(fromCodex.scope);

    expect(result).toMatchObject({ behavior: "allow" });
    expect(codexAnswer()).toBe('"acceptForSession"');
    expect(rules(a.project.id)).toEqual([["Bash", "bash_prefix", "npm test"]]);
    expect(rules(b.project.id)).toEqual(rules(a.project.id));
  });

  it("declines the same way, with the user's note on both transcripts and no rule minted", async () => {
    const a = fixture();
    const b = fixture();

    const codexEvents = await codexTurn(a.codex, a.project, ["deny", "not now"]);
    const { result, events } = await claudeTurn(b.claude, b.project, ["deny", "not now"]);

    expect(codexAnswer()).toBe('"decline"');
    expect(result).toMatchObject({ behavior: "deny" });
    expect(outcome(events)).toMatchObject({ decision: "deny", note: "not now" });
    expect(outcome(events)).toEqual(outcome(codexEvents));
    expect(rules(a.project.id)).toEqual([]);
    expect(rules(b.project.id)).toEqual([]);
  });

  it("auto-denies both when the run is declared unattended", async () => {
    const { project, codex, claude } = fixture();
    setRunContext(codex.id, SCHEDULED_RUN_CONTEXT);
    setRunContext(claude.id, SCHEDULED_RUN_CONTEXT);
    try {
      const codexEvents = await codexTurn(codex, project);
      const { result, events } = await claudeTurn(claude, project);

      expect(outcome(codexEvents)).toMatchObject({ decision: "deny", auto: true, reason: "unattended" });
      expect(outcome(events)).toEqual(outcome(codexEvents));
      expect(result).toMatchObject({ behavior: "deny" });
      expect(codexAnswer()).toBe('"decline"');
    } finally {
      clearRunContext(codex.id);
      clearRunContext(claude.id);
    }
  });
});
