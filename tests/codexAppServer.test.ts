import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The Codex app-server transport end to end against a FAKE `codex` binary
// (tests/fixtures/codex/fake-app-server.mjs) that speaks the v2 JSON-RPC
// protocol: the handshake, thread start/resume, the turn, and — the point of
// the transport — the server's approval requests, answered through the same
// permission card, rules and /answer registry the Claude driver's gate uses.
// The real driver's runTurn() runs; only the binary is swapped.

vi.hoisted(() => {
  process.env.CODEX_TRANSPORT = "app-server";
  // No imports are live inside vi.hoisted; the fixture path is spelled out.
  process.env.CODEX_CLI_PATH = `${__dirname}/fixtures/codex/${process.platform === "win32" ? "fake-app-server.cmd" : "fake-app-server.mjs"}`;
  // Unattended grace short enough to test, long enough that an attended card
  // (a subscriber is registered below) never trips it.
  process.env.CALANDRIA_PERMISSION_UNATTENDED_MS = "400";
});

import { codexDriver } from "@/lib/agents/codex/driver";
import { createProject, createTask, updateProject, updateTask, getTask, listPermissionRules, listMessages } from "@/lib/store";
import { submitAnswer } from "@/lib/asks";
import { subscribeGlobal, subscribe } from "@/lib/events";
import { setRunContext, clearRunContext, SCHEDULED_RUN_CONTEXT } from "@/lib/runContext";
import { startResumeTurn } from "@/lib/runner";
import type { Project, Task, StreamEvent, TaskStreamEvent, ToolData } from "@/lib/types";

type Ev<T extends StreamEvent["type"]> = Extract<StreamEvent, { type: T }>;

const tmp: string[] = [];
let logFile = "";
let offWatcher: (() => void) | null = null;

beforeEach(() => {
  logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-fake-log-")), "log.jsonl");
  tmp.push(path.dirname(logFile));
  process.env.FAKE_CODEX_LOG = logFile;
  process.env.FAKE_CODEX_SCENARIO = "command";
  // A watching client, so the card waits for an answer instead of
  // auto-denying on the unattended grace.
  offWatcher = subscribeGlobal(() => {});
});
afterEach(() => {
  offWatcher?.();
  offWatcher = null;
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_SCENARIO;
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function worktree(): { repo: string; wt: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-as-"));
  tmp.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  const wt = path.join(root, "wt");
  git(["worktree", "add", "-q", wt, "-b", "task"]);
  return { repo, wt };
}

function fixture(permission: string, opts: { sessionId?: string | null } = {}): { project: Project; task: Task; repo: string; wt: string } {
  const { repo, wt } = worktree();
  // repo_path IS the linked worktree here, so the turn's cwd (which falls
  // back to repo_path when no task worktree was cut) is a worktree.
  const project = createProject({ name: "CodexAS", repo_path: wt });
  updateProject(project.id, { default_agent: "codex" });
  let task = createTask({ project_id: project.id, title: "T", description: "", permission_mode: permission });
  if (opts.sessionId) {
    updateTask(task.id, { session_id: opts.sessionId });
    task = getTask(task.id)!;
  }
  return { project, task, repo, wt };
}

type Log = { argv?: string[]; method?: string; params?: Record<string, unknown>; decision?: string; response?: unknown };
const readLog = (): Log[] =>
  fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Log)
    : [];
const logged = (method: string) => readLog().find((l) => l.method === method)?.params;
const decision = () => readLog().find((l) => l.decision !== undefined)?.decision;

/** Drive the driver directly, answering the first card with `answer`. */
async function turn(task: Task, project: Project, opts: { answer?: string[]; onEvent?: (ev: StreamEvent) => void; abort?: AbortController } = {}): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of codexDriver.runTurn(task, project, "go", opts.abort)) {
    out.push(ev);
    opts.onEvent?.(ev);
    if (ev.type === "permission" && opts.answer) {
      const id = ev.request.id;
      await vi.waitFor(() => expect(submitAnswer(task.id, id, [opts.answer!])).toBe(true));
    }
    if (ev.type === "ask" && opts.answer) {
      const id = ev.id;
      await vi.waitFor(() => expect(submitAnswer(task.id, id, [opts.answer!])).toBe(true));
    }
  }
  return out;
}

