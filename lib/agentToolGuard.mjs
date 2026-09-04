/* Making an agent tool's failure LOUD.
 *
 * Observed twice in the wild (2026-08-24 task s5xI9x469CeDBTtY3adLg, 2026-08-30
 * task iOo9IgSUi8nhKWLipMoVo): partway through a live turn, every Calandria tool
 * call started coming back with no content and no error, and kept doing it for
 * 20-50 minutes before healing itself inside the same session. The sessions went
 * on to announce a withdrawal, a runbook and a pull request that were never
 * written; the only way either noticed was reading the database by hand.
 *
 * That is the part worth fixing regardless of cause. An empty result is
 * indistinguishable from a quiet success, so the model cannot tell it apart, and
 * a tool it cannot trust is worse than one that is missing. Whatever is dropping
 * the answer sits below this seam and did not reproduce from here, so this
 * module fixes what is ours: whatever happens, what comes back is a sentence the
 * model can read and relay.
 *
 * Three ways a call can fail to answer, one shape of answer:
 *
 *   - it throws          -> the message, named with the tool that produced it
 *   - it never returns   -> a bounded wait, then a loud abandonment
 *   - it returns nothing -> an empty or all-blank result is rewritten as an error
 *
 * The bound is the one that is easy to under-rate. The CLI's own per-call MCP
 * timeout defaults to 1e8 ms (~27.7 hours) and is not settable per in-process
 * server, and the SDK host awaits a handler indefinitely, so nothing else in the
 * stack would ever end that wait. `create_pr` is exactly the shape that would
 * test it: it commits, pushes over the network and shells out to `gh`.
 *
 * Plain .mjs with no imports so the Claude driver (TypeScript, in-process SDK
 * MCP server) and scripts/calandria-mcp.mjs (plain Node, stdio bridge) share ONE
 * copy. Those are the only two ways a Calandria tool call reaches a model, and a
 * guard covering one of them is a guard the other silently loses.
 */

/**
 * Default bound on a single tool call, in ms. Ten minutes is far above anything
 * legitimate — the slowest tool is `create_pr`, and lib/github.ts already caps
 * each of its subprocesses at 120s — and far below the CLI's ~27.7 hours.
 * Callers pass their own; 0 means unbounded, which only `ask_user` needs,
 * because that one is waiting on a human and a human may take all day.
 */
export const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 10 * 60 * 1000;

/** The sentinel the bounded wait resolves with. Never leaves this module. */
const TIMED_OUT = Symbol("calandria.agentTool.timedOut");

/** An MCP tool result carrying `text`, flagged so the model reads it as a failure. */
export function toolErrorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

/** What the model is told when a handler threw. */
export function toolFailureMessage(name, error) {
  const raw = error && typeof error.message === "string" ? error.message : String(error);
  const message = raw.trim() || "no error message";
  return (
    `${name} failed and did nothing: ${message}. ` +
    `Do not report this as done — retry it, or tell the user it failed and what you were trying to do.`
  );
}

/**
 * What the model is told when a handler ran past its bound. Deliberately does
 * NOT claim nothing happened: the work is still running and may yet land, so the
 * honest instruction is to go and look rather than to assume either way.
 */
export function toolTimeoutMessage(name, timeoutMs) {
  return (
    `${name} did not answer within ${Math.round(timeoutMs / 1000)}s and was abandoned. ` +
    `It may or may not have taken effect, so treat it as unfinished: verify the result before reporting anything as done.`
  );
}

/** What the model is told when a handler answered with nothing. The bug this file exists for. */
export function blankToolResultMessage(name) {
  return (
    `${name} returned an empty result, so the call did not complete and nothing was done. ` +
    `Do not report this as successful. Retry it, and if it stays empty, stop and tell the user the ` +
    `Calandria tool bridge is returning empty results — every tool call is unreliable until it recovers.`
  );
}

/**
 * Is this result one the model would read as a silent success while saying
 * nothing? Anything that is not an object, carries no `content` array, carries
 * an empty one, or carries only text parts that are missing or whitespace.
 *
 * `structuredContent` alone is a legitimate answer, and a non-text part (an
 * image, an embedded resource) is content even when the text beside it is
 * blank — neither is what went wrong here.
 */
export function isBlankToolResult(result) {
  if (!result || typeof result !== "object") return true;
  if (result.structuredContent !== undefined && result.structuredContent !== null) return false;
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return true;
  return content.every(
    (part) =>
      !part ||
      typeof part !== "object" ||
      (part.type === "text" && (typeof part.text !== "string" || part.text.trim() === ""))
  );
}

/**
 * Wrap one tool handler so it can only ever answer with something the model can
 * act on. Signature-transparent: the wrapper forwards every argument the MCP
 * server passes, so it can be dropped over a handler without the caller knowing
 * what that handler takes.
 *
 * A healthy result is returned untouched — this must not reshape the answers
 * that already work.
 *
 * `timeoutMs: 0` disables the bound.
 *
 * `onStart()` and `onSettle(outcome, ms)` are observation hooks, with `outcome`
 * one of "ok" | "error" | "timeout" | "blank": the seam where a server-side
 * record of the call is written (lib/agentToolLog.ts), so "did the call reach
 * Calandria at all?" is a grep rather than a manual GET. A hook that throws is
 * swallowed — the observer must never become a fourth way for a call to fail.
 */
