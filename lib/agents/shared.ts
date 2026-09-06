// Agent-agnostic building blocks shared by every driver: the project-context
// prompt, the conflict-resolution prompt, and the normalizers that turn a raw
// tool call/result into the UI's title/detail/peek shape. Nothing in here
// knows which agent is running; drivers reuse these to emit the normalized
// StreamEvent contract (see lib/agents/types.ts).

import type { Project, Task, AskQuestion, AskAnswers, ToolPeek, DiffLine } from "../types";
import { listSummaries } from "../store";
import { tagContextBlock } from "../tagContext";
import { hasOwnBase, resolveBaseBranch } from "../baseBranch";
import { takeBaseCutNote } from "../baseDrift";
import { getCapabilities } from "./capabilities";
import { BACKGROUND_LINGER_MS, DELEGATE_COLLECTION } from "../config";

// A fresh agent session still needs a user turn to begin, but task metadata is
// already supplied by buildProjectContext(). This prompt stays generic so the
// title and details have one canonical representation.
export const INITIAL_TASK_PROMPT = "Start working on the task described in the task context.";

/**
 * The second half of the "Base branch:" line, per the project's landing
 * mode. Exported so tests can pin both wordings without rebuilding a whole
 * context string. Under `pr`, naming only the branch as protected still lets
 * a session reach for Merge; it also has to hear what finishing means instead.
 */
export function landingSentence(project: Pick<Project, "landing_mode">, base: string): string {
  if (project.landing_mode === "pr")
    return (
      `This worktree was cut from it. Sync catches up to it; Merge does not land it. ` +
      `${base} is protected, so Merge is rejected: this project lands work by pull request. ` +
      `Finish by opening a PR against ${base} for review. Use \`create_pr\`: it pushes and opens ` +
      `the PR server-side, since a plain \`git push\` is usually refused. Merging it afterward is ` +
      `the user's call, and there is no tool for it.`
    );
  return "This worktree was cut from it, Sync catches up to it, and Merge lands into it.";
}

/**
 * Build the context string prepended to every task's session via the
 * agent's system prompt: project description, conventions, task framing,
 * and any prior-session summaries.
 *
 * When the task opted out of saved project context (send_context = 0), the
 * "what we're building" block is omitted; everything else the session needs
 * still goes out: task title/details, carried summaries, and the Calandria
 * tool instructions.
 */
