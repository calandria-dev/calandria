"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Skel, ErrNote } from "./orchestrator/shared";
import { CollabDoc } from "./orchestrator/CollabDoc";
import { Icon } from "./icons";
import type { TaskComment } from "@/lib/types";

interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  truncated?: boolean;
}
interface DiffResp {
  isolated: boolean;
  reason?: string;
  branch?: string;
  baseLabel?: string;
  merged_at?: number;
  alreadyMerged?: boolean;
  files: DiffFile[];
  isDirty: boolean;
  ahead: number;
  error?: string;
  mergeInProgress?: boolean; // a conflict resolution is staged, awaiting accept/discard
  unresolved?: string[]; // files still flagged unmerged
  head?: string | null; // worktree HEAD when this diff was computed — stamped onto new comments as anchor_sha
}
interface DirtyEntry {
  code: string; // raw porcelain XY status ("??" untracked, " M" modified, …)
  path: string;
  untracked: boolean;
}
interface MergeResp {
  ok: boolean;
  targetBranch: string;
  committed: boolean;
  alreadyMerged?: boolean;
  conflicts?: string[];
  error?: string;
  // The merge ran in the project's MAIN checkout and it wasn't clean — these are
  // the uncommitted files that blocked it (server-side list, so the card never
  // has to string-match the message).
  dirty?: DirtyEntry[];
  dirtyTruncated?: boolean;
  stashed?: { restored: boolean; sha: string; label: string; error?: string };
}
// Returned by the AI-resolution callback wired from the parent (it runs the
// /prepare step + streams the resolution turn into the transcript).
export interface ResolveResult {
  ok: boolean;
  merged?: boolean; // trial merge was clean and landed immediately
  // A resolution turn was started — the caller may switch to the chat to watch
  // it. Absent when there was nothing for the agent to do (the merge is already
  // paused with every text conflict resolved, or only binaries remain), in which
  // case the right place to go is the review state in Changes, not the chat.
  resolving?: boolean;
  error?: string;
  conflicts?: string[];
  binaryConflicts?: string[];
}

const STATUS_LABEL: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", "?": "new" };

// The merge routes always answer JSON, but a layer above them can still hand
// back HTML (a tunnel 502, a request killed at maxDuration) — parse defensively
// so the banner shows the HTTP status, not JSON.parse's "Unexpected token '<'".
const mergeJson = (r: Response): Promise<MergeResp> =>
  r.json().catch(() => ({ ok: false, targetBranch: "", committed: false, error: `merge request failed (HTTP ${r.status})` }));

// Last fetched diff per task, module-level so it survives unmounts. The rail
// remounts this component on every collapse/expand, DIFF↔CONTEXT tab switch,
// and chat/changes toggle — without a cache each of those pays a fresh
// diff-endpoint round trip behind a skeleton. With it, reopening renders the
// previous diff instantly and revalidates in the background.
const diffCache = new Map<string, DiffResp>();

