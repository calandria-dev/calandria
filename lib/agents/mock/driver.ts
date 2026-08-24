// The e2e mock driver — a deterministic AgentDriver used only by the Playwright
// suite (registered when ORCH_E2E_MOCK_AGENT=1, see registry.ts). It exercises
// the full turn contract (session/model/tool/assistant/usage/done, plus error,
// suggested, and abort-aware sleeps) without any real agent CLI or login, so
// e2e runs need no Claude/Codex credentials and produce the same transcript
// every time.
//
// Turn behavior is scripted by directives embedded in user text or, for a
// fresh session, in the task metadata supplied through the real drivers'
// project context:
//   e2e:write=<relpath>:<content>   write a file into the task's worktree
//   e2e:sleep=<ms>                  hold the turn open (Stop / queue tests)
//   e2e:fail=<message>              end the turn with an error event
//   e2e:suggest=<title>             create a suggested task + emit "suggested"
//   e2e:suggest-into=<proj>|<title> …but file it into ANOTHER project (by id or
//                                   name), through the same strict resolution the
//                                   real suggest_task tool uses
//   e2e:retitle=<title>             rename the RUNNING task through the same
//                                   shared logic the real update_task tool calls
//   e2e:permission=<command>        raise a Bash permission card and park on it
//   e2e:blocked=<command>           a Bash call the CLI refused on its own — an
//                                   already-decided card, no buttons, nothing parked
// With no directives, the turn appends the prompt to AGENT_NOTES.md — so every
// plain turn still produces a diff to view and merge.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Project, Task } from "@/lib/types";
import type {
  AgentAuthStatus,
  AgentDriver,
  AgentLoginSession,
  AgentVerifyResult,
  StreamEvent,
} from "../types";
import { createSuggestedTask, resolveTargetProject, updateTaskForAgent } from "@/lib/agentTools";
import { listPermissionRules, addPermissionRule } from "@/lib/store";
import {
  allowedByRules,
  describePermission,
  parseDecision,
  promptDeadline,
  scopeOfferFor,
  waitForPermission,
  blockedReason,
  DENIED_BY_USER,
} from "@/lib/permissions";
import { PERMISSION_PROMPT_TIMEOUT_MS, PERMISSION_UNATTENDED_MS } from "@/lib/config";
import { MOCK_CAPABILITIES } from "./capabilities";

const MOCK_EMAIL = "e2e@example.com";
const MOCK_PLAN = "Mock";

function loginSuccess(): AgentLoginSession {
  return { status: "success", url: null, email: MOCK_EMAIL, plan: MOCK_PLAN, error: null, log: "mock login ok\n" };
}

/** Abort-aware sleep: resolves early (and quietly) when the turn is stopped. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Resolve a directive's relative path inside the cwd, refusing escapes. */
function safeJoin(cwd: string, rel: string): string | null {
  const abs = path.resolve(cwd, rel);
  return abs === cwd || abs.startsWith(cwd + path.sep) ? abs : null;
}

let currentLogin: AgentLoginSession | null = null;

// A fixed command set standing in for what a real CLI would report, so the
// composer's "/" menu has something deterministic to render. Deliberately
// covers the shapes the menu has to handle: a plain command, one that takes
// arguments, a namespaced plugin command with an alias, and two entries the
// server is expected to filter out (the agent's own /clear, which Calandria
// overrides, and an internal sentinel).
const MOCK_COMMANDS = [
  { name: "mock-echo", description: "echo the arguments back", argumentHint: "<text>" },
  { name: "mock-status", description: "report mock agent status" },
  { name: "mock-plugin:mock-deploy", description: "deploy from the mock plugin", aliases: ["mock-deploy"] },
  { name: "clear", description: "the agent's own clear — Calandria's must win" },
  { name: "__mock-internal", description: "internal, never offered" },
];

