"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { Markdown } from "../Markdown";
import { Modal } from "./Modal";
import { Skel, ErrNote } from "./shared";
import { buildCollabPacket, DEFAULT_COLLAB_EDIT_MODE, type CollabEditMode, type PassageComment } from "@/lib/collab";

// Document collaboration mode — a Word-style review of one markdown file the
// agent touched. Two tabs over ONE document state: EDIT (source editor beside
// a live render) and COMMENT (the render, select a passage → attach a note,
// plus a general box). Send builds a single message (lib/collab.ts) carrying
// the edit diff and/or the comments with their location, and hands it to the
// same onSend chat uses — so it queues behind a running turn like any message.
//
// Edits reach the file one of two ways (`CollabEditMode`). "direct" — the
// default — writes the edited text into the worktree first (POST
// /api/tasks/[id]/file) and the message carries the diff as context; it's the
// reliable route, since a model asked to apply a patch verbatim sometimes
// doesn't. "patch" sends only the diff and asks the agent to apply it, which
// keeps the agent's session the worktree's only writer. Direct is refused by
// the server while a turn is running (the agent owns the worktree) and when
// the file changed since the modal loaded it; the picker greys the option out
// for the first case client-side, the second shows up as an error on Send.

const EDIT_MODE_KEY = "collab-edit-mode";
function loadEditMode(): CollabEditMode {
  try {
    const v = localStorage.getItem(EDIT_MODE_KEY);
    return v === "patch" || v === "direct" ? v : DEFAULT_COLLAB_EDIT_MODE;
  } catch {
    return DEFAULT_COLLAB_EDIT_MODE;
  }
}

const MarkdownEditor = dynamic(() => import("./MarkdownEditor"), { ssr: false, loading: () => <Skel w="100%" h={200} /> });

type Tab = "edit" | "comment";
type Draft = PassageComment & { id: number };
// A selection the user just made in the rendered view, before it's a comment.
type Pending = { quote: string; heading: string | null; top: number; left: number };

const HIGHLIGHT_NAME = "collab-comments";
const ACTIVE_HIGHLIGHT_NAME = "collab-comment-active";

// Nearest heading above a range in the rendered DOM: walk up to the block that
// contains the selection start, then back through its siblings.
function nearestHeading(range: Range, host: HTMLElement): string | null {
  // The blocks are children of the Markdown component's own wrapper, not of
  // the scroll host that owns the selection.
  const root = host.querySelector(".md") ?? host;
  let node: Node | null = range.startContainer;
  while (node && node.parentNode !== root) node = node.parentNode;
  for (let el = node as Element | null; el; el = el.previousElementSibling) {
    if (/^H[1-6]$/.test(el.tagName)) return el.textContent?.trim() || null;
  }
  return null;
}

// Re-find a quote in the rendered DOM as a Range, whitespace-insensitively
// (Selection.toString() inserts newlines between blocks that textContent
// doesn't). Used to paint highlights after a re-render and to scroll to a
// comment's passage; null when the text is no longer there (edited away).
function findRange(root: HTMLElement, quote: string): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chars: { node: Text; off: number }[] = [];
  let norm = "";
  let lastSpace = true;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const t = n.data;
    for (let i = 0; i < t.length; i++) {
      const ws = /\s/.test(t[i]);
      if (ws) {
        if (lastSpace) continue;
        norm += " ";
        chars.push({ node: n, off: i });
        lastSpace = true;
      } else {
        norm += t[i];
        chars.push({ node: n, off: i });
        lastSpace = false;
      }
    }
  }
  const q = quote.replace(/\s+/g, " ").trim();
  if (!q) return null;
  const at = norm.indexOf(q);
  if (at < 0) return null;
  const s = chars[at];
  const e = chars[at + q.length - 1];
  const r = document.createRange();
  r.setStart(s.node, s.off);
  r.setEnd(e.node, e.off + 1);
  return r;
}

const highlightsSupported = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

// The tint rules can't live in globals.css: Lightning CSS (Turbopack's CSS
// pass) doesn't know the ::highlight() pseudo-element and fails the build on
// it. Injected once, on first open, in browsers that have the API.
const HIGHLIGHT_STYLE_ID = "collab-highlight-style";
function ensureHighlightStyle() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = HIGHLIGHT_STYLE_ID;
  el.textContent =
    `::highlight(${HIGHLIGHT_NAME}){background:color-mix(in oklab,var(--warn) 28%,transparent);}` +
    `::highlight(${ACTIVE_HIGHLIGHT_NAME}){background:color-mix(in oklab,var(--warn) 55%,transparent);}`;
  document.head.appendChild(el);
}

