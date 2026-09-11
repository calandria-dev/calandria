"use client";

import { useRef, useState } from "react";
import { Icon } from "../icons";
import { displayFileName, isImageExt, maxUploadBytes, uploadExtension } from "@/lib/uploadTypes";
import type { MsgAttachment } from "./format";

// One file on a draft: the composer's message, or a task dialog's description.
// Any file type is accepted (drop/paste/pick). It uploads on attach, and its
// server path is written into the text as a marker line when the draft is
// sent or saved (lib/uploadTypes.ts); the bytes never enter the prompt, the
// agent gets a staged path to open.
export type Attachment = {
  key: string;
  kind: "image" | "file";
  name: string;
  /** Image thumbnail source: a local object URL for a fresh upload, the serving URL for one already staged. "" for a file chip. */
  preview: string;
  /** Absolute server path once uploaded. */
  path: string;
  status: "uploading" | "ready" | "error";
  error?: string;
};

/** An attachment already staged and named in some text, as the edit dialog seeds it. */
export function stagedAttachment(a: MsgAttachment, key: string): Attachment {
  return { key, kind: a.kind, name: displayFileName(a.name), preview: a.kind === "image" ? a.url : "", path: a.path, status: "ready" };
}

/**
 * The attach-on-drop/paste/pick state machine, shared by the composer and the
 * task dialogs so the three can't drift on what a chip is. `upload` is the
 * only thing that differs: which route the bytes go to.
 */
export function useAttachments({ upload, disabled = false, initial }: {
  upload: (file: File, name: string) => Promise<{ path: string }>;
  disabled?: boolean;
  initial?: Attachment[];
}) {
  const [atts, setAtts] = useState<Attachment[]>(initial ?? []);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire per child element, so depth-count to know when the
  // pointer has really left the drop zone.
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const addFiles = (files: File[]) => {
    if (disabled) return;
    const cap = maxUploadBytes();
    for (const f of files) {
      // Extension-first, matching the server (lib/uploadTypes.ts): a dragged
      // .png whose MIME the OS didn't fill in is still a picture.
      const isImage = f.type.startsWith("image/") || isImageExt(uploadExtension(f.name || "", f.type || ""));
      const key = `att-${++seq.current}`;
      const kind = isImage ? "image" : "file";
      const name = f.name || (isImage ? "image" : "attachment");
      // Only images get a local object-URL thumbnail; file chips render a label.
      const preview = isImage ? URL.createObjectURL(f) : "";
      // Refuse an oversized file here instead of pushing it over the wire for
      // the route to reject: the chip is the same either way, the upload isn't.
      if (f.size > cap) {
        setAtts((prev) => [...prev, { key, kind, name, preview, path: "", status: "error", error: `Too large (max ${Math.round(cap / 1024 / 1024)} MB).` }]);
        continue;
      }
      setAtts((prev) => [...prev, { key, kind, name, preview, path: "", status: "uploading" }]);
      upload(f, name)
        .then((j) => setAtts((prev) => prev.map((a) => (a.key === key ? { ...a, path: j.path, status: "ready" } : a))))
        .catch((err: unknown) => {
          setAtts((prev) => prev.map((a) => (a.key === key ? { ...a, status: "error", error: err instanceof Error ? err.message : String(err) } : a)));
        });
    }
  };
  const remove = (key: string) => {
    setAtts((prev) => {
      const gone = prev.find((a) => a.key === key);
      if (gone?.preview.startsWith("blob:")) URL.revokeObjectURL(gone.preview);
      return prev.filter((a) => a.key !== key);
    });
  };
  const clear = () => {
    atts.forEach((a) => { if (a.preview.startsWith("blob:")) URL.revokeObjectURL(a.preview); });
    setAtts([]);
  };
  const hasFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const dropProps = {
    onDragEnter: (e: React.DragEvent) => { if (!disabled && hasFileDrag(e)) { e.preventDefault(); dragDepth.current++; setDragging(true); } },
    onDragOver: (e: React.DragEvent) => { if (!disabled && hasFileDrag(e)) e.preventDefault(); },
    onDragLeave: () => { if (dragDepth.current > 0 && --dragDepth.current === 0) setDragging(false); },
    onDrop: (e: React.DragEvent) => { if (disabled || !hasFileDrag(e)) return; e.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles(Array.from(e.dataTransfer.files)); },
  };
  /** Paste handler half: attaches any pasted files and says whether it did. */
  const pasteFiles = (e: React.ClipboardEvent): boolean => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return false;
    e.preventDefault();
    addFiles(files);
    return true;
  };
  const fileInput = (
    <input ref={fileRef} type="file" multiple hidden aria-label="Attach files"
      onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
  );
  const openPicker = () => fileRef.current?.click();

  return {
    atts,
    addFiles,
    remove,
    clear,
    ready: atts.filter((a) => a.status === "ready"),
    uploading: atts.some((a) => a.status === "uploading"),
    dragging,
    dropProps,
    pasteFiles,
    fileInput,
    openPicker,
  };
}

/** The chip row over a draft: thumbnails for images, labelled chips for files, each removable. */
export function AttachmentChips({ atts, onRemove }: { atts: Attachment[]; onRemove: (key: string) => void }) {
  if (!atts.length) return null;
  return (
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
          <button type="button" className="attach-x" title="Remove" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.key)}>×</button>
        </div>
      ))}
    </div>
  );
}

// Attachments already sent: inline thumbnails for images (click opens full
// size) and a named chip for any other file (opens in a tab, or downloads it,
// per lib/uploadTypes.ts servedType). Both are served from the task's uploads
// dir. The chip shows the user's own filename (the staged name minus its
// unique prefix), since with any type accepted "attached file" no longer says
// anything. Rendered under a transcript message and under a task's brief.
export function AttachmentStrip({ items }: { items: MsgAttachment[] }) {
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
          <a key={i} href={a.url} target="_blank" rel="noreferrer" className="file-chip" title={`Open ${displayFileName(a.name)}`}>
            {Icon.clip()} <span>{displayFileName(a.name)}</span>
          </a>
        )
      )}
    </div>
  );
}

/** The route a task's own attachments upload through, the shape useAttachments wants. */
export function uploadToTask(taskId: string) {
  return async (file: File, name: string) => {
    const body = new FormData();
    body.append("file", file, name);
    const res = await fetch(`/api/tasks/${taskId}/uploads`, { method: "POST", body });
    const j = await res.json().catch(() => ({} as { path?: string; error?: string }));
    if (!res.ok || !j.path) throw new Error(j.error || `Upload failed (${res.status})`);
    return { path: j.path as string };
  };
}

/** The draft route for a task that doesn't exist yet (POST /api/uploads); `draft` groups one dialog's files. */
export function uploadToDraft(draft: string) {
  return async (file: File, name: string) => {
    const body = new FormData();
    body.append("file", file, name);
    body.append("draft", draft);
    const res = await fetch("/api/uploads", { method: "POST", body });
    const j = await res.json().catch(() => ({} as { path?: string; error?: string }));
    if (!res.ok || !j.path) throw new Error(j.error || `Upload failed (${res.status})`);
    return { path: j.path as string };
  };
}