// Strip the file-metadata preamble (diff --git / index / --- / +++) and return
// just the hunk lines, the way GitHub shows them.
function hunkLines(patch: string): string[] {
  const lines = patch.split("\n");
  const i = lines.findIndex((l) => l.startsWith("@@"));
  return i >= 0 ? lines.slice(i) : [];
}
// One rendered diff line plus its old/new line numbers, for the dual gutter
// (GitHub-style). Tracked by walking the hunk headers (`@@ -a,b +c,d @@`
// seed the counters) rather than trusting the patch's own numbers past the
// first hunk, since a file with multiple hunks resets per @@.
interface NumberedLine { cls: string; oldNo: number | null; newNo: number | null; text: string }
function numberedLines(patch: string): NumberedLine[] {
  let oldNo = 0, newNo = 0;
  const out: NumberedLine[] = [];
  for (const text of hunkLines(patch)) {
    if (text.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (m) { oldNo = parseInt(m[1], 10); newNo = parseInt(m[2], 10); }
      out.push({ cls: "hunk", oldNo: null, newNo: null, text });
    } else if (text.startsWith("\\")) {
      // "\ No newline at end of file" — a patch marker, not a content line.
      // Drop it entirely: no row, no counter bump (it can sit between a
      // del-run and its paired add-run, so bumping either would misnumber
      // every line after it).
    } else if (text.startsWith("+") && !text.startsWith("+++")) {
      out.push({ cls: "add", oldNo: null, newNo: newNo++, text });
    } else if (text.startsWith("-") && !text.startsWith("---")) {
      out.push({ cls: "del", oldNo: oldNo++, newNo: null, text });
    } else {
      out.push({ cls: "ctx", oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return out;
}

// A single split-view row: a hunk-header divider (spans both columns), or a
// left(base)/right(worktree) pair. Consecutive del/add runs within a hunk are
// paired index-for-index (standard split-diff alignment) — the shorter run's
// unpaired rows come back as `undefined`, rendered as blank spacer cells so
// the two columns stay row-aligned. Ctx lines pair with themselves.
interface SplitCell { no: number; text: string; cls: "ctx" | "add" | "del" }
interface SplitRow { hunkText?: string; left?: SplitCell; right?: SplitCell }
function splitLines(patch: string): SplitRow[] {
  const rows: SplitRow[] = [];
  let oldNo = 0, newNo = 0;
  let delBuf: SplitCell[] = [], addBuf: SplitCell[] = [];
  const flush = () => {
    const n = Math.max(delBuf.length, addBuf.length);
    for (let i = 0; i < n; i++) rows.push({ left: delBuf[i], right: addBuf[i] });
    delBuf = []; addBuf = [];
  };
  for (const text of hunkLines(patch)) {
    if (text.startsWith("@@")) {
      flush();
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (m) { oldNo = parseInt(m[1], 10); newNo = parseInt(m[2], 10); }
      rows.push({ hunkText: text });
    } else if (text.startsWith("\\")) {
      // Same marker as in numberedLines: skip without flushing — it can land
      // between a del-run and its paired add-run, and flushing early would
      // pair each side against a blank spacer instead of each other.
    } else if (text.startsWith("+") && !text.startsWith("+++")) {
      addBuf.push({ no: newNo++, text, cls: "add" });
    } else if (text.startsWith("-") && !text.startsWith("---")) {
      delBuf.push({ no: oldNo++, text, cls: "del" });
    } else {
      flush();
      rows.push({ left: { no: oldNo++, text, cls: "ctx" }, right: { no: newNo++, text, cls: "ctx" } });
    }
  }
  flush();
  return rows;
}

// Persisted across sessions — flipping to Split shouldn't need re-doing per task.
const VIEW_MODE_KEY = "calandria:diffViewMode";
const LEGACY_VIEW_MODE_KEY = "orch:diffViewMode";

// Files past this many hunk lines start collapsed: a diff with many files near
// the per-file patch cap would otherwise mount tens of thousands of line divs
// in one commit and jank the main thread when the rail opens.
const COLLAPSE_LINES = 400;

// The line range currently being commented on (textarea open, not yet sent).
// `side` disambiguates old-file vs new-file line numbers — see TaskComment.
interface CommentSel { file: string; side: "old" | "new"; start: number; end: number }

// The review-comment box: label + textarea + Send to agent / Comment only,
// anchored right under the row it targets. Shared by the composer (draft,
// editable) and nothing else — posted comments render via CommentThread.
function CommentBox({
  file, start, end, draft, busy, onDraftChange, onSend, onCommentOnly, onCancel,
}: {
  file: string; start: number; end: number; draft: string; busy: boolean;
  onDraftChange: (v: string) => void; onSend: () => void; onCommentOnly: () => void; onCancel: () => void;
}) {
  const label = start === end ? `L${start}` : `L${start}–${end}`;
  return (
    <div className="cmt">
      <div className="cmt-who">
        Comment on {file} · {label}
        <button className="cmt-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      <textarea
        className="cmt-ta"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder="Leave a review comment…"
        autoFocus
      />
      <div className="cmt-row">
        <button className="tc-btn primary" onClick={onSend} disabled={busy || !draft.trim()}>Send to agent</button>
        <button className="tc-btn" onClick={onCommentOnly} disabled={busy || !draft.trim()}>Comment only</button>
      </div>
    </div>
  );
}

// A posted comment, rendered read-only under the row it was anchored to.
function CommentThread({ c }: { c: TaskComment }) {
  const label = c.line_start === c.line_end ? `L${c.line_start}` : `L${c.line_start}–${c.line_end}`;
  return (
    <div className="cmt cmt-posted">
      <div className="cmt-who">
        {c.file} · {label}
        {c.sent_to_agent ? <span className="cmt-sent">✓ sent to agent</span> : null}
      </div>
      <div className="cmt-body">{c.body}</div>
    </div>
  );
}

// Comment affordances shared by both view modes: existing threads anchored to
// this row's (side, ending line) plus the open composer, if this exact anchor
// is where it's composing. `side` + `no` together are the anchor — old/new are
// independent line-number namespaces, so a comment on deleted line 3 and one
// on context line 3 must not both render here. Returns null when there's
// nothing to show, and — because (file, side, no) is unique across a diff —
// renders the composer under at most one row, never two.
function RowComments({
  side, no, comments, sel, draft, busy, onDraftChange, onSend, onCommentOnly, onCancel,
}: {
  side: "old" | "new";
  no: number | null;
  comments: TaskComment[]; // pre-filtered to this file + current diff anchor
  sel: CommentSel | null; // pre-filtered to this file (null if not composing here)
  draft: string; busy: boolean;
  onDraftChange: (v: string) => void; onSend: () => void; onCommentOnly: () => void; onCancel: () => void;
}) {
  if (no == null) return null;
  const posted = comments.filter((c) => c.side === side && c.line_end === no);
  const composing = sel && sel.side === side && sel.end === no;
  if (!posted.length && !composing) return null;
  return (
    <>
      {posted.map((c) => <CommentThread key={c.id} c={c} />)}
      {composing && sel && (
        <CommentBox
          file={sel.file} start={sel.start} end={sel.end} draft={draft} busy={busy}
          onDraftChange={onDraftChange} onSend={onSend} onCommentOnly={onCommentOnly} onCancel={onCancel}
        />
      )}
    </>
  );
}

// Comments whose anchor_sha doesn't match the currently loaded diff (or has
// none — pre-fix rows) — collapsed rather than guess-matched to a line, since
// the diff that numbered them is gone.
function OutdatedComments({ comments }: { comments: TaskComment[] }) {
  const [open, setOpen] = useState(false);
  if (!comments.length) return null;
  return (
    <div className="tc-outdated">
      <button className="tc-btn" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : "Show"} {comments.length} outdated comment{comments.length === 1 ? "" : "s"}
      </button>
      {open && comments.map((c) => {
        const label = c.line_start === c.line_end ? `L${c.line_start}` : `L${c.line_start}–${c.line_end}`;
        return (
          <div key={c.id} className="cmt cmt-posted">
            <div className="cmt-who">
              {c.file} · {label}
              {c.sent_to_agent ? <span className="cmt-sent">✓ sent to agent</span> : null}
            </div>
            <div className="cmt-body">{c.body}</div>
          </div>
        );
      })}
    </div>
  );
}

// One file section. Memoized so the scroll tracker's setActive (which fires on
// every scroll frame) re-renders only the overview list, not every hunk line
// of every file (comment composing does re-render every section on keystroke,
// since the draft lives in the parent — acceptable at the file counts/sizes
// this view already caps large diffs to).
const FileDiff = memo(function FileDiff({
  file: f,
  userToggled,
  onToggle,
  refs,
  viewMode,
  comments,
  diffHead,
  sel,
  draft,
  busy,
  onLineClick,
  onDraftChange,
  onSend,
  onCommentOnly,
  onCancel,
  onCollaborate,
}: {
  file: DiffFile;
  userToggled: boolean; // user flipped this file away from its default state
  onToggle: (path: string) => void;
  refs: { current: Record<string, HTMLDivElement | null> };
  viewMode: "unified" | "split";
  comments: TaskComment[]; // full task list; filtered to this file below
  diffHead: string | null; // the loaded diff's HEAD — decides current vs outdated
  sel: CommentSel | null;
  draft: string;
  busy: boolean;
  onLineClick: (file: string, side: "old" | "new", no: number, shiftKey: boolean) => void;
  onDraftChange: (v: string) => void;
  onSend: () => void;
  onCommentOnly: () => void;
  onCancel: () => void;
  onCollaborate?: (path: string) => void; // opens the document collaboration modal (any text file)
}) {
  const lines = useMemo(() => (f.binary ? [] : numberedLines(f.patch)), [f]);
  const rows = useMemo(() => (f.binary || viewMode === "unified" ? [] : splitLines(f.patch)), [f, viewMode]);
  const big = lines.length > COLLAPSE_LINES;
  const isCollapsed = userToggled ? !big : big;
  const fileComments = useMemo(() => comments.filter((c) => c.file === f.path), [comments, f.path]);
  // Only a comment stamped with THIS diff's head anchors inline — anything
  // else (including null anchor_sha, pre-fix rows) is outdated. Note this
  // catches a rewritten diff, not a dirty worktree that changed content
  // without moving HEAD — see the comment on currentHead in the diff route.
  const currentComments = useMemo(
    () => fileComments.filter((c) => diffHead != null && c.anchor_sha === diffHead),
    [fileComments, diffHead]
  );
  const outdatedComments = useMemo(
    () => fileComments.filter((c) => !(diffHead != null && c.anchor_sha === diffHead)),
    [fileComments, diffHead]
  );
  const fileSel = sel && sel.file === f.path ? sel : null;
  // Accurate placeholder height for content-visibility while the section is
  // offscreen-unrendered (header ≈34px, hunk lines 12px × 1.55 line-height),
  // so offsetTop-based jump/scroll-spy stay truthful. `auto` pins the real
  // size once rendered.
  const est = Math.round(34 + (isCollapsed ? 38 : Math.max(1, lines.length) * 18.6));
  const rowComments = (side: "old" | "new", no: number | null) => (
    <RowComments
      side={side} no={no} comments={currentComments} sel={fileSel} draft={draft} busy={busy}
      onDraftChange={onDraftChange} onSend={onSend} onCommentOnly={onCommentOnly} onCancel={onCancel}
    />
  );
  // Unified: one gutter cell per side, but only the row's OWN side is
  // clickable (del → old, add/ctx → new) — the other cell just displays its
  // number, so a ctx row's old-side number can't open a second, colliding
  // composer for the same content.
  const gutter = (no: number | null, cellSide: "old" | "new", rowSide: "old" | "new") =>
    no == null ? (
      <span className="dl-no" />
    ) : cellSide === rowSide ? (
      <span className="dl-no click" onClick={(e) => onLineClick(f.path, rowSide, no, e.shiftKey)}>{no}</span>
    ) : (
      <span className="dl-no">{no}</span>
    );
  // Split: each column is its own line, so del (left) and add (right) anchor
  // independently even when paired on the same visual row. ctx only anchors
  // on the new (right) side, matching the unified rule above.
  const splitGutter = (cell: SplitCell | undefined, pos: "old" | "new") => {
    if (!cell) return <span className="dl-no" />;
    const clickable = pos === "old" ? cell.cls === "del" : cell.cls === "add" || cell.cls === "ctx";
    return clickable ? (
      <span className="dl-no click" onClick={(e) => onLineClick(f.path, pos, cell.no, e.shiftKey)}>{cell.no}</span>
    ) : (
      <span className="dl-no">{cell.no}</span>
    );
  };
  return (
    <div
      className="tc-file"
      style={{ containIntrinsicSize: `auto ${est}px` }}
      ref={(el) => { refs.current[f.path] = el; }}
    >
      <div className="tc-fhead">
        <button className="tc-fhead-main" onClick={() => onToggle(f.path)}>
          <span className={`tc-chev ${isCollapsed ? "" : "open"}`}>▸</span>
          <span className={`tc-st s-${f.status === "?" ? "new" : f.status}`}>{f.status}</span>
          <span className="tc-fpath">{f.path}</span>
          <span className="tc-cnt">
            <b className="add">+{f.additions}</b> <b className="del">−{f.deletions}</b>
          </span>
        </button>
        {/* A text file the agent wrote or changed can be reviewed as a document
            — edited and commented on — rather than hunk by hunk. The transcript's
            Write/Edit card offers the same for files this list can't see
            (gitignored ones). */}
        {onCollaborate && !f.binary && f.status !== "D" && (
          <button className="tc-fact" title="Open in collaboration mode: edit the file and attach comments" onClick={() => onCollaborate(f.path)}>
            {Icon.edit()} Collaborate
          </button>
        )}
      </div>
      {isCollapsed ? (
        // A big file collapsed by default still needs to say why it's empty.
        big && (
          <button className="tc-bigdiff" onClick={() => onToggle(f.path)}>
            Large diff ({lines.length.toLocaleString()} lines) — click to expand
          </button>
        )
      ) : (
        <div className="tc-hunks">
          {f.binary ? (
            <div className="tc-empty">Binary file — not shown</div>
          ) : lines.length === 0 ? (
            <div className="tc-empty">No textual changes (mode or rename).</div>
          ) : viewMode === "unified" ? (
            // One max-content-wide block holds every row, so the longest line
            // sets the width of all of them and the file scrolls as a whole
            // (see .tc-rows) — rows sized individually would each need their
            // own scrollbar and would stripe short.
            <div className="tc-rows">
              {lines.map((ln, i) => {
                const side: "old" | "new" = ln.cls === "del" ? "old" : "new";
                const anchor = side === "old" ? ln.oldNo : ln.newNo;
                return ln.cls === "hunk" ? (
                  <div key={i} className="dl hunk">{ln.text}</div>
                ) : (
                  <div key={i}>
                    <div className={`dl ${ln.cls}`}>
                      {gutter(ln.oldNo, "old", side)}
                      {gutter(ln.newNo, "new", side)}
                      <span className="dl-c">{ln.text || " "}</span>
                    </div>
                    {rowComments(side, anchor)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="tc-split">
              {rows.map((row, i) => {
                if (row.hunkText !== undefined) return <div key={i} className="dl hunk tc-split-full">{row.hunkText}</div>;
                const oldAnchor = row.left?.cls === "del" ? row.left.no : null;
                const newAnchor = row.right && (row.right.cls === "add" || row.right.cls === "ctx") ? row.right.no : null;
                return (
                  <div key={i} className="tc-split-full">
                    <div className="tc-split-pair">
                      <div className={`dl ${row.left ? row.left.cls : "spacer"}`}>
                        {splitGutter(row.left, "old")}
                        <span className="dl-c">{(row.left?.text || " ")}</span>
                      </div>
                      <div className={`dl ${row.right ? row.right.cls : "spacer"}`}>
                        {splitGutter(row.right, "new")}
                        <span className="dl-c">{(row.right?.text || " ")}</span>
                      </div>
                    </div>
                    {rowComments("old", oldAnchor)}
                    {rowComments("new", newAnchor)}
                  </div>
                );
              })}
            </div>
          )}
          {f.truncated && <div className="tc-empty">… file diff truncated</div>}
        </div>
      )}
      <OutdatedComments comments={outdatedComments} />
    </div>
  );
});

/**
 * Offered after a merge lands: publish the base branch the merge just advanced.
 *
 * Merging only ever moved the LOCAL base branch, so a team that reviews on
 * GitHub ends up with two diverging integration points — the app's and the
 * remote's. One click closes that loop. Renders nothing unless there's a remote
 * and something to send, so a purely local project never sees it.
 */
function PushBaseBranch({ projectId }: { projectId: string }) {
  const [st, setSt] = useState<{ ahead: number; label: string } | null>(null);
  const [state, setState] = useState<"" | "busy" | "done">("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/api/projects/${projectId}/base-branch`, { cache: "no-store" });
        const j = await r.json();
        if (live && j?.hasRemote && (j.ahead ?? 0) > 0 && !j.diverged) setSt({ ahead: j.ahead, label: j.label || "the remote" });
      } catch { /* no banner beats a wrong one */ }
    })();
    return () => { live = false; };
  }, [projectId]);

  if (!st) return null;
  if (state === "done") return <span className="tc-merged">✓ Pushed to {st.label}</span>;

  const push = async () => {
    setState("busy");
    setErr("");
    try {
      const r = await fetch(`/api/projects/${projectId}/base-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "push" }),
      });
      const j = await r.json();
      // A rejected push leaves the merge intact — it landed locally either way.
      if (j?.ok) setState("done");
      else { setErr(j?.error || "push failed"); setState(""); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("");
    }
  };

  return (
    <div className="tc-push">
      <button className="tc-btn" onClick={push} disabled={state === "busy"} title={`Push the base branch to ${st.label}`}>
        {state === "busy" ? "Pushing…" : `Push to ${st.label}`}
      </button>
      {err && <span className="tc-push-err">⚠ {err}</span>}
    </div>
  );
}

export default function TaskChanges({
  taskId,
  projectId,
  running,
  prUrl,
  onMerged,
  onPrCreated,
  onResolveWithAI,
  onSyncChanged,
  refresh,
  onSend,
}: {
  taskId: string;
  projectId: string;
  running?: boolean;
  // Fired after any merge-state mutation here (land, prepare, accept, discard),
  // successful or not: the session's sync banner reads the same worktree and
  // only re-reads on its own when a turn ends, so without this an Accept or
  // Discard in this tab would leave it describing the state from before.
  onSyncChanged?: () => void;
  // Bumped by the parent when the merge state changed OUTSIDE this component
  // (the session's sync banner accepting a resolution): the review state shown
  // here is otherwise re-read only on mount, a task switch, or a turn ending.
  refresh?: number;
  prUrl?: string; // GitHub PR already opened from this branch ("" / undefined = none)
  onMerged?: () => void;
  onPrCreated?: (url: string) => void;
  onResolveWithAI?: (taskId: string) => Promise<ResolveResult>;
  // Send-to-agent path for review comments: the same handler SessionView wires
  // to runTurn, so a sent comment flips local running state exactly like a
  // normal chat message. Undefined only in contexts that don't offer it
  // (shouldn't happen in practice) — the comment still posts, just unsent.
  onSend?: (text: string) => void;
}) {
  const [data, setData] = useState<DiffResp | null>(() => diffCache.get(taskId) ?? null);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(false);
  const [prBusy, setPrBusy] = useState(false);
  const [prErr, setPrErr] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [dirtyHelp, setDirtyHelp] = useState(false);
  const [binaryConflicts, setBinaryConflicts] = useState<string[]>([]);
  const [mergeRes, setMergeRes] = useState<MergeResp | null>(null);
  const [active, setActive] = useState<string | null>(null);
  // Paths the user flipped away from their default state (expanded normally,
  // collapsed for big files) — override semantics so a background revalidate
  // doesn't reset the user's choices.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"unified" | "split">(() => {
    try { return (localStorage.getItem(VIEW_MODE_KEY) ?? localStorage.getItem(LEGACY_VIEW_MODE_KEY)) === "split" ? "split" : "unified"; } catch { return "unified"; }
  });
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [sel, setSel] = useState<CommentSel | null>(null); // line range being commented on, if any
  const [collab, setCollab] = useState<string | null>(null); // file path open in collaboration mode
  const [draft, setDraft] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const secRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const setView = (v: "unified" | "split") => {
    setViewMode(v);
    try { localStorage.setItem(VIEW_MODE_KEY, v); } catch { /* private browsing, etc. */ }
  };

  const loadComments = useCallback(async () => {
    try {
      const r = await fetch(`/api/tasks/${taskId}/comments`, { cache: "no-store" });
      const j: { comments?: TaskComment[] } = await r.json();
      setComments(j.comments ?? []);
    } catch { /* comments are supplementary — a failed fetch just shows none */ }
  }, [taskId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/tasks/${taskId}/diff`, { cache: "no-store" });
      const j: DiffResp = await r.json();
      if (!j.error) diffCache.set(taskId, j); // errors are worth retrying, not replaying
      setData(j);
    } catch (e) {
      setData({ isolated: false, files: [], isDirty: false, ahead: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setMergeRes(null);
    setPrErr(null);
    setToggled(new Set());
    setManualOpen(false);
    setBinaryConflicts([]);
    setSel(null);
    setDraft("");
    // Task switched without a remount: show the new task's cached diff (or the
    // skeleton), never the previous task's stale files, while we revalidate.
    setData(diffCache.get(taskId) ?? null);
    load();
    loadComments();
  }, [taskId, load, loadComments]);

  // The diff moves while the agent works — refetch when a turn finishes so a
  // just-written change appears without a manual Refresh (same trigger the
  // SyncBanner uses). Only on the running→idle transition; mount already loads.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) load();
    wasRunning.current = running;
  }, [running, load]);

  useEffect(() => { if (refresh) load(); }, [refresh, load]);

  // Track which file is at the top of the scroll area to highlight it in the list.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !data?.files?.length) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = sc.scrollTop + 16;
        let cur = data.files[0]?.path ?? null;
        for (const f of data.files) {
          const el = secRefs.current[f.path];
          if (el && el.offsetTop <= top) cur = f.path;
        }
        setActive(cur);
      });
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      sc.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [data]);

  const jump = (path: string) => {
    const el = secRefs.current[path];
    const sc = scrollRef.current;
    if (!el || !sc) return;
    setActive(path);
    // content-visibility placeholders make offsetTop an estimate until the
    // sections near the target actually render, and that rendering lags the
    // scroll by a frame or two — so instead of one smooth scroll to a
    // coordinate that goes stale mid-flight, jump instantly and keep
    // re-targeting for a few frames while the layout settles.
    let frames = 0;
    const settle = () => {
      const top = Math.max(0, el.offsetTop - 4);
      if (Math.abs(sc.scrollTop - top) > 1) sc.scrollTop = top;
      if (++frames < 12) requestAnimationFrame(settle);
    };
    settle();
  };
  const toggle = useCallback(
    (path: string) =>
      setToggled((s) => {
        const n = new Set(s);
        n.has(path) ? n.delete(path) : n.add(path);
        return n;
      }),
    []
  );

  // Start or extend the comment selection. Plain click opens a fresh
  // single-line box; shift-click on another line in the same file extends the
  // range instead of starting over.
  const onLineClick = useCallback((file: string, side: "old" | "new", no: number, shiftKey: boolean) => {
    setSel((prev) => {
      if (shiftKey && prev && prev.file === file && prev.side === side)
        return { file, side, start: Math.min(prev.start, no), end: Math.max(prev.end, no) };
      return { file, side, start: no, end: no };
    });
    setDraft("");
  }, []);
  const cancelComment = useCallback(() => { setSel(null); setDraft(""); }, []);

  const submitComment = async (sentToAgent: boolean) => {
    if (!sel || !draft.trim()) return;
    setCommentBusy(true);
    try {
      const r = await fetch(`/api/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: sel.file, side: sel.side, lineStart: sel.start, lineEnd: sel.end, body: draft.trim(), sentToAgent,
          anchorSha: data?.head ?? null,
        }),
      });
      const j: { ok?: boolean; comment?: TaskComment } = await r.json();
      if (j.ok && j.comment) {
        setComments((cs) => [...cs, j.comment as TaskComment]);
        if (sentToAgent) onSend?.(`Review comment on ${sel.file} L${sel.start}–${sel.end}:\n${draft.trim()}`);
        setSel(null);
        setDraft("");
      }
    } finally {
      setCommentBusy(false);
    }
  };

  // `stashDirty` carries the exact paths shown in the dirty-checkout card — the
  // user's by-name consent to have those set aside for the merge and put back
  // after it. An ordinary Merge click sends no body and never stashes anything.
  const doMerge = async (stashDirty?: string[]) => {
    setMerging(true);
    setMergeRes(null);
    try {
      const r = await fetch(`/api/tasks/${taskId}/merge`, {
        method: "POST",
        ...(stashDirty ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ stashDirty }) } : {}),
      });
      const res = await mergeJson(r);
      setMergeRes(res);
      if (res.ok) {
        onMerged?.();
        load();
      }
    } catch (e) {
      setMergeRes({ ok: false, targetBranch: "", committed: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setMerging(false);
      onSyncChanged?.();
    }
  };

  // Review-on-GitHub path: push the branch + open (or update) a PR. The server
  // commits any dirty work first and is idempotent, so a second click on an
  // already-open PR just pushes the new commits to it.
  const doCreatePr = async () => {
    setPrBusy(true);
    setPrErr(null);
    try {
      const r = await fetch(`/api/tasks/${taskId}/pr`, { method: "POST" });
      const res: { ok?: boolean; url?: string; error?: string } = await r.json();
      if (res.ok && res.url) onPrCreated?.(res.url);
      else setPrErr(res.error || "could not create the PR");
    } catch (e) {
      setPrErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPrBusy(false);
      load(); // the push may have committed dirty work — refresh the diff state
    }
  };

  // Fix with AI: prepare the trial merge + stream a resolution turn (handled by
  // the parent so it shows in the transcript), then reload into review state.
  const doResolveWithAI = async () => {
    if (!onResolveWithAI) return;
    setResolving(true);
    setManualOpen(false);
    setMergeRes(null);
    try {
      const res = await onResolveWithAI(taskId);
      setBinaryConflicts(res.binaryConflicts ?? []);
      if (res.merged) onMerged?.();
      else if (!res.ok)
        setMergeRes({ ok: false, targetBranch: "", committed: false, error: res.error || "AI resolution failed" });
    } finally {
      setResolving(false);
      load(); // reload → mergeInProgress review state (Accept/Discard) or merged
      onSyncChanged?.();
    }
  };

  // Accept a resolution: commit + land the (now clean) branch into the base.
  // Takes the same dirty-checkout acknowledgement as doMerge — this path lands
  // through the same in-place merge and can be refused by the same dirt.
  const doComplete = async (stashDirty?: string[]) => {
    setMerging(true);
    try {
      const r = await fetch(`/api/tasks/${taskId}/merge/complete`, {
        method: "POST",
        ...(stashDirty ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ stashDirty }) } : {}),
      });
      const res = await mergeJson(r);
      setMergeRes(res);
      if (res.ok) onMerged?.();
    } catch (e) {
      setMergeRes({ ok: false, targetBranch: "", committed: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setMerging(false);
      load();
      onSyncChanged?.();
    }
  };

  // Discard a resolution: abort the trial merge, back to a clean worktree.
  const doAbort = async () => {
    setMerging(true);
    try {
      await fetch(`/api/tasks/${taskId}/merge/abort`, { method: "POST" });
      setMergeRes(null);
      setBinaryConflicts([]);
    } finally {
      setMerging(false);
      load();
      onSyncChanged?.();
    }
  };

  if (loading && !data) {
    // Diffing shells out to git — sketch the toolbar + file list so the tab
    // reads "computing the diff", not "empty".
    return (
      <div className="tc-root" aria-hidden>
        <div className="tc-bar">
          <Skel w={150} h={13} />
          <Skel w={70} h={11} />
          <span className="tc-spacer" />
          <Skel w={130} h={26} r="var(--r-sm)" />
        </div>
        <div className="tc-scroll">
          <div className="tc-list">
            {[62, 44, 54].map((w, i) => (
              <div key={i} className="skel-lrow">
                <Skel w={13} h={13} r={4} />
                <Skel w={`${w}%`} h={11} />
                <span style={{ flex: 1 }} />
                <Skel w={46} h={10} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (!data) return <div className="tc-note">No data.</div>;
  if (data.error) return <div className="tc-note"><ErrNote onRetry={load}>{data.error}</ErrNote></div>;
  if (!data.isolated) return <div className="tc-note">{data.reason || "No isolated branch for this task."}</div>;

  const merged = !!data.merged_at || !!data.alreadyMerged;
  const totalAdd = data.files.reduce((n, f) => n + f.additions, 0);
  const totalDel = data.files.reduce((n, f) => n + f.deletions, 0);
  const nothing = data.files.length === 0;
  // Something to merge if the branch isn't fully in the base branch yet, or
  // there are uncommitted edits in the worktree. `alreadyMerged` also catches
  // merges done outside the app, so an already-landed branch won't re-offer.
  const pending = !data.alreadyMerged || data.isDirty;
  // A conflict resolution is staged in the worktree, awaiting accept/discard.
  const reviewing = !!data.mergeInProgress;

  return (
    <div className="tc-root">
      <div className="tc-bar">
        <code className="tc-branch">{data.branch}</code>
        <span className="tc-arrow">→ {data.baseLabel}</span>
        {!nothing && (
          <span className="tc-stat">
            <b className="add">+{totalAdd}</b> <b className="del">−{totalDel}</b>
          </span>
        )}
        {data.isDirty && <span className="tc-dirty">● uncommitted</span>}
        {data.ahead > 0 && <span className="tc-ahead">{data.ahead} commit{data.ahead === 1 ? "" : "s"}</span>}
        {!nothing && (
          <span className="tc-vseg">
            <button className={viewMode === "unified" ? "on" : ""} onClick={() => setView("unified")}>Unified</button>
            <button className={viewMode === "split" ? "on" : ""} onClick={() => setView("split")}>Split</button>
          </span>
        )}
        <span className="tc-spacer" />
        <button className="tc-btn" onClick={load} disabled={loading || merging || resolving}>
          {loading ? "…" : "Refresh"}
        </button>
        {reviewing ? (
          <>
            <button className="tc-btn" onClick={doAbort} disabled={merging || resolving}>
              Discard
            </button>
            <button className="tc-btn primary" onClick={() => doComplete()} disabled={merging || resolving}>
              {merging ? "Merging…" : "Accept & merge"}
            </button>
          </>
        ) : resolving ? (
          <span className="tc-merged faint">Resolving conflicts with AI…</span>
        ) : (
          <>
            {merged && !pending && <span className="tc-merged">✓ Merged · up to date</span>}
            {prUrl && (
              <a className="tc-btn tc-pr" href={prUrl} target="_blank" rel="noreferrer" title="Open this task's pull request on GitHub">
                PR ↗
              </a>
            )}
            {(data.ahead > 0 || data.isDirty) && (
              <button
                className="tc-btn"
                onClick={doCreatePr}
                disabled={prBusy || merging}
                title={prUrl ? "Push the branch's new commits to the open PR" : "Push the branch to origin and open a GitHub PR"}
              >
                {prBusy ? (prUrl ? "Pushing…" : "Creating PR…") : prUrl ? "Update PR" : "Create PR"}
              </button>
            )}
            {pending && (
              <button className="tc-btn primary" onClick={() => doMerge()} disabled={merging || prBusy}>
                {merging ? "Merging…" : merged ? "Merge new changes" : `Merge to ${data.baseLabel}`}
              </button>
            )}
            {!pending && !merged && !nothing && <span className="tc-merged faint">Up to date</span>}
          </>
        )}
      </div>

      {reviewing && (
        <div className="tc-mergebar review">
          Conflicts resolved — review the merged result below, then <b>Accept &amp; merge</b> or <b>Discard</b>.
          {data.unresolved && data.unresolved.length > 0 && (
            <div className="tc-conflicts">
              {`⚠ ${data.unresolved.length} file(s) still unresolved:\n${data.unresolved.join("\n")}`}
            </div>
          )}
          {binaryConflicts.length > 0 && (
            <div className="tc-conflicts">
              {`Binary conflicts kept the task-branch version — review manually:\n${binaryConflicts.join("\n")}`}
            </div>
          )}
        </div>
      )}

      {prErr && <div className="tc-mergebar bad">⚠ {prErr}</div>}

      {mergeRes && (
        <div className={`tc-mergebar ${mergeRes.ok ? "ok" : "bad"}`}>
          {mergeRes.ok
            ? mergeRes.alreadyMerged
              ? `Already up to date with ${mergeRes.targetBranch}.`
              : `Merged into ${mergeRes.targetBranch}.`
            : `⚠ ${mergeRes.error || "merge failed"}`}
          {mergeRes.ok && !mergeRes.alreadyMerged && <PushBaseBranch projectId={projectId} />}
          {/* The merge had to run in the project's own checkout and found it
              dirty. Show exactly what is in the way — usually a tool dropping,
              not the user's work — and offer to set it aside for the merge. */}
          {!mergeRes.ok && mergeRes.dirty && mergeRes.dirty.length > 0 && (
            <>
              <div className="tc-manual">
                These are uncommitted in the project&apos;s checkout — <b>not</b> in this task&apos;s worktree. The merge lands on{" "}
                <code>{mergeRes.targetBranch}</code>, which is the branch that checkout has open, so it has to be clean first.
              </div>
              <div className="tc-conflicts">
                {mergeRes.dirty.map((d) => `${d.code} ${d.path}`).join("\n")}
                {mergeRes.dirtyTruncated ? "\n… and more" : ""}
              </div>
              <div className="tc-conflict-actions">
                <button className="tc-btn" onClick={() => setDirtyHelp((v) => !v)} disabled={merging}>
                  Handle it myself
                </button>
                {!mergeRes.dirtyTruncated && (
                  <button
                    className="tc-btn primary"
                    onClick={() => {
                      const paths = mergeRes.dirty!.map((d) => d.path);
                      // Retry through whichever path was refused, so accepting a
                      // resolution still clears its abort marker on the way out.
                      return reviewing ? doComplete(paths) : doMerge(paths);
                    }}
                    disabled={merging}
                    title="git stash push --include-untracked, merge, then restore the stash"
                  >
                    {merging
                      ? "Merging…"
                      : `Stash ${mergeRes.dirty.length} file${mergeRes.dirty.length === 1 ? "" : "s"} & merge`}
                  </button>
                )}
              </div>
              {dirtyHelp && (
                <div className="tc-manual">
                  Open a terminal on <b>Project</b> scope and commit, revert or delete the files above, then click Merge again.
                  Stashing does the same thing without leaving Calandria: exactly these files are stashed, the merge runs, and the
                  stash is applied back on top — if that apply hits a conflict the stash is kept and its id shown here.
                </div>
              )}
            </>
          )}
          {mergeRes.stashed && (
            <div className="tc-manual">
              {mergeRes.stashed.restored
                ? "Your uncommitted changes were set aside for the merge and restored afterwards."
                : `Your uncommitted changes are still stashed${
                    mergeRes.stashed.error ? ` (${mergeRes.stashed.error})` : ""
                  } — recover them with: git stash apply ${mergeRes.stashed.sha.slice(0, 10)}`}
            </div>
          )}
          {mergeRes.conflicts && mergeRes.conflicts.length > 0 && (
            <div className="tc-conflicts">{mergeRes.conflicts.join("\n")}</div>
          )}
          {mergeRes.conflicts && mergeRes.conflicts.length > 0 && !reviewing && (
            <>
              <div className="tc-conflict-actions">
                <button className="tc-btn" onClick={() => setManualOpen((v) => !v)} disabled={resolving || merging}>
                  Resolve manually
                </button>
                {onResolveWithAI && (
                  <button className="tc-btn primary" onClick={doResolveWithAI} disabled={resolving || merging}>
                    {resolving ? "Resolving…" : "Fix with AI"}
                  </button>
                )}
              </div>
              {manualOpen && (
                <div className="tc-manual">
                  Resolve these conflicts yourself in the task&apos;s worktree (use the integrated terminal): merge{" "}
                  <code>{data.baseLabel}</code> into the branch, fix the markers, commit, then click Merge again.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {nothing ? (
        <div className="tc-note">No changes on this branch yet.</div>
      ) : (
        <div className="tc-scroll" ref={scrollRef}>
          {/* overview list — click a file to jump to its diff */}
          <div className="tc-list">
            <div className="tc-list-h">
              {data.files.length} file{data.files.length === 1 ? "" : "s"} changed
            </div>
            {data.files.map((f) => (
              <button key={f.path} className={`tc-frow ${active === f.path ? "on" : ""}`} onClick={() => jump(f.path)} title={f.path}>
                <span className={`tc-st s-${f.status === "?" ? "new" : f.status}`} title={STATUS_LABEL[f.status] || f.status}>
                  {f.status}
                </span>
                <span className="tc-fpath">{f.path}</span>
                {f.binary ? (
                  <span className="tc-bin">bin</span>
                ) : (
                  <span className="tc-cnt">
                    <b className="add">+{f.additions}</b> <b className="del">−{f.deletions}</b>
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* per-file diffs with sticky headers */}
          {data.files.map((f) => (
            <FileDiff
              key={f.path} file={f} userToggled={toggled.has(f.path)} onToggle={toggle} refs={secRefs}
              viewMode={viewMode} comments={comments} diffHead={data.head ?? null} sel={sel} draft={draft} busy={commentBusy}
              onLineClick={onLineClick} onDraftChange={setDraft}
              onSend={() => submitComment(true)} onCommentOnly={() => submitComment(false)} onCancel={cancelComment}
              onCollaborate={onSend ? setCollab : undefined}
            />
          ))}
        </div>
      )}
      {collab && onSend && (
        <CollabDoc taskId={taskId} file={collab} running={running} onClose={() => setCollab(null)} onSend={onSend} onWritten={load} />
      )}
    </div>
  );
}
