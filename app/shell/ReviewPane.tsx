"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CodeManifest, DocumentManifest, ReviewActionName, ReviewView, SubmissionView } from "@/lib/reviews/types";
import { Icon } from "../icons";
import {
  PREVIEW_REASON, REQUEST_STATE_LABEL, diffLines, diffStats, firstDiffPath, historyRows, reviewDisplay, safeHref, shortDigest, shortSha,
  type ReviewDisplay,
} from "./reviewModel";
import {
  DECISION_IND, DECISION_OK, DECISION_PENDING, RETRY_FEEDBACK_REASON, decisionFailText, feedbackFailText, newIdempotencyKey, postReviewAction, recallFeedback, rememberFeedback,
  type ReviewDecision, type ReviewIntent,
} from "./reviewActions";
import { useArtifact, useRequestHistory, type ArtifactRead } from "./useTaskReviews";
import { ago } from "./workCenterModel";

// The Review tab and the phone Review segment (design release
// work-center-design-release/1, section 5). It shows what an agent explicitly
// submitted: the revision, the pinned artifact it captured and what was decided.
// Every artifact on screen comes from the stored manifest and the review-owned
// refs, never from the task branch or a live file. Decisions post to the review
// action route; Accept never merges, completes or reclaims, and Merge stays in
// the landing controls. C2: there is no "accept anyway" after feedback.

export type ReviewFocus = { taskId: string; requestId: string | null; submissionId: string | null; n: number };

const when = (t: number) => {
  const a = ago(Date.now(), t);
  return a === "now" ? "just now" : `${a} ago`;
};

function Strip({ tone, icon, children, label }: { tone: "ok" | "ind" | "fail" | "pend"; icon?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <div className={`wc-rv-out ${tone}`} role={tone === "fail" || tone === "ind" ? "alert" : "status"} aria-label={label}>
      {tone === "pend" ? <span className="wc-spin" aria-hidden /> : icon}
      <span>{children}</span>
    </div>
  );
}

// ---------- summary ----------

function noteFor(d: ReviewDisplay, view: ReviewView, sub: SubmissionView): ReactNode {
  const n = sub.revision;
  const r = view.applicability.reason;
  const reason = r ? `${r[0].toUpperCase()}${r.slice(1)}.` : "";
  switch (d) {
    case "accepted": return <><b>Accepted.</b> Nothing has merged. Merge from the landing controls pins to the head of rev {n}.</>;
    case "accepted_changed": return <><b>Accepted rev {n}, then it changed.</b> {reason} Acceptance is kept as history. The required review is unsatisfied again until the agent resubmits.</>;
    case "changes_requested": return "Feedback was delivered to the agent as durable work. The agent will resubmit as the next revision.";
    case "feedback_pending": return "Feedback recorded. It is being delivered to the agent.";
    case "delivery_unknown": return <><b>Feedback was recorded, but delivery to the agent is unknown.</b> Nothing is retried automatically.</>;
    case "feedback_failed": return <><b>Feedback was recorded but not delivered.</b> Nothing is retried automatically.</>;
    case "waived": return "The requirement was waived for this submission only. It is not an acceptance and nothing merged.";
    case "withdrawn": return "The agent withdrew this submission. History is kept. There is no decision to make; a required review stays unsatisfied.";
    case "superseded": return `Rev ${n} was superseded. It can be read but not decided on.`;
    case "decision_pending": return "Recording the decision…";
    default:
      if (view.applicability.state === "changed" && sub.artifact.kind === "document") return <><b>The file changed since this revision.</b> {reason} The text below is the exact captured version.</>;
      if (view.applicability.state === "changed") return <><b>The branch moved since this revision.</b> {reason} The diff below is the pinned capture.</>;
      if (view.applicability.state === "unavailable") return <><b>This revision cannot be checked against the task.</b> {reason}</>;
      return sub.artifact.kind === "document"
        ? "Exact bytes of the file at submission. If the file changes in the worktree this revision goes stale."
        : "Captured from a clean worktree. The artifact is immutable; a resubmission creates the next revision.";
  }
}

