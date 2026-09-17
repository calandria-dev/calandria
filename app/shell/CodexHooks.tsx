"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { ErrNote, LoadNote } from "./shared";
import type {
  CodexHook,
  CodexHookInventory,
  CodexHookSkip,
} from "@/lib/agents/codex/hooks";

type HooksAnswer =
  | { supported: false }
  | { supported: true; error: string }
  | { supported: true; inventory: CodexHookInventory; skippedHooks: CodexHookSkip[] };

// Hex after the `sha256:` prefix, shortened for the chip; the full value is
// still readable via the chip's `title`, since a review has to be against the
// exact hash a trust record pins.
function shortHash(hash: string): string {
  const hex = hash.replace(/^sha256:/, "");
  return hex.length > 10 ? `${hex.slice(0, 10)}…` : hex;
}

function trustChip(hook: CodexHook): { label: string; cls: string } {
  if (hook.trustStatus === "managed") return { label: "Managed", cls: "mute" };
  if (hook.trustStatus === "trusted") return { label: "Trusted", cls: "ok" };
  if (hook.trustStatus === "modified") return { label: "Modified", cls: "warn" };
  return { label: "Not reviewed", cls: "warn" };
}

function whatItDoes(hook: CodexHook): string {
  if (hook.handlerType === "command") return hook.command || "(no command)";
  if (hook.handlerType === "mcpTool") return `${hook.server ?? "?"}/${hook.tool ?? "?"}`;
  return hook.handlerType;
}

const SOURCE_LABEL: Record<string, string> = {
  system: "system",
  user: "user",
  project: "project",
  mdm: "MDM policy",
  sessionFlags: "session flags",
  plugin: "plugin",
  cloudRequirements: "cloud requirements",
  cloudManagedConfig: "cloud-managed config",
  legacyManagedConfigFile: "legacy managed config",
  legacyManagedConfigMdm: "legacy MDM config",
  unknown: "unknown source",
};

function HookRow({ hook, reason, busy, onAct }: {
  hook: CodexHook;
  reason: string | null;
  busy: boolean;
  onAct: (action: "trust" | "untrust" | "enable" | "disable") => void;
}) {
  const chip = trustChip(hook);
  const willRun = !reason;
  return (
    <div className={`chk-hook${willRun ? "" : " off"}`}>
      <div className="chk-hook-top">
        <span className="chk-event">
          {hook.eventName}{hook.matcher ? `(${hook.matcher})` : ""}
        </span>
        <span className={`chk-chip ${chip.cls}`} title={hook.currentHash}>{chip.label} · {shortHash(hook.currentHash)}</span>
        {!hook.enabled && <span className="chk-chip mute">Disabled</span>}
        {reason && <span className="chk-skip">won&apos;t run: {reason}</span>}
      </div>
      <div className="chk-hook-what ctx-mono">{whatItDoes(hook)}</div>
      <div className="chk-hook-src">
        {hook.sourcePath || "(no path)"} · {SOURCE_LABEL[hook.source] ?? hook.source}
      </div>
      <div className="chk-hook-acts">
        {hook.isManaged ? (
          <span className="chk-managed">An administrator pinned this hook; it can&apos;t be reviewed away here.</span>
        ) : hook.trustStatus === "trusted" ? (
          <button className="btn btn-sm" disabled={busy} onClick={() => onAct("untrust")}>Withdraw trust</button>
        ) : (
          <button className="btn btn-sm btn-accent" disabled={busy} onClick={() => onAct("trust")}>Review and trust</button>
        )}
        <button className="btn btn-sm" disabled={busy} onClick={() => onAct(hook.enabled ? "disable" : "enable")}>
          {hook.enabled ? "Disable" : "Enable"}
        </button>
      </div>
    </div>
  );
}

