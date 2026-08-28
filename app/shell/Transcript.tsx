"use client";

import { memo, useCallback, useEffect, useState } from "react";
import type { ToolData, ToolPeek, AskQuestion, AskAnswers, PermissionDecision, SuggestionCard } from "@/lib/types";
import { Icon } from "../icons";
import { Markdown } from "../Markdown";
import { jget } from "./api";
import { PriPill } from "./shared";
import { clockTime, diffCls, splitAttachments, type MsgAttachment } from "./format";
import { CONTEXT_OVERFLOW_NOTICE } from "@/lib/promptLimits";
import { AUTH_EXPIRED_NOTICE } from "@/lib/authFailure";
import { USAGE_LIMIT_NOTICE } from "@/lib/usageLimit";
import { deferredStartFor } from "@/lib/usageReset";
import { wakeLabel } from "./snooze";
import { resetClock } from "./queuedStart";
import { APPROVAL_BLOCKED_NOTICE } from "@/lib/approvalFailure";
import { WORKTREE_REPAIR_NOTICE } from "@/lib/worktreeFailure";
import type { Msg } from "./types";
import { Avatar } from "./shared";

// The always-visible "peek" tier — Claude Code's `⎿` line. Counts show no
// content; diffs/snippets show a capped hunk with a clickable "+N more" that
// opens the full body. TodoWrite renders its checklist inline.
function PeekView({ peek, expandable, onExpand }: { peek: ToolPeek; expandable: boolean; onExpand: () => void }) {
  const corner = <span className="tcorner">⎿</span>;
  if (peek.kind === "count") {
    return (
      <button className="tpeek tpeek-count" style={{ cursor: expandable ? "pointer" : "default" }} onClick={() => expandable && onExpand()}>
        {corner}<span className="tpeek-txt">{peek.text}</span>
        {expandable && <span className="tpeek-more">expand</span>}
      </button>
    );
  }
  if (peek.kind === "todos") {
    return (
      <div className="tpeek tpeek-todos">
        {peek.items.map((t, i) => (
          <div className={`tdo ${t.status}`} key={i}>
            <span className="tdo-box">{t.status === "completed" ? "✔" : t.status === "in_progress" ? "▣" : "▢"}</span>
            <span className="tdo-txt">{t.text}</span>
          </div>
        ))}
      </div>
    );
  }
  if (peek.kind === "diff") {
    return (
      <div className="tpeek tpeek-diff">
        <div className="tpeek-sum">{corner}<span className="dstat add">+{peek.added}</span><span className="dstat del">−{peek.removed}</span>{peek.label && <span className="tpeek-txt">{peek.label}</span>}</div>
        <pre className="tpeek-pre diff">{peek.lines.map((l, i) => <div className={`dl ${diffCls(l.sign)}`} key={i}>{l.sign} {l.text}</div>)}</pre>
        {peek.truncated ? <button className="tpeek-more btn-link" onClick={onExpand}>+{peek.truncated} more lines</button> : null}
      </div>
    );
  }
  // fail: the exit status and the LAST lines — the reason for a non-zero exit
  // is at the end of the output, so that's what shows without expanding. Only
  // the status is red; the output itself isn't the error.
  if (peek.kind === "fail") {
    return (
      <div className="tpeek tpeek-fail">
        <div className="tpeek-sum">{corner}<span className="tpeek-fail-label">{peek.label ?? "Failed"}</span></div>
        <pre className="tpeek-pre">{peek.lines.join("\n") || "(no output)"}</pre>
        {peek.omitted ? <button className="tpeek-more btn-link" onClick={onExpand}>+{peek.omitted} earlier lines</button> : null}
      </div>
    );
  }
  // lines (Bash output)
  return (
    <div className="tpeek tpeek-lines">
      {peek.label && <div className="tpeek-sum">{corner}<span className="tpeek-txt">{peek.label}</span></div>}
      <pre className="tpeek-pre">{peek.lines.join("\n") || "(no output)"}</pre>
      {peek.truncated ? <button className="tpeek-more btn-link" onClick={onExpand}>+{peek.truncated} more lines</button> : null}
    </div>
  );
}

