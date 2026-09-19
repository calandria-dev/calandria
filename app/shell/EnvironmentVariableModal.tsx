"use client";

import { useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { apiFetch } from "./api";
import { Modal } from "./Modal";
import {
  canonicalizeForUniqueness,
  lookupDescriptor,
  validateNameForScope,
  validateValue,
} from "@/lib/advanced-env/catalog.mjs";
import type { CatalogDescriptor, EnvScope, PresentedVariable } from "@/lib/advanced-env/types";

const AGENT_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Antigravity" };

function agentsLine(descriptor: CatalogDescriptor | null): string | null {
  if (!descriptor?.supportedAgents?.length) return null;
  return descriptor.supportedAgents.map((a) => AGENT_LABEL[a] ?? a).join(", ");
}

function effectLine(effect: "restart" | "next_turn"): string {
  return effect === "restart" ? "Restart required" : "Applies on next turn";
}

type Step = "catalog" | "form";

/**
 * Add/edit dialog for one App or Agent sessions row. Add starts on a
 * searchable catalog of that scope's editable descriptors, plus a Custom
 * variable option; both land on the same form. Edit skips straight to the
 * form. A secret row's name and value never arrive here: for those two
 * fields, the form offers Keep (send nothing, so the stored value survives)
 * or Replace (send a new one), since there is no old value to prefill.
 */
export function EnvironmentVariableModal({ scope, row, rows, catalog, revision, onClose, onSaved, onConflict }: {
  scope: EnvScope;
  /** null adds a new row; set edits this one. */
  row: PresentedVariable | null;
  /** Every row already saved in this scope, for the catalog's "already added" filter. */
  rows: PresentedVariable[];
  /** This scope's editable descriptors. */
  catalog: CatalogDescriptor[];
  revision: number;
  onClose: () => void;
  onSaved: () => void;
  /** A save hit a stale revision: refetch current metadata but keep the dialog and its draft open, so the user only retypes nothing and just retries Save. */
  onConflict: () => void;
}) {
  const [step, setStep] = useState<Step>(row ? "form" : "catalog");
  const [search, setSearch] = useState("");
  const [descriptor, setDescriptor] = useState<CatalogDescriptor | null>(row ? lookupDescriptor(row.name ?? "") ?? null : null);

  const [name, setName] = useState(row && !row.secret ? row.name ?? "" : "");
  const [value, setValue] = useState(row && !row.secret ? row.value ?? "" : "");
  const [secret, setSecret] = useState(row ? row.secret : false);
  const [showValue, setShowValue] = useState(false);

  // Only meaningful when editing a row that is currently secret: whether the
  // name/value field below is "keep what's stored" or "type a replacement".
  const [keepName, setKeepName] = useState(!!row?.secret);
  const [keepValue, setKeepValue] = useState(!!row?.secret);
  const [confirmExpose, setConfirmExpose] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const existingNames = useMemo(
    () => new Set(rows.filter((r) => !r.secret && r.id !== row?.id).map((r) => canonicalizeForUniqueness(r.name ?? ""))),
    [rows, row],
  );

  const pick = (d: CatalogDescriptor | null) => {
    setDescriptor(d);
    setName(d ? d.name : "");
    setValue("");
    setSecret(d ? d.secretByDefault : false);
    setError(null);
    setStep("form");
  };

  const results = catalog
    .filter((d) => !existingNames.has(canonicalizeForUniqueness(d.name)))
    .filter((d) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q);
    });

  // The effective name/value about to be sent, resolving the catalog lock, the
  // keep/replace toggles, and free typing into one candidate the client can
  // validate the same way the server will.
  const effectiveName = descriptor ? descriptor.name : row?.secret && keepName ? null : name;
  const effectiveValueForValidation = row?.secret && keepValue ? null : value;

  const nameCheck = effectiveName === null ? null : validateNameForScope(effectiveName, scope);
  const valueCheck = effectiveValueForValidation === null
    ? null
    : validateValue(descriptor ?? lookupDescriptor(effectiveName || ""), effectiveValueForValidation);

  const turningSecretOff = !!row?.secret && !secret;
  const canSave = !saving
    && (nameCheck === null || nameCheck.ok)
    && (valueCheck === null || valueCheck.ok)
    && (!turningSecretOff || confirmExpose);

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (!row) {
        const body = { scope, name, value, secret, expectedRevision: revision };
        const r = await apiFetch("/api/settings/environment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}) as Record<string, unknown>);
        if (!r.ok) {
          if (r.status === 409) {
            onConflict();
            throw new Error("This name was just taken, or the list changed. The list was refreshed; try Save again.");
          }
          throw new Error(typeof j.error === "string" ? j.error : "Could not add this variable.");
        }
      } else {
        const patch: Record<string, unknown> = { expectedRevision: revision, secret };
        if (!(row.secret && keepName)) patch.name = name;
        if (!(row.secret && keepValue)) patch.value = value;
        if (turningSecretOff) patch.confirmExpose = true;
        const r = await apiFetch(`/api/settings/environment/${row.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const j = await r.json().catch(() => ({}) as Record<string, unknown>);
        if (!r.ok) {
          if (r.status === 409) {
            onConflict();
            throw new Error("This variable changed elsewhere. The list was refreshed; try Save again.");
          }
          throw new Error(typeof j.error === "string" ? j.error : "Could not save this variable.");
        }
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (step === "catalog") {
    return (
      <Modal
        title={`Add ${scope === "app" ? "an app" : "an agent session"} variable`}
        onClose={onClose}
        width={640}
        footer={<><span className="spacer" /><button className="btn btn-ghost" onClick={onClose}>Cancel</button></>}
      >
        <div className="field" style={{ marginBottom: 12 }}>
          <input
            ref={firstFieldRef}
            className="ctx-mono"
            placeholder="Search the catalog…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search the environment variable catalog"
            data-testid="env-catalog-search"
            autoFocus
          />
        </div>
        <div className="mv-mlist" role="listbox" aria-label="Catalog entries">
          {results.map((d) => (
            <button
              key={d.name}
              type="button"
              role="option"
              className="mv-mrow adv-cat-row"
              onClick={() => pick(d)}
              data-testid={`env-catalog-item-${d.name}`}
            >
              <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                <code>{d.name}</code>
                <div className="adv-cat-desc">{d.description} Default: {d.defaultDescription}</div>
              </div>
              <span className="mv-tag" title="When a saved change takes effect">{effectLine(d.effect)}</span>
              {agentsLine(d) && <span className="mv-fam">{agentsLine(d)}</span>}
            </button>
          ))}
          <button type="button" role="option" className="mv-mrow adv-cat-row" onClick={() => pick(null)} data-testid="env-catalog-custom">
            <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
              <strong>Custom variable</strong>
              <div className="adv-cat-desc">Any other name, applied literally with no shell expansion.</div>
            </div>
          </button>
          {results.length === 0 && (
            <div className="hlp" style={{ padding: "10px 12px" }}>No catalog entries match &quot;{search}&quot;.</div>
          )}
        </div>
      </Modal>
    );
  }

  const showNameReplace = !row || !row.secret || !keepName;
  const showValueReplace = !row || !row.secret || !keepValue;

  return (
    <Modal
      title={row ? "Edit variable" : descriptor ? descriptor.name : "Add a custom variable"}
      sub={descriptor ? `${descriptor.description} Default: ${descriptor.defaultDescription}` : undefined}
      onClose={onClose}
      width={560}
      footer={<>
        <span className="hint">{error}</span>
        <span className="spacer" />
        {!row && (
          <button className="btn btn-ghost" onClick={() => setStep("catalog")}>{Icon.chevRight({ style: { transform: "rotate(180deg)" } })} Back</button>
        )}
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" disabled={!canSave} onClick={() => void submit()} data-testid="env-save">
          {saving ? "Saving…" : row ? "Save" : "Add variable"}
        </button>
      </>}
    >
      <div className="mv-form">
        {!descriptor && (
          <div className="field">
            <div className="lab">Name</div>
            {row?.secret ? (
              <div className="seg" role="radiogroup" aria-label="Name">
                <button type="button" className={keepName ? "on" : ""} onClick={() => setKeepName(true)}>Keep stored name</button>
                <button type="button" className={!keepName ? "on" : ""} onClick={() => setKeepName(false)}>Replace</button>
              </div>
            ) : null}
            {showNameReplace && (
              <input
                ref={firstFieldRef}
                className="ctx-mono"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="CUSTOM_VARIABLE_NAME"
                data-testid="env-name-input"
                style={{ marginTop: row?.secret ? 8 : 0 }}
              />
            )}
            {nameCheck && !nameCheck.ok && <div className="hlp err" style={{ color: "var(--red)" }}>{nameCheck.reason}</div>}
          </div>
        )}

        <div className="field">
          <div className="lab">Value</div>
          {row?.secret ? (
            <div className="seg" role="radiogroup" aria-label="Value" style={{ marginBottom: 8 }}>
              <button type="button" className={keepValue ? "on" : ""} onClick={() => setKeepValue(true)}>Keep stored value</button>
              <button type="button" className={!keepValue ? "on" : ""} onClick={() => setKeepValue(false)}>Replace</button>
            </div>
          ) : null}
          {showValueReplace && (
            descriptor?.inputType === "enum" ? (
              <select value={value} onChange={(e) => setValue(e.target.value)} data-testid="env-value-input">
                <option value="" disabled>Choose a value…</option>
                {descriptor.enumValues?.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            ) : (
              <div className="mv-keyrow">
                <input
                  className="ctx-mono"
                  type={secret && !showValue ? "password" : "text"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={secret ? "New value" : "value"}
                  data-testid="env-value-input"
                />
                {secret && (
                  <button type="button" className="mv-eye" aria-label={showValue ? "Hide value" : "Show value"} onClick={() => setShowValue(!showValue)}>
                    {Icon.eye()}
                  </button>
                )}
              </div>
            )
          )}
          {valueCheck && !valueCheck.ok && <div className="hlp err" style={{ color: "var(--red)" }}>{valueCheck.reason}</div>}
        </div>

        <label className="dep-autostart" style={{ marginBottom: turningSecretOff ? 8 : 0 }}>
          <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} data-testid="env-secret-checkbox" />
          Secret <span className="opt">(hide the name and value everywhere this list is shown)</span>
        </label>
        {turningSecretOff && (
          <label className="dep-autostart" style={{ color: "var(--red)" }}>
            <input type="checkbox" checked={confirmExpose} onChange={(e) => setConfirmExpose(e.target.checked)} data-testid="env-confirm-expose" />
            I understand the name and value become visible in this list.
          </label>
        )}

        <div className="hlp" style={{ marginTop: 12 }}>
          {effectLine(descriptor ? descriptor.effect : scope === "app" ? "restart" : "next_turn")}
          {agentsLine(descriptor) ? ` · Supported by ${agentsLine(descriptor)}` : ""}
        </div>
      </div>
    </Modal>
  );
}