function Tags({ view, d }: { view: ReviewView; d: ReviewDisplay }) {
  const t: ReactNode[] = [];
  if (view.required) t.push(<span key="req" className="wc-rv-tag req">Required</span>);
  switch (d) {
    case "accepted": t.push(<span key="s" className="wc-rv-tag ok">Accepted</span>); break;
    case "accepted_changed": t.push(<span key="s" className="wc-rv-tag ok">Accepted</span>, <span key="c" className="wc-rv-tag stale">Changed since</span>); break;
    case "changes_requested": case "feedback_pending": t.push(<span key="s" className="wc-rv-tag">Changes requested</span>); break;
    case "delivery_unknown": case "feedback_failed": t.push(<span key="s" className="wc-rv-tag stale">Delivery unknown</span>); break;
    case "waived": t.push(<span key="s" className="wc-rv-tag ok">Waived</span>); break;
    case "withdrawn": t.push(<span key="s" className="wc-rv-tag dim">Withdrawn</span>); break;
    case "superseded": t.push(<span key="s" className="wc-rv-tag dim">Superseded</span>); break;
    case "decision_pending": t.push(<span key="s" className="wc-rv-tag">Recording</span>); break;
    default:
      t.push(<span key="s" className="wc-rv-tag">Awaiting decision</span>);
      if (view.applicability.state === "changed") t.push(<span key="c" className="wc-rv-tag stale">Changed since</span>);
      else if (view.applicability.state === "unavailable") t.push(<span key="c" className="wc-rv-tag stale">Unavailable</span>);
  }
  if (d !== "superseded" && view.applicability.state === "landed") t.push(<span key="l" className="wc-rv-tag ok">Landed</span>);
  if (d !== "superseded" && view.applicability.state === "retired") t.push(<span key="r" className="wc-rv-tag dim">Checkout retired</span>);
  return <>{t}</>;
}