export function buildProjectContext(project: Project, task: Task): string {
  const summaries = listSummaries(task.id);
  const ctx = project.context || [project.building, project.conventions].filter(Boolean).join("\n");
  const lines: string[] = [];
  lines.push(`You are working inside the project "${project.name}".`);
  if (ctx && task.send_context !== 0) lines.push(`\nWhat we're building (project context):\n${ctx}`);
  // Names the base branch: what the worktree was cut from, what Sync catches
  // up to, and what Merge lands on. The parenthetical shows only when the
  // task has a base of its own. Landing mode decides the wording, since under
  // `pr` the server rejects Merge and the sentence must say so.
  const base = resolveBaseBranch(task, project);
  if (base)
    lines.push(
      `\nBase branch: ${base}. ${landingSentence(project, base)}` +
        (hasOwnBase(task, project) ? ` (The project's default is ${project.branch}.)` : "")
    );
  // Set when the cut base drifted from the project default or no longer
  // exists (lib/baseDrift.ts). Empty on an ordinary task; placed right after
  // the line it qualifies, since alone it would read as reassurance.
  const cutNote = takeBaseCutNote(task.id);
  if (cutNote) lines.push(`\n${cutNote}`);
  lines.push(`\n---\nThe current task is: "${task.title}"`);
  if (task.description) lines.push(`Task details: ${task.description}`);

  // Each tag's name, description and sibling order, one block per tag
  // (lib/tagContext.ts). Placed right after the brief, since it frames it.
  const tagBlocks = tagContextBlock(task);
  if (tagBlocks) lines.push(tagBlocks);

  if (summaries.length > 0) {
    lines.push(`\n--- Carried context from previous sessions of this task ---`);
    for (const s of summaries) {
      lines.push(`\n[Session ${s.generation} summary]\n${s.summary}`);
    }
    lines.push(`\nContinue this task from where the previous session left off.`);
  }

  // Per-driver truth about backgrounded work. A lingering driver (Claude, via
  // streaming-input mode; see BACKGROUND_LINGER_MS) keeps the CLI alive after
  // the turn so background work finishes and its notification wakes the
  // model. Every other driver kills the turn's process at result time,
  // taking backgrounded commands with it, so the model must be warned off a
  // promise its harness cannot keep.
  if (getCapabilities(task.agent).backgroundTasksLinger) {
    lines.push(
      `\n---\nBackground shell tasks keep running after your turn ends: the session stays open ` +
        `until they settle and their completion notifications re-invoke you. ` +
        (BACKGROUND_LINGER_MS > 0
          ? `The wait is bounded to ${Math.round(BACKGROUND_LINGER_MS / 60000)} minutes, with a ` +
            `transcript notice for anything cut off. Run interruption-sensitive work in the ` +
            `foreground. Scheduled wakeups (ScheduleWakeup, CronCreate) fire only inside the ` +
            `window; a later one is cancelled and named in a notice.`
          : `There is no deadline: the session waits until the work finishes, or the user stops it. ` +
            `Never background a process that does not exit on its own (a dev server, a watcher); ` +
            `use the managed services / expose_service path for those instead. A watcher loop whose ` +
            `own command line contains the pattern it greps for (\`while pgrep -f "vitest"; do sleep 20; done\`) ` +
            `matches ITSELF and never exits. Use \`run_in_background\` on the real command instead, ` +
            `which re-invokes you when it exits; poll only with \`pgrep -f "[v]itest"\` if you must. ` +
            `Scheduled wakeups (ScheduleWakeup, CronCreate) are honored the same way: the session ` +
            `stays open until they fire, and a recurring one keeps it open until you delete it or ` +
            `the user stops the session.`)
    );
  } else {
    lines.push(
      `\n---\nBackground shell tasks do NOT survive the end of your turn. Each turn runs in its ` +
        `own process; backgrounded commands are killed with it when the turn completes, regardless ` +
        `of what your shell tool's documentation promises. Run long commands in the foreground, ` +
        `and split a run longer than the foreground timeout into stages. Scheduled wakeups ` +
        `(ScheduleWakeup, CronCreate) die the same way: nothing re-invokes you after your turn ` +
        `ends, so don't schedule one.`
    );
  }

  lines.push(
    `\n---\nYou have a "calandria" MCP tool \`suggest_task\`. It files into THIS project by ` +
      `default and lands in the user's Suggested tray to review and start later. Use it two ` +
      `ways: on request, to plan, break down or roadmap work (once per task); and proactively, ` +
      `to capture out-of-scope follow-ups instead of doing them now. For a different project, ` +
      `pass \`project\` (id or exact name from \`list_projects\`); an unrecognized value is refused.\n\n` +
      `Order the plan: a task can be blocked by others and won't start until they're done. File ` +
      `every task with \`suggest_task\` first, WAIT for the ids it returns, then call ` +
      `\`update_task\` once per dependent task with \`blocked_by\` set to the ids it waits on. ` +
      `Independent tasks stay unblocked; dependencies never cross projects.\n\n` +
      `Name the plan: pass the same \`tags\` to every task of one feature, migration or refactor. ` +
      `A tag is created on first use; the user gets one chip for the plan, and each session ` +
      `learns which step it is.`
  );
  lines.push(
    `\n\`update_task\` also reaches any task on the board, in any project, including ones the ` +
      `user has accepted or started. If a planned task turns out wrong or stale, correct it: the ` +
      `edit is flagged on the board as changed by an agent, with a before/after diff and a ` +
      `one-click revert, so it stays reviewable instead of silent. Refused only on a task with a ` +
      `turn running in it right now.`
  );
  lines.push(
    `\nYou also have \`create_runbook\`, \`list_runbooks\` and \`update_runbook\`. A runbook is a ` +
      `saved recipe (a prompt plus how to run it) the user can dispatch later in one click, ` +
      `minting a fresh task each time. Offer to save one when asked to, or when the user mentions ` +
      `a procedure they run regularly. A runbook runs nothing on its own, so creating one is safe; ` +
      `use \`suggest_task\` for work that should actually happen. You cannot delete a runbook, and ` +
      `cannot edit one a schedule fires, since that would silently change unattended work; ` +
      `\`list_runbooks\` shows which those are.`
  );
  lines.push(
    `\nYou also have an \`expose_service\` MCP tool. Once a long-running server (dev server, API, ` +
      `preview, Storybook) is listening, call \`expose_service(name, port)\` to register it: it ` +
      `appears in the project's Services panel and returns the URL the user can open (on a hosted ` +
      `instance, a real public hostname; reply with that exact URL so the user can verify your ` +
      `work live). Names are slugified to lowercase [a-z0-9-]. Prefer the PORT environment ` +
      `variable Calandria injected (${project.port ? `PORT=${project.port}` : "set per project"}) ` +
      `so the address is stable. The URL is proxied under that hostname, so allow it in dev-server ` +
      `host checks: Vite \`server.allowedHosts: [process.env.CALANDRIA_PUBLIC_HOST]\` (or \`true\`), ` +
      `Next dev \`allowedDevOrigins: [process.env.CALANDRIA_PUBLIC_HOST]\` in next.config, ` +
      `CRA/webpack-dev-server is pre-cleared via env.`
  );

  // Bulk collection goes to a subagent. Placed last so it overrides the CLI's
  // own "work through Bash" guidance from earlier in the same window. Lives
  // here instead of CLAUDE.md because a project's own instructions are read
  // as context, and this needs to read as a harness rule. The trigger is a
  // count: a model judging each command on its own merits won't reliably
  // fire a rule phrased as a repeated question.
  // Measurement: https://github.com/calandria-dev/calandria-notes/blob/main/measurements/DELEGATION.md
  if (DELEGATE_COLLECTION && getCapabilities(task.agent).dispatchesSubagents) {
    lines.push(
      `\n---\nCollecting context: the bulk reads go to a subagent.\n\n` +
        `Dispatching a subagent to collect context is requested work here, overriding the ` +
        `default caution against unprompted subagents and auto mode's instruction to work ` +
        `through Bash. It covers gathering only, never deciding.\n\n` +
        `Once you have run two read-only commands (\`cat\`, \`sed -n\`, \`head\`, \`grep\`, ` +
        `\`find\`, \`ls\`, \`git log\`, \`git show\`) in a row, run the third through a subagent ` +
        `instead, even on a purely investigative task split by facet.\n\n` +
        `- \`Agent(subagent_type: "Explore", model: "haiku", run_in_background: false)\` for a ` +
        `list: call sites, \`file:line\`, what exists, what a config says.\n` +
        `- \`Agent(subagent_type: "general-purpose", model: "sonnet", run_in_background: false)\` ` +
        `when the answer needs judgment about what it found.\n\n` +
        `\`run_in_background: false\` is required and is not the default: a backgrounded agent ` +
        `reports after this turn ends, so its answer is lost if you wait here. Send independent ` +
        `sweeps in one message; ask for conclusions and \`file:line\`s, not file contents.\n\n` +
        `Keep in your own loop: your edits; test, typecheck and build runs; \`git diff\` of your ` +
        `own work; anything you need the full output of to decide. Never substitute a cheaper ` +
        `proxy for a measurement: run the thing and read the number.`
    );
  }
  return lines.join("\n");
}

