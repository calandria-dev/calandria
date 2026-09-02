// The e2e mock driver — a deterministic AgentDriver used only by the Playwright
// suite (registered when CALANDRIA_E2E_MOCK_AGENT=1, see registry.ts). It exercises
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
//   e2e:ask=[header|]<question>|<a>,<b>[|multi]
//                                   raise an AskUserQuestion card and park on it,
//                                   through the same startAskUser() the stdio
//                                   bridge's ask_user tool calls. Repeat the
//                                   directive to put several questions on one card
// With no directives, the turn appends the prompt to AGENT_NOTES.md — so every
// plain turn still produces a diff to view and merge.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AskQuestion, Project, Task } from "@/lib/types";
import type {
  AgentAuthStatus,
  AgentDriver,
  AgentLoginSession,
  AgentVerifyResult,
  StreamEvent,
} from "../types";
import { createSuggestedTask, resolveTargetProject, startAskUser, updateTaskForAgent } from "@/lib/agentTools";
import { takeAskOutcome } from "@/lib/asks";
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
import { summarizeFailure } from "@/lib/agents/shared";
import { PERMISSION_PROMPT_TIMEOUT_MS, PERMISSION_UNATTENDED_MS } from "@/lib/config";
import { MOCK_CAPABILITIES } from "./capabilities";

const MOCK_EMAIL = "e2e@example.com";
// How the mock spells the tool, matching the shape a real driver reports:
// lib/suggestionCard.ts matches a substring precisely because every driver
// prefixes it differently.
const SUGGEST_TOOL = "mcp__calandria__suggest_task";
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

// How long an `e2e:ask=` turn will sit parked before giving up, and how often it
// looks. The stdio bridge waits a day at 1.5s intervals; a mock turn nobody
// answers has to end on its own rather than hold the turn slot for the life of
// the test server, and a spec that clicks the card wants the resume to be
// prompt rather than realistic.
const ASK_WAIT_MS = 120_000;
const ASK_POLL_MS = 100;

/**
 * Parse one `e2e:ask=` directive into an AskQuestion.
 *
 * `[<header>|]<question>|<optA>,<optB>[|multi]` — the header is optional
 * because a one-question card reads fine without one. Defaults match the
 * bridge's own sanitizeQuestions() (header "Question", single-select), so a
 * card raised from here is indistinguishable from one ask_user raised.
 * Returns null for a directive with no question or no options, which is what
 * that sanitizer does with the same input.
 */
function parseAsk(spec: string): AskQuestion | null {
  const parts = spec.split("|").map((p) => p.trim());
  const multiSelect = parts.length > 2 && parts[parts.length - 1].toLowerCase() === "multi";
  if (multiSelect) parts.pop();
  const [header, question, optionSpec] =
    parts.length > 2 ? parts : ["Question", parts[0] ?? "", parts[1] ?? ""];
  const options = optionSpec
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((label) => ({ label }));
  if (!question || !options.length) return null;
  return { header: header.slice(0, 24), question, options, multiSelect };
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

  // Stands in for the Claude driver's WATCHED_SETTINGS_FILES so the runner's
  // pre-turn settings gate (lib/settingsDrift.ts, issue #43) is exercised end
  // to end in the built server, card and all. The mock reads nothing from this
  // file; what the e2e is testing is the gate and its UI, and both are the
  // runner's, driven off exactly this declaration. `e2e:write=` is what plants
  // the file, which is also the escalation being modelled: an agent writing
  // the settings its NEXT turn would run under.
  watchedSettingsFiles: [".claude/settings.json"],

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

    // Per-turn, so two suggestions in one turn get distinct tool_use ids and the
    // runner settles a card onto each.
    let suggestSeq = 0;

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

    // An AskUserQuestion, raised through lib/agentTools.startAskUser — the call
    // the stdio bridge's ask_user tool makes, rather than the Claude driver's
    // in-SDK PreToolUse hook, because the bridge is the path with no browser
    // coverage at all. startAskUser owns the card completely: it persists the
    // tool row, publishes it, raises awaiting_input and parks a DETACHED waiter
    // on lib/asks.ts. So there is nothing to yield here and the turn's only job
    // is to wait for the outcome the way the bridge does — polling
    // takeAskOutcome() rather than holding anything open.
    const asks = [...instructionText.matchAll(/e2e:ask=([^\n]+)/g)]
      .map((m) => parseAsk(m[1].trim()))
      .filter((q): q is AskQuestion => q !== null);
    if (asks.length) {
      const { askId } = startAskUser(task, asks);
      let outcome: string | null = null;
      const deadline = Date.now() + ASK_WAIT_MS;
      while (outcome === null && !signal?.aborted && Date.now() < deadline) {
        await sleep(ASK_POLL_MS, signal);
        outcome = takeAskOutcome(task.id, askId);
      }
      if (signal?.aborted) return; // a Stop ends the stream without an error event
      if (outcome === null) {
        yield { type: "error", content: `Mock ask ${askId} was never answered.` };
        return;
      }
      // The formatted answers are what a real agent reads back as the tool
      // result, so echoing them is how a spec proves the answer reached the
      // model and not just the database.
      yield { type: "assistant", content: outcome };
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
        const refused = `refused path outside worktree: ${w.rel}`;
        yield { type: "tool_result", id, content: refused, isError: true, peek: summarizeFailure(refused) };
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

    // Emitted as a real tool call (row, result, then the `suggested` event), the
    // way both real drivers do it — that ordering is what lets the runner settle
    // the suggestion card onto the call that made it, so the e2e exercises the
    // transcript card and not just the tray.
    for (const m of instructionText.matchAll(/e2e:suggest=([^\n]+)/g)) {
      const title = m[1].trim();
      const id = `sug-${suggestSeq++}`;
      yield { type: "tool", id, name: SUGGEST_TOOL, title: "✦ Suggested a task", detail: title };
      const { task: made, text } = createSuggestedTask(project, { title, description: "Suggested by the mock agent (e2e)." });
      yield { type: "tool_result", id, content: text, isError: !made };
      if (made) yield { type: "suggested", title, projectId: project.id, taskId: made.id };
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
      const id = `sug-${suggestSeq++}`;
      yield { type: "tool", id, name: SUGGEST_TOOL, title: "✦ Suggested a task", detail: `${title} → ${target.project.name}` };
      const { task: made, text } = createSuggestedTask(target.project, { title, description: "Suggested by the mock agent (e2e)." });
      yield { type: "tool_result", id, content: text, isError: !made };
      if (made) yield { type: "suggested", title, projectId: target.project.id, taskId: made.id };
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
    // Occupancy is reported separately from spend, as the Claude driver does,
    // so the runner's `context` path runs under e2e too.
    yield { type: "context", tokens: 120 };
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
  // "Refresh tag" reads a JSON plan back, so the mock has to emit one — canned
  // text would parse as an empty plan and the e2e would only ever see the
  // nothing-changed path. It rewords the FIRST member (whose id it lifts out of
  // the digest it was handed) so the apply half, and the "Changed by agent"
  // chip that half exists to raise, are both exercisable.
  async planTagRefresh(project: Project, digest: string) {
    const first = /^id: (\S+)$/m.exec(digest)?.[1];
    const plan = {
      description: `Mock tag refresh for ${project.name}.`,
      tasks: first ? [{ id: first, description: "Mock refreshed brief." }] : [],
    };
    return { text: `<<<TAG_PLAN>>>\n${JSON.stringify(plan)}\n<<<END_TAG_PLAN>>>` };
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
