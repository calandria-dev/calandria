"use client";

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Priority } from "@/lib/types";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { SLABEL, type FsListing, type PickerOption, type TaskRow } from "./types";
import { StatusDot, Skel, ErrNote } from "./shared";
import { blockerCandidates } from "./format";

// Tracks open modals so Escape only dismisses the topmost one when modals stack
// (e.g. the folder picker opened over the project-context editor).
const modalStack: symbol[] = [];

export function Modal({ title, sub, onClose, children, footer, width }: { title: string; sub?: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: number }) {
  useEffect(() => {
    const token = Symbol();
    modalStack.push(token);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && modalStack[modalStack.length - 1] === token) onClose(); };
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("keydown", esc);
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-h">
          <div style={{ flex: 1 }}>
            <div className="m-title">{title}</div>
            {sub && <div className="m-sub" style={{ marginTop: 3 }}>{sub}</div>}
          </div>
          <button className="modal-close" onClick={onClose}>{Icon.x()}</button>
        </div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

export function FolderPicker({ initial, onClose, onPick }: { initial?: string; onClose: () => void; onPick: (path: string) => void }) {
  const [data, setData] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Last path requested, so Retry after a failed listing re-asks for the same
  // folder instead of resetting the whole picker to its initial directory.
  const lastReq = useRef<string | undefined>(undefined);
  const load = useCallback((p?: string) => {
    lastReq.current = p;
    setLoading(true);
    setError(null);
    jget<FsListing>(`/api/fs${p ? `?path=${encodeURIComponent(p)}` : ""}`)
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(initial && initial.trim() ? initial : undefined); }, [load, initial]);

  return (
    <Modal title="Select working directory" sub="pick the folder agents run tasks in" onClose={onClose} width={580}
      footer={<>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" disabled={!data} onClick={() => data && onPick(data.path)}>{Icon.check()} Use this folder</button>
      </>}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <button className="btn btn-line" disabled={!data?.parent} onClick={() => data?.parent && load(data.parent)} title="Up one level">{Icon.chevDown({ style: { transform: "rotate(180deg)" } })} Up</button>
        <button className="btn btn-line" onClick={() => load(data?.home)} title="Go to home directory">{Icon.folder()} Home</button>
        <div className="ctx-mono" style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={data?.path}>{data?.path ?? "…"}</div>
      </div>
      {error && <ErrNote style={{ marginBottom: 10 }} onRetry={() => load(lastReq.current)}>{error}</ErrNote>}
      <div style={{ border: "1px solid var(--line-strong)", borderRadius: "var(--r)", background: "var(--raise)", maxHeight: 320, overflowY: "auto" }}>
        {loading && [56, 42, 64, 38, 50].map((w, i) => (
          <div key={i} className="skel-lrow">
            <Skel w={15} h={15} r={4} />
            <Skel w={`${w}%`} h={11} />
          </div>
        ))}
        {!loading && data && data.entries.length === 0 && <div className="hlp" style={{ padding: "14px 14px" }}>No subfolders here.</div>}
        {!loading && data && data.entries.map((e) => (
          <button key={e.path} onClick={() => load(e.path)} title={e.path}
            style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", padding: "9px 13px", borderBottom: "1px solid var(--line)", color: "var(--ink)", fontSize: 13.5 }}>
            <span style={{ color: "var(--accent)", display: "inline-flex" }}>{Icon.folder()}</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
            <span style={{ color: "var(--ink-4)", display: "inline-flex" }}>{Icon.chevRight()}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// "Browse" control for a working-dir field. Tries the OS-native folder chooser
// first (search, new-folder, Finder favorites); falls back to the in-app
// FolderPicker with no message when no native dialog is available (non-macOS
// / headless) or the call errors. Cancelling the native dialog is a no-op.
export function BrowseDirButton({ initial, onPick }: { initial?: string; onPick: (p: string) => void }) {
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const browse = useCallback(async () => {
    setBusy(true);
    try {
      const r = await jsend<{ path?: string; canceled?: boolean; unsupported?: boolean }>("/api/fs/pick-dir", "POST", { initial: initial || "" });
      if (r.path) onPick(r.path);
      else if (r.unsupported) setBrowsing(true);
      // canceled → do nothing
    } catch {
      setBrowsing(true); // network/route failure → in-app fallback
    } finally {
      setBusy(false);
    }
  }, [initial, onPick]);
  return (
    <>
      <button type="button" className="btn btn-line" style={{ flex: "none" }} disabled={busy} onClick={browse} title="Browse for a folder">{Icon.folder()} {busy ? "Browse…" : "Browse"}</button>
      {browsing && <FolderPicker initial={initial} onClose={() => setBrowsing(false)} onPick={(p) => { onPick(p); setBrowsing(false); }} />}
    </>
  );
}

/**
 * The one model input, in both of its shapes.
 *
 * A cloud project gets a <select> over the driver's own catalog (modelOptions
 * over the capability descriptor, the same one the session rail's picker
 * reads), so a Vertex instance's corrected windows and a new driver's models
 * arrive here with no edit. Uses a <select> instead of the `seg wrap` its
 * neighbours use because Claude Code offers a dozen-plus entries across three
 * groups; consecutive options sharing a `group` render under one <optgroup>,
 * matching the rail's headers. It renders nothing when the agent contributes no
 * models: that means the capabilities bundle has not loaded, and the synthetic
 * "Inherit" head alone is not a choice.
 *
 * `freeForm` is the local-model case (lib/agentEnv.ts): the catalog is the
 * vendor's line-up while the ids on the machine are whatever was pulled, so a
 * closed list can only be wrong. The field becomes a text box whose
 * `suggestions` are what the endpoint itself reports, a datalist instead of a
 * select, because a model pulled a second ago must be typeable before any probe
 * has seen it. The same component serves both shapes: they share the label,
 * the inherit semantics of `null` and the help line, and a second component
 * would drift from this one the first time either changed.
 */
export function ModelField({ options, value, onChange, help, label = "Model", note, freeForm, suggestions, status }: {
  options: PickerOption[]; value: string | null; onChange: (v: string | null) => void;
  help?: string; label?: string; note?: React.ReactNode;
  /** Accept any id and offer `suggestions` instead of restricting to `options`. */
  freeForm?: boolean;
  suggestions?: string[];
  /** Replaces the catalog's subtitle in free-form mode: what the endpoint said. */
  status?: React.ReactNode;
}) {
  // Consecutive same-group runs, in catalog order. Built before the early
  // return would skip it, so the hook order is stable across a bundle arriving.
  const sections = useMemo(() => {
    const out: { group?: string; items: PickerOption[] }[] = [];
    for (const o of options) {
      const last = out[out.length - 1];
      if (last && last.group === o.group) last.items.push(o);
      else out.push({ group: o.group, items: [o] });
    }
    return out;
  }, [options]);
  if (freeForm) {
    return (
      <div className="field model-field">
        <div className="lab">{Icon.spark()} {label}</div>
        {note}
        <FreeFormModel value={value ?? ""} onChange={(v) => onChange(v.trim() || null)} suggestions={suggestions ?? []}
          label={label} placeholder="model id, e.g. qwen3-coder" />
        <div className="hlp">{status}{help}</div>
      </div>
    );
  }
  if (options.length <= 1) return null;
  // A model the catalog no longer lists: an id pinned before the instance was
  // pointed at Vertex, or carried in from another agent. Kept as an entry of its
  // own so the select shows what the task will actually run instead of reading
  // as blank, and so touching an unrelated field cannot drop it.
  const known = options.some((o) => o.value === value);
  const sel = options.find((o) => o.value === value);
  return (
    <div className="field model-field">
      <div className="lab">{Icon.spark()} {label}</div>
      {note}
      <select value={value ?? ""} aria-label={label} onChange={(e) => onChange(e.target.value || null)}>
        {sections.map((s, i) => {
          const opts = s.items.map((o) => <option key={o.label} value={o.value ?? ""}>{o.label}</option>);
          return s.group ? <optgroup key={s.group} label={s.group}>{opts}</optgroup> : <Fragment key={i}>{opts}</Fragment>;
        })}
        {value && !known && <option value={value}>{value} (not in this agent’s list)</option>}
      </select>
      <div className="hlp">{known ? sel?.sub : "This id isn’t one this agent offers. It may not run."}{help}</div>
    </div>
  );
}

/**
 * The free-form model input itself: a text box with a <datalist> of whatever
 * the endpoint reports.
 *
 * Its own component because the project settings dialog needs the input
 * without ModelField's label-and-help chrome (it sits inline beside the base
 * URL), and two hand-rolled inputs would be two behaviours. Uses a datalist
 * instead of a combobox because the browser's own is exactly right here:
 * suggestions filter as you type and anything typed is still accepted, which
 * is the requirement since a model pulled a second ago will not be in a list
 * probed before it.
 */
export function FreeFormModel({ value, onChange, suggestions, placeholder, label = "Model", className = "ctx-mono", style, title }: {
  value: string; onChange: (v: string) => void; suggestions: string[];
  placeholder?: string; label?: string; className?: string; style?: React.CSSProperties; title?: string;
}) {
  const listId = useId();
  return (
    <>
      <input type="text" className={className} style={style} value={value} placeholder={placeholder} title={title}
        aria-label={label} autoComplete="off" spellCheck={false}
        list={suggestions.length ? listId : undefined} onChange={(e) => onChange(e.target.value)} />
      {suggestions.length > 0 && (
        <datalist id={listId}>{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
      )}
    </>
  );
}

export function PrioritySeg({ value, onChange }: { value: Priority; onChange: (p: Priority) => void }) {
  const opts: { key: Priority; label: string; color: string }[] = [
    { key: "lo", label: "Low", color: "var(--ink-4)" },
    { key: "med", label: "Medium", color: "var(--amber)" },
    { key: "hi", label: "High", color: "var(--red)" },
  ];
  return (
    <div className="seg">
      {opts.map((o) => (
        <button key={o.key} className={value === o.key ? "on" : ""} onClick={() => onChange(o.key)}>
          <span className="pdot" style={{ background: o.color }} />{o.label}
        </button>
      ))}
    </div>
  );
}

// "Blocked by" picker: choose the tasks that must reach Done before this one can
// start. Candidates are the other tasks in the project (self excluded by caller),
// minus the terminal ones, which can't block anything and so aren't offered, and
// listed alphabetically instead of in the caller's recency order.
// With any blockers selected, offers the per-task "Start when unblocked" opt-in:
// the last blocker flipping to Done launches this task's first turn on its own.
export function DepPicker({ candidates, value, onChange, autoStart, onAutoStart }: {
  candidates: TaskRow[]; value: string[]; onChange: (ids: string[]) => void;
  autoStart: boolean; onAutoStart: (on: boolean) => void;
}) {
  const rows = useMemo(() => blockerCandidates(candidates, value), [candidates, value]);
  // blockerCandidates only lists a suggestion that's already an edge, so in
  // practice every suggested row here is ticked. The `value` check is what
  // keeps the notice honest if that ever stops being true.
  const pendingSuggestions = useMemo(() => rows.filter((c) => c.suggested && value.includes(c.id)).length, [rows, value]);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="field">
      <div className="lab">Blocked by <span className="opt">(must finish first)</span></div>
      {rows.length === 0 ? (
        <div className="hlp">No unfinished tasks in this project to wait on.</div>
      ) : (
        <div className="dep-list">
          {rows.map((c) => (
            <label key={c.id} className={`dep-row ${value.includes(c.id) ? "on" : ""}`}>
              <input type="checkbox" checked={value.includes(c.id)} onChange={() => toggle(c.id)} />
              <StatusDot status={c.status} />
              <span className="dep-title">{c.title}</span>
              {c.suggested ? <span className="dep-sugg" title="Still in the Suggested tray — it blocks until it's accepted and finished, dismissed, or unticked here">Suggested</span> : null}
              <span className="dep-status">{SLABEL[c.status]}</span>
            </label>
          ))}
        </div>
      )}
      {pendingSuggestions > 0 && (
        <div className="hlp">
          {pendingSuggestions === 1 ? "One blocker is" : `${pendingSuggestions} blockers are`} still an unreviewed suggestion. Accept
          {pendingSuggestions === 1 ? " it" : " them"} from the Suggested tray to work through the plan in order, or untick
          {pendingSuggestions === 1 ? " it" : " them"} here to start now.
        </div>
      )}
      {value.length > 0 ? (
        <label className="dep-autostart" title="When the last blocker above is marked Done, this task sends its initial prompt by itself">
          <input type="checkbox" checked={autoStart} onChange={(e) => onAutoStart(e.target.checked)} />
          Start when unblocked <span className="opt">(session launches itself once every blocker is done)</span>
        </label>
      ) : (
        <div className="hlp">This task can&apos;t be started until every selected task is marked Done.</div>
      )}
    </div>
  );
}
