"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { attachmentMarker, fileAttachmentMarker } from "./format";
import { AttachmentChips, uploadToTask, useAttachments } from "./attachments";
import { useCoarsePointer } from "./shared";
import { PASTE_ATTACH_THRESHOLD } from "@/lib/promptLimits";
import type { AgentCommand } from "@/lib/agents/types";
import type { TaskRow } from "./types";

// Drafts persist per-task in localStorage so switching tasks, opening Settings,
// or reloading the page doesn't throw away half-typed messages. (SessionView is
// keyed by task.id, so the Composer remounts on every task switch.)
// loadDraft/saveDraft also migrate a draft stored under the old `orch:draft:` key.
const draftKey = (taskId: string) => `calandria:draft:${taskId}`;
const legacyDraftKey = (taskId: string) => `orch:draft:${taskId}`;
const loadDraft = (taskId: string) => {
  if (typeof window === "undefined") return "";
  try {
    const v = window.localStorage.getItem(draftKey(taskId));
    if (v !== null) return v;
    const legacy = window.localStorage.getItem(legacyDraftKey(taskId));
    if (legacy !== null) {
      window.localStorage.setItem(draftKey(taskId), legacy);
      window.localStorage.removeItem(legacyDraftKey(taskId));
      return legacy;
    }
    return "";
  } catch { return ""; }
};
const saveDraft = (taskId: string, v: string) => {
  if (typeof window === "undefined") return;
  try {
    if (v) window.localStorage.setItem(draftKey(taskId), v);
    else {
      window.localStorage.removeItem(draftKey(taskId));
      window.localStorage.removeItem(legacyDraftKey(taskId));
    }
  } catch { /* private mode / quota: drafts just won't persist */ }
};

// One row in the "/" menu. Calandria's own commands carry a `run`: this
// component performs the action directly instead of expanding text. Agent
// commands have no `run`; picking one completes it into the box and the
// ordinary send path hands it to the CLI, the same as typing it in full.
type MenuCommand = { name: string; desc: string; hint?: string; aliases?: string[]; run?: () => void };

