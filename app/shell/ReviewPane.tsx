"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CodeManifest, DocumentManifest, ReviewView, SubmissionView } from "@/lib/reviews/types";
import { Icon } from "../icons";
import {
  PREVIEW_REASON, REQUEST_STATE_LABEL, diffLines, diffStats, firstDiffPath, historyRows, reviewDisplay, safeHref, shortDigest, shortSha,
  type ReviewDisplay,
} from "./reviewModel";
import { useArtifact, useRequestHistory, type ArtifactRead } from "./useTaskReviews";
import { ago } from "./workCenterModel";

// The Review tab and the phone Review segment (design release
// work-center-design-release/1, section 5). It shows what an agent explicitly
// submitted: the revision, the pinned artifact it captured and what was decided.
// Every artifact on screen comes from the stored manifest and the review-owned
// refs, never from the task branch or a live file. Decision controls render
// disabled until the decision routes ship (WC-16, WC-17); the one release rule
// that already applies is C2: there is no "accept anyway" after feedback.

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
    </div>
  );
}

// ---------- decision (read-only until WC-17) ----------

function Decision({ view, sub, d, onOpenDiff, onGoCurrent }: {
  view: ReviewView; sub: ReviewView["currentSubmission"]; d: ReviewDisplay; onOpenDiff: () => void; onGoCurrent: () => void;
}) {
  const n = sub.revision;
  const fine = <div className="wc-rv-fine"><b>Accept</b> records approval of rev {n} only. <b>Merge</b> is a separate landing action. <b>Completing</b> the task is separate again and is what releases dependents.</div>;
  const none = <div className="wc-rv-fine">Decision controls are not available in this release.</div>;
  const wrap = (children: ReactNode, title = "Decision") => <section className="wc-rv-dec" aria-label="Decision"><div className="wc-rv-ttl">{title}</div>{children}</section>;

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
      </>, `Decision · Accepted rev ${n}`);
    case "accepted_changed":
      return wrap(<>
        <Strip tone="ind" icon={Icon.clock()}><b>Rev {n} was accepted, then it changed.</b> The requirement is unsatisfied. Ask the agent to resubmit, or waive.</Strip>
        <div className="wc-rv-btns"><button className="wc-act wc-rv-act" disabled>Ask agent to resubmit</button>{view.required && <button className="wc-act ghost wc-rv-act" disabled>Waive…</button>}</div>
        {none}
      </>);
    case "changes_requested":
      return wrap(<>
        <Strip tone="ok" icon={Icon.check()}>Changes requested · delivered to the agent.</Strip>
        <div className="wc-rv-fine">Nothing further until rev {view.currentSubmission.revision + 1} arrives.</div>
      </>);
    case "feedback_pending":
      return wrap(<Strip tone="pend">Feedback recorded · delivering to the agent…</Strip>);
    case "feedback_failed":
      return wrap(<>
        <Strip tone="fail" icon={Icon.x()}>Feedback not delivered.</Strip>
        <div className="wc-rv-fine">Retry and Leave as is arrive with the decision controls.</div>
      </>);
    case "delivery_unknown":
      return wrap(<>
        <Strip tone="ind" icon={Icon.clock()}><b>Unknown result.</b> Feedback was recorded; delivery to the agent is unknown.</Strip>
        <div className="wc-rv-fine">Retry would re-send the same feedback. It is never retried automatically.</div>
      </>);
    case "waived":
      return wrap(<Strip tone="ok" icon={Icon.check()}>Waived for this submission. A later resubmission restores the requirement.</Strip>);
    case "decision_pending":
      return wrap(<Strip tone="pend">Recording the decision on rev {n}…</Strip>);
    default: {
      const blocked = view.applicability.state !== "current";
      return wrap(<>
        {blocked && <Strip tone="ind" icon={Icon.clock()}>This revision no longer matches the task, so it cannot be accepted. {view.applicability.reason ? `${view.applicability.reason[0].toUpperCase()}${view.applicability.reason.slice(1)}.` : ""}</Strip>}
        <div className="wc-rv-btns">
          <button className="wc-act pri wc-rv-act" disabled>Accept rev {n}<small>records approval · no merge</small></button>
          <button className="wc-act wc-rv-act" disabled>Request changes<small>write feedback · delivered as work</small></button>
          {view.required && <button className="wc-act ghost wc-rv-act" disabled>Waive…<small>reason required · this submission only</small></button>}
        </div>
        {none}
        {fine}
      </>);
    }
  }
}

// ---------- the pane ----------

export function ReviewPane({ taskId, reviews, focus, mobile, onOpenDiff, onOpenDocument }: {
  taskId: string;
  reviews: ReviewView[];
  focus: ReviewFocus | null;
  mobile: boolean;
  onOpenDiff: () => void;
  onOpenDocument: (path: string) => void;
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
      <Decision view={view} sub={viewing} d={d} onOpenDiff={onOpenDiff} onGoCurrent={() => setViewSub(null)} />
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
