"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { apiFetch, jget } from "./api";
import { LoadNote, ErrNote } from "./shared";
import { EnvironmentVariableModal } from "./EnvironmentVariableModal";
import type { CatalogDescriptor, EnvScope, PresentedVariable } from "@/lib/advanced-env/types";

type ListResponse = {
  rows: PresentedVariable[];
  revision: number;
  restartRequired: boolean;
  loadError: string | null;
  catalog: CatalogDescriptor[];
  instance: { name: string; host: string };
};

function effectLabel(row: PresentedVariable): string {
  return row.effect === "restart" ? "Restart required" : "Applies on next turn";
}

function rowLabel(row: PresentedVariable): string {
  return row.secret ? `Secret variable · ${row.id.slice(0, 4)}` : (row.name ?? "");
}

function EnvRow({ row, revision, onEdit, onDeleted, onConflict }: {
  row: PresentedVariable;
  revision: number;
  onEdit: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onDeleted: () => void;
  onConflict: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Two-click confirm, same shape as the provider Remove tab: the first click
  // only arms the button, so an accidental click never deletes anything.
  const del = async () => {
    if (!confirm) { setConfirm(true); return; }
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch(`/api/settings/environment/${row.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      const body = await r.json().catch(() => ({}) as Record<string, unknown>);
      if (!r.ok) {
        if (r.status === 409) { onConflict(); return; }
        throw new Error(typeof body.error === "string" ? body.error : "Could not delete this variable.");
      }
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mv-row adv-row" data-testid={`env-row-${row.id}`}>
      <div className="mv-id">
        <div className="mv-nm">
          <span className="ctx-mono">{rowLabel(row)}</span>
          {row.secret && <span className="mv-chip mute" title="The name and value are hidden">{Icon.lock()} Secret</span>}
          {row.overriddenByHost && (
            <span className="mv-chip warn" title="A launch environment value takes precedence; this saved value is not active right now">
              Overridden by host
            </span>
          )}
        </div>
        <div className="mv-ty adv-val" title={row.secret ? undefined : (row.value ?? "")}>
          {row.secret ? "Hidden" : (row.value ? row.value : <em>(empty)</em>)}
          {" · "}{effectLabel(row)}
        </div>
      </div>
      <div className="mv-acts">
        <button className="btn btn-sm" onClick={onEdit} aria-label={`Edit ${rowLabel(row)}`}>{Icon.edit()} Edit</button>
        <button
          className={confirm ? "btn btn-sm btn-danger on" : "btn btn-sm btn-danger"}
          disabled={busy}
          onClick={() => void del()}
          aria-label={`${confirm ? "Confirm delete" : "Delete"} ${rowLabel(row)}`}
        >
          {confirm ? "Confirm delete" : "Delete"}
        </button>
      </div>
      {err && <ErrNote style={{ marginTop: 6, width: "100%" }}>{err}</ErrNote>}
    </div>
  );
}

function EnvTable({ scope, title, help, rows, revision, catalog, onReload }: {
  scope: EnvScope;
  title: string;
  help: string;
  rows: PresentedVariable[];
  revision: number;
  catalog: CatalogDescriptor[];
  onReload: () => void;
}) {
  const [modal, setModal] = useState<{ id: string | null } | null>(null);
  const editing = modal?.id ? rows.find((r) => r.id === modal.id) ?? null : null;
  // The element that opened the dialog, so closing it (Cancel, Save, or the
  // scrim/Escape Modal already wires up) returns focus there instead of
  // dropping it to <body>.
  const opener = useRef<HTMLElement | null>(null);
  const openModal = (id: string | null, e: React.MouseEvent<HTMLButtonElement>) => {
    opener.current = e.currentTarget;
    setModal({ id });
  };
  const closeModal = () => {
    setModal(null);
    opener.current?.focus();
  };

  return (
    <div className="mv-sec">
      <div className="mv-sec-h">
        <h2>{title}</h2>
        <span className="st">
          <button className="btn btn-sm btn-accent" onClick={(e) => openModal(null, e)} data-testid={`env-add-${scope}`}>
            {Icon.plus()} Add variable
          </button>
        </span>
      </div>
      <p className="mv-fine">{help}</p>
      <div className="mv-list">
        {rows.length === 0 && <div className="hlp" style={{ padding: "10px 2px" }}>No {scope === "app" ? "app" : "agent"} variables saved yet.</div>}
        {rows.map((row) => (
          <EnvRow
            key={row.id}
            row={row}
            revision={revision}
            onEdit={(e) => openModal(row.id, e)}
            onDeleted={onReload}
            onConflict={onReload}
          />
        ))}
      </div>
      {modal && (
        <EnvironmentVariableModal
          scope={scope}
          row={editing}
          rows={rows}
          catalog={catalog}
          revision={revision}
          onClose={closeModal}
          onSaved={() => { setModal(null); onReload(); opener.current?.focus(); }}
          onConflict={onReload}
        />
      )}
    </div>
  );
}

// Settings -> Advanced: two name/value tables (App restarts to apply; Agent
// sessions pick a saved change up on their next turn). Both read and write
// through the redacted store API in lib/advanced-env/store.ts; a secret row's
// name and value never reach this component, only an opaque id and flags.
export function AdvancedSettingsSection() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    jget<ListResponse>("/api/settings/environment")
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => { load(); }, []);

  // Reserved for task 9: an agent-approved mutation dispatches this same event
  // so the tables pick it up without a poll, exactly like calandria:agent_auth
  // does for the Models section.
  useEffect(() => {
    const onChanged = () => load();
    window.addEventListener("calandria:advanced-env-changed", onChanged);
    return () => window.removeEventListener("calandria:advanced-env-changed", onChanged);
  }, []);

  // Reload when the tab regains focus, so a change made from another tab or a
  // remote desktop editing this same instance is not silently stale.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const onFocus = () => loadRef.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (err) return <ErrNote onRetry={load}>{err}</ErrNote>;
  if (!data) return <LoadNote style={{ padding: 0 }}>Loading advanced settings…</LoadNote>;

  const appRows = data.rows.filter((r) => r.scope === "app");
  const agentRows = data.rows.filter((r) => r.scope === "agent");
  const appCatalog = data.catalog.filter((d) => d.scope === "app");
  const agentCatalog = data.catalog.filter((d) => d.scope === "agent");

  return (
    <>
      <p className="mv-lede">
        Settings here are stored on <strong>{data.instance.name}</strong>{data.instance.host ? ` (${data.instance.host})` : ""} and
        apply to every project this instance runs. A remote desktop connection edits that server&apos;s copy, never the
        local supervisor&apos;s own configuration.
      </p>
      {data.loadError && <ErrNote style={{ marginBottom: 14 }} onRetry={load}>{data.loadError}</ErrNote>}
      {data.restartRequired && (
        <div className="mv-test" style={{ marginBottom: 14 }} data-testid="env-restart-banner">
          <div className="mv-trow"><span className="mv-tmsg">A saved app setting is not active yet. Restart the server to apply it.</span></div>
        </div>
      )}
      <EnvTable
        scope="app"
        title="App"
        help="Applied to the server process. Changes take effect after a restart."
        rows={appRows}
        revision={data.revision}
        catalog={appCatalog}
        onReload={load}
      />
      <EnvTable
        scope="agent"
        title="Agent sessions"
        help="Applied to task sessions (Claude, Codex and Antigravity turns). A saved change reaches the next turn, including a resumed session; a turn already running keeps its own snapshot. This does not configure one-shot utility jobs or the interactive terminal."
        rows={agentRows}
        revision={data.revision}
        catalog={agentCatalog}
        onReload={load}
      />
    </>
  );
}
