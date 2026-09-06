import { describe, it, expect, beforeAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A LIVE Codex turn over the app-server transport, against the real `codex`
// on PATH and the machine's real ChatGPT login. Off by default because it
// spends the user's plan: CALANDRIA_LIVE_CODEX=1 npx vitest run tests/codexLive.test.ts
//
// What it proves that the fake can't: the CLI accepts the thread and turn
// parameters this driver sends (sandbox policy with writable roots, approval
// policy, approvals reviewer), streams a real turn through the adapter, and
// under `default` raises an approval the card can answer. The prompt asks
// for one shell command that the workspace-write sandbox refuses, so the
// model has to request an escalation.

const LIVE = process.env.CALANDRIA_LIVE_CODEX === "1";

vi.hoisted(() => {
  process.env.CODEX_TRANSPORT = "app-server";
  // The real ~/.codex, not the suite's scratch one: the login lives there.
  delete process.env.CODEX_HOME;
});

import { codexDriver } from "@/lib/agents/codex/driver";
import { createProject, createTask, updateProject } from "@/lib/store";
import { submitAnswer } from "@/lib/asks";
import { subscribeGlobal } from "@/lib/events";
import type { StreamEvent } from "@/lib/types";

describe.skipIf(!LIVE)("codex live turn (app-server)", () => {
  let wt = "";
  beforeAll(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-live-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git(["init", "-q", "-b", "main"]);
    git(["commit", "-q", "--allow-empty", "-m", "init"]);
    wt = path.join(root, "wt");
    git(["worktree", "add", "-q", wt, "-b", "task"]);
    subscribeGlobal(() => {});
  });

  it("runs a full-access turn end to end", async () => {
    const project = createProject({ name: "Live", repo_path: wt });
    updateProject(project.id, { default_agent: "codex" });
    const task = createTask({ project_id: project.id, title: "live", description: "", permission_mode: "bypassPermissions" });
    const evs: StreamEvent[] = [];
    for await (const ev of codexDriver.runTurn(task, project, "Reply with exactly the word ok. Do not run any commands.")) evs.push(ev);
    console.log(JSON.stringify(evs.map((e) => (e.type === "assistant" ? { assistant: e.content } : e.type === "error" ? e : e.type)), null, 0));
    expect(evs.some((e) => e.type === "error")).toBe(false);
    expect(evs.some((e) => e.type === "session")).toBe(true);
    expect(evs.some((e) => e.type === "assistant")).toBe(true);
    expect(evs.some((e) => e.type === "usage")).toBe(true);
  }, 180_000);

  it("raises an approval under `default` that the card answers", async () => {
    const project = createProject({ name: "LiveAsk", repo_path: wt });
    updateProject(project.id, { default_agent: "codex" });
    const task = createTask({ project_id: project.id, title: "live-ask", description: "", permission_mode: "default" });
    const evs: StreamEvent[] = [];
    const prompt =
      "Run this exact shell command and report its output: `cat /etc/hostname`. If the sandbox blocks it, " +
      "request approval to run it outside the sandbox rather than working around it. Then reply with the word done.";
    for await (const ev of codexDriver.runTurn(task, project, prompt)) {
      evs.push(ev);
      if (ev.type === "permission") {
        const id = ev.request.id;
        console.log("card:", JSON.stringify(ev.request));
        await vi.waitFor(() => expect(submitAnswer(task.id, id, [["allow_once"]])).toBe(true));
      }
    }
    console.log(JSON.stringify(evs.map((e) => (e.type === "assistant" ? { assistant: e.content } : e.type === "error" || e.type === "notice" ? e : e.type === "permission_decided" ? e : e.type)), null, 0));
    expect(evs.some((e) => e.type === "error")).toBe(false);
    expect(evs.some((e) => e.type === "permission")).toBe(true);
    expect(evs.some((e) => e.type === "permission_decided" && e.outcome.decision === "allow_once")).toBe(true);
  }, 300_000);

  it("under `auto`, Codex's own reviewer decides the escalation and nothing parks on you", async () => {
    const project = createProject({ name: "LiveAuto", repo_path: wt });
    updateProject(project.id, { default_agent: "codex" });
    const task = createTask({ project_id: project.id, title: "live-auto", description: "", permission_mode: "auto" });
    const evs: StreamEvent[] = [];
    const prompt =
      "Run this exact shell command and report its output: `cat /etc/hostname`. If the sandbox blocks it, " +
      "request approval to run it outside the sandbox rather than working around it. Then reply with the word done.";
    for await (const ev of codexDriver.runTurn(task, project, prompt)) evs.push(ev);
    console.log(JSON.stringify(evs.map((e) => (e.type === "assistant" ? { assistant: e.content } : e.type === "error" || e.type === "notice" ? e : e.type === "tool" ? { tool: e.title } : e.type === "tool_result" ? { result: e.content.slice(0, 200), isError: e.isError } : e.type)), null, 0));
    expect(evs.some((e) => e.type === "error")).toBe(false);
    expect(evs.some((e) => e.type === "permission")).toBe(false);
    expect(evs.some((e) => e.type === "assistant")).toBe(true);
  }, 300_000);
});