function Summary({ view, sub, d, artifact, headingRef }: { view: ReviewView; sub: SubmissionView; d: ReviewDisplay; artifact: ArtifactRead | null; headingRef: React.Ref<HTMLElement> }) {
  const m = sub.artifact.manifest;
  const isDoc = sub.artifact.kind === "document";
  const preview = artifact && artifact.kind === "code" ? artifact.preview : null;
  const stats = preview?.text ? diffStats(preview.text) : null;
  return (
    <section className="wc-rv-sub" aria-label={`Revision ${sub.revision}`}>
      <div className="wc-rv-h">
        <b tabIndex={-1} ref={headingRef as React.Ref<HTMLElement>}>Revision {sub.revision} · {isDoc ? "Document" : "Code"}</b>
        <Tags view={view} d={d} />
      </div>
      <div className="wc-rv-meta">
        {isDoc ? (
          <>
            <span>document</span>
            <span>{(m as DocumentManifest).path}</span>
            <span title={`sha256 ${(m as DocumentManifest).sha256}`}>{shortDigest((m as DocumentManifest).sha256)}</span>
          </>
        ) : (
          <>
            <span>code</span>
            <span title={`base ${(m as CodeManifest).baseCommitSha}\nhead ${(m as CodeManifest).headCommitSha}`}>{shortSha((m as CodeManifest).baseCommitSha)} → {shortSha((m as CodeManifest).headCommitSha)}</span>
            {preview?.pathCount != null && <span>{preview.pathCount} {preview.pathCount === 1 ? "file" : "files"}</span>}
            {stats && !preview?.truncated && <><span className="a">+{stats.added}</span><span className="d">−{stats.removed}</span></>}
          </>
        )}
        <span>{when(sub.createdAt)}</span>
      </div>
      <div className="wc-rv-note">{noteFor(d, view, sub)}</div>
      {sub.summary && <div className="wc-rv-said"><span className="wc-rv-k">Agent summary</span>{sub.summary}</div>}
      {sub.requestedDecision && <div className="wc-rv-said"><span className="wc-rv-k">Asks for</span>{sub.requestedDecision}</div>}
      {sub.evidence.length > 0 && (
        <div className="wc-rv-said">
          <span className="wc-rv-k">Evidence</span>
          <ul className="wc-rv-list">
            {sub.evidence.map((e, i) => {
              const href = safeHref(e.url);
              return <li key={i}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{e.label || e.url}</a> : (e.label || e.url)}</li>;
            })}
          </ul>
        </div>
      )}
      {sub.validation.length > 0 && (
        <div className="wc-rv-said">
          <span className="wc-rv-k">Validation claimed by {sub.submitter.agent}, not verified</span>
          <ul className="wc-rv-list">
            {sub.validation.map((v, i) => <li key={i}><code>{v.command}</code>{v.result ? ` → ${v.result}` : ""}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------- artifact ----------

function ArtifactBox({ view, sub, load, onOpenDiff, onOpenDocument, taskId, requestId }: {
  view: ReviewView; sub: SubmissionView;
  load: { data: ArtifactRead | null; error: string | null; loading: boolean };
  onOpenDiff: () => void; onOpenDocument: (path: string) => void; taskId: string; requestId: string;
}) {
  const isCurrent = sub.id === view.currentSubmission.id;
  // The Diff tab and the editor show the live branch and the live file. They open only
  // while those still match the captured revision; otherwise the person is told why.
  const live = isCurrent && view.applicability.state === "current";
  const mismatch = !live ? (view.applicability.reason ?? (isCurrent ? "the task no longer matches this revision" : "this revision was superseded")) : null;

  if (load.error && !load.data) {
    return <div className="wc-rv-art"><div className="wc-rv-gone"><b>This artifact is no longer available.</b> {load.error}</div></div>;
  }
  if (!load.data) return <div className="wc-rv-art"><div className="wc-rv-gone" aria-busy="true">Loading the captured artifact…</div></div>;

  const a = load.data;
  if (a.kind === "document") {
    const m = a.manifest as DocumentManifest;
    const p = a.preview;
    return (
      <div className="wc-rv-art" data-wc-artifact="document">
        <div className="wc-rv-bar">
          <span className="f">{m.path}</span>
          <span>{m.byteLength} bytes</span>
          <span title="Exact bytes captured at submission">{shortDigest(m.sha256)}</span>
        </div>
        <pre className="wc-rv-doc" tabIndex={0} aria-label="Document text as captured">{p.text ?? ""}</pre>
        <div className="wc-rv-digest" title="SHA-256 of the captured bytes">sha256 {m.sha256}</div>
        {m.realRelativePath !== m.path && <div className="wc-rv-digest">resolved path {m.realRelativePath}</div>}
        <div className="wc-rv-links">
          <a className="wc-rv-more" href={`/api/tasks/${taskId}/reviews/${encodeURIComponent(requestId)}/submissions/${encodeURIComponent(sub.id)}/artifact/raw`} download>Download the exact bytes</a>
          <button className="wc-rv-more" onClick={() => onOpenDocument(m.path)} disabled={!live} title={mismatch ?? undefined}>
            {live ? "Open the document collaboration view" : `Current file differs from this revision: ${mismatch}`}
          </button>
        </div>
      </div>
    );
  }

  const m = a.manifest as CodeManifest;
  const p = a.preview as Extract<ArtifactRead["preview"], { pathCount: number | null }>;
  const stats = p.text ? diffStats(p.text) : null;
  const lines = p.text ? diffLines(p.text) : [];
  return (
    <div className="wc-rv-art" data-wc-artifact="code">
      <div className="wc-rv-bar">
        <span className="f">{p.text ? (firstDiffPath(p.text) ?? "Code changes") : "Code changes"}</span>
        {stats && !p.truncated && <span>+{stats.added} −{stats.removed}</span>}
        {p.pathCount != null && <span>{p.pathCount} {p.pathCount === 1 ? "file" : "files"}</span>}
        <span title="SHA-256 of the captured manifest">{shortDigest(a.manifestSha256)}</span>
        {p.truncated && <span className="wc-rv-trunc">PREVIEW TRUNCATED{p.reason && PREVIEW_REASON[p.reason] ? ` · ${PREVIEW_REASON[p.reason]}` : ""}</span>}
      </div>
      {p.text === null
        ? <div className="wc-rv-gone">No preview is shown for this revision. The pinned commits are complete.</div>
        : <pre className="wc-rv-pre" tabIndex={0} aria-label="Diff preview as captured">{lines.map((l, i) => <span key={i} className={l.cls}>{l.text + "\n"}</span>)}</pre>}
      <button className="wc-rv-more" onClick={onOpenDiff} disabled={!live} title={mismatch ?? undefined}>
        {live
          ? `${p.truncated ? "Open the full diff in the Diff tab" : "Open in Diff tab"} · pinned ${shortSha(m.baseCommitSha)}…${shortSha(m.headCommitSha)}`
          : `The Diff tab shows the live branch, which no longer matches this revision: ${mismatch}`}
      </button>
      <div className="wc-rv-digest" title="SHA-256 of the captured manifest">manifest sha256 {a.manifestSha256}</div>
      <div className="wc-rv-digest">base {m.baseCommitSha}</div>
      <div className="wc-rv-digest">head {m.headCommitSha}</div>
    </div>
  );
}

// ---------- decision ----------

type Local =
  | { t: "idle" }
  | { t: "pending"; intent: ReviewIntent }
  | { t: "ok"; decision: "accept" | "waive" }
  | { t: "fail"; intent: ReviewIntent; status: number; code: string | null; retryable: boolean }
  | { t: "ind"; intent: ReviewIntent; ack: boolean }
  | { t: "conflict"; message: string };

type Form = "none" | "compose" | "waive";

/** Fail and unknown strips for an accept or waive this pane sent. */
function DecisionStrip({ local, onRetry, onDismiss, onAck }: {
  local: Extract<Local, { t: "fail" | "ind" }>; onRetry: () => void; onDismiss: () => void; onAck: (v: boolean) => void;
}) {
  const d = local.intent.decision === "waive" ? "waive" : "accept";
  if (local.t === "fail") {
    return (
      <>
        <Strip tone="fail" icon={Icon.x()}>{decisionFailText(d, local.status, local.code)}</Strip>
        <div className="wc-rv-btns wc-rv-row">{local.retryable && <button className="wc-act wc-rv-act" onClick={onRetry}>Retry</button>}<button className="wc-act ghost wc-rv-act" onClick={onDismiss}>Dismiss</button></div>
      </>
    );
  }
  return (
    <>
      <Strip tone="ind" icon={Icon.clock()}><b>Unknown result.</b> {DECISION_IND[d]}</Strip>
      <div className="wc-rv-btns wc-rv-row">
        <label className="wc-rv-dup"><input type="checkbox" checked={local.ack} onChange={(e) => onAck(e.target.checked)} /> May duplicate</label>
        <button className="wc-act wc-rv-act" disabled={!local.ack} onClick={onRetry}>Retry</button>
        <button className="wc-act ghost wc-rv-act" onClick={onDismiss}>Leave as is</button>
      </div>
    </>
  );
}

function Decision({ taskId, view, sub, d, mobile, onOpenDiff, onGoCurrent, onAskResubmit, onChanged }: {
  taskId: string; view: ReviewView; sub: ReviewView["currentSubmission"]; d: ReviewDisplay; mobile: boolean;
  onOpenDiff: () => void; onGoCurrent: () => void; onAskResubmit: () => void; onChanged: () => void;
}) {
  const n = sub.revision;
  const [local, setLocal] = useState<Local>({ t: "idle" });
  const [form, setForm] = useState<Form>("none");
  const [feedback, setFeedback] = useState("");
  const [waiveReason, setWaiveReason] = useState("");
  const [dupAck, setDupAck] = useState(false);
  const [left, setLeft] = useState<string | null>(null);
  const retryKey = useRef<{ prior: string; key: string } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // The opener unmounts while its form is open, so focus returns by name once the controls are back.
  const openerRef = useRef<string | null>(null);
  const decRef = useRef<HTMLElement>(null);
  const okTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (okTimer.current) clearTimeout(okTimer.current); }, []);

  const allowed = (a: ReviewActionName) => view.allowedActions.includes(a);
  const isCurrent = sub.id === view.currentSubmission.id;
  const last = view.latestAction;

  const openForm = (f: Form, opener?: HTMLElement | null) => {
    openerRef.current = opener?.dataset.wcRvAct ?? null;
    setForm(f);
  };
  // An opened form takes focus once it has rendered.
  useEffect(() => { if (form !== "none") textRef.current?.focus(); }, [form]);
  const closeForm = () => {
    setForm("none");
    const o = openerRef.current;
    if (o) requestAnimationFrame(() => decRef.current?.querySelector<HTMLElement>(`[data-wc-rv-act="${o}"]`)?.focus());
  };

  const send = async (intent: ReviewIntent) => {
    setLocal({ t: "pending", intent });
    const res = await postReviewAction(taskId, intent);
    if (res.kind === "ok") {
      if (intent.decision === "request_changes" || intent.decision === "retry_feedback") {
        const text = intent.decision === "request_changes" ? intent.reason ?? "" : recallFeedback(last?.id) ?? "";
        if (text) rememberFeedback(res.body.action.id, text);
        setFeedback("");
        setForm("none");
        setDupAck(false);
        setLocal({ t: "idle" });
      } else {
        setForm("none");
        setWaiveReason("");
        setLocal({ t: "ok", decision: intent.decision });
        if (okTimer.current) clearTimeout(okTimer.current);
        okTimer.current = setTimeout(() => setLocal((l) => (l.t === "ok" ? { t: "idle" } : l)), 2500);
      }
      onChanged();
      return;
    }
    if (res.kind === "conflict") { setLocal({ t: "conflict", message: res.message }); return; }
    if (res.kind === "fail") { setLocal({ t: "fail", intent, status: res.status, code: res.code, retryable: res.retryable }); return; }
    setLocal({ t: "ind", intent, ack: false });
  };

  const intentFor = (decision: ReviewDecision, reason: string | null, key = newIdempotencyKey()): ReviewIntent => ({
    decision, requestId: view.id, submissionId: view.currentSubmission.id, expectedVersion: view.version, reason, idempotencyKey: key,
  });
  // A refusal means the review moved: the form closes (its text is kept) and the stored state renders.
  const dismiss = () => { setDupAck(false); setLocal({ t: "idle" }); setForm("none"); onChanged(); };

  const fine = <div className="wc-rv-fine"><b>Accept</b> records approval of rev {n} only. <b>Merge</b> is a separate landing action. <b>Completing</b> the task is separate again and is what releases dependents.</div>;
  const wrap = (children: ReactNode, title: ReactNode = "Decision") => (
    <section ref={decRef} className={`wc-rv-dec${mobile && form === "compose" ? " wc-rv-pinned" : ""}`} aria-label="Decision"><div className="wc-rv-ttl">{title}</div>{children}</section>
  );

  // ----- outcomes of an action this pane sent take precedence over the stored state -----
  if (isCurrent && local.t === "pending") {
    const dec = local.intent.decision;
    const msg = dec === "accept" ? `Recording acceptance of rev ${n}…` : dec === "waive" ? DECISION_PENDING.waive : "Recording feedback…";
    return wrap(<>
      <Strip tone="pend">{msg}</Strip>
      <div className="wc-rv-btns wc-rv-off" aria-hidden>
        <button className="wc-act pri wc-rv-act" disabled tabIndex={-1}>Accept rev {n}</button>
        <button className="wc-act wc-rv-act" disabled tabIndex={-1}>Request changes</button>
        {view.required && <button className="wc-act ghost wc-rv-act" disabled tabIndex={-1}>Waive…</button>}
      </div>
    </>);
  }
  if (isCurrent && local.t === "ok") {
    const [msg, subText] = DECISION_OK[local.decision];
    return wrap(<Strip tone="ok" icon={Icon.check()}>{msg} <span className="wc-rv-sub2">{subText}</span></Strip>);
  }
  if (isCurrent && local.t === "conflict") {
    return wrap(<>
      <Strip tone="fail" icon={Icon.x()}>{local.message[0].toUpperCase() + local.message.slice(1)}{/[.!?]$/.test(local.message) ? "" : "."}</Strip>
      <div className="wc-rv-btns wc-rv-row"><button className="wc-act ghost wc-rv-act" onClick={dismiss}>Dismiss</button></div>
    </>);
  }
  if (isCurrent && (local.t === "fail" || local.t === "ind") && local.intent.decision === "request_changes") {
    // The feedback was not recorded (or may not have been): the text stays, and Retry resends it under the same key.
    const failed = local.t === "fail";
    return wrap(<>
      {failed
        ? <Strip tone="fail" icon={Icon.x()}>{feedbackFailText(local.status, local.code)}</Strip>
        : <Strip tone="ind" icon={Icon.clock()}><b>Unknown result.</b> {DECISION_IND.request_changes}</Strip>}
      <textarea className="wc-rv-text" readOnly value={local.intent.reason ?? ""} aria-label="Your feedback" />
      <div className="wc-rv-btns wc-rv-row">
        {!failed && <label className="wc-rv-dup"><input type="checkbox" checked={local.ack} onChange={(e) => setLocal({ ...local, ack: e.target.checked })} /> May duplicate</label>}
        {(!failed || local.retryable) && <button className="wc-act wc-rv-act" disabled={!failed && !local.ack} onClick={() => void send(local.intent)}>Retry</button>}
        <button className="wc-act ghost wc-rv-act" onClick={() => { setDupAck(false); setLocal({ t: "idle" }); openForm("compose"); onChanged(); }}>{failed ? "Dismiss" : "Leave as is"}</button>
      </div>
    </>, <>Request changes on rev {n}</>);
  }
  if (isCurrent && (local.t === "fail" || local.t === "ind") && local.intent.decision === "retry_feedback") {
    const failed = local.t === "fail";
    return wrap(<>
      {failed
        ? <Strip tone="fail" icon={Icon.x()}>{feedbackFailText(local.status, local.code)}</Strip>
        : <Strip tone="ind" icon={Icon.clock()}><b>Unknown result.</b> {DECISION_IND.request_changes}</Strip>}
      <div className="wc-rv-btns wc-rv-row">
        {!failed && <label className="wc-rv-dup"><input type="checkbox" checked={local.ack} onChange={(e) => setLocal({ ...local, ack: e.target.checked })} /> May duplicate</label>}
        {(!failed || local.retryable) && <button className="wc-act wc-rv-act" disabled={!failed && !local.ack} onClick={() => void send(local.intent)}>Retry</button>}
        <button className="wc-act ghost wc-rv-act" onClick={dismiss}>{failed ? "Dismiss" : "Leave as is"}</button>
      </div>
    </>);
  }
  if (isCurrent && (local.t === "fail" || local.t === "ind")) {
    return wrap(<DecisionStrip
      local={local}
      onRetry={() => void send(local.intent)}
      onDismiss={dismiss}
      onAck={(v) => setLocal({ ...local, ack: v } as Local)}
    />);
  }

  // ----- the waive form (reason required) -----
  if (isCurrent && form === "waive") {
    return wrap(<>
      <textarea
        ref={textRef}
        className="wc-rv-text"
        placeholder="Reason (required)"
        aria-label="Reason for waiving"
        value={waiveReason}
        onChange={(e) => setWaiveReason(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeForm(); } }}
      />
      <div className="wc-rv-fine">Waives this submission only. A later resubmission restores the requirement. This is not acceptance and nothing merges.</div>
      <div className="wc-rv-btns wc-rv-row">
        <button className="wc-act ghost wc-rv-act" onClick={closeForm}>Cancel</button>
        <button className="wc-act pri wc-rv-act wc-rv-end" disabled={!waiveReason.trim()} onClick={() => void send(intentFor("waive", waiveReason.trim()))}>Waive</button>
      </div>
    </>, <>Waive required review · rev {n}</>);
  }

  // ----- the feedback field -----
  if (isCurrent && form === "compose") {
    const head = sub.artifact.kind === "code" ? shortSha((sub.artifact.manifest as CodeManifest).headCommitSha) : shortDigest((sub.artifact.manifest as DocumentManifest).sha256);
    return wrap(<>
      <div className="wc-rv-fhead"><span>Request changes on <b>rev {n}</b></span><span className="wc-rv-mono">{head}</span></div>
      <textarea
        ref={textRef}
        className={`wc-rv-text${mobile ? " wc-rv-text-phone" : ""}`}
        placeholder="What should change? The agent receives this as its next message."
        aria-label="Feedback for the agent"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeForm(); } }}
      />
      <div className="wc-rv-btns wc-rv-row wc-rv-pair">
        <button className="wc-act wc-rv-act" onClick={closeForm}>Cancel</button>
        <button className="wc-act pri wc-rv-act" disabled={!feedback.trim()} onClick={() => void send(intentFor("request_changes", feedback.trim()))}>Send feedback</button>
      </div>
    </>, "Decision");
  }

  // ----- the stored state -----
  switch (d) {
    case "withdrawn":
      return wrap(<div className="wc-rv-fine">No decision is offered on a withdrawn submission.</div>);
    case "superseded":
      return wrap(<>
        <div className="wc-rv-fine">This revision was superseded. Decide on the latest revision instead.</div>
        <div className="wc-rv-btns"><button className="wc-act wc-rv-act" onClick={onGoCurrent}>Go to rev {view.currentSubmission.revision} {Icon.chevRight()}</button></div>
      </>);
    case "accepted":
      return wrap(<>
        <div className="wc-rv-btns"><button className="wc-act wc-rv-act" onClick={onOpenDiff}>Merge from landing controls {Icon.chevRight()}</button></div>
        {fine}
      </>, <>Decision <span className="wc-rv-tag ok">Accepted rev {n}</span></>);
    case "accepted_changed":
      return wrap(<>
        <Strip tone="ind" icon={Icon.clock()}><b>Rev {n} was accepted, then it changed.</b> The requirement is unsatisfied. Ask the agent to resubmit, or waive.</Strip>
        <div className="wc-rv-btns">
          <button className="wc-act wc-rv-act" onClick={onAskResubmit}>Ask agent to resubmit</button>
          {view.required && allowed("waive") && <button className="wc-act ghost wc-rv-act" data-wc-rv-act="waive" onClick={(e) => openForm("waive", e.currentTarget)}>Waive…</button>}
        </div>
        {fine}
      </>);
    case "changes_requested":
      return wrap(<>
        <Strip tone="ok" icon={Icon.check()}>Changes requested · delivered to the agent.</Strip>
        <div className="wc-rv-fine">Nothing further until rev {view.currentSubmission.revision + 1} arrives.</div>
      </>);
    case "feedback_pending":
      return wrap(<Strip tone="pend">Feedback recorded · delivering to the agent…</Strip>);
    case "feedback_failed":
    case "delivery_unknown": {
      const failed = d === "feedback_failed";
      const text = recallFeedback(last?.id);
      const strip = failed
        ? <Strip tone="fail" icon={Icon.x()}>Feedback not delivered.</Strip>
        : <Strip tone="ind" icon={Icon.clock()}><b>Unknown result.</b> Feedback was recorded; delivery to the agent is unknown.</Strip>;
      if (left && left === last?.id) return wrap(strip);
      const canRetry = allowed("retry_feedback") && !!last;
      const retry = () => {
        if (!last) return;
        // One key per resend intent: a second click after a lost reply replays it.
        if (!retryKey.current || retryKey.current.prior !== last.id) retryKey.current = { prior: last.id, key: newIdempotencyKey() };
        setDupAck(false);
        void send(intentFor("retry_feedback", RETRY_FEEDBACK_REASON, retryKey.current.key));
      };
      return wrap(<>
        {strip}
        {text && <textarea className="wc-rv-text" readOnly value={text} aria-label="Your feedback" />}
        <div className="wc-rv-btns wc-rv-row">
          <label className="wc-rv-dup"><input type="checkbox" checked={dupAck} disabled={!canRetry} onChange={(e) => setDupAck(e.target.checked)} /> The agent may receive this twice</label>
          <button className="wc-act wc-rv-act wc-rv-end" disabled={!dupAck || !canRetry} onClick={retry}>Retry delivery</button>
          <button className="wc-act ghost wc-rv-act" onClick={() => { setDupAck(false); setLeft(last?.id ?? null); }}>Leave as is</button>
        </div>
        <div className="wc-rv-fine">Retry re-sends the same feedback. It is never retried automatically.</div>
      </>);
    }
    case "waived":
      return wrap(<Strip tone="ok" icon={Icon.check()}>Waived for this submission. A later resubmission restores the requirement.</Strip>);
    case "decision_pending":
      return wrap(<Strip tone="pend">Recording the decision on rev {n}…</Strip>);
    default: {
      const blocked = view.applicability.state !== "current";
      const accept = () => void send(intentFor("accept", null));
      return wrap(<>
        {blocked && <Strip tone="ind" icon={Icon.clock()}>This revision no longer matches the task, so it cannot be accepted. {view.applicability.reason ? `${view.applicability.reason[0].toUpperCase()}${view.applicability.reason.slice(1)}.` : ""}</Strip>}
        <div className="wc-rv-btns">
          <button className="wc-act pri wc-rv-act" disabled={!allowed("accept")} onClick={accept}>Accept rev {n}<small>records approval · no merge</small></button>
          <button className="wc-act wc-rv-act" data-wc-rv-act="changes" disabled={!allowed("request_changes")} onClick={(e) => openForm("compose", e.currentTarget)}>Request changes<small>write feedback · delivered as work</small></button>
          {view.required && <button className="wc-act ghost wc-rv-act" data-wc-rv-act="waive" disabled={!allowed("waive")} onClick={(e) => openForm("waive", e.currentTarget)}>Waive…<small>reason required · this submission only</small></button>}
        </div>
        {fine}
      </>);
    }
  }
}