export function CollabDoc({ taskId, file, running, onClose, onSend, onWritten }: {
  taskId: string;
  file: string;
  running?: boolean; // a turn is live — direct writes are refused server-side, so the picker says so up front
  onClose: () => void;
  onSend: (text: string) => void;
  onWritten?: () => void; // the file on disk changed under the Changes tab — refetch the diff
}) {
  const [original, setOriginal] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("comment");
  const [comments, setComments] = useState<Draft[]>([]);
  const [general, setGeneral] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [composing, setComposing] = useState<{ quote: string; heading: string | null } | null>(null);
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const [mode, setMode] = useState<CollabEditMode>(loadEditMode);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const dark = typeof document !== "undefined" && document.documentElement.dataset.mode !== "light";

  useEffect(() => {
    let dead = false;
    fetch(`/api/tasks/${taskId}/file?path=${encodeURIComponent(file)}`, { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { content?: string; error?: string };
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        return j.content ?? "";
      })
      .then((c) => { if (!dead) { setOriginal(c); setText(c); } })
      .catch((e) => { if (!dead) setError(e instanceof Error ? e.message : String(e)); });
    return () => { dead = true; };
  }, [taskId, file]);

  const edited = original !== null && text !== original;
  // The mode that will actually be used: a running turn makes direct
  // impossible, and the server would refuse it anyway.
  const effectiveMode: CollabEditMode = mode === "direct" && running ? "patch" : mode;
  const packet = useMemo(
    () => (original === null ? null : buildCollabPacket({ file, original, edited: text, comments, general, mode: effectiveMode })),
    [file, original, text, comments, general, effectiveMode]
  );
  const pickMode = (m: CollabEditMode) => {
    setMode(m);
    setSendError(null);
    try { localStorage.setItem(EDIT_MODE_KEY, m); } catch { /* private browsing, etc. */ }
  };
  const dirty = edited || comments.length > 0 || general.trim().length > 0;

  // Closing with unsent work asks once; the scrim, Escape and Cancel all go
  // through here.
  const close = useCallback(() => {
    if (dirty && !window.confirm("Discard your edits and comments?")) return;
    onClose();
  }, [dirty, onClose]);

  // Selection → "Add comment" affordance. Runs on mouseup/keyup inside the
  // rendered view; anything collapsed or outside it clears the affordance.
  const onSelect = useCallback(() => {
    const root = docRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) { setPending(null); return; }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) { setPending(null); return; }
    const quote = sel.toString().trim();
    if (!quote) { setPending(null); return; }
    const rect = range.getBoundingClientRect();
    const host = root.getBoundingClientRect();
    setPending({
      quote,
      heading: nearestHeading(range, root),
      top: rect.bottom - host.top + root.scrollTop + 6,
      left: Math.max(0, Math.min(rect.left - host.left, host.width - 140)),
    });
  }, []);

  const startComment = () => {
    if (!pending) return;
    setComposing({ quote: pending.quote, heading: pending.heading });
    setDraft("");
    setPending(null);
    window.getSelection()?.removeAllRanges();
  };
  const addComment = () => {
    if (!composing || !draft.trim()) return;
    setComments((cs) => [...cs, { ...composing, comment: draft.trim(), id: nextId.current++ }]);
    setComposing(null);
    setDraft("");
  };
  const remove = (id: number) => setComments((cs) => cs.filter((c) => c.id !== id));

  // Paint every comment's passage via the CSS Custom Highlight API — no DOM
  // mutation, so react-markdown's tree is never fought over, and a re-render
  // (tab switch, edit) simply repaints from the quotes. Browsers without it
  // still get the list on the right; the passage just isn't tinted.
  useEffect(() => {
    if (!highlightsSupported()) return;
    ensureHighlightStyle();
    const root = docRef.current;
    if (!root || tab !== "comment") { CSS.highlights.delete(HIGHLIGHT_NAME); CSS.highlights.delete(ACTIVE_HIGHLIGHT_NAME); return; }
    const all: Range[] = [];
    const act: Range[] = [];
    for (const c of comments) {
      const r = findRange(root, c.quote);
      if (!r) continue;
      (c.id === active ? act : all).push(r);
    }
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...all));
    CSS.highlights.set(ACTIVE_HIGHLIGHT_NAME, new Highlight(...act));
    return () => { CSS.highlights.delete(HIGHLIGHT_NAME); CSS.highlights.delete(ACTIVE_HIGHLIGHT_NAME); };
  }, [comments, active, tab, text]);

  const jumpTo = (c: Draft) => {
    setActive(c.id);
    const root = docRef.current;
    if (!root) return;
    const r = findRange(root, c.quote);
    const el = r?.startContainer.parentElement;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const send = async () => {
    if (!packet || sending || original === null) return;
    if (edited && effectiveMode === "direct") {
      setSending(true);
      setSendError(null);
      try {
        const r = await fetch(`/api/tasks/${taskId}/file`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: file, original, content: text }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string; current?: string };
          const why = j.error || `HTTP ${r.status}`;
          throw new Error(
            typeof j.current === "string"
              ? `${why}. Your edits were made against text that is no longer on disk — send them as a patch so the agent can reconcile, or cancel and reopen the document.`
              : why
          );
        }
        onWritten?.();
      } catch (e) {
        setSendError(e instanceof Error ? e.message : String(e));
        setSending(false);
        return;
      }
    }
    onSend(packet);
    onClose();
  };

  const status = [
    edited ? "edited" : null,
    comments.length ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : null,
    general.trim() ? "general note" : null,
  ].filter(Boolean).join(" · ");

  return (
    <Modal
      title="Collaborate on document"
      sub={file}
      onClose={close}
      width={1180}
      footer={
        <>
          <span className="collab-status">{sendError ? <span className="collab-send-err">{sendError}</span> : status || "No changes yet — edit the text or select a passage to comment."}</span>
          <span className="spacer" />
          {edited && (
            <label className="collab-mode" title={running ? "The agent is working, so the worktree is its to write; your edits go as a patch until the turn ends." : "How your edits reach the file"}>
              <span>Edits</span>
              <select value={effectiveMode} onChange={(e) => pickMode(e.target.value as CollabEditMode)} disabled={sending}>
                <option value="direct" disabled={!!running}>{running ? "Write to file (agent is working)" : "Write to file"}</option>
                <option value="patch">Send as patch for the agent to apply</option>
              </select>
            </label>
          )}
          <button className="btn btn-line" onClick={close} disabled={sending}>Cancel</button>
          <button className="btn btn-accent" onClick={send} disabled={!packet || sending}>{Icon.send()} {sending ? "Writing…" : "Send to agent"}</button>
        </>
      }
    >
      <div className="collab">
        <div className="collab-tabs">
          <button className={`rail-tab ${tab === "edit" ? "on" : ""}`} onClick={() => setTab("edit")}>{Icon.edit()} EDIT</button>
          <button className={`rail-tab ${tab === "comment" ? "on" : ""}`} onClick={() => setTab("comment")}>{Icon.doc()} COMMENT</button>
          <span className="collab-hint">
            {tab === "edit"
              ? effectiveMode === "direct"
                ? "Edit the markdown source; it's written to the file as-is when you send."
                : "Edit the markdown source; your exact wording is sent as a patch."
              : "Select text in the document to attach a comment to it."}
          </span>
        </div>

        {error ? (
          <ErrNote>{error}</ErrNote>
        ) : original === null ? (
          <Skel w="100%" h={320} />
        ) : tab === "edit" ? (
          <div className="collab-split">
            <div className="collab-pane collab-editor">
              <MarkdownEditor value={text} onChange={setText} dark={dark} />
            </div>
            <div className="collab-pane collab-render">
              <Markdown>{text}</Markdown>
            </div>
          </div>
        ) : (
          <div className="collab-split">
            <div className="collab-pane collab-render collab-selectable" ref={docRef} onMouseUp={onSelect} onKeyUp={onSelect}>
              <Markdown>{text}</Markdown>
              {pending && (
                <button className="collab-addc" style={{ top: pending.top, left: pending.left }} onMouseDown={(e) => e.preventDefault()} onClick={startComment}>
                  {Icon.plus()} Add comment
                </button>
              )}
            </div>
            <div className="collab-pane collab-side">
              {composing && (
                <div className="collab-compose">
                  <div className="collab-quote">{composing.quote}</div>
                  <textarea
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="What should change here?"
                    rows={3}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addComment(); }}
                  />
                  <div className="collab-compose-a">
                    <button className="tc-btn" onClick={() => setComposing(null)}>Cancel</button>
                    <button className="tc-btn primary" onClick={addComment} disabled={!draft.trim()}>Add</button>
                  </div>
                </div>
              )}
              {comments.length === 0 && !composing && (
                <div className="collab-empty">No passage comments yet. Highlight text on the left and press <b>Add comment</b>.</div>
              )}
              {comments.map((c, i) => (
                <div key={c.id} className={`collab-c ${active === c.id ? "on" : ""}`} onMouseEnter={() => setActive(c.id)} onMouseLeave={() => setActive(null)} onClick={() => jumpTo(c)}>
                  <div className="collab-c-h">
                    <span className="collab-c-n">{i + 1}</span>
                    {c.heading && <span className="collab-c-where">{c.heading}</span>}
                    <span style={{ flex: 1 }} />
                    <button className="collab-c-x" title="Remove comment" onClick={(e) => { e.stopPropagation(); remove(c.id); }}>{Icon.x()}</button>
                  </div>
                  <div className="collab-quote">{c.quote}</div>
                  <div className="collab-c-body">{c.comment}</div>
                </div>
              ))}
              <div className="collab-general">
                <div className="lab">General comments</div>
                <textarea value={general} onChange={(e) => setGeneral(e.target.value)} placeholder="Feedback on the document as a whole…" rows={4} />
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
