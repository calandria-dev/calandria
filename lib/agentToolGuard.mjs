/* Makes an agent tool's failure LOUD.
 *
 * A Calandria tool call can fail with no error: an empty result reads as a
 * success, so the model cannot tell it apart and may report work done that
 * never landed. Whatever is dropping the answer sits below this seam, so this
 * module guarantees only its own contract: whatever happens, what comes back
 * is a sentence the model can read and relay.
 *
 * Three ways a call can fail to answer, one shape of answer:
 *
 *   - it throws          -> the message, named with the tool that produced it
 *   - it never returns   -> a bounded wait, then a loud abandonment
 *   - it returns nothing -> an empty or all-blank result is rewritten as an error
 *
 * The bound matters because the CLI's own per-call MCP timeout defaults to 1e8
 * ms (~27.7 hours) and is not settable per in-process server, and the SDK host
 * awaits a handler indefinitely, so nothing else in the stack would end that
 * wait. `create_pr` is the shape that would test it: it commits, pushes over
 * the network and shells out to `gh`.
 *
 * Plain .mjs with no imports so the Claude driver (TypeScript, in-process SDK
 * MCP server) and scripts/calandria-mcp.mjs (plain Node, stdio bridge) share ONE
 * copy. Those are the only two ways a Calandria tool call reaches a model, and a
 * guard covering only one of them would leave the other unguarded.
 */

/**
 * Default bound on a single tool call, in ms. Ten minutes is far above anything
 * legitimate (the slowest tool is `create_pr`, and lib/github.ts already caps
 * each of its subprocesses at 120s) and far below the CLI's ~27.7 hours.
 * Callers pass their own; 0 means unbounded, which only `ask_user` needs,
 * since that one waits on a human who may take all day.
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
    `Do not report this as done. Retry it, or tell the user it failed and what you were trying to do.`
  );
}

/**
 * What the model is told when a handler ran past its bound. Does not claim
 * nothing happened: the work may still be running and may yet land, so the
 * instruction is to check what actually happened instead of assuming.
 */
export function toolTimeoutMessage(name, timeoutMs) {
  return (
    `${name} did not answer within ${Math.round(timeoutMs / 1000)}s and was abandoned. ` +
    `It may or may not have taken effect, so treat it as unfinished: verify the result before reporting anything as done.`
  );
}

/** What the model is told when a handler answered with nothing. */
export function blankToolResultMessage(name) {
  return (
    `${name} returned an empty result, so the call did not complete and nothing was done. ` +
    `Do not report this as successful. Retry it, and if it stays empty, stop and tell the user the ` +
    `Calandria tool bridge is returning empty results, so every tool call is unreliable until it recovers.`
  );
}

