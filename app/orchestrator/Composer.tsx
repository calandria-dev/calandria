"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { attachmentMarker, fileAttachmentMarker } from "./format";
import { useCoarsePointer } from "./shared";
import { PASTE_ATTACH_THRESHOLD } from "@/lib/promptLimits";
import type { AgentCommand } from "@/lib/agents/types";
import type { TaskRow } from "./types";

// Drafts persist per-task in localStorage so switching tasks, opening Settings,
// or reloading the page doesn't throw away half-typed messages. (SessionView is
// keyed by task.id, so the Composer remounts on every task switch.)
const draftKey = (taskId: string) => `orch:draft:${taskId}`;
const loadDraft = (taskId: string) => {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(draftKey(taskId)) ?? ""; } catch { return ""; }
};
const saveDraft = (taskId: string, v: string) => {
  if (typeof window === "undefined") return;
  try {
    if (v) window.localStorage.setItem(draftKey(taskId), v);
    else window.localStorage.removeItem(draftKey(taskId));
  } catch { /* private mode / quota — drafts just won't persist */ }
};

// An attachment on the draft — an image (drop/paste/pick) or a large text paste
// diverted to a .txt file (see PASTE_ATTACH_THRESHOLD) so it never bloats the
// prompt and poisons the session. Uploaded eagerly on attach so send stays
// instant; on send its server path is appended to the message as a marker line
// (attachmentMarker for images, fileAttachmentMarker for text). Not persisted
// with the draft — object URLs don't survive a remount, and an unsent upload is
// just an orphaned file that the task's hard delete sweeps away.
type Attachment = {
  key: string;
  kind: "image" | "file";
  name: string;
  preview: string; // local object URL for the image thumbnail ("" for text files)
  path: string; // absolute server path once uploaded
  status: "uploading" | "ready" | "error";
  error?: string;
};

// One row in the "/" menu. Calandria's own commands carry a `run` (they're
// actions this component performs, not text the agent expands); the agent's own
// commands don't — picking one completes it into the box and the ordinary send
// path hands it to the CLI, which is what already made typing them in full work.
type MenuCommand = { name: string; desc: string; hint?: string; aliases?: string[]; run?: () => void };