/**
 * Prompt for an AI conflict-resolution turn. The task's base branch has been
 * trial-merged into its work branch (in the isolated worktree), leaving conflict
 * markers in the listed files. The agent resolves them in place. Completion
 * (commit and land into base) is handled by the app on the user's Accept, so
 * the prompt tells it not to commit, though the flow is robust if it does
 * anyway.
 */
export function buildConflictPrompt(baseBranch: string, conflicts: string[]): string {
  const files = conflicts.map((f) => `  - ${f}`).join("\n");
  return [
    `I merged \`${baseBranch}\` into this branch and hit merge conflicts. Resolve every conflict.`,
    ``,
    `Conflicted files:`,
    files,
    ``,
    `For each file, remove all conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) and produce a`,
    `correct merged result that preserves the intent of both sides. Don't blindly pick one.`,
    `Read the surrounding code and keep both changes where they are independent. Run \`git diff\``,
    `or inspect the files as needed.`,
    ``,
    `Do not run \`git commit\`, \`git merge --continue\`, or \`git add\`. Just edit the files to a clean,`,
    `marker-free state. I'll review your resolution and land the merge myself.`,
  ].join("\n");
}

/** One red check as the Fix-CI prompt wants it: named, linked, and (usually) logged. */
export interface CiFailure {
  name: string;
  url: string;
  workflow: string;
  /** The tail of the job's failed steps, "" when GitHub couldn't give us one. */
  log: string;
  /** Why there is no log, when there isn't one. */
  logError: string;
}

