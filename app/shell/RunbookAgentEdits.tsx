"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { relTime } from "./format";
import { Modal } from "./Modal";
import { ErrNote, LoadNote } from "./shared";
import type { RunbookRow } from "./types";

type Field = "name" | "description" | "prompt" | "permission_mode" | "priority" | "provider_id" | "model" | "send_context";
type Edit = {
  id: string;
  actor_task_id: string | null;
  actor_title: string;
  actor_agent: string;
  changes: { field: Field; before: string; after: string }[];
  created_at: number;
  reverted_at: number;
  acknowledged_at: number;
};

const LABEL: Record<Field, string> = {
  name: "Name", description: "Description", prompt: "Prompt", permission_mode: "Permission mode",
  priority: "Priority", provider_id: "Provider", model: "Model", send_context: "Project context",
};

export function RunbookAgentEditedChip({ runbook }: { runbook: RunbookRow }) {
  const [open, setOpen] = useState(false);
  if (!runbook.agent_edited_at && !open) return null;
  return <>
    {!!runbook.agent_edited_at && <button type="button" className="blocked-chip changed rb-agent-edited"
      title="An agent changed this runbook. Review the prompt and settings before running it."
      onClick={() => setOpen(true)}>
      {Icon.edit()} Changed by agent <span className="ae-chip-time">{relTime(runbook.agent_edited_at)}</span>
    </button>}
    {open && <RunbookAgentEditsModal runbook={runbook} onClose={() => setOpen(false)} />}
  </>;
}

function RunbookAgentEditsModal({ runbook, onClose }: { runbook: RunbookRow; onClose: () => void }) {
  const [edits, setEdits] = useState<Edit[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState("");
  const [revertBusy, setRevertBusy] = useState("");
  const [revertErrors, setRevertErrors] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoadError("");
    jget<{ edits: Edit[] }>(`/api/runbooks/${runbook.id}/agent-edits`)
      .then((data) => setEdits(data.edits))
      .catch((error) => setLoadError(error instanceof Error ? error.message : String(error)));
  }, [runbook.id]);
  useEffect(() => { load(); }, [load]);

  const ack = async () => {
    setAckBusy(true); setAckError("");
    try { await jsend(`/api/runbooks/${runbook.id}/agent-edits`, "POST", { action: "ack" }); onClose(); }
    catch (error) { setAckError(error instanceof Error ? error.message : String(error)); setAckBusy(false); }
  };

  const revert = async (id: string) => {
    setRevertBusy(id); setRevertErrors((old) => { const next = { ...old }; delete next[id]; return next; });
    try {
      const data = await jsend<{ edits: Edit[] }>(`/api/runbooks/${runbook.id}/agent-edits`, "POST", { action: "revert", edit_id: id });
      setEdits(data.edits);
    } catch (error) { setRevertErrors((old) => ({ ...old, [id]: error instanceof Error ? error.message : String(error) })); }
    finally { setRevertBusy(""); }
  };

  return <Modal title="Changes by agent" sub={runbook.name} onClose={onClose} footer={<>
    <span className="ae-hint">Keep changes clears this review flag. Running still asks you to confirm this recipe.</span>
    <button className="btn btn-ghost" onClick={onClose}>Close</button>
    <button className="btn btn-accent" disabled={ackBusy || edits === null} onClick={ack}>
      {Icon.check()} {ackBusy ? "Saving…" : "Keep changes"}
    </button>
  </>}>
    {edits === null && !loadError && <LoadNote>Loading changes…</LoadNote>}
    {loadError && <ErrNote onRetry={load}>{loadError}</ErrNote>}
    {edits?.length === 0 && <div className="ae-none">No recorded edits. The runbook may already have been reviewed.</div>}
    {edits?.map((edit) => {
      const reverted = edit.reverted_at !== 0;
      return <div key={edit.id} className={`ae-edit ${reverted ? "ae-reverted" : ""}`}>
        <div className="ae-who">{edit.actor_title || "An agent session"}<span className="ae-agent"> · {edit.actor_agent}</span><span className="ae-time"> · {relTime(edit.created_at)}</span></div>
        {edit.changes.map((change, index) => <div className="ae-row" key={index}>
          <div className="ae-field">{LABEL[change.field]}</div>
          <div className="ae-before">{change.before || <span className="ae-empty">(empty)</span>}</div>
          <div className="ae-after">{change.after || <span className="ae-empty">(empty)</span>}</div>
        </div>)}
        <div className="ae-actions">{reverted ? <span className="ae-reverted-note">Reverted {relTime(edit.reverted_at)}</span> :
          <button className="btn btn-line btn-sm" disabled={revertBusy === edit.id} onClick={() => void revert(edit.id)}>
            {Icon.restore()} {revertBusy === edit.id ? "Reverting…" : "Revert"}
          </button>}</div>
        {revertErrors[edit.id] && <div className="ae-err" role="alert">{revertErrors[edit.id]}</div>}
      </div>;
    })}
    {ackError && <div className="ae-err" role="alert" style={{ marginTop: 12 }}>{ackError}</div>}
  </Modal>;
}
