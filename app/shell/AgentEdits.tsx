"use client";

// A task the user already accepted can still be changed by an agent (its own
// session's update_task, or another task's — see lib/agentTools.ts). Every such
// edit is recorded server-side; this is the user-facing half: a chip on the card
// that lights up while one is unreviewed (TaskRow.agent_edited_at !== 0), and a
// modal that shows what changed with a per-edit Revert.

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { relTime } from "./format";
import { Modal } from "./Modal";
import { LoadNote, ErrNote } from "./shared";
import type { AgentEditField, TaskAgentEdit, TaskRow } from "./types";

const FIELD_LABEL: Record<AgentEditField, string> = {
  title: "Title",
  description: "Description",
  priority: "Priority",
  status: "Status",
  tags: "Tags",
  blocked_by: "Blocked by",
  base_branch: "Base branch",
};

// The chip itself is a leaf: it owns whether its own modal is open rather than
// lifting that state to the card, so a card re-render (a stream event, a sort)
// can't blow away an open modal.
export function AgentEditedChip({ task, variant }: { task: TaskRow; variant: "list" | "board" }) {
  const [open, setOpen] = useState(false);
  // `&& !open` matters: reverting or acking the last outstanding edit clears
  // agent_edited_at, the global task_edited event refetches the row, and this
  // component would otherwise vanish — taking the panel the user is reading
  // out from under them mid-review. Once opened, the modal closes on the
  // user's word alone; only the chip beside it disappears.
  if (!task.agent_edited_at && !open) return null;
  return (
    <>
      {task.agent_edited_at !== 0 && <button
        type="button"
        className={variant === "list" ? "blocked-chip changed" : "bc-chip changed"}
        title="An agent changed this task after you accepted it — click to see what."
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
      >
        {Icon.edit()} Changed by agent <span className="ae-chip-time">{relTime(task.agent_edited_at)}</span>
      </button>}
      {open && <AgentEditsModal task={task} onClose={() => setOpen(false)} />}
    </>
  );
}

function ChangeRow({ change }: { change: { field: AgentEditField; before: string; after: string } }) {
  return (
    <div className="ae-row">
      <div className="ae-field">{FIELD_LABEL[change.field]}</div>
      <div className="ae-before">{change.before === "" ? <span className="ae-empty">(empty)</span> : change.before}</div>
      <div className="ae-after">{change.after === "" ? <span className="ae-empty">(empty)</span> : change.after}</div>
    </div>
  );
}

export function AgentEditsModal({ task, onClose }: { task: TaskRow; onClose: () => void }) {
  const [edits, setEdits] = useState<TaskAgentEdit[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [ackBusy, setAckBusy] = useState(false);
  const [ackErr, setAckErr] = useState<string | null>(null);
  const [revertBusy, setRevertBusy] = useState<string | null>(null); // edit id in flight
  const [revertErr, setRevertErr] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoadErr(null);
    jget<{ edits: TaskAgentEdit[] }>(`/api/tasks/${task.id}/agent-edits`)
      .then((d) => setEdits(d.edits))
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, [task.id]);
  useEffect(() => { load(); }, [load]);

  const ack = async () => {
    setAckBusy(true);
    setAckErr(null);
    try {
      await jsend(`/api/tasks/${task.id}/agent-edits`, "POST", { action: "ack" });
      onClose();
    } catch (e) {
      setAckErr(e instanceof Error ? e.message : String(e));
      setAckBusy(false);
    }
  };

  const revert = async (editId: string) => {
    setRevertBusy(editId);
    setRevertErr((m) => { if (!(editId in m)) return m; const n = { ...m }; delete n[editId]; return n; });
    try {
      const r = await jsend<{ task: TaskRow; edits: TaskAgentEdit[] }>(`/api/tasks/${task.id}/agent-edits`, "POST", { action: "revert", edit_id: editId });
      setEdits(r.edits);
    } catch (e) {
      setRevertErr((m) => ({ ...m, [editId]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRevertBusy(null);
    }
  };

  return (
    <Modal title="Changes by agent" sub={task.title} onClose={onClose}
      footer={<>
        <span className="ae-hint">Keep changes clears this flag and keeps the edits; Close leaves it for later.</span>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-accent" disabled={ackBusy || edits === null} onClick={ack}>
          {Icon.check()} {ackBusy ? "Saving…" : "Keep changes"}
        </button>
      </>}>
      {edits === null && !loadErr && <LoadNote>Loading changes…</LoadNote>}
      {loadErr && <ErrNote onRetry={load}>{loadErr}</ErrNote>}
      {edits && edits.length === 0 && (
        <div className="ae-none">Nothing outstanding — every agent edit here has already been reviewed.</div>
      )}
      {edits && edits.map((edit) => {
        const who = edit.actor_task_id ? (edit.actor_title || "An agent session") : "An agent session";
        const reverted = edit.reverted_at !== 0;
        return (
          <div key={edit.id} className={`ae-edit ${reverted ? "ae-reverted" : ""}`}>
            <div className="ae-who">
              {who}
              <span className="ae-agent"> · {edit.actor_agent}</span>
              <span className="ae-time"> · {relTime(edit.created_at)}</span>
            </div>
            {edit.changes.map((c, i) => <ChangeRow key={i} change={c} />)}
            <div className="ae-actions">
              {reverted ? (
                <span className="ae-reverted-note">Reverted {relTime(edit.reverted_at)}</span>
              ) : (
                <button className="btn btn-line btn-sm" disabled={revertBusy === edit.id} onClick={() => revert(edit.id)}>
                  {Icon.restore()} {revertBusy === edit.id ? "Reverting…" : "Revert"}
                </button>
              )}
            </div>
            {revertErr[edit.id] && <div className="ae-err">⚠ {revertErr[edit.id]}</div>}
          </div>
        );
      })}
      {ackErr && <div className="ae-err" style={{ marginTop: 12 }}>⚠ {ackErr}</div>}
    </Modal>
  );
}