/**
 * Prompt for a "Fix CI" turn. The task's own session, in its own worktree, is
 * told which job on its PR went red and shown the tail of that job's failed
 * steps.
 *
 * The shape mirrors buildConflictPrompt: an ordinary user message on the
 * existing session (the client sends it through POST /messages), not a
 * special turn kind. The agent already has the branch checked out, so it needs
 * the failure, not the context.
 *
 * A missing log is stated rather than hidden. `gh run view --log-failed` can
 * come back empty for an expired run, a legacy status context or a check
 * published by something other than Actions, and an agent told "here is the
 * log" followed by nothing will invent one; told the log is unavailable, it
 * reproduces the job locally instead, which is the right move anyway.
 */
export function buildCiFixPrompt(prNumber: number, failures: CiFailure[]): string {
  const label = (f: CiFailure) => (f.workflow && f.workflow !== f.name ? `${f.workflow} / ${f.name}` : f.name);
  const lines: string[] = [
    `CI is failing on this task's pull request${prNumber ? ` (#${prNumber})` : ""}. Please fix it.`,
    ``,
    failures.length === 1 ? `Failing check:` : `Failing checks (${failures.length}):`,
    ...failures.map((f) => `  - ${label(f)}${f.url ? ` — ${f.url}` : ""}`),
  ];
  for (const f of failures) {
    lines.push(``, `## ${label(f)}`);
    if (f.log) {
      lines.push(``, "```", f.log, "```");
    } else {
      lines.push(
        ``,
        `No log available${f.logError ? ` (${f.logError})` : ""}. Reproduce this job locally instead of`,
        `guessing — read the workflow file that defines it and run the same command.`
      );
    }
  }
  lines.push(
    ``,
    `Work in this worktree, on this task's branch. Diagnose the real cause rather than`,
    `silencing the check: a test that fails in CI and passes locally is usually an`,
    `environment or ordering difference, not a flaky test to retry.`,
    ``,
    `Commit the fix when you're done. I'll push it and watch the re-run.`
  );
  return lines.join("\n");
}

export function clip(s: unknown, n = 4000): string {
  const str = typeof s === "string" ? s : JSON.stringify(s, null, 2);
  return str.length > n ? str.slice(0, n) + `\n… (${str.length - n} more chars)` : str;
}

// The clip for a failed result: cut the middle, keep both ends. A shell
// appends stderr after stdout, so a long failed command ("cat a b" where only
// b is missing, a compound command whose last step errored) carries its
// explanation in the last few hundred bytes, and a plain clip() would throw
// exactly that away, leaving thousands of chars of good output under a red ✗
// with no visible reason. The head stays too: the exit status is the first line.
export function clipKeepTail(s: string, n = 6000): string {
  if (s.length <= n) return s;
  const tail = Math.floor(n / 3);
  const head = n - tail;
  return s.slice(0, head) + `\n… (${s.length - n} chars omitted) …\n` + s.slice(s.length - tail);
}

// Turn a failed tool result into its peek: the exit status (the Claude CLI
// writes "Exit code N" as the first line; Codex reports it as a field, passed
// in) and the last lines of the output, where the reason lives. Applies to
// every tool, not just shell commands: a Read's "File does not exist" is one
// line either way. `omitted` is what the full body holds above the tail; the
// renderer offers it as "+N earlier lines", not "more".
export function summarizeFailure(raw: string, exitCode?: number | null): ToolPeek {
  const exitLine = /^Exit code (-?\d+)\n?/.exec(raw);
  const label = exitLine ? `Exit code ${exitLine[1]}` : exitCode != null && exitCode !== 0 ? `Exit code ${exitCode}` : undefined;
  const body = exitLine ? raw.slice(exitLine[0].length) : raw;
  const lines = body.split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const MAX = 6;
  return { kind: "fail", label, lines: lines.slice(-MAX), omitted: Math.max(0, lines.length - MAX) };
}

// How a tool's eventual result should be summarized into a peek. The result
// content only arrives later (a separate tool_result event), so describeToolUse
// records the kind and summarizeResult turns the raw output into the peek.
export type ResultKind = "read" | "output" | "grep" | "glob";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Line diff for an Edit's old/new strings. Not full LCS: edits are localized,
// so trimming the common prefix/suffix and keeping a few unchanged lines of
// context on each side reads like a real diff hunk without the machinery.
const DIFF_CTX = 3;
export function diffLines(oldS: string, newS: string): DiffLine[] {
  const a = oldS ? oldS.split("\n") : [];
  const b = newS ? newS.split("\n") : [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return [
    ...a.slice(Math.max(0, pre - DIFF_CTX), pre).map((text) => ({ sign: " " as const, text })),
    ...a.slice(pre, a.length - suf).map((text) => ({ sign: "-" as const, text })),
    ...b.slice(pre, b.length - suf).map((text) => ({ sign: "+" as const, text })),
    ...a.slice(a.length - suf, a.length - suf + DIFF_CTX).map((text) => ({ sign: " " as const, text })),
  ];
}

// Cap the stored full diff so a giant Edit doesn't bloat the DB row or SSE event.
const DIFF_MAX = 400;
function capDiff(diff: DiffLine[]): DiffLine[] {
  return diff.length <= DIFF_MAX ? diff : [...diff.slice(0, DIFF_MAX), { sign: " ", text: `… (${diff.length - DIFF_MAX} more lines)` }];
}

// The always-visible peek: exact +/− counts over a capped slice of the hunk.
function diffPeek(diff: DiffLine[], label?: string): ToolPeek {
  const added = diff.filter((l) => l.sign === "+").length;
  const removed = diff.filter((l) => l.sign === "-").length;
  const MAX = 14;
  return { kind: "diff", added, removed, label, lines: diff.slice(0, MAX), truncated: Math.max(0, diff.length - MAX) };
}

// Turn a tool's raw (pre-clip) result into its peek, by kind.
export function summarizeResult(kind: ResultKind, raw: string): ToolPeek {
  const lines = raw ? raw.split("\n") : [];
  const hits = lines.filter((l) => l.trim()).length;
  switch (kind) {
    case "read":
      return { kind: "count", text: `Read ${plural(lines.length, "line")}` };
    case "grep":
      return { kind: "count", text: `Found ${plural(hits, "match")}` };
    case "glob":
      return { kind: "count", text: `Found ${plural(hits, "file")}` };
    case "output": {
      if (!raw.trim()) return { kind: "count", text: "No output" };
      const MAX = 6;
      return { kind: "lines", lines: lines.slice(0, MAX), truncated: Math.max(0, lines.length - MAX) };
    }
  }
}

// Returns a one-line title, an expandable detail of the tool input, an optional
// always-visible peek, and (for result-derived peeks) the kind to summarize the
// eventual output with. Mirrors what Claude Code reveals per tool; the names
// are the common coding-agent tool vocabulary, and the default arm renders any
// unknown tool generically, so other drivers can reuse this as-is.
export function describeToolUse(
  name: string,
  input: Record<string, unknown>
): { title: string; detail: string; peek?: ToolPeek; diff?: DiffLine[]; resultKind?: ResultKind; file?: string } {
  const file = (input?.file_path || input?.path || input?.notebook_path) as string | undefined;
  // `file` on the return is the path a text-writing call touched, for the
  // transcript's Collaborate button. Only Write/Edit carry it: a notebook is
  // JSON no one reviews as a document, and reads change nothing.
  const base = file ? file.split("/").slice(-1)[0] : undefined;
  switch (name) {
    case "Write": {
      const content = typeof input?.content === "string" ? input.content : "";
      const diff = diffLines("", content);
      return {
        title: `✎ Write ${base ?? "file"}`,
        detail: file ?? "",
        file,
        diff: capDiff(diff),
        peek: diffPeek(diff, `Wrote ${plural(diff.length, "line")}${base ? ` to ${base}` : ""}`),
      };
    }
    case "Edit":
    case "NotebookEdit": {
      const diff = diffLines(
        typeof input?.old_string === "string" ? input.old_string : "",
        typeof input?.new_string === "string" ? input.new_string : ""
      );
      return { title: `✎ Edit ${base ?? "file"}`, detail: file ?? "", diff: capDiff(diff), peek: diffPeek(diff), file: name === "Edit" ? file : undefined };
    }
    case "Read":
      return { title: `📖 Read ${base ?? "file"}`, detail: file ?? "", resultKind: "read" };
    case "Bash":
      return { title: `❯ ${String(input?.command ?? "").split("\n")[0].slice(0, 70)}`, detail: clip(input?.command), resultKind: "output" };
    case "Grep":
      return { title: `🔎 Grep ${String(input?.pattern ?? "")}`, detail: clip(input), resultKind: "grep" };
    case "Glob":
      return { title: `🔎 Glob ${String(input?.pattern ?? "")}`, detail: String(input?.pattern ?? ""), resultKind: "glob" };
    case "TodoWrite": {
      const todos = Array.isArray(input?.todos) ? (input.todos as Record<string, unknown>[]) : [];
      const items = todos.map((t) => ({ text: String(t?.content ?? t?.text ?? ""), status: String(t?.status ?? "pending") }));
      return { title: `☑ Updated todos`, detail: clip(input?.todos), peek: { kind: "todos", items } };
    }
    case "Task":
      return { title: `🤖 Subagent: ${String(input?.description ?? "task")}`, detail: clip(input?.prompt) };
    case "ExitPlanMode":
      // Plan mode's handoff: the agent is asking to stop planning and start
      // editing, with the plan itself as the input worth reading.
      return { title: `📋 Proposed a plan`, detail: clip(input?.plan) };
    default:
      if (name.includes("suggest_task")) return { title: `✦ Suggested a task`, detail: clip(input) };
      if (name.includes("expose_service")) return { title: `🔌 Exposed ${String(input?.name ?? "service")} :${String(input?.port ?? "")}`, detail: clip(input) };
      return { title: `⚙ ${name}`, detail: clip(input) };
  }
}

// Format the user's ask answers into the text fed back to the agent as the
// tool result (for Claude, delivered via the PreToolUse hook's deny reason).
export function formatAnswers(questions: AskQuestion[], answers: AskAnswers): string {
  const lines = questions.map((q, i) => {
    const picked = (answers[i] ?? []).filter((s) => s && s.trim());
    return `- ${q.header || q.question}: ${picked.length ? picked.join(", ") : "(no selection)"}`;
  });
  return `The user answered your question${questions.length > 1 ? "s" : ""}:\n${lines.join("\n")}\n\nProceed based on these choices.`;
}

// Minimal push/pull async queue. A driver's native message pump and any
// interactive hooks (asks) both push events; runTurn yields them in order
// until the queue closes. A queue is needed because hooks fire inside the
// native iteration (they park awaiting the user), so they can't yield from
// runTurn directly and push here instead.
export function makeQueue<T>() {
  const items: T[] = [];
  let waiting: ((r: IteratorResult<T>) => void) | null = null;
  let closed = false;
  return {
    push(item: T) {
      if (closed) return;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: item, done: false });
      } else items.push(item);
    },
    close() {
      closed = true;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: undefined as never, done: true });
      }
    },
    async *drain(): AsyncGenerator<T> {
      while (true) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        if (closed) return;
        const r = await new Promise<IteratorResult<T>>((res) => {
          waiting = res;
        });
        if (r.done) return;
        yield r.value;
      }
    },
  };
}