// Settings → Run defaults' Codex hooks panel: the inventory of what Codex
// will run on a lifecycle event, and the review workflow that trusts or
// withdraws trust on one hook at a time. Renders nothing for an agent whose
// driver reports no hook support (every agent but Codex today), the same
// quiet-absence rule AgentSandboxWarning follows for a diagnostic that only
// applies to one driver.
export function CodexHooksPanel({ agentId, currentProjectId, projects }: {
  agentId: string;
  currentProjectId: string | null;
  projects: { id: string; name: string }[];
}) {
  const [projectId, setProjectId] = useState<string | null>(currentProjectId ?? projects[0]?.id ?? null);
  useEffect(() => {
    if (currentProjectId) setProjectId(currentProjectId);
  }, [currentProjectId]);

  const [state, setState] = useState<"loading" | "unsupported" | "error" | "ready">("loading");
  const [inventory, setInventory] = useState<CodexHookInventory | null>(null);
  const [skipped, setSkipped] = useState<CodexHookSkip[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!projectId) return;
    setLoadErr(null);
    jget<HooksAnswer>(`/api/agents/${agentId}/hooks?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => {
        if (!r.supported) { setState("unsupported"); return; }
        if ("error" in r) { setLoadErr(r.error); setState("error"); return; }
        setInventory(r.inventory);
        setSkipped(r.skippedHooks);
        setState("ready");
      })
      .catch((e) => { setLoadErr(e instanceof Error ? e.message : String(e)); setState("error"); });
  }, [agentId, projectId]);

  useEffect(() => { void load(); }, [load]);

  const act = async (hook: CodexHook, action: "trust" | "untrust" | "enable" | "disable") => {
    if (!projectId) return;
    setBusyKey(hook.key);
    setActErr(null);
    try {
      await jsend(`/api/agents/${agentId}/hooks`, "POST", { projectId, reviews: [{ key: hook.key, action }] });
      load();
    } catch (e) {
      setActErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  // No project exists at all: nothing to scope the query to, and nothing
  // useful to say either way.
  if (!projectId) return null;
  // Unsupported means this driver has no listHooks: quiet, not an error, so
  // every agent but Codex renders nothing here.
  if (state === "unsupported") return null;

  const skipReasons = new Map(skipped.map((s) => [s.hook.key, s.reason]));
  const projectName = projects.find((p) => p.id === projectId)?.name ?? null;

  return (
    <div className="field">
      <div className="lab">{Icon.lock()} Codex hooks</div>
      <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
        Hook definitions Codex will run on lifecycle events like a tool call, and whether each one is trusted to
        actually run. A hook that is untrusted, edited since its last review, or turned off will not fire, silently.
      </div>
      {!currentProjectId && projects.length > 1 && (
        <div className="chk-picker">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {projectName && <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>Scoped to <strong>{projectName}</strong>&apos;s working directory.</div>}

      {state === "loading" && <LoadNote>Reading the hook inventory…</LoadNote>}
      {state === "error" && <ErrNote onRetry={load}>{loadErr}</ErrNote>}
      {actErr && <ErrNote style={{ marginTop: 8 }}>{actErr}</ErrNote>}

      {state === "ready" && inventory && (
        <>
          {inventory.suppressedReason && (
            <div className="chk-suppressed">
              <span className="chk-warnic">{Icon.bolt()}</span>
              <div>
                <div className="chk-suppressed-t">Project-local hooks are suppressed</div>
                <div className="hlp" style={{ marginTop: 4 }}>{inventory.suppressedReason}</div>
              </div>
            </div>
          )}
          {inventory.scopes.length === 0 && (
            <div className="hlp">
              {inventory.suppressedReason
                ? "The list below is empty because project-local hooks are suppressed, not because none are configured."
                : "No hooks are configured for this working directory."}
            </div>
          )}
          {inventory.scopes.map((scope) => (
            <div className="chk-scope" key={scope.cwd}>
              <div className="chk-scope-h ctx-mono">{scope.cwd}</div>
              {scope.warnings.map((w, i) => <div className="chk-scope-warn" key={`w${i}`}>{w}</div>)}
              {scope.errors.map((e, i) => <div className="chk-scope-warn" key={`e${i}`}>{e.path}: {e.message}</div>)}
              {scope.hooks.length === 0 ? (
                <div className="hlp" style={{ marginTop: 0 }}>No hooks configured in this scope.</div>
              ) : (
                <div className="chk-hooks">
                  {scope.hooks.map((hook) => (
                    <HookRow
                      key={hook.key}
                      hook={hook}
                      reason={skipReasons.get(hook.key) ?? null}
                      busy={busyKey === hook.key}
                      onAct={(action) => void act(hook, action)}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