// `onCollaborate` opens a file the call wrote in collaboration mode. The card
// is the entry point that doesn't go through git: `data.file` is set by the
// runner from the path the agent WROTE, so a gitignored scratch doc — which
// the Changes tab never lists — is reachable the moment the Write lands.
function ToolView({ data, onCollaborate }: { data: ToolData; onCollaborate?: (file: string) => void }) {
  const [open, setOpen] = useState(false);
  const hasDiff = !!data.diff?.length;
  const expandable = !!(data.detail || hasDiff || data.result !== undefined);
  // A failure surfaces its reason without a click. Results persisted with a
  // `fail` peek show it there (status + the tail of the output); older rows
  // and drivers that peek nothing fall back to opening the whole body, which
  // is what every failure did before — 6000 red chars with the reason clipped
  // off the end, i.e. an "error banner" over output that looked fine.
  const showBody = open || (!!data.isError && data.result !== undefined && !data.peek);
  const file = data.file;
  return (
    <div className="tool">
      <div className="tool-hrow">
        <button className="tool-h" style={{ cursor: expandable ? "pointer" : "default" }} onClick={() => expandable && setOpen((o) => !o)}>
          {expandable && <span className={`tchev ${showBody ? "open" : ""}`}>{Icon.chevRight()}</span>}
          <span className="tbullet">●</span>
          <span className="tg">{data.title}</span>
          {data.result !== undefined && <span className={data.isError ? "tx" : "tcheck"}>{data.isError ? Icon.x() : Icon.check()}</span>}
        </button>
        {file && onCollaborate && !data.isError && (
          <button className="tc-fact tool-collab" title={`Open ${file} in collaboration mode: edit the file and attach comments`} onClick={() => onCollaborate(file)}>
            {Icon.edit()} Collaborate
          </button>
        )}
      </div>
      {data.peek && !showBody && <PeekView peek={data.peek} expandable={expandable} onExpand={() => setOpen(true)} />}
      {showBody && (
        <div className="tool-body">
          {data.detail && <pre className="tool-pre">{data.detail}</pre>}
          {hasDiff && (
            <pre className="tool-pre diff">{data.diff!.map((l, i) => <div className={`dl ${diffCls(l.sign)}`} key={i}>{l.sign} {l.text}</div>)}</pre>
          )}
          {data.result !== undefined && (
            <>
              {(data.detail || hasDiff) && <div className="tool-divider">result</div>}
              <pre className={`tool-pre ${data.isError ? "err" : ""}`}>{data.result || "(no output)"}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Interactive AskUserQuestion card: option pickers (+ an "Other" free-text per
// question) while pending; a read-only summary once answered.
function AskView({ data, agentLabel, onAnswer }: { data: ToolData; agentLabel: string; onAnswer: (answers: AskAnswers) => void }) {
  const questions = data.ask?.questions ?? [];
  const existing = data.ask?.answers;
  const [state, setState] = useState(() => questions.map(() => ({ picked: [] as string[], other: "" })));
  const [submitted, setSubmitted] = useState(false);

  if (existing) {
    return (
      <div className="ask answered">
        <div className="ask-head">{Icon.spark()} You answered</div>
        {questions.map((q, i) => (
          <div className="ask-q" key={i}>
            <div className="ask-qh"><span className="ask-chip">{q.header}</span>{q.question}</div>
            <div className="ask-picked">{(existing[i] ?? []).join(", ") || "—"}</div>
          </div>
        ))}
      </div>
    );
  }

  const toggle = (qi: number, label: string, multi: boolean) =>
    setState((s) => s.map((st, i) => {
      if (i !== qi) return st;
      if (multi) {
        const has = st.picked.includes(label);
        return { ...st, picked: has ? st.picked.filter((l) => l !== label) : [...st.picked, label] };
      }
      return { picked: [label], other: "" }; // single-select replaces, clears Other
    }));
  const setOther = (qi: number, v: string) =>
    setState((s) => s.map((st, i) => (i === qi ? (questions[i].multiSelect ? { ...st, other: v } : { picked: [], other: v }) : st)));

  const answers: AskAnswers = state.map((st) => [...st.picked, ...(st.other.trim() ? [st.other.trim()] : [])]);
  const complete = answers.every((a) => a.length > 0);
  const submit = () => { if (complete && !submitted) { setSubmitted(true); onAnswer(answers); } };

  return (
    <div className="ask">
      <div className="ask-head">{Icon.spark()} {agentLabel} needs your input</div>
      {questions.map((q, i) => (
        <div className="ask-q" key={i}>
          <div className="ask-qh"><span className="ask-chip">{q.header}</span>{q.question}{q.multiSelect && <span className="ask-multi">pick any</span>}</div>
          <div className="ask-opts">
            {q.options.map((o) => (
              <button key={o.label} className={`ask-opt ${state[i].picked.includes(o.label) ? "on" : ""}`} onClick={() => toggle(i, o.label, !!q.multiSelect)} disabled={submitted}>
                <span className="ask-opt-l">{o.label}</span>
                {o.description && <span className="ask-opt-d">{o.description}</span>}
              </button>
            ))}
            <input className="ask-other" placeholder="Other…" value={state[i].other} disabled={submitted} onChange={(e) => setOther(i, e.target.value)} />
          </div>
        </div>
      ))}
      <div className="ask-foot">
        <button className="btn btn-accent btn-sm" onClick={submit} disabled={!complete || submitted}>{submitted ? "Sending…" : "Send answer"}</button>
      </div>
    </div>
  );
}

// Who refused, for a card that arrives already settled because Claude Code
// blocked the call itself (PermissionOutcome.reason === "blocked"). Keyed by the
// SDK's decision_reason_type, which is stored raw precisely so this mapping can
// grow: the CLI mints values the SDK's docs don't list, and an unmapped one is
// shown verbatim rather than swallowed — "Blocked by Claude Code" alone would
// hide the only clue about which check fired.
const BLOCKED_BY: Record<string, string> = {
  classifier: "Blocked by Claude Code's safety classifier",
  mode: "Blocked by this task's permission mode",
  rule: "Blocked by a deny rule in your Claude Code settings",
  asyncAgent: "Blocked by Claude Code's background-agent policy",
  subcommandResults: "Blocked by Claude Code: one of the command's subcommands isn't allowed",
};
const blockedHead = (by?: string): string =>
  (by && BLOCKED_BY[by]) || (by ? `Blocked by Claude Code (${by})` : "Blocked by Claude Code");

// Tool-permission card — the canUseTool gate under acceptEdits and plan
// mode" (lib/permissions.ts). Unlike a question card this isn't a multiple
// choice: the user needs the ACTION, so the request's detail (the full Bash
// command, the file path, the plan) is shown verbatim, with the diff when the
// call would write. "Always allow" spells out the exact rule it will store, so
// nobody grants more than they read.
//
// The same card also renders read-only, with no buttons, for a call Claude Code
// refused on its own (the "auto" classifier, a deny rule) — that decision is
// already made, and it arrives settled.
function PermissionView({ data, agentLabel, onDecide }: { data: ToolData; agentLabel: string; onDecide: (decision: PermissionDecision, note: string) => void }) {
  const req = data.permission?.request;
  const outcome = data.permission?.outcome;
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  if (!req) return null;

  // The pre-turn settings gate (lib/settingsDrift.ts, issue #43): the same card
  // asking about a different thing — not one tool call, but the configuration
  // the whole turn would load. Declining doesn't refuse a call and let the
  // session carry on; it means the turn never runs, so every sentence below
  // that promises otherwise has to change. There is also nobody to write a note
  // TO — the agent hasn't started — so the note field goes away with it.
  const settings = req.kind === "settings";

  if (outcome) {
    const allowed = outcome.decision !== "deny";
    const blocked = outcome.reason === "blocked";
    const what = blocked
      ? blockedHead(outcome.blockedBy)
      : settings
        ? allowed
          ? "You approved this settings change"
          : outcome.auto ? "Declined automatically — the turn did not run" : "You declined this settings change"
        : outcome.decision === "allow_always"
          ? `Allowed: ${outcome.remembered ?? "remembered for this project"}`
          : outcome.decision === "allow_once"
            ? "You allowed this once"
            : outcome.auto ? "Declined automatically" : "You declined this";
    return (
      <div className={`perm settled ${allowed ? "ok" : "no"}`}>
        <div className="perm-head">{allowed ? Icon.check() : Icon.x()} {what}</div>
        <div className="perm-what">{req.title}</div>
        {/* On a block: this card was never open, so it's the one place the user
            gets to see what the agent was actually about to run. On a settings
            change: what changed is the whole point of the record, and unlike a
            tool call it stays true afterwards — the file is still sitting in
            the worktree. Every other outcome had its input on screen before it
            settled. */}
        {(blocked || settings) && req.detail && <pre className="perm-pre">{req.detail}</pre>}
        {(blocked || settings) && !!req.diff?.length && (
          <pre className="perm-pre diff">{req.diff.map((l, i) => <div className={`dl ${diffCls(l.sign)}`} key={i}>{l.sign} {l.text}</div>)}</pre>
        )}
        {outcome.note && <div className="perm-note">{outcome.note}</div>}
        {blocked && <div className="perm-hint">You weren&apos;t asked. Change this task&apos;s permission mode if it should have been allowed.</div>}
      </div>
    );
  }

  const decide = (d: PermissionDecision) => { if (!sent) { setSent(true); onDecide(d, note); } };
  return (
    <div className="perm">
      <div className="perm-head">{Icon.lock()} {settings ? "This task's settings changed" : `${agentLabel} needs permission`}</div>
      <div className="perm-what">{req.title}</div>
      {req.description && <div className="perm-sub">{req.description}</div>}
      {req.detail && <pre className="perm-pre">{req.detail}</pre>}
      {!!req.diff?.length && (
        <pre className="perm-pre diff">{req.diff.map((l, i) => <div className={`dl ${diffCls(l.sign)}`} key={i}>{l.sign} {l.text}</div>)}</pre>
      )}
      {!settings && (
        <input className="ask-other" placeholder="Note for the agent (used if you decline)…" value={note} disabled={sent} onChange={(e) => setNote(e.target.value)} />
      )}
      <div className="perm-foot">
        <button className="btn btn-accent btn-sm" onClick={() => decide("allow_once")} disabled={sent}>{settings ? "Run this turn" : "Allow once"}</button>
        {req.scope && (
          <button className="btn btn-sm" onClick={() => decide("allow_always")} disabled={sent} title={req.scope.label}>{req.scope.label}</button>
        )}
        <button className="btn btn-sm btn-danger" onClick={() => decide("deny")} disabled={sent}>Decline</button>
      </div>
      <div className="perm-hint">
        {settings
          ? "Declining ends this turn before the agent starts — nothing runs under the new settings. Revert the file, or send again and approve, to carry on."
          : "Declines automatically if nobody responds. The session keeps running either way."}
      </div>
    </div>
  );
}

/**
 * The three handlers a suggestion card in the transcript needs, and the project
 * it is being read FROM. All three are the tray's own — a suggestion started
 * here has to be indistinguishable from one started there (same worktree cut,
 * same agent resolution, same auto-start-dependents sweep), which is only true
 * if it goes down the same code path rather than a second copy of it.
 */
export interface SuggestionActions {
  /** The project whose session the transcript belongs to — see SuggestionView. */
  projectId: string;
  onStart: (taskId: string) => void | Promise<void>;
  onAccept: (taskId: string) => void | Promise<void>;
  onDismiss: (taskId: string) => void | Promise<void>;
}

// A suggestion filed by a `suggest_task` call, rendered on the call's own row.
//
// State is NEVER held here between renders: the transcript is persisted and a
// reload must not resurrect a Start button for a task that has since been
// started, accepted, withdrawn or hard-deleted. So the card holds two ids and
// re-reads the task (GET /api/tasks/[id]/suggestion) on mount and after every
// action; what it offers is a function of the row it gets back.
//
//   still in the tray   → Start · Add · Dismiss
//   accepted (suggested=0, started=0) → "Added to the task list"
//   started             → "Session started"
//   withdrawn (still in the tray, cancelled, with a reason) → struck through,
//                         Restore in place of Add, the rest unchanged
//   404                 → "No longer exists" (Dismiss is a hard delete)
//
// START AND ANOTHER PROJECT. `suggest_task` can file into ANY project, and
// starting a task mints its session and selects it — which, for a suggestion
// filed elsewhere, means being pulled out of the session you are reading and
// into a project you may not have had on screen. That is a bigger, less
// recoverable interruption than walking to the other project's tray, and the
// tray is right there. So Start is offered only for a suggestion filed into the
// project this transcript belongs to; a cross-project card names where the task
// went and offers Add and Dismiss, neither of which navigates anywhere.
function SuggestionView({ data, actions }: { data: ToolData; actions?: SuggestionActions }) {
  const ref = data.suggestion;
  const taskId = ref?.taskId;
  const [card, setCard] = useState<SuggestionCard | null>(null);
  // Distinguished from "not loaded yet" so the first paint isn't an empty card
  // and a deleted task isn't mistaken for a slow one.
  const [state, setState] = useState<"loading" | "ready" | "gone" | "error">("loading");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!taskId) return;
    try {
      setCard(await jget<SuggestionCard>(`/api/tasks/${taskId}/suggestion`));
      setState("ready");
    } catch (e) {
      // A hard delete is the expected failure, and it is a real answer; only an
      // actual fetch failure is worth saying nothing useful about.
      setState(e instanceof Error && /not found/i.test(e.message) ? "gone" : "error");
    }
  }, [taskId]);
  useEffect(() => { void load(); }, [load]);

  if (!ref || !taskId) return null;

  const act = async (fn: (id: string) => void | Promise<void>) => {
    setBusy(true);
    try { await fn(taskId); } finally { setBusy(false); }
    await load();
  };

  if (state === "loading") return <div className="sugcard loading">{Icon.spark()} Suggested a task…</div>;
  if (state === "gone") {
    return (
      <div className="sugcard gone">
        <div className="sugcard-head">{Icon.x()} Suggestion no longer exists</div>
        <div className="sugcard-note">It was dismissed, or the task was deleted.</div>
      </div>
    );
  }
  if (state === "error" || !card) {
    return <div className="sugcard gone"><div className="sugcard-head">{Icon.x()} Couldn&apos;t read this suggestion</div></div>;
  }

  const withdrawn = card.suggested === 1 && card.status === "cancelled";
  // Still in the tray = still the user's to decide, withdrawn included: a
  // retraction is the agent's recommendation to drop it, not a deletion, and
  // the tray keeps Restore/Start/✕ on those rows. The card offers the same
  // three so the two surfaces can't disagree about what is still actionable.
  const actionable = card.suggested === 1;
  const elsewhere = card.project_id !== actions?.projectId;
  const what = card.started === 1
    ? "Session started"
    : card.suggested === 0
      ? "Added to the task list"
      : withdrawn
        ? `Withdrawn${card.withdrawn_reason ? ` — ${card.withdrawn_reason}` : ""}`
        : "Suggested a task";

  return (
    <div className={`sugcard ${actionable && !withdrawn ? "open" : "settled"} ${withdrawn ? "withdrawn" : ""}`}>
      <div className="sugcard-head">{actionable && !withdrawn ? Icon.spark() : Icon.check()} {what}</div>
      <div className="sugcard-title">
        <span className={withdrawn ? "struck" : ""}>{card.title}</span>
        <PriPill p={card.priority} />
        {/* Always named, never assumed: a suggestion can be filed anywhere, and
            "which project did that go into" is the first thing the card has to
            answer for a cross-project one. */}
        <span className="sugcard-proj" title={elsewhere ? "Filed into another project" : "Filed into this project"}>
          {Icon.folder()} {card.project_name}
        </span>
      </div>
      {card.description && <div className="sugcard-why">{card.description}</div>}
      {!!card.blocked_by.length && (
        <div className="sugcard-blocked">
          {Icon.lock()} Blocked by {card.blocked_by.map((b) => b.title).join(", ")}
        </div>
      )}
      {actionable && actions && (
        <div className="sugcard-acts">
          {elsewhere ? (
            <span className="sugcard-note">Open {card.project_name} to start it — starting it here would leave this session.</span>
          ) : (
            <button className="btn btn-accent btn-sm" disabled={busy} onClick={() => act(actions.onStart)} title="Cut a worktree and start the session now">
              {Icon.play()} Start
            </button>
          )}
          <button className="btn btn-sm" disabled={busy} onClick={() => act(actions.onAccept)} title={withdrawn ? "Disagree — restore it to the task list" : "Add to the task list to start later"}>
            {Icon.plus()} {withdrawn ? "Restore" : "Add"}
          </button>
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => act(actions.onDismiss)} title="Dismiss — deletes the task">
            {Icon.x()} Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// Attachment chips parsed out of a user message's markers: image thumbnails
// (click opens full size) and text-file chips (a big paste diverted to a file;
// click opens it). Both are served from the task's uploads dir.
function AttachmentStrip({ items }: { items: MsgAttachment[] }) {
  if (!items.length) return null;
  return (
    <div className="msg-attachments">
      {items.map((a, i) =>
        a.kind === "image" ? (
          <a key={i} href={a.url} target="_blank" rel="noreferrer" title="Open full size">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.url} alt="attached image" loading="lazy" />
          </a>
        ) : (
          <a key={i} href={a.url} target="_blank" rel="noreferrer" className="file-chip" title={`Open ${a.name}`}>
            {Icon.clip()} <span>attached file</span>
          </a>
        )
      )}
    </div>
  );
}

// Memoized: during a live turn every SSE event re-renders the transcript's
// parents, but message objects are append-only (replaced only when their content
// changes), so unchanged messages skip re-rendering — and re-parsing their
// markdown — entirely. Callers must pass identity-stable handlers or the memo
// is defeated (SessionView wraps its handlers for exactly this reason).
// The usage-limit notice's one action, supplied only for the LAST message of
// the transcript (an old notice from a limit that has since healed must not
// offer to queue anything): `queuedAt` is the task's start_at (0 = not
// queued), `resetAt` the reset the plan meter currently reports (null = none
// known — a Codex task, or no telemetry yet), and the two handlers set/clear
// the deadline. See app/shell/queuedStart.ts.
export interface LimitResume {
  queuedAt: number;
  resetAt: number | null;
  onQueue: (at: number) => void;
  onCancel: () => void;
}

/**
 * The "Repair worktree" affordance on a worktree-prep failure. Owns its own
 * busy/error state because its handler does two round trips (repair, then the
 * resend) and the first can fail on its own terms — the other recovery buttons
 * are one fire-and-forget send, and their failure comes back as a fresh
 * transcript line. Not memoized: it's rendered once, on one message.
 */
function RepairWorktree({ msgId, running, onRepair }: { msgId: string; running?: boolean; onRepair: (msgId: string) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="overflow-actions">
      <button
        className="btn btn-sm"
        disabled={busy || running}
        title="Clear the stale lock, prune the stale registration, cut the worktree again, and send the message"
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try { setErr(await onRepair(msgId)); } finally { setBusy(false); }
        }}
      >
        {Icon.restore()} {busy ? "Repairing…" : "Repair worktree"}
      </button>
      {err && <span className="queued-note">{err}</span>}
    </div>
  );
}

export const MessageView = memo(function MessageView({ m, initial, hideWho, running, agent, agentLabel = "The agent", onAnswer, onDecidePermission, onCancelQueued, onClear, onReconnect, onRetry, onRepairWorktree, onCollaborate, suggestionActions, limitResume }: { m: Msg; initial: boolean; hideWho: boolean; running?: boolean; agent?: string | null; agentLabel?: string; onAnswer?: (askId: string, questions: AskQuestion[], answers: AskAnswers) => void; onDecidePermission?: (permId: string, decision: PermissionDecision, note: string) => void; onCancelQueued?: (pendingId: string) => void; onClear?: () => void; onReconnect?: () => void; onRetry?: (msgId: string) => void; onRepairWorktree?: (msgId: string) => Promise<string | null>; onCollaborate?: (file: string) => void; suggestionActions?: SuggestionActions; limitResume?: LimitResume }) {
  if (m.role === "queued") {
    // A follow-up the user typed mid-turn, waiting its turn. Reads like a user
    // bubble but dimmed, tagged "Queued", with an × to drop it before it runs.
    const { text, attachments } = splitAttachments(m.content);
    return (
      <div className="msg user queued">
        <div className="who"><Avatar who="user" /> You<span className="badge queued-badge">queued</span>{m.ts != null && <span className="msg-time">{clockTime(m.ts)}</span>}</div>
        <div className="msg-body">
          {text && <Markdown>{text}</Markdown>}
          <AttachmentStrip items={attachments} />
          {onCancelQueued && <button className="queued-x" title="Remove from queue" aria-label="Remove from queue" onClick={() => onCancelQueued(m.id)}>{Icon.x()}</button>}
        </div>
      </div>
    );
  }
  if (m.role === "tool") {
    let data: ToolData;
    try { data = JSON.parse(m.content) as ToolData; } catch { data = { title: m.content }; }
    if (data.ask) {
      return <div className="msg msg-tool"><AskView data={data} agentLabel={agentLabel} onAnswer={(answers) => onAnswer?.(data.ask?.id || m.toolId || "", data.ask?.questions ?? [], answers)} /></div>;
    }
    if (data.permission) {
      return <div className="msg msg-tool"><PermissionView data={data} agentLabel={agentLabel} onDecide={(d, note) => onDecidePermission?.(data.permission?.request.id || m.toolId || "", d, note)} /></div>;
    }
    // A suggest_task call that actually filed a task carries its card BELOW the
    // ordinary tool row rather than replacing it: the call, its input and its
    // result are still what happened, and the proposal is the artifact it left.
    return (
      <div className="msg msg-tool">
        <ToolView data={data} onCollaborate={onCollaborate} />
        {data.suggestion && <SuggestionView data={data} actions={suggestionActions} />}
      </div>
    );
  }
  if (m.role === "system") {
    // A context-overflow failure: render the warning line plus a one-click path
    // to /clear, which resets the poisoned session and starts a fresh window
    // (carrying a summary over). The notice string is matched verbatim — it's
    // the durable, reconnect-safe channel written by lib/runner.ts.
    if (m.content.includes(CONTEXT_OVERFLOW_NOTICE)) {
      return (
        <div className="msg system overflow">
          <div className="msg-body">
            {m.content}
            {onClear && (
              <div className="overflow-actions">
                <button className="btn btn-sm" onClick={onClear} disabled={running} title="Save a summary and start a fresh context window">
                  {Icon.clear()} Start fresh context
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }
    // The agent's login died: same shape as the overflow case — the warning line
    // plus the one action that fixes it (Settings → Agents, where the connect
    // flow lives). Instance-wide, so the titlebar banner says it too; this is
    // the in-context copy for whoever is reading the failed task.
    if (m.content.includes(AUTH_EXPIRED_NOTICE)) {
      return (
        <div className="msg system overflow">
          <div className="msg-body">
            {m.content}
            {onReconnect && (
              <div className="overflow-actions">
                <button className="btn btn-sm" onClick={onReconnect} title={`Sign in to ${agentLabel} again`}>
                  {Icon.bolt()} Reconnect {agentLabel}
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }
    // The agent's usage limit is spent: same shape as the two cases above. The
    // only recovery is waiting for the reset — so the one action is to have
    // the wait done for you: queue the task to resume on its own once the
    // reset the plan meter reports has passed (lib/deferredStart.ts). Offered
    // only on the newest message (see LimitResume) and only when a reset time
    // is actually known; once queued, the same slot says so and offers Cancel.
    if (m.content.includes(USAGE_LIMIT_NOTICE)) {
      return (
        <div className="msg system overflow">
          <div className="msg-body">
            {m.content}
            {limitResume && limitResume.queuedAt > 0 && (
              <div className="overflow-actions queued">
                <span className="queued-note">{Icon.clock()} Queued: resumes {wakeLabel(limitResume.queuedAt)}.</span>
                <button className="btn btn-sm" onClick={limitResume.onCancel} title="Don't resume automatically">Cancel</button>
              </div>
            )}
            {limitResume && limitResume.queuedAt === 0 && limitResume.resetAt != null && (
              <div className="overflow-actions">
                <button className="btn btn-sm" onClick={() => limitResume.onQueue(deferredStartFor(limitResume.resetAt!))} disabled={running}
                  title="Resume this session on its own once the usage window resets: the queued follow-up if there is one, otherwise a continue prompt">
                  {Icon.clock()} Resume when the limit resets ({resetClock(limitResume.resetAt)})
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }
    // The approval policy blocked the turn (enterprise-managed Codex downgraded
    // the driver's "never" to an approval-requiring policy that exec mode can't
    // service): same shape as the cases above, with a Retry button — the driver
    // already switched future turns to the compatible "on-request" policy, so
    // resending the failed message is the recovery (see lib/approvalFailure.ts).
    if (m.content.includes(APPROVAL_BLOCKED_NOTICE)) {
      return (
        <div className="msg system overflow">
          <div className="msg-body">
            {m.content}
            {onRetry && (
              <div className="overflow-actions">
                <button className="btn btn-sm" onClick={() => onRetry(m.id)} disabled={running} title="Send the failed message again">
                  {Icon.bolt()} Retry
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }
    // The worktree couldn't be prepared, in one of the two ways stale git
    // bookkeeping causes (a crashed git's lock file, a registration pointing at
    // a directory that's gone): same shape as the cases above, with a "Repair
    // worktree" button. Unlike them the action isn't a resend — it clears the
    // lock, prunes and re-cuts first (POST /repair-worktree), then sends the
    // failed message — so it reports its own failure inline rather than handing
    // the user a second dead end (see lib/worktreeFailure.ts). The
    // non-recoverable classifications (full disk, detached HEAD) carry their
    // explanation without this notice, and fall through to the plain ⚠ line.
    if (m.content.includes(WORKTREE_REPAIR_NOTICE)) {
      return (
        <div className="msg system overflow">
          <div className="msg-body">
            {m.content}
            {onRepairWorktree && <RepairWorktree msgId={m.id} running={running} onRepair={onRepairWorktree} />}
          </div>
        </div>
      );
    }
    // The glyph the PRODUCER wrote decides the tone: ✓/ℹ/▶ is good news (the
    // "caught up to main" sync note, the parked-queue note, a deferred start
    // firing at the usage-window reset), ⚠ is a warning (every runner error
    // line is minted with one — tests/authFailure.test.ts and e2e/04 count
    // errors by it) and so is ⏰ (a scheduled wakeup that will NOT fire,
    // lib/agents/claude/sessionCrons.ts), and anything else is a quiet note —
    // a background command settling, a service URL, a lingered wake-up (⏵).
    // This used to prepend ⚠ to glyph-less content, which turned every quiet
    // notice into an error banner: `Background command "…" completed (exit
    // code 0)` and the bare description of a command that ran fine both
    // rendered red.
    const tone = /^[✓ℹ▶]/.test(m.content) ? "info" : /^[⚠⏰]/.test(m.content) ? "" : "note";
    return <div className={`msg system${tone ? ` ${tone}` : ""}`}><div className="msg-body">{m.content}</div></div>;
  }
  const isUser = m.role === "user";
  // Only user messages carry attachment markers; assistant text passes through.
  const { text, attachments } = isUser ? splitAttachments(m.content) : { text: m.content, attachments: [] };
  return (
    <div className={`msg ${isUser ? "user" : "assistant"} ${initial ? "initial" : ""}`}>
      {!hideWho && (
        <div className="who">
          <Avatar who={isUser ? "user" : "cc"} agent={agent} />
          {isUser ? "You" : "Agent"}
          {initial && <span className="badge">initial prompt</span>}
          {m.ts != null && <span className="msg-time">{clockTime(m.ts)}</span>}
        </div>
      )}
      <div className="msg-body">
        {initial && <div className="initial-tag">{Icon.spark()} sent with project context</div>}
        {text && <Markdown>{text}</Markdown>}
        <AttachmentStrip items={attachments} />
      </div>
    </div>
  );
});

export function SessionBreak({ summary }: { summary: string }) {
  return (
    <div className="sbreak">
      <span className="ln" />
      <div className="card">
        <div className="cl">{Icon.clear()} context cleared · summary saved</div>
        <div className="ct">{summary}</div>
      </div>
      <span className="ln" />
    </div>
  );
}