// Flatten a tool_result's content (string | block list | anything) to text.
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : typeof b === "string" ? b : "")).join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

// ---------- the "Refresh tag" plan (lib/tagRefresh.ts) ----------
//
// The prompt and parser live here rather than in each driver, unlike the older
// one-shots whose prose is duplicated per driver. Those return free text, where
// drift is a style difference; this one returns a machine-read contract that
// the server applies to real rows. Two copies of the schema could disagree
// about a field name, and the symptom would be a Codex instance whose refresh
// silently changes nothing.

/** Delimiters the plan JSON is wrapped in, so interim narration can be dropped. */
export const TAG_PLAN_OPEN = "<<<TAG_PLAN>>>";
export const TAG_PLAN_CLOSE = "<<<END_TAG_PLAN>>>";

/** One member the refresh wants to change. `retire` and the text fields are exclusive. */
export interface TagPlanTask {
  id: string;
  title?: string;
  description?: string;
  /** Retract this task: it is already done elsewhere, or a sibling superseded it. */
  retire?: boolean;
  /** Why, required for a retirement, and shown to the user on the struck-through card. */
  reason?: string;
}

export interface TagPlan {
  /** The rewritten tag description, or "" to leave the saved one alone. */
  description: string;
  tasks: TagPlanTask[];
}