export function guardToolHandler(name, handler, opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs >= 0 ? opts.timeoutMs : DEFAULT_AGENT_TOOL_TIMEOUT_MS;
  const onStart = typeof opts.onStart === "function" ? opts.onStart : null;
  const onSettle = typeof opts.onSettle === "function" ? opts.onSettle : null;
  return async function guardedAgentTool(...args) {
    const startedAt = Date.now();
    const settle = (outcome, value) => {
      if (onSettle) {
        try {
          onSettle(outcome, Date.now() - startedAt);
        } catch {
          /* an observer must not fail the call */
        }
      }
      return value;
    };
    if (onStart) {
      try {
        onStart();
      } catch {
        /* same */
      }
    }
    let result;
    try {
      if (timeoutMs > 0) {
        // Cleared in the finally so a fast call doesn't leave a ten-minute timer
        // behind, and unref'd so a slow one can't hold the process open.
        let timer;
        const bounded = new Promise((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
          if (timer && typeof timer.unref === "function") timer.unref();
        });
        try {
          // Inside the try, so a handler that throws synchronously is caught too.
          result = await Promise.race([Promise.resolve(handler(...args)), bounded]);
        } finally {
          clearTimeout(timer);
        }
      } else {
        result = await handler(...args);
      }
    } catch (e) {
      return settle("error", toolErrorResult(toolFailureMessage(name, e)));
    }
    if (result === TIMED_OUT) return settle("timeout", toolErrorResult(toolTimeoutMessage(name, timeoutMs)));
    if (isBlankToolResult(result)) return settle("blank", toolErrorResult(blankToolResultMessage(name)));
    return settle("ok", result);
  };
}

/* ---------------------------------------------------------------------------
 * The failure this guard cannot reach: a result the CLI answers itself.
 *
 * Measured on 2026-09-02 (task CrDHcuyuDt1PmLu0PDd1K, Claude Code 2.1.257,
 * server pid unchanged throughout): five in-process Calandria tool calls came
 * back to the model as "The tool call was interrupted before a result was
 * received." Every one of them returned in the SAME SECOND as the call, only
 * `mcp__calandria__*` calls were hit, and Bash calls in the same assistant
 * turns were fine. That sentence is the CLI's, not ours — it is what
 * `callMCPTool` returns when the MCP client rejects with an AbortError,
 * i.e. the tool-call signal was already aborted when the request was made.
 *
 * So the call never reaches an MCP handler and `guardToolHandler` above never
 * runs: this failure sits ABOVE the seam that module guards, not below it.
 * Verified for that session: `tasks.pr_url` stayed empty and no branch was
 * pushed for three `create_pr` calls, and the task the model reported filing
 * was created 23 seconds later by its own `POST /api/tasks` fallback, with
 * `suggested=0`. Nothing landed. The abort can still fire mid-flight, though,
 * so the wording below stops short of promising that.
 *
 * Only the Claude driver's stream pump can see this, because only it reads the
 * tool_result the CLI wrote. The stdio bridge is a separate process and never
 * learns its answer was discarded.
 *
 * Measured over 14 days on 2026-09-03 (486 calls): 1 of 363 calls in a task's
 * first session, 31 of 123 in resumed ones, all on CLI 2.1.257, and a session
 * that has failed once keeps failing — across a `--resume` into a fresh CLI
 * process too — while every built-in tool works. The answer arrives 3–5 ms
 * after the call. Seven SDK spikes (fresh, resumed, background work in flight,
 * subagents, mid-turn input) all passed, so it is not reproducible on demand;
 * lib/agents/CLAUDE.md has the evidence, and CALANDRIA_CLAUDE_DEBUG_DIR is how
 * the next occurrence gets the CLI's own record.
 * ------------------------------------------------------------------------- */

/**
 * The CLI's own sentence, matched as a substring because the rest of it is
 * advice we replace. Classifying vendor text is the house pattern —
 * lib/promptLimits.ts, lib/authFailure.ts and lib/approvalFailure.ts all do it.
 */
export const CLI_INTERRUPTED_TOOL_RESULT = "The tool call was interrupted before a result was received";

/** Did the CLI answer this call itself, without it ever reaching Calandria? */
export function isCliInterruptedToolResult(text) {
  return typeof text === "string" && text.includes(CLI_INTERRUPTED_TOOL_RESULT);
}

/**
 * Is this the agent's name for one of Calandria's own tools? Substring, for the
 * reason lib/suggestionCard.ts gives: the prefix belongs to the driver
 * (`mcp__calandria__` in-process, `calandria__` over the stdio bridge).
 */
export function isCalandriaToolName(name) {
  return typeof name === "string" && name.includes("calandria__");
}

/**
 * What the model is told instead. Names the tool, says who cut the call off,
 * and gives the one instruction that is always right here: go and look. It
 * deliberately does not claim nothing happened — the abort can land after the
 * request went out — which is the same honesty toolTimeoutMessage keeps.
 */
export function toolInterruptedMessage(name) {
  return (
    `${name} was cut off by the agent CLI before Calandria answered, so this result did not come from Calandria. ` +
    `It may or may not have taken effect: check whether the work landed before reporting anything as done, then retry if it did not.`
  );
}

/**
 * The transcript line the USER sees the first time a turn hits this. The model
 * cannot be reached (it is holding the CLI's sentence, above), but the person
 * watching can, and the one thing measured to help is theirs to do: a fresh
 * session. Measured 2026-08-20..2026-09-03 on this instance (CLI 2.1.257): 1 of
 * 363 calls in a task's FIRST session failed this way, against 31 of 123 in
 * resumed sessions, and once a session starts failing it keeps failing while
 * Bash, Read and Edit carry on. `/clear` ends the generation and starts the
 * next one without `--resume`, which is the fresh-session case.
 */
export function toolCutoffNotice(name) {
  return (
    `The Claude CLI cut off the ${name} call before it reached Calandria, so nothing was done. ` +
    `Once this starts it usually persists for the rest of the session while other tools keep working; ` +
    `/clear starts a fresh session, where Calandria's tools reliably work.`
  );
}