export function Composer({ task, agentLabel, disabled, running, onSend, onStop, onClear }: { task: TaskRow; agentLabel: string; disabled: boolean; running: boolean; onSend: (t: string) => void; onStop: () => void; onClear: () => void }) {
  const [val, setVal] = useState(() => loadDraft(task.id));
  // On a touch keyboard, return means "new line" since there is no Shift to
  // hold, and the send button is the one visible affordance for sending.
  // Enter-to-send stays a hardware-keyboard behavior.
  const coarse = useCoarsePointer();
  // Tapping a button steals focus from the message field, and on iOS that
  // dismisses the keyboard before the click lands, so the tap closes the
  // keyboard instead of sending. Cancelling mousedown (the compat event iOS
  // fires on tap) keeps focus on the field so the keyboard stays up and the
  // click lands normally.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const [slash, setSlash] = useState(false);
  // The agent's own slash commands, fetched once per task the first time the
  // user types "/". Lazy because a task the user only reads should never spawn
  // a CLI. Empty is a fine steady state: a driver may have none (Codex), and
  // the route answers [] when discovery doesn't work.
  const [agentCmds, setAgentCmds] = useState<AgentCommand[]>([]);
  // Highlighted row, driven by ↑/↓. Reset whenever the query changes, because
  // index 3 of the old list means nothing in the new one.
  const [active, setActive] = useState(0);
  const asked = useRef(false);
  const cancelLoad = useRef<(() => void) | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [stopping, setStopping] = useState(false);
  // Attachments on the draft (./attachments.tsx): any file type, uploaded on
  // attach, appended to the message as marker lines on send. Not persisted
  // with the draft: object URLs don't survive a remount, and an unsent upload
  // is an orphaned file the task's hard delete removes.
  const files = useAttachments({ upload: uploadToTask(task.id), disabled });
  const { atts, ready, uploading, dragging } = files;
  // Reset the stopping state once the turn actually ends.
  useEffect(() => { if (!running) setStopping(false); }, [running]);
  // Mirror the draft to localStorage so it survives remounts/navigation.
  useEffect(() => { saveDraft(task.id, val); }, [task.id, val]);
  const ref = useRef<HTMLDivElement>(null);
  // Put the caret after the last character. Needed for the writes the app makes
  // itself, since replacing the field's text drops the selection with it.
  const caretToEnd = (el: HTMLElement) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  };
  // React does not control a contenteditable, so `val` is mirrored into the
  // element by hand, and only when the two disagree. A keystroke sets `val`
  // from the element's own text, so this effect finds them equal and leaves the
  // node alone, which is what holds the caret still while the user types. It
  // writes for the other direction: a restored draft, a completed command, the
  // clear after a send.
  useEffect(() => {
    const el = ref.current;
    if (!el || el.textContent === val) return;
    el.textContent = val;
    if (document.activeElement === el) caretToEnd(el);
  }, [val]);
  // Reflect the slash menu state of a restored draft.
  useEffect(() => {
    setSlash(val.trim().startsWith("/"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  // Ask the task's agent what it would actually expand. Once per mount (the
  // route caches server-side anyway), and only when the menu is first wanted.
  const loadCommands = useCallback(() => {
    if (asked.current || disabled) return;
    asked.current = true;
    let alive = true;
    cancelLoad.current = () => { alive = false; };
    fetch(`/api/tasks/${task.id}/commands`)
      .then((r) => (r.ok ? r.json() : { commands: [] }))
      .then((j: { commands?: AgentCommand[] }) => { if (alive) setAgentCmds(j.commands ?? []); })
      // Discovery failing costs the menu its long tail, nothing else: typing a
      // command in full still works, so there's no error worth showing here.
      .catch(() => {});
  }, [task.id, disabled]);
  // Discovery can outlive a fast task switch, so drop a late response rather
  // than let one task's commands land in another's menu.
  useEffect(() => () => cancelLoad.current?.(), []);

  // Calandria's own commands, then the agent's. /clear is Calandria's only: it
  // summarizes the transcript and starts the next generation of the task's
  // session lineage, which the CLI's same-named command does not do, so the
  // server drops the CLI's version (lib/agentCommands.ts). /clear also can't
  // run mid-turn, since it would collide with the live session, so it isn't
  // offered while a turn runs.
  const cmds: MenuCommand[] = [
    ...(running ? [] : [{ name: "clear", desc: "save summary · fresh session", run: () => { onClear(); setVal(""); setSlash(false); } }]),
    ...agentCmds.map((c) => ({ name: c.name, desc: c.description, hint: c.argumentHint, aliases: c.aliases })),
  ];

  // The menu is for picking a command, so it's only live while the value is a
  // bare command token. Once there's a space the user has moved on to writing
  // arguments and a dropdown over the box is just in the way.
  const token = val.trim();
  const picking = token.startsWith("/") && !/\s/.test(token);
  const q = picking ? token.slice(1).toLowerCase() : "";
  // Prefix matches first, then a match on the part after the namespace, then
  // any substring, so "/plan" still finds superpowers:writing-plans, but "/cl"
  // puts /clear at the top where muscle memory expects it. Aliases match too
  // (the CLI resolves /cost and /stats to /usage) but the canonical name is
  // what's shown and inserted.
  const names = (c: MenuCommand) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  // Both namespace shapes, since typing the source is how you find either: a
  // plugin's "plugin:command" and an MCP server's "mcp__server__prompt", where
  // "stash" should reach mcp__stash__discover-performers.
  const afterNs = (n: string) => (n.startsWith("mcp__") ? n.slice(5) : n.slice(n.indexOf(":") + 1));
  const rank = (c: MenuCommand) =>
    Math.min(...names(c).map((n) => (n.startsWith(q) ? 0 : afterNs(n).startsWith(q) ? 1 : 2)));
  const filtered = (q ? cmds.filter((c) => names(c).some((n) => n.includes(q))) : cmds)
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
  const menuOpen = slash && picking && filtered.length > 0;
  const idx = Math.min(active, Math.max(filtered.length - 1, 0));
  const highlighted = filtered[idx];
  // While a menu is open, Enter commits the highlighted completion instead of
  // sending. The exception is a command that's already fully typed, still
  // highlighted, and takes no arguments: completing it would be a no-op
  // keystroke, so Enter acts instead, letting `/clear`-and-Enter send directly
  // while arrowing away from an exact match still commits what's highlighted.
  const enterActs = !!highlighted && highlighted.name.toLowerCase() === q && !highlighted.hint;

  // Pick a row: a Calandria action runs; an agent command completes into the
  // box with a trailing space, ready for arguments, and is sent by the user.
  const choose = (c: MenuCommand) => {
    if (c.run) { c.run(); return; }
    setVal(`/${c.name} `);
    setSlash(false);
    // The mirror effect writes the text and lands the caret after it once this
    // render commits, so focus is all this has to do.
    ref.current?.focus();
  };

  // /clear can't run mid-turn, since it would collide with the live session. It
  // also must not be queued as an ordinary follow-up: the agent's CLI has its
  // own /clear, so the queued text would reach it and wipe the session's
  // context with no handoff summary and no new generation to show for it. So
  // mid-turn it's refused outright: canSend goes false and the footer says why.
  const blockedClear = running && val.trim() === "/clear" && ready.length === 0;

  // A turn lingering on background work or a scheduled wakeup has no model
  // running and still holds an open input into the agent session, so a message
  // sent now isn't queued: the server pushes it straight in as the next turn.
  // The composer states that instead of promising a wait that won't happen.
  const lingering = running && !!task.background_pending;

  const submit = () => {
    const v = val.trim();
    if ((!v && ready.length === 0) || disabled || uploading || blockedClear) return;
    if (v === "/clear" && ready.length === 0) { onClear(); setVal(""); setSlash(false); return; }
    // Attachments ride along as marker lines after the typed text: an image or
    // file marker depending on the attachment kind.
    onSend([v, ...ready.map((a) => (a.kind === "image" ? attachmentMarker(a.path) : fileAttachmentMarker(a.path)))].filter(Boolean).join("\n\n"));
    files.clear(); setVal(""); setSlash(false);
  };
  const canSend = (!!val.trim() || ready.length > 0) && !uploading && !blockedClear;

  // Keep the highlighted row visible: the list scrolls once an agent brings
  // dozens of commands, and arrowing into an offscreen row looks like nothing
  // happened.
  useEffect(() => {
    menuRef.current?.querySelector(".slash-item.act")?.scrollIntoView({ block: "nearest" });
  }, [active, menuOpen, val]);

  return (
    <div className="composer">
      <div className="composer-inner">
        {menuOpen && (
          <div className="slash" ref={menuRef}>
            {filtered.map((c, i) => (
              <div
                key={c.name}
                className={`slash-item${i === idx ? " act" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); choose(c); }}
              >
                <span className="cmd">/{c.name}</span>
                {c.hint && <span className="arg">{c.hint}</span>}
                <span className="cd">{c.desc}</span>
              </div>
            ))}
          </div>
        )}
        <div className={`comp-box${dragging ? " dropping" : ""}`} {...files.dropProps}>
          <AttachmentChips atts={atts} onRemove={files.remove} />
          <div className="comp-area">
            <div
              ref={ref}
              className="comp-input"
              // The message field is a contenteditable div so that it sits
              // outside Safari's AutoFill classifier. As a textarea it drew a
              // one-time-code keyboard on some iOS installs: a
              // verification-code suggestion above the keys and no autocorrect.
              // WebKit derives that keyboard only from a literal
              // autocomplete="one-time-code" token (WebCore/html/Autofill.cpp,
              // WKContentViewInteraction.mm contentTypeFromFieldName), and five
              // on-device probe rounds cleared the attributes, the geometry,
              // the placeholder and the field count, which leaves Safari's own
              // AutoFill client as the source. That client's surfaces are
              // HTMLInputElement and HTMLTextAreaElement, and WebKit's
              // contenteditable branch in
              // focusedElementInformationWithoutLayout never fills in
              // autofillFieldName, so this field is beyond its reach by
              // construction. The chat products that never show the symptom all
              // use a contenteditable editor. The probe rounds are recorded in
              // the notes repo,
              // measurements/2026-09-08-ios-composer-otp-classification.md.
              // plaintext-only keeps markup out of the editor; the paste
              // handler below inserts the text itself for the engines that
              // honor the value loosely.
              contentEditable={disabled ? false : "plaintext-only"}
              role="textbox"
              aria-multiline="true"
              aria-label="Message"
              aria-disabled={disabled || undefined}
              autoCorrect="on" autoCapitalize="sentences" spellCheck={true}
              // Drawn by CSS while the field is empty
              // (`.comp-area .comp-input:empty::before`). Short enough to fit
              // the one line the empty box is; anything longer ellipsizes.
              // Keep it short: the task title is already shown in the session
              // header above, so don't repeat it here.
              data-placeholder={disabled ? "Start the session to reply…" : lingering ? "Reply now: the session is held open…" : running ? "Queue a follow-up… (sent at turn end)" : `Reply to ${agentLabel}…`}
              onInput={(e) => {
                const el = e.currentTarget;
                // Deleting the last character can leave a <br> behind, which
                // defeats :empty: the placeholder would stay hidden and the
                // empty box would stand two lines tall.
                if (!el.textContent && el.firstChild) el.replaceChildren();
                const v = el.textContent ?? "";
                setVal(v); setActive(0);
                const open = v.trim().startsWith("/");
                setSlash(open);
                if (open) loadCommands();
              }}
              onKeyDown={(e) => {
                // Mid-composition Enter is the IME committing a candidate, not
                // the user sending. Never act on it.
                if (e.nativeEvent.isComposing) return;
                if (menuOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  e.preventDefault();
                  setActive(() => (idx + (e.key === "ArrowDown" ? 1 : filtered.length - 1)) % filtered.length);
                  return;
                }
                // Tab always completes the highlighted row; Enter does too,
                // except for the already-typed-in-full case (see enterActs).
                if (menuOpen && highlighted && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !enterActs))) {
                  e.preventDefault();
                  choose(highlighted);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !coarse) { e.preventDefault(); submit(); }
                if (e.key === "Escape") setSlash(false);
              }}
              onPaste={(e) => {
                // Any pasted file attaches: a screenshot from the clipboard, or
                // a file copied out of a file manager.
                if (files.pasteFiles(e)) return;
                // A huge text paste would balloon the prompt and can permanently
                // poison the session ("Prompt is too long"). Divert anything over
                // the threshold to a .txt attachment instead of inlining it.
                const text = e.clipboardData?.getData("text/plain") ?? "";
                if (text.length > PASTE_ATTACH_THRESHOLD) {
                  e.preventDefault();
                  files.addFiles([new File([text], "pasted-text.txt", { type: "text/plain" })]);
                  return;
                }
                // Firefox honors plaintext-only for typing and still drops rich
                // markup in on a paste, so the plain text goes in by hand.
                // execCommand keeps the browser's own undo stack, which a Range
                // write does not.
                e.preventDefault();
                document.execCommand("insertText", false, text);
              }}
            />
            {running ? (
              // Mid-turn: queue the typed follow-up (when there's text), and keep
              // Stop available to interrupt the current turn. While lingering it
              // isn't queued at all: the model has stopped and the session's
              // input is still open, so the server sends it straight in (see
              // sendToLingeringTurn in lib/runner.ts). Same button, honest label.
              <div className="send-group">
                {canSend && <button className={`send${lingering ? "" : " queue"}`} onMouseDown={keepFocus} onClick={submit} title={lingering ? "Send now: it becomes the session's next turn" : "Queue this follow-up: it'll send when the current turn ends"}>{Icon.send()}</button>}
                <button className="send stop" onMouseDown={keepFocus} onClick={() => { setStopping(true); onStop(); }} disabled={stopping} title={stopping ? "Stopping…" : "Stop the current turn"}>{Icon.stop()}</button>
              </div>
            ) : (
              <button className="send" disabled={!canSend || disabled} onMouseDown={keepFocus} onClick={submit}>{Icon.send()}</button>
            )}
          </div>
          <div className="comp-foot">
            {blockedClear ? (
              // The composer refuses this input outright, so say so instead of
              // leaving Enter dead with no explanation (see blockedClear).
              <span className="hint warn">/clear can’t run mid-turn. Stop the turn first</span>
            ) : (
              <>
                <span className="hint"><span className="kbd">⏎</span> send</span>
                <span className="hint"><span className="kbd">⇧⏎</span> newline</span>
                <span className="hint"><span className="kbd">/</span> commands</span>
              </>
            )}
            <span className="spacer" />
            {files.fileInput}
            {!disabled && (
              <button className="hint" style={{ cursor: "pointer" }} title="Attach a file, or drag, drop, or paste one. It's saved to disk for the agent to open, not inlined into the prompt." onMouseDown={(e) => { e.preventDefault(); files.openPicker(); }}>{Icon.clip()} attach</button>
            )}
            <button className="hint" style={{ cursor: "pointer" }} onMouseDown={(e) => { e.preventDefault(); onClear(); }}>{Icon.clear()} /clear</button>
          </div>
        </div>
      </div>
    </div>
  );
}