/**
 * Is this result one the model would read as a silent success while saying
 * nothing? Anything that is not an object, carries no `content` array, carries
 * an empty one, or carries only text parts that are missing or whitespace.
 *
 * `structuredContent` alone is a legitimate answer, and a non-text part (an
 * image, an embedded resource) is content even when the text beside it is
 * blank; neither counts as blank here.
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
 * Wraps one tool handler so it can only ever answer with something the model
 * can act on. Signature-transparent: the wrapper forwards every argument the
 * MCP server passes, so it can be dropped over a handler without the caller
 * knowing what that handler takes.
 *
 * A healthy result is returned untouched, since this must not reshape the
 * answers that already work.
 *
 * `timeoutMs: 0` disables the bound.
 *
 * `onStart()` and `onSettle(outcome, ms)` are observation hooks, with `outcome`
 * one of "ok" | "error" | "timeout" | "blank": the seam where a server-side
 * record of the call is written (lib/agentToolLog.ts), so "did the call reach
 * Calandria at all?" is answered with a grep, not a manual GET. A hook that throws is
 * swallowed, so an observer can never become a fourth way for a call to fail.
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
 * Some in-process Calandria tool calls come back to the model as "The tool
 * call was interrupted before a result was received." That sentence is the
 * CLI's, not ours: it is what `callMCPTool` returns when the MCP client
 * rejects with an AbortError, meaning the tool-call signal was aborted. The
 * abort lands in one of two places, and they are detected in two different
 * places:
 *
 *   before the request goes out  the call never reaches an MCP handler, so
 *                                `guardToolHandler` never runs and nothing
 *                                server-side is touched. Only a driver that
 *                                reads the tool_result the CLI wrote can see
 *                                it: the Claude stream pump, via
 *                                isCliInterruptedToolResult below. Over the
 *                                stdio bridge the request is never sent, so
 *                                the bridge process has nothing to observe;
 *                                nothing ran, so nothing was lost either.
 *
 *   after the request goes out   the handler runs, Calandria does the work,
 *                                and the answer is thrown away. In-process
 *                                this looks identical to the case above. Over
 *                                the stdio bridge it is a protocol event: the
 *                                MCP client sends notifications/cancelled (or
 *                                the transport closes), the SDK aborts the
 *                                request handler's signal and then DROPS the
 *                                response instead of sending it. That signal
 *                                is what watchToolCancellation below watches,
 *                                so the bridge does learn its answer was
 *                                discarded, for the half of the failure where
 *                                real work may already have landed.
 *
 * A session that has failed once tends to keep failing for the rest of it,
 * including across a `--resume` into a fresh CLI process, while every built-in
 * tool keeps working; `/clear` starts a fresh session and clears it.
 * lib/agents/CLAUDE.md has more detail, and CALANDRIA_CLAUDE_DEBUG_DIR is how
 * a future occurrence gets the CLI's own record.
 * ------------------------------------------------------------------------- */

/**
 * The CLI's own sentence, matched as a substring because the rest of it is
 * advice we replace. Classifying vendor text is the house pattern:
 * lib/promptLimits.ts, lib/authFailure.ts and lib/approvalFailure.ts all do it.
 */
export const CLI_INTERRUPTED_TOOL_RESULT = "The tool call was interrupted before a result was received";

/** Did the CLI answer this call itself, without it ever reaching Calandria? */
export function isCliInterruptedToolResult(text) {
  return typeof text === "string" && text.includes(CLI_INTERRUPTED_TOOL_RESULT);
}

/**
 * Codex CLI failure texts captured from a Calandria MCP item that failed
 * before the client dispatched a request to the bridge. A 0.153.4
 * `codex exec --json` capture emitted the approval-policy text. Earlier
 * 0.142.5 and 0.146.0 CLI captures emitted the cancellation text. Match
 * vendor text as a substring because the surrounding item error can vary by
 * transport.
 */
export const CODEX_PRE_DISPATCH_TOOL_CUTOFFS = [
  "MCP tool call requires approval, but approval policy is never",
  "user cancelled MCP tool call",
];