export function Composer({ task, agentLabel, disabled, running, onSend, onStop, onClear }: { task: TaskRow; agentLabel: string; disabled: boolean; running: boolean; onSend: (t: string) => void; onStop: () => void; onClear: () => void }) {
  const [val, setVal] = useState(() => loadDraft(task.id));
  // On a touch keyboard, return means "new line" — there is no Shift to hold,
  // and the send button is the one visible affordance for sending. Enter-to-send
  // stays a hardware-keyboard behavior.
  const coarse = useCoarsePointer();
  // Tapping a button steals focus from the textarea, and on iOS that dismisses
  // the keyboard BEFORE the click lands — the layout shifts under the finger
  // and the tap is spent closing the keyboard, so send needed a second tap.
  // Cancelling mousedown (the compat event iOS fires on tap) keeps focus put:
  // the keyboard stays up, the click fires on a stable layout, and the box is
  // ready for the follow-up without a re-tap.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const [slash, setSlash] = useState(false);
  // The agent's own slash commands, fetched once per task the first time the
  // user types "/". Lazy because a task the user only reads should never spawn
  // a CLI, and empty is a fine steady state — a driver may have none (Codex),
  // and the route answers [] rather than failing when discovery doesn't work.
  const [agentCmds, setAgentCmds] = useState<AgentCommand[]>([]);
  // Highlighted row, driven by ↑/↓. Reset whenever the query changes, because
  // index 3 of the old list means nothing in the new one.
  const [active, setActive] = useState(0);
  const asked = useRef(false);
  const cancelLoad = useRef<(() => void) | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [stopping, setStopping] = useState(false);
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire per child element — depth-count to know when the
  // pointer has really left the drop zone.
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const attSeq = useRef(0);
  // Reset the stopping state once the turn actually ends.
  useEffect(() => { if (!running) setStopping(false); }, [running]);
  // Mirror the draft to localStorage so it survives remounts/navigation.
  useEffect(() => { saveDraft(task.id, val); }, [task.id, val]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const autosize = (el: HTMLTextAreaElement) => { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; };
  // Grow the box to fit a restored draft and reflect the slash menu state.
  useEffect(() => {
    if (ref.current) autosize(ref.current);
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
      // Discovery failing costs the menu its long tail, nothing else — typing a
      // command in full still works, so there's no error worth showing here.
      .catch(() => {});
  }, [task.id, disabled]);
  // Discovery outlives a fast task switch (a cold CLI spawn is ~300ms, a click
  // is faster) — drop a late response rather than let one task's commands land
  // in another's menu.
  useEffect(() => () => cancelLoad.current?.(), []);

  const addFiles = (files: File[]) => {
    if (disabled) return;
    for (const f of files) {
      const isImage = f.type.startsWith("image/");
      const isText = f.type.startsWith("text/plain");
      if (!isImage && !isText) continue;
      const key = `att-${++attSeq.current}`;
      const kind = isImage ? "image" : "file";
      const name = f.name || (isImage ? "image" : "pasted-text.txt");
      // Only images get a local object-URL thumbnail; text chips render a label.
      const preview = isImage ? URL.createObjectURL(f) : "";
      setAtts((prev) => [...prev, { key, kind, name, preview, path: "", status: "uploading" }]);
      const body = new FormData();
      body.append("file", f, name);
      fetch(`/api/tasks/${task.id}/uploads`, { method: "POST", body })
        .then(async (res) => {
          const j = await res.json().catch(() => ({} as { path?: string; error?: string }));
          if (!res.ok || !j.path) throw new Error(j.error || `Upload failed (${res.status})`);
          setAtts((prev) => prev.map((a) => (a.key === key ? { ...a, path: j.path as string, status: "ready" } : a)));
        })
        .catch((err: unknown) => {
          setAtts((prev) => prev.map((a) => (a.key === key ? { ...a, status: "error", error: err instanceof Error ? err.message : String(err) } : a)));
        });
    }
  };
  const removeAtt = (key: string) => {
    setAtts((prev) => {
      const gone = prev.find((a) => a.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((a) => a.key !== key);
    });
  };
  const hasFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const ready = atts.filter((a) => a.status === "ready");
  const uploading = atts.some((a) => a.status === "uploading");
  // Calandria's own commands, then the agent's. /clear is ours and only ours:
  // it summarizes the transcript and starts the next generation of the task's
  // session lineage, which the CLI's same-named command does not do — so the
  // server drops the CLI's (lib/agentCommands.ts) and this one stands alone.
  // It's also the one command that can't run mid-turn (it would collide with
  // the live session), so while a turn runs it simply isn't offered.
  const cmds: MenuCommand[] = [
    ...(running ? [] : [{ name: "clear", desc: "save summary · fresh session", run: () => { onClear(); setVal(""); setSlash(false); } }]),
    ...agentCmds.map((c) => ({ name: c.name, desc: c.description, hint: c.argumentHint, aliases: c.aliases })),
  ];

  // The menu is for picking a command, so it's only live while the value IS a
  // bare command token — once there's a space the user has moved on to writing
  // arguments and a dropdown over the box is just in the way.
  const token = val.trim();
  const picking = token.startsWith("/") && !/\s/.test(token);
  const q = picking ? token.slice(1).toLowerCase() : "";
  // Prefix matches first, then a match on the part after "plugin:", then any
  // substring — so "/plan" still finds superpowers:writing-plans, but "/cl"
  // puts /clear at the top where muscle memory expects it. Aliases match too
  // (the CLI resolves /cost and /stats to /usage) but the canonical name is
  // what's shown and inserted.
  const names = (c: MenuCommand) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  const rank = (c: MenuCommand) =>
    Math.min(...names(c).map((n) => (n.startsWith(q) ? 0 : n.slice(n.indexOf(":") + 1).startsWith(q) ? 1 : 2)));
  const filtered = (q ? cmds.filter((c) => names(c).some((n) => n.includes(q))) : cmds)
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
  const menuOpen = slash && picking && filtered.length > 0;
  const idx = Math.min(active, Math.max(filtered.length - 1, 0));
  const highlighted = filtered[idx];
  // Enter normally commits the highlighted completion rather than sending —
  // that's the predictable rule when a menu is open. The one exception is a
  // command that's already fully typed, still highlighted, and takes no
  // arguments: completing it would be a no-op keystroke, so Enter acts. That's
  // what keeps `/clear`-and-Enter working exactly as it always has, while
  // arrowing away from an exact match correctly commits what's highlighted.
  const enterActs = !!highlighted && highlighted.name.toLowerCase() === q && !highlighted.hint;

  // Pick a row: an Calandria action runs; an agent command completes into the
  // box with a trailing space, ready for arguments, and is sent by the user.
  const choose = (c: MenuCommand) => {
    if (c.run) { c.run(); return; }
    setVal(`/${c.name} `);
    setSlash(false);
    const el = ref.current;
    if (el) { el.focus(); requestAnimationFrame(() => autosize(el)); }
  };

  // /clear can't run mid-turn — it would collide with the live session. It also
  // must not be QUEUED as an ordinary follow-up: the agent's CLI has a /clear of
  // its own, so the queued text would reach it and wipe the session's context
  // behind Calandria's back, with no handoff summary and no new generation to
  // show for it. So mid-turn it's refused outright (canSend goes false and the
  // footer says why) rather than sent.
  const blockedClear = running && val.trim() === "/clear" && ready.length === 0;

  // A turn LINGERING on background work or a scheduled wakeup has no model
  // running and still holds an open input into the agent session, so a message
  // sent now isn't queued — the server pushes it straight in as the next turn.
  // The composer says so rather than promising a wait that won't happen.
  const lingering = running && !!task.background_pending;

  const submit = () => {
    const v = val.trim();
    if ((!v && ready.length === 0) || disabled || uploading || blockedClear) return;
    if (v === "/clear" && ready.length === 0) { onClear(); setVal(""); setSlash(false); if (ref.current) ref.current.style.height = "auto"; return; }
    // Attachments ride along as marker lines after the typed text — an image or
    // file marker depending on the attachment kind.
    onSend([v, ...ready.map((a) => (a.kind === "image" ? attachmentMarker(a.path) : fileAttachmentMarker(a.path)))].filter(Boolean).join("\n\n"));
    atts.forEach((a) => { if (a.preview) URL.revokeObjectURL(a.preview); });
    setAtts([]); setVal(""); setSlash(false);
    if (ref.current) ref.current.style.height = "auto";
  };
  const canSend = (!!val.trim() || ready.length > 0) && !uploading && !blockedClear;

  // Keep the highlighted row visible — the list scrolls once an agent brings
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
        <div
          className={`comp-box${dragging ? " dropping" : ""}`}
          onDragEnter={(e) => { if (!disabled && hasFileDrag(e)) { e.preventDefault(); dragDepth.current++; setDragging(true); } }}
          onDragOver={(e) => { if (!disabled && hasFileDrag(e)) e.preventDefault(); }}
          onDragLeave={() => { if (dragDepth.current > 0 && --dragDepth.current === 0) setDragging(false); }}
          onDrop={(e) => { if (disabled || !hasFileDrag(e)) return; e.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}
        >
          {atts.length > 0 && (
            <div className="attach-row">
              {atts.map((a) => (
                <div key={a.key} className={`attach-chip ${a.kind} ${a.status}`} title={a.error || a.name}>
                  {a.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.preview} alt={a.name} />
                  ) : (
                    <span className="attach-file">{Icon.clip()} {a.name}</span>
                  )}
                  {a.status === "uploading" && <span className="attach-badge">uploading…</span>}
                  {a.status === "error" && <span className="attach-badge err">failed</span>}
                  <button className="attach-x" title="Remove" aria-label={`Remove ${a.name}`} onClick={() => removeAtt(a.key)}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className="comp-area">
            <textarea
              ref={ref} rows={1} value={val} disabled={disabled}
              // These state the field's intent and are kept because they are
              // correct — NOT because they fix the mobile keyboard bug. They
              // don't, and neither did the attribute combinations tried before
              // them. DO NOT "fix" that bug by editing this line again.
              //
              // THE BUG: on mobile the composer offers an SMS/verification-code
              // suggestion above the keyboard and refuses to autocorrect.
              // MEASURED 2026-08-25 on an iPhone running an iOS 27 BETA, as an
              // INSTALLED PWA (display-mode: standalone, navigator.standalone
              // true) — the only configuration it has ever been reported from.
              // The UA reads "CPU iPhone OS 18_7" and that is NOT the OS: Apple
              // freezes that token, and "Version/27.0" is the real signal. Do
              // not read the OS off the UA string here. Five rounds of
              // side-by-side A/B on the device; docs/kbprobe.html is the
              // instrument (copy it into public/ and restart to re-run it).
              //
              // A replica of this textarea — same attributes, same rows={1},
              // same 22px min-height, same placeholder — does NEITHER, while
              // the live composer beside it does both. Every static property of
              // this element has now been copied exactly and none reproduces it:
              //   · attributes — a bare textarea and this one behave alike
              //   · one-line geometry — 22px vs 46px min-height: no difference
              //   · the placeholder, even carrying a task title containing the
              //     literal words "verification-code" (clean — so sanitising
              //     task titles is not the fix either)
              //   · the task title — a neutral-titled task reproduces the bug
              //   · field count — lone field vs two: no difference
              //   · <form> membership — the app has no <form> anywhere
              //   · controlled-component behaviour — reassigning .value on every
              //     keystroke, autosizing, and re-render churn, separately and
              //     together, all autocorrect normally
              //
              // What IS true, and worth not breaking: iOS's classifier can be
              // reached through text, but only when the accessible name is
              // essentially nothing BUT trigger words — "verification code" as
              // the entire placeholder, or in aria-label, reproduces it on
              // demand, while prose around the same words defeats it. So
              // aria-label is a second channel here, not just the placeholder.
              // And there are two levels: a bare <input> gets the code
              // suggestion but still autocorrects; losing autocorrect as well
              // is the stronger classification the live composer is stuck in,
              // which is why "no autocorrect" is the tell worth watching.
              //
              // The mechanism remains unidentified and is not anything this
              // element declares about itself. Since every measurement above
              // was taken on a BETA OS, the leading remaining explanation is a
              // beta regression rather than something we can fix in markup —
              // so the cheap next step is a retest on a shipping OS (and on a
              // second device) before anyone concludes it is permanent, not a
              // sixth round of attribute edits here.
              autoComplete="off" autoCorrect="on" autoCapitalize="sentences" spellCheck={true}
              // Inert: added on the since-disproven theory that an unnamed field
              // invited the one-time-code guess. Harmless, so left alone.
              name="message"
              placeholder={disabled ? "Start the session to reply…" : lingering ? "Reply now — the session is held open…" : running ? "Queue a follow-up… (sent when this turn ends)" : `Reply to ${agentLabel} in “${task.title}”…  (try /clear, drop an image)`}
              onChange={(e) => {
                const v = e.target.value;
                setVal(v); autosize(e.target); setActive(0);
                const open = v.trim().startsWith("/");
                setSlash(open);
                if (open) loadCommands();
              }}
              onKeyDown={(e) => {
                // Mid-composition Enter is the IME committing a candidate, not
                // the user sending — never act on it.
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
                const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
                if (imgs.length) { e.preventDefault(); addFiles(imgs); return; }
                // A huge text paste would balloon the prompt and can permanently
                // poison the session ("Prompt is too long"). Divert anything over
                // the threshold to a .txt attachment instead of inlining it.
                const text = e.clipboardData?.getData("text/plain") ?? "";
                if (text.length > PASTE_ATTACH_THRESHOLD) {
                  e.preventDefault();
                  addFiles([new File([text], "pasted-text.txt", { type: "text/plain" })]);
                }
              }}
            />
            {running ? (
              // Mid-turn: queue the typed follow-up (when there's text), and keep
              // Stop available to interrupt the current turn. Mid-LINGER it isn't
              // queued at all — the model has stopped and the session's input is
              // still open, so the server sends it straight in (see
              // sendToLingeringTurn in lib/runner.ts). Same button, honest label.
              <div className="send-group">
                {canSend && <button className={`send${lingering ? "" : " queue"}`} onMouseDown={keepFocus} onClick={submit} title={lingering ? "Send now — the session is held open and picks this up as its next turn" : "Queue this follow-up — it'll send when the current turn ends"}>{Icon.send()}</button>}
                <button className="send stop" onMouseDown={keepFocus} onClick={() => { setStopping(true); onStop(); }} disabled={stopping} title={stopping ? "Stopping…" : "Stop the current turn"}>{Icon.stop()}</button>
              </div>
            ) : (
              <button className="send" disabled={!canSend || disabled} onMouseDown={keepFocus} onClick={submit}>{Icon.send()}</button>
            )}
          </div>
          <div className="comp-foot">
            {blockedClear ? (
              // The one input the composer refuses outright — say so, rather
              // than leaving Enter silently dead (see blockedClear).
              <span className="hint warn">/clear can’t run mid-turn — stop the turn first</span>
            ) : (
              <>
                <span className="hint"><span className="kbd">⏎</span> send</span>
                <span className="hint"><span className="kbd">⇧⏎</span> newline</span>
                <span className="hint"><span className="kbd">/</span> commands</span>
              </>
            )}
            <span className="spacer" />
            <input
              ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden
              onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}
            />
            {!disabled && (
              <button className="hint" style={{ cursor: "pointer" }} title="Attach an image (or drag & drop / paste one)" onMouseDown={(e) => { e.preventDefault(); fileRef.current?.click(); }}>{Icon.clip()} image</button>
            )}
            <button className="hint" style={{ cursor: "pointer" }} onMouseDown={(e) => { e.preventDefault(); onClear(); }}>{Icon.clear()} /clear</button>
          </div>
        </div>
      </div>
    </div>
  );
}