export const mockDriver: AgentDriver = {
  id: "mock",
  label: "Mock Agent",
  capabilities: MOCK_CAPABILITIES,

  async listCommands() {
    return MOCK_COMMANDS;
  },

  async *runTurn(task: Task, project: Project, userText: string, abort?: AbortController): AsyncGenerator<StreamEvent> {
    const signal = abort?.signal;
    const cwd = task.worktree_path || project.repo_path;
    const sessionId = task.session_id || `mock-${task.id}-g${task.generation}`;
    const instructionText = task.session_id
      ? userText
      : [task.title, task.description, userText].filter(Boolean).join("\n");

    yield { type: "session", sessionId };
    yield { type: "model", model: "mock-1" };

    const sleepMs = instructionText.match(/e2e:sleep=(\d+)/)?.[1];
    if (sleepMs) await sleep(Math.min(Number(sleepMs), 120_000), signal);
    if (signal?.aborted) return; // a Stop ends the stream without an error event

    const fail = instructionText.match(/e2e:fail=([^\n]+)/)?.[1];
    if (fail) {
      yield { type: "error", content: fail.trim() };
      return;
    }

    // A tool-permission prompt. Deliberately runs the REAL gate helpers
    // (lib/permissions.ts) rather than a hand-rolled stand-in, so the e2e suite
    // covers the same rule lookup, card shape, parking, and rule storage the
    // Claude driver's canUseTool goes through — everything except the SDK.
    const gated = instructionText.match(/e2e:permission=([^\n]+)/)?.[1]?.trim();
    if (gated) {
      const input = { command: gated };
      if (allowedByRules(listPermissionRules(project.id), "Bash", input)) {
        yield { type: "notice", content: `Permission for \`${gated}\` was already remembered.` };
      } else {
        const described = describePermission("Bash", input);
        const scope = scopeOfferFor("Bash", input) ?? undefined;
        const id = `perm:mock-${task.id}-g${task.generation}`;
        yield {
          type: "permission",
          request: {
            id, tool: "Bash", title: described.title, detail: described.detail, scope,
            expiresAt: promptDeadline(PERMISSION_PROMPT_TIMEOUT_MS, PERMISSION_UNATTENDED_MS, task.id),
          },
        };
        const waited = await waitForPermission({
          taskId: task.id, id, signal,
          attendedMs: PERMISSION_PROMPT_TIMEOUT_MS,
          unattendedMs: PERMISSION_UNATTENDED_MS,
        });
        if ("answers" in waited) {
          const { decision, note } = parseDecision(waited.answers);
          let remembered: string | undefined;
          if (decision === "allow_always" && scope?.scope === "project" && scope.match_kind) {
            addPermissionRule({ project_id: project.id, tool: "Bash", match_kind: scope.match_kind, value: scope.value });
            remembered = scope.label;
          }
          yield { type: "permission_decided", id, outcome: { decision, remembered, note: note || undefined } };
          if (decision === "deny") {
            yield { type: "assistant", content: `Skipped \`${gated}\` — ${note || DENIED_BY_USER}` };
            yield { type: "done", sessionId };
            return;
          }
        } else {
          const reason = "expired" in waited ? waited.expired : "interrupted";
          yield { type: "permission_decided", id, outcome: { decision: "deny", auto: true, reason } };
          yield { type: "done", sessionId };
          return;
        }
      }
    }

    // A call the CLI refused BY ITSELF, with no card — the "auto" classifier or
    // a deny rule in the Claude driver, and nothing to answer here either. The
    // sequence mirrors the real one exactly: the tool call, then the refusal
    // against its tool_use id, then the is_error tool_result the CLI feeds the
    // model. The reason text goes through the same blockedReason() the driver
    // uses, boilerplate tail and all, so the e2e covers what the user actually
    // reads rather than a cleaned-up version of it.
    const blocked = instructionText.match(/e2e:blocked=([^\n]+)/)?.[1]?.trim();
    if (blocked) {
      const id = `mock-blocked-${task.id}-g${task.generation}`;
      const described = describePermission("Bash", { command: blocked });
      const message =
        `Permission to use Bash with command ${blocked} has been denied. ` +
        `IMPORTANT: You *may* attempt to accomplish this action using other tools.`;
      yield { type: "tool", id, title: described.title, detail: described.detail };
      yield { type: "permission_denied", id, tool: "Bash", reasonType: "classifier", reason: blockedReason(undefined, message) };
      yield { type: "tool_result", id, content: message, isError: true };
      yield { type: "assistant", content: `Skipped \`${blocked}\` — Claude Code refused it.` };
      yield { type: "done", sessionId };
      return;
    }

    // File writes: every explicit e2e:write, else the default notes append.
    const writes: { rel: string; content: string }[] = [];
    for (const m of instructionText.matchAll(/e2e:write=([^\s:]+):([^\n]+)/g)) {
      writes.push({ rel: m[1], content: m[2].trim() + "\n" });
    }
    if (writes.length === 0) {
      writes.push({ rel: "AGENT_NOTES.md", content: `- ${userText.split("\n")[0].slice(0, 200)}\n` });
    }
    let toolN = 0;
    for (const w of writes) {
      const abs = safeJoin(cwd, w.rel);
      const id = `mock-tool-${++toolN}`;
      // The same shape the Claude driver's describeToolUse() yields for a
      // Write — absolute path in `detail` and `file` — so the runner's
      // worktree-relative resolution and the transcript's Collaborate button
      // are exercised on the real contract, not a mock-only one.
      yield {
        type: "tool", id,
        title: `✎ Write ${path.basename(w.rel)}`,
        detail: abs ?? w.rel,
        file: abs ?? w.rel,
        peek: { kind: "count", text: "1 file" },
      };
      if (!abs) {
        yield { type: "tool_result", id, content: `refused path outside worktree: ${w.rel}`, isError: true };
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (w.rel === "AGENT_NOTES.md") fs.appendFileSync(abs, w.content);
      else fs.writeFileSync(abs, w.content);
      yield { type: "tool_result", id, content: `wrote ${w.rel}`, isError: false };
    }

    // Commit the work like a real coding agent would — an uncommitted-only
    // worktree has zero commits ahead of base, which the diff route reads as
    // "already merged". Best-effort: a non-git cwd just skips it.
    try {
      execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", `mock: ${task.title}`], { cwd, stdio: "ignore" });
    } catch {
      // not a repo / nothing to commit — fine
    }

    for (const m of instructionText.matchAll(/e2e:suggest=([^\n]+)/g)) {
      const title = m[1].trim();
      createSuggestedTask(project, { title, description: "Suggested by the mock agent (e2e)." });
      yield { type: "suggested", title, projectId: project.id };
    }

    // Cross-project filing, through the SAME resolver the real tool calls — a
    // bad project ref surfaces as an error event, exactly as the tool refuses it.
    for (const m of instructionText.matchAll(/e2e:suggest-into=([^|\n]+)\|([^\n]+)/g)) {
      const [ref, title] = [m[1].trim(), m[2].trim()];
      const target = resolveTargetProject(project, ref);
      if ("error" in target) {
        yield { type: "error", content: target.error };
        continue;
      }
      createSuggestedTask(target.project, { title, description: "Suggested by the mock agent (e2e)." });
      yield { type: "suggested", title, projectId: target.project.id };
    }

    // A turn editing its OWN row — update_task's default target. Nothing is
    // yielded onto the task's stream: the write publishes "task_edited"
    // globally from updateTaskForAgent, and that's precisely what the e2e
    // asserts, so a stream event here would mask a broken global path.
    const retitle = instructionText.match(/e2e:retitle=([^\n]+)/)?.[1];
    if (retitle) updateTaskForAgent(task, undefined, { title: retitle.trim() });

    yield {
      type: "assistant",
      content: `Mock turn complete. Wrote ${writes.map((w) => `\`${w.rel}\``).join(", ")} in \`${path.basename(cwd)}\`.`,
    };
    yield { type: "usage", usage: { cost_usd: 0, input_tokens: 120, output_tokens: 40, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    yield { type: "done", sessionId };
  },

  // One-shot helpers return canned text so /clear, recap, and "Refresh with AI"
  // are exercisable without a real agent.
  async summarizeTranscript(transcript: string) {
    return { text: `Mock handoff summary (${transcript.length} chars of transcript).` };
  },
  async draftProjectContext(project: Project) {
    return { text: `Mock context draft for ${project.name}.` };
  },
  async summarizeProjectRecap(project: Project) {
    return { text: `Mock recap for ${project.name}: everything is fine.` };
  },

  async authStatus(): Promise<AgentAuthStatus> {
    return { authenticated: true, method: "mock", email: MOCK_EMAIL, plan: MOCK_PLAN, error: null };
  },
  async startLogin(): Promise<AgentLoginSession> {
    currentLogin = loginSuccess();
    return currentLogin;
  },
  getLogin(): AgentLoginSession | null {
    return currentLogin;
  },
  async submitLoginCode(): Promise<AgentLoginSession> {
    currentLogin = loginSuccess();
    return currentLogin;
  },
  cancelLogin(): void {
    currentLogin = null;
  },
  async verify(): Promise<AgentVerifyResult> {
    return { ok: true, output: "mock pong", error: null };
  },
};