/**
 * What the utility agent is asked to do when the user presses "Refresh tag".
 *
 * The instruction that matters most is the last one: say nothing about a task
 * that is still accurate. A model asked to review seven briefs will, unprompted,
 * return seven improved briefs, and the user then gets seven "Changed by agent"
 * chips for a plan that hadn't actually gone stale, which teaches them to stop
 * pressing the button. Silence is the expected output of a healthy tag.
 */
export function buildTagRefreshPrompt(project: Project, digest: string): string {
  return (
    `A "tag" in this app is a named plan: a set of tasks in the project "${project.name}" that belong to one ` +
    `feature, migration or refactor, plus a description of what the plan IS. The plan was written at some point ` +
    `in the past. The code has moved since. Your job is to check the plan against the code as it stands NOW and ` +
    `report only what has actually gone stale.\n\n` +
    `Explore the repository in your working directory using the read-only tools available to you — read the files ` +
    `each task talks about, grep for the symbols and routes it names, check whether the thing it proposes already ` +
    `exists, and look at recent history. Judge every task on evidence you found in the code, never on how the ` +
    `brief reads.\n\n` +
    `For each task, decide which ONE of these applies:\n` +
    `  (a) Still accurate — the work described is still needed and still described correctly. Say NOTHING about it.\n` +
    `  (b) Stale wording — the work is still needed, but the brief points at files, symbols or an approach that no ` +
    `longer exist. Return a corrected "title" and/or "description".\n` +
    `  (c) Overtaken — the work is already done in the code, or another task in this plan has made it unnecessary. ` +
    `Return "retire": true with a "reason" naming the evidence (the file, function or task that settles it).\n\n` +
    `Be conservative about (c). "Retire" retracts a task the user planned; propose it only when you have READ the ` +
    `code that makes it redundant, not because the title sounds similar to something you saw. If you are unsure, ` +
    `treat it as (a) and mention the doubt in the tag description instead.\n\n` +
    `Then write the tag's description: a short paragraph (2-5 sentences, plain prose, no heading, no bullet list) ` +
    `saying what this plan is for and where it currently stands. It is shown under the tag and given to every ` +
    `session that carries it, so it must be accurate about the present. Return "" to keep the saved one unchanged.\n\n` +
    `Output a single JSON object wrapped between a line containing ${TAG_PLAN_OPEN} and a line containing ` +
    `${TAG_PLAN_CLOSE}, with this exact shape:\n` +
    `{"description": "...", "tasks": [{"id": "<the task's id, copied exactly>", "title": "...", ` +
    `"description": "...", "retire": false, "reason": "..."}]}\n` +
    `Omit "title"/"description" on a task you aren't rewording. Use the ids exactly as given below — a task you ` +
    `invent an id for is dropped. An empty "tasks" array is a perfectly good answer and means the plan is fresh. ` +
    `Any thinking-out-loud goes BEFORE the opening marker.\n\n` +
    `=== THE PLAN ===\n${digest}`
  );
}