/** Did Codex reject this MCP call before it dispatched it to Calandria? */
export function isCodexPreDispatchToolCutoff(text) {
  return typeof text === "string" && CODEX_PRE_DISPATCH_TOOL_CUTOFFS.some((phrase) => text.includes(phrase));
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
 * and gives the instruction that is always right here: check whether the work
 * landed. It does not claim nothing happened, since the abort can land after
 * the request went out, matching the honesty toolTimeoutMessage keeps.
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
 * watching can, and the one thing that helps is theirs to do: start a fresh
 * session. Once this starts it tends to persist for the rest of the session
 * while Bash, Read and Edit carry on. `/clear` ends the generation and starts
 * the next one without `--resume`, which is the fresh-session case.
 *
 * Says "the agent CLI", not "the Claude CLI": every agent reaching Calandria
 * over the stdio bridge can cut a call off the same way.
 */
export function toolCutoffNotice(name) {
  return (
    `The agent CLI cut off the ${name} call before it reached Calandria, so nothing was done. ` +
    `Once this starts it usually persists for the rest of the session while other tools keep working; ` +
    `/clear starts a fresh session, where Calandria's tools reliably work.`
  );
}

/**
 * The USER-facing line for the other half: the call DID reach Calandria and the
 * CLI threw the answer away. The recovery advice is the same, but the warning is
 * different and sharper, because work may already have landed and a retry would
 * repeat it.
 *
 * It does not say whether the call finished. The cancellation arrives while the
 * handler is still running (that is the only window in which it can be seen),
 * and the handler may well go on to succeed afterwards, so "it took effect" is
 * never a fact this line can state.
 */
export function toolDiscardedNotice(name) {
  return (
    `The agent CLI cancelled the ${name} call after it had already reached Calandria, so Calandria's answer was ` +
    `thrown away and the model never saw it. The call may still have taken effect, so check that before letting the ` +
    `model retry it, or the work may be done twice. ` +
    `/clear starts a fresh session, where Calandria's tools reliably work.`
  );
}

/**
 * The MCP `extra` argument an SDK tool handler is passed, found by shape. A
 * handler with an input schema is called `(args, extra)` and one without is
 * called `(extra)`, so the position is not fixed; the AbortSignal is, and it is
 * the only thing wanted here.
 */
function requestSignalOf(args) {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (!a || typeof a !== "object") continue;
    const signal = a.signal;
    if (signal && typeof signal === "object" && typeof signal.addEventListener === "function" && "aborted" in signal) {
      return signal;
    }
  }
  return null;
}

/** The cancellation's own words, if it brought any. */
function abortReasonOf(signal) {
  const reason = signal.reason;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  if (reason && typeof reason.message === "string" && reason.message.trim()) return reason.message.trim();
  return "";
}

/**
 * Wraps one tool handler so a cancellation that lands AFTER the request was
 * dispatched is reported instead of vanishing. This is the stdio bridge's half
 * of the cut-off detection the Claude stream pump does for the in-process
 * transport (see the block above).
 *
 * The signal it watches is the MCP SDK's per-request AbortController, aborted
 * by `notifications/cancelled` from the client or by the transport closing. In
 * both cases the SDK drops the handler's result instead of sending it, so an
 * abort seen here means this answer will not reach the model, whatever the
 * handler goes on to return.
 *
 * `onCutoff({ tool, reason, ms })` fires at most once per call, as soon as the
 * abort is seen, without waiting for the handler to unwind: the same event that
 * cancels the call is often the transport dropping, and this process may be
 * killed moments later, so the report has to go out while it still can.
 * Observation only: a throw from it is swallowed and the handler's own answer is
 * untouched, for the reason guardToolHandler's hooks are swallowed. Goes OUTSIDE
 * that guard, so it watches the whole in-flight window including the guard's own
 * deadline.
 */
export function watchToolCancellation(name, handler, opts = {}) {
  const onCutoff = typeof opts.onCutoff === "function" ? opts.onCutoff : null;
  if (!onCutoff) return handler;
  return async function watchedAgentTool(...args) {
    const signal = requestSignalOf(args);
    if (!signal) return handler(...args);
    const startedAt = Date.now();
    let reported = false;
    const fire = () => {
      if (reported) return;
      reported = true;
      try {
        onCutoff({ tool: name, reason: abortReasonOf(signal), ms: Date.now() - startedAt });
      } catch {
        /* an observer must not fail the call */
      }
    };
    // Already aborted at entry: the SDK still calls the handler, and will still
    // drop whatever it returns, so this counts.
    if (signal.aborted) fire();
    const onAbort = () => fire();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await handler(...args);
    } finally {
      // Covers an abort landing between the handler returning and the SDK
      // checking `aborted` to decide whether to send. Still a dropped answer,
      // and `reported` keeps it to one report either way.
      if (signal.aborted) fire();
      signal.removeEventListener("abort", onAbort);
    }
  };
}