describe("codex app-server transport", () => {
  it("runs a turn: handshake, thread, config overrides, items, plan, usage, context", async () => {
    const { project, task, repo } = fixture("default");
    const evs = await turn(task, project, { answer: ["allow_once"] });

    // The thread id is the session id, and the turn ends with it.
    expect((evs.find((e) => e.type === "session") as Ev<"session">).sessionId).toBe("thread-fake-1");
    expect((evs.at(-1) as Ev<"done">).sessionId).toBe("thread-fake-1");
    expect(evs.some((e) => e.type === "error")).toBe(false);

    // The Calandria bridge and the config overrides travel as `-c` flags on
    // the app-server command line, exactly as the SDK flattened them.
    const argv = readLog()[0].argv!;
    expect(argv[0]).toBe("app-server");
    expect(argv.some((a) => a.startsWith("mcp_servers.calandria.command="))).toBe(true);
    expect(argv.some((a) => a === 'mcp_servers.calandria.default_tools_approval_mode="approve"')).toBe(true);
    expect(argv.some((a) => a.includes(`CALANDRIA_TASK_ID="${task.id}"`))).toBe(true);

    // The thread was started with the mode's policy, and the turn with the
    // FULL sandbox policy, writable roots included (thread/start can't carry
    // them — verified against 0.153.0).
    expect(logged("thread/start")).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user" });
    const start = logged("turn/start") as { sandboxPolicy: { type: string; writableRoots: string[]; networkAccess: boolean }; input: { type: string; text: string }[] };
    expect(start.sandboxPolicy.type).toBe("workspaceWrite");
    expect(start.sandboxPolicy.networkAccess).toBe(true);
    expect(start.sandboxPolicy.writableRoots).toContain(path.join(repo, ".git", "objects"));
    expect(start.sandboxPolicy.writableRoots).toContain(path.join(repo, ".git", "worktrees", "wt"));
    expect(start.sandboxPolicy.writableRoots).not.toContain(path.join(repo, ".git"));
    // A fresh thread's opening message carries the project context.
    expect(start.input[0].text).toContain("go");
    expect(start.input[0].text.length).toBeGreaterThan("go".length);

    // Items map through the same normalizer the exec transport uses.
    const tools = evs.filter((e) => e.type === "tool") as Ev<"tool">[];
    expect(tools.find((t) => t.id === "item-cmd")?.title).toContain("npm test");
    const result = evs.find((e) => e.type === "tool_result" && e.id === "item-cmd") as Ev<"tool_result">;
    expect(result.isError).toBe(false);
    expect(result.content).toContain('decision="accept"');
    expect((evs.find((e) => e.type === "assistant") as Ev<"assistant">).content).toBe("all done");
    expect(tools.find((t) => t.peek?.kind === "todos")?.peek).toMatchObject({ kind: "todos", items: [{ text: "run tests", status: "completed" }, { text: "report", status: "pending" }] });

    // Usage is the thread total netted into disjoint buckets; the context
    // gauge reads the last request's prompt size.
    const usage = (evs.find((e) => e.type === "usage") as Ev<"usage">).usage;
    expect(usage.input_tokens).toBe(800);
    expect(usage.cache_read_tokens).toBe(200);
    expect(usage.output_tokens).toBe(60);
    expect((evs.find((e) => e.type === "context") as Ev<"context">).tokens).toBe(1000);
    // The CLI's config warning surfaces once as a notice.
    expect(evs.filter((e) => e.type === "notice" && e.content.includes("fake warning"))).toHaveLength(1);
  });

  it("parks a command approval on a permission card and answers accept / acceptForSession / decline", async () => {
    const { project, task } = fixture("default");
    const evs = await turn(task, project, { answer: ["allow_once"] });
    const card = evs.find((e) => e.type === "permission") as Ev<"permission">;
    expect(card.request.id).toBe("perm:item-cmd");
    expect(card.request.tool).toBe("Bash");
    expect(card.request.detail).toBe("npm test");
    expect(card.request.description).toBe("the sandbox refused to run it");
    expect(card.request.scope).toMatchObject({ scope: "project", match_kind: "bash_prefix" });
    expect((evs.find((e) => e.type === "permission_decided") as Ev<"permission_decided">).outcome.decision).toBe("allow_once");
    expect(decision()).toBe('"accept"');
    expect(listPermissionRules(project.id)).toHaveLength(0);

    // Always: the CLI is told to stop asking for the session AND the project
    // remembers the prefix, so the next turn never raises a card at all.
    fs.writeFileSync(logFile, "");
    const always = await turn(task, project, { answer: ["allow_always"] });
    expect(decision()).toBe('"acceptForSession"');
    expect((always.find((e) => e.type === "permission_decided") as Ev<"permission_decided">).outcome.remembered).toBeTruthy();
    expect(listPermissionRules(project.id).map((r) => [r.match_kind, r.value])).toEqual([["bash_prefix", "npm test"]]);

    fs.writeFileSync(logFile, "");
    const remembered = await turn(task, project, {});
    expect(remembered.some((e) => e.type === "permission")).toBe(false);
    expect(decision()).toBe('"accept"');

    // Deny: the CLI declines, and the item comes back failed.
    const { project: p2, task: t2 } = fixture("default");
    fs.writeFileSync(logFile, "");
    const denied = await turn(t2, p2, { answer: ["deny", "not now"] });
    expect(decision()).toBe('"decline"');
    expect((denied.find((e) => e.type === "permission_decided") as Ev<"permission_decided">).outcome).toMatchObject({ decision: "deny", note: "not now" });
    expect((denied.find((e) => e.type === "tool_result" && e.id === "item-cmd") as Ev<"tool_result">).isError).toBe(true);
  });

  it("declines at once on a run declared unattended, and on the unattended grace with nobody watching", async () => {
    const { project, task } = fixture("default");
    setRunContext(task.id, SCHEDULED_RUN_CONTEXT);
    try {
      const evs = await turn(task, project, {});
      expect((evs.find((e) => e.type === "permission_decided") as Ev<"permission_decided">).outcome).toMatchObject({ decision: "deny", auto: true, reason: "unattended" });
      expect(decision()).toBe('"decline"');
    } finally {
      clearRunContext(task.id);
    }

    offWatcher?.();
    offWatcher = null;
    const { project: p2, task: t2 } = fixture("default");
    fs.writeFileSync(logFile, "");
    const evs = await turn(t2, p2, {});
    expect((evs.find((e) => e.type === "permission_decided") as Ev<"permission_decided">).outcome.reason).toBe("unattended");
    expect(decision()).toBe('"decline"');
  });

  it("sends each mode's own policy: auto-review, full access, read-only", async () => {
    const { project, task } = fixture("auto");
    await turn(task, project, { answer: ["allow_once"] });
    expect(logged("thread/start")).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
    expect(logged("turn/start")).toMatchObject({ approvalsReviewer: "auto_review", sandboxPolicy: { type: "workspaceWrite" } });

    fs.writeFileSync(logFile, "");
    const b = fixture("bypassPermissions");
    await turn(b.task, b.project, { answer: ["allow_once"] });
    expect(logged("thread/start")).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(logged("turn/start")).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });

    fs.writeFileSync(logFile, "");
    const p = fixture("plan");
    await turn(p.task, p.project, { answer: ["allow_once"] });
    expect(logged("turn/start")).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
  });

  it("renders a file-change approval with its diff and the escape it asks for", async () => {
    process.env.FAKE_CODEX_SCENARIO = "fileChange";
    const { project, task } = fixture("default");
    const evs = await turn(task, project, { answer: ["allow_once"] });
    const card = evs.find((e) => e.type === "permission") as Ev<"permission">;
    expect(card.request.id).toBe("perm:item-patch");
    expect(card.request.title).toBe("Edit a.ts");
    expect(card.request.description).toContain("/outside");
    expect(card.request.diff).toEqual([
      { sign: " ", text: "@@ -1 +1 @@" },
      { sign: "-", text: "old" },
      { sign: "+", text: "new" },
    ]);
    expect(decision()).toBe('"accept"');
    expect(evs.some((e) => e.type === "tool" && e.id === "item-patch" && e.title.includes("a.ts"))).toBe(true);
  });

  it("answers Codex's native question tool through the ask card", async () => {
    process.env.FAKE_CODEX_SCENARIO = "ask";
    const { project, task } = fixture("default");
    const evs = await turn(task, project, { answer: ["blue"] });
    const ask = evs.find((e) => e.type === "ask") as Ev<"ask">;
    expect(ask.id).toBe("ask:item-q");
    expect(ask.questions[0]).toMatchObject({ question: "Which colour?", header: "Colour", options: [{ label: "red" }, { label: "blue" }] });
    expect((evs.find((e) => e.type === "ask_answered") as Ev<"ask_answered">).answers).toEqual([["blue"]]);
    expect(decision()).toBe(JSON.stringify({ answers: { q1: { answers: ["blue"] } } }));
  });

  it("interrupts the turn on Stop and ends cleanly", async () => {
    process.env.FAKE_CODEX_SCENARIO = "interrupt";
    const { project, task } = fixture("acceptEdits");
    const abort = new AbortController();
    const evs = await turn(task, project, {
      abort,
      onEvent: (ev) => {
        if (ev.type === "tool" && ev.id === "item-slow") abort.abort();
      },
    });
    expect(readLog().some((l) => l.method === "turn/interrupt")).toBe(true);
    expect(evs.some((e) => e.type === "error")).toBe(false);
    expect(evs.at(-1)?.type).toBe("done");
  });

  it("falls back to a fresh thread when the CLI can't resume the old one", async () => {
    process.env.FAKE_CODEX_SCENARIO = "resumeFails";
    const { project, task } = fixture("acceptEdits", { sessionId: "gone-thread" });
    const evs = await turn(task, project, { answer: ["allow_once"] });
    expect(logged("thread/resume")).toMatchObject({ threadId: "gone-thread" });
    expect(evs.some((e) => e.type === "notice" && e.content.includes("could not resume"))).toBe(true);
    expect((evs.find((e) => e.type === "session") as Ev<"session">).sessionId).toBe("thread-fake-1");
    // A fresh thread is seeded with the project context again.
    expect((logged("turn/start") as { input: { text: string }[] }).input[0].text.length).toBeGreaterThan("go".length);
  });

  it("resumes the task's thread on a later turn without re-seeding context", async () => {
    const { project, task } = fixture("acceptEdits", { sessionId: "thread-fake-1" });
    await turn(task, project, { answer: ["allow_once"] });
    expect(logged("thread/resume")).toMatchObject({ threadId: "thread-fake-1", sandbox: "workspace-write" });
    expect(logged("thread/start")).toBeUndefined();
    expect((logged("turn/start") as { input: { text: string }[] }).input[0].text).toBe("go");
  });

  it("reports a process that dies mid-turn as an error, not a silent end", async () => {
    process.env.FAKE_CODEX_SCENARIO = "dies";
    const { project, task } = fixture("acceptEdits");
    const evs = await turn(task, project, {});
    const err = evs.find((e) => e.type === "error") as Ev<"error">;
    expect(err?.content).toContain("simulated crash");
    expect(evs.at(-1)?.type).toBe("done");
  });

  it("through the runner: the card is persisted and flags the task until answered", async () => {
    const { project, task } = fixture("default");
    const events: TaskStreamEvent[] = [];
    let off = () => {};
    // startResumeTurn launches a DETACHED turn and returns; the turn's end is
    // the turn_end event, not the promise.
    const ended = new Promise<void>((resolve) => {
      off = subscribe(task.id, (ev) => {
        events.push(ev);
        if (ev.type === "turn_end") resolve();
      });
    });
    await startResumeTurn(task, project, "go");
    await vi.waitFor(() => expect(getTask(task.id)?.awaiting_input).toBe(1), { timeout: 10_000 });
    const parked = listMessages(task.id)
      .filter((m) => m.role === "tool")
      .map((m) => JSON.parse(m.content) as ToolData)
      .find((d) => d.permission);
    expect(parked?.permission?.request.id).toBe("perm:item-cmd");
    expect(parked?.permission?.outcome).toBeUndefined();
    expect(submitAnswer(task.id, "perm:item-cmd", [["allow_once"]])).toBe(true);
    await ended;
    off();
    // The card settled on its row (a finished turn re-flags the task as
    // needing you, so awaiting_input is not the thing to read here).
    const settled = listMessages(task.id)
      .filter((m) => m.role === "tool")
      .map((m) => JSON.parse(m.content) as ToolData)
      .find((d) => d.permission);
    expect(settled?.permission?.outcome?.decision).toBe("allow_once");
    expect(getTask(task.id)?.session_id).toBe("thread-fake-1");
    expect(events.some((e) => e.type === "permission_decided")).toBe(true);
    expect(decision()).toBe('"accept"');
  });
});