/**
 * Pull the plan out of a one-shot's raw text. Every failure mode degrades to an
 * empty plan instead of throwing: the job is to change what it can justify, and
 * a model that emitted prose instead of JSON has justified nothing. The caller
 * reports "nothing needed changing", which is honest, since the check did run.
 */
export function parseTagPlan(raw: string): TagPlan {
  const empty: TagPlan = { description: "", tasks: [] };
  const open = raw.indexOf(TAG_PLAN_OPEN);
  const close = raw.lastIndexOf(TAG_PLAN_CLOSE);
  let body = open !== -1 && close > open ? raw.slice(open + TAG_PLAN_OPEN.length, close) : raw;
  body = body.trim().replace(/^```(?:json)?\n([\s\S]*)\n```$/, "$1").trim();
  // Without markers the text may be narration with an object buried in it.
  if (!body.startsWith("{")) {
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first === -1 || last <= first) return empty;
    body = body.slice(first, last + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const obj = parsed as { description?: unknown; tasks?: unknown };
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const tasks: TagPlanTask[] = Array.isArray(obj.tasks)
    ? obj.tasks.flatMap((t) => {
        if (!t || typeof t !== "object") return [];
        const e = t as Record<string, unknown>;
        const id = str(e.id);
        if (!id) return [];
        const entry: TagPlanTask = { id };
        // "" is not a proposed rewrite, it's a field the model left blank;
        // applying it would blank a real brief.
        if (str(e.title)) entry.title = str(e.title);
        if (str(e.description)) entry.description = str(e.description);
        if (e.retire === true) entry.retire = true;
        if (str(e.reason)) entry.reason = str(e.reason);
        return [entry];
      })
    : [];
  return { description: str(obj.description), tasks };
}