// ---------- the pane ----------

export function ReviewPane({ taskId, reviews, focus, mobile, onOpenDiff, onOpenDocument, onAskResubmit, onChanged }: {
  taskId: string;
  reviews: ReviewView[];
  focus: ReviewFocus | null;
  mobile: boolean;
  onOpenDiff: () => void;
  onOpenDocument: (path: string) => void;
  /** "Ask agent to resubmit" (C3): the transcript composer, focused, nothing prefilled. */
  onAskResubmit: () => void;
  /** A decision landed or was refused: refetch the task's requests. */
  onChanged: () => void;
}) {
  const [reqId, setReqId] = useState<string | null>(null);
  const [viewSub, setViewSub] = useState<string | null>(null);
  const headingRef = useRef<HTMLElement>(null);

  // A Work Center chip anchors one submission: select its request, show that revision, focus the summary.
  useEffect(() => {
    if (!focus) return;
    if (focus.requestId && reviews.some((r) => r.id === focus.requestId)) setReqId(focus.requestId);
    setViewSub(focus.submissionId);
    const t = setTimeout(() => headingRef.current?.focus({ preventScroll: false }), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n]);

  const view = useMemo(
    () => reviews.find((r) => r.id === reqId) ?? reviews.find((r) => r.state === "pending") ?? reviews[0] ?? null,
    [reviews, reqId],
  );
  const stamp = view ? `${view.version}:${view.currentSubmission.id}:${view.latestAction?.id ?? ""}:${view.latestAction?.state ?? ""}` : "";
  const hist = useRequestHistory(taskId, view?.id ?? null, stamp);
  const rows = useMemo(() => historyRows(hist.data?.history.submissions ?? [], hist.data?.history.actions ?? []), [hist.data]);

  const viewing: SubmissionView | null = !view ? null : (viewSub && rows.find((r) => r.submission.id === viewSub)?.submission) || view.currentSubmission;
  const artifact = useArtifact(taskId, view?.id ?? null, viewing?.id ?? null, viewing?.artifact.manifestSha256 ?? "");

  if (!view || !viewing) return <div className="wc-rv" data-wc-review><div className="wc-rv-gone">No review requests on this task.</div></div>;
  const d = reviewDisplay(view, viewing);
  const isCurrentRev = viewing.id === view.currentSubmission.id;

  return (
    <div className={`wc-rv${mobile ? " wc-rv-stack" : ""}`} data-wc-review data-wc-review-state={d}>
      {reviews.length > 1 && (
        <div className="wc-rv-reqs" role="group" aria-label="Review requests on this task">
          {reviews.map((r) => (
            <button key={r.id} className={`wc-rv-req${r.id === view.id ? " on" : ""}`} aria-pressed={r.id === view.id} onClick={() => { setReqId(r.id); setViewSub(null); }}>
              <span>{r.outputKey}</span><small>{REQUEST_STATE_LABEL[r.state]}</small>
            </button>
          ))}
        </div>
      )}
      <Summary view={view} sub={viewing} d={d} artifact={artifact.data} headingRef={headingRef} />
      <ArtifactBox view={view} sub={viewing} load={artifact} onOpenDiff={onOpenDiff} onOpenDocument={onOpenDocument} taskId={taskId} requestId={view.id} />
      {/* Keyed by revision: a resubmission retires the old revision's controls and any open form. */}
      <Decision
        key={`${view.id}:${view.currentSubmission.id}`}
        taskId={taskId} view={view} sub={viewing} d={d} mobile={mobile}
        onOpenDiff={onOpenDiff} onGoCurrent={() => setViewSub(null)} onAskResubmit={onAskResubmit} onChanged={onChanged}
      />
      <section className="wc-rv-sub wc-rv-histbox" aria-label="Revisions">
        <div className="wc-rv-ttl">Revisions</div>
        <div className="wc-rv-hist">
          {(rows.length ? rows : [{ submission: view.currentSubmission, outcome: null, tone: "" as const }]).map(({ submission: s, outcome, tone }) => {
            const cur = s.id === view.currentSubmission.id;
            const shown = s.id === viewing.id;
            return (
              <button key={s.id} className={`wc-rv-r${cur ? " cur" : " old"}${tone ? ` ${tone}` : ""}${shown ? " shown" : ""}`} aria-current={shown ? "true" : undefined} onClick={() => setViewSub(cur ? null : s.id)}>
                <i />
                <span>Rev {s.revision} · {s.artifact.kind}{cur && view.state === "withdrawn" ? " · withdrawn by agent" : outcome ? ` · ${outcome}` : ""}</span>
                <span className="m">{s.artifact.kind === "code" ? shortSha((s.artifact.manifest as CodeManifest).headCommitSha) : shortDigest((s.artifact.manifest as DocumentManifest).sha256)} · {when(s.createdAt)}</span>
              </button>
            );
          })}
        </div>
        {hist.data?.history.nextCursor && <div className="wc-rv-fine">Older revisions are not shown.</div>}
        {!isCurrentRev && <div className="wc-rv-fine">Viewing rev {viewing.revision}. The current revision is rev {view.currentSubmission.revision}.</div>}
      </section>
    </div>
  );
}
