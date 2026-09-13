"use client";

import { useEffect, useState } from "react";
import { Icon, EnvMark, ProviderMark } from "../icons";
import { jget, jsend } from "./api";
import { Modal } from "./Modal";
import { LoadNote } from "./shared";
import { usePlanUsage, planUsageShown } from "./PlanUsage";
import type {
  AgentInfoT, ProviderType,
  PresentedProviderT, ProviderProbeResultT, FlatProviderModelT, ProviderModelsResponseT,
  ProviderUsageT, ModelPolicyT,
} from "./types";

// The three environments a provider type can ever serve, in the fixed order
// every EnvMark row renders them. Mirrors lib/providers/types.ts EnvironmentId.
export const ALL_ENVS = ["claude", "codex", "gemini"] as const;

// Metadata for the six user-addable provider types (lib/providers/types.ts
// PROVIDER_REGISTRY holds the same facts server-side; duplicated here because
// the client only needs the shape for the add grid and the connection form,
// not the zod schemas that come with it).
const USER_TYPES: { type: ProviderType; label: string; desc: string; policyMode: "allow" | "deny"; hasKey: boolean }[] = [
  { type: "litellm", label: "LiteLLM gateway", desc: "A gateway you run. One key, any model, spend caps per project.", policyMode: "allow", hasKey: true },
  { type: "ollama", label: "Ollama", desc: "Local models on this machine or your network.", policyMode: "deny", hasKey: false },
  { type: "lmstudio", label: "LM Studio", desc: "Local server with an OpenAI-compatible endpoint.", policyMode: "deny", hasKey: false },
  { type: "openai_key", label: "OpenAI API key", desc: "Direct to OpenAI with your own key, separate from the Codex login.", policyMode: "deny", hasKey: true },
  { type: "gemini_key", label: "Gemini API key", desc: "Direct to Google with your own key, separate from Antigravity.", policyMode: "deny", hasKey: true },
  { type: "custom", label: "Custom endpoint", desc: "Anything else that speaks the chat completions API.", policyMode: "deny", hasKey: true },
];
const TYPE_ENVS: Record<ProviderType, string[]> = {
  anthropic: ["claude"], openai: ["codex"], google: ["gemini"],
  litellm: ["claude", "codex", "gemini"], ollama: ["claude", "codex"], lmstudio: ["claude", "codex"],
  openai_key: ["codex"], gemini_key: ["gemini"], custom: ["claude", "codex"],
};
const DEFAULT_ENDPOINT: Partial<Record<ProviderType, string>> = {
  litellm: "https://", ollama: "http://localhost:11434", lmstudio: "http://localhost:1234",
  openai_key: "https://api.openai.com", gemini_key: "https://generativelanguage.googleapis.com", custom: "https://",
};
// The directories lib/agents/detect.ts looks for, restated for the bundled
// Connection tab's read-only "Config" row. Not served by GET /api/agents.
const CONFIG_DIR: Record<string, string> = { claude: "~/.claude", codex: "~/.codex", gemini: "~/.gemini/antigravity-cli" };

export function envLabel(agents: AgentInfoT[], id: string): string {
  return agents.find((a) => a.id === id)?.label
    ?? { claude: "Claude Code", codex: "Codex", gemini: "Antigravity" }[id]
    ?? id;
}

export function EnvDots({ served, active }: { served: readonly string[]; active?: (id: string) => boolean }) {
  return (
    <span className="mv-envs">
      {ALL_ENVS.map((e) => (
        <span key={e} className={(active ? active(e) : served.includes(e)) ? "on" : ""}>{EnvMark[e]?.()}</span>
      ))}
    </span>
  );
}

export function StatusChip({ status }: { status: "connected" | "reachable" | "unreachable" | "untested" }) {
  const cls = status === "connected" || status === "reachable" ? "ok" : status === "unreachable" ? "warn" : "mute";
  const label = status === "connected" ? "Connected" : status === "reachable" ? "Reachable" : status === "unreachable" ? "Unreachable" : "Untested";
  return <span className={`mv-chip ${cls}`}>{label}</span>;
}

// "Bundled with Claude Code · via Claude Max", "LiteLLM gateway · gw.home.arpa",
// "Local server · localhost:11434": the provider row's type line, shared by
// the list row and the detail modal's header subtitle.
export function providerTypeLine(provider: PresentedProviderT, agents: AgentInfoT[]): string {
  if (provider.bundled) {
    const env = agents.find((a) => a.id === provider.bundled);
    const via = env?.account?.plan ? `via ${env.account.plan}` : `via ${env?.label ?? provider.bundled}`;
    return `Bundled with ${env?.label ?? provider.bundled} · ${via}`;
  }
  const host = provider.config.base_url ? provider.config.base_url.replace(/^https?:\/\//, "") : "";
  if (provider.type === "litellm") return `LiteLLM gateway${host ? ` · ${host}` : ""}`;
  if (provider.type === "ollama" || provider.type === "lmstudio") return `Local server${host ? ` · ${host}` : ""}`;
  if (provider.type === "custom") return `Custom endpoint${host ? ` · ${host}` : ""}`;
  if (provider.type === "openai_key") return "OpenAI API key";
  if (provider.type === "gemini_key") return "Gemini API key";
  return provider.label;
}

// lib/providers/rows.ts's ProviderTestResult documents every field as
// optional ("a probe reports what it could learn"), so a stored `last_test`
// is not guaranteed to carry `models` even though every live probe route
// defaults it to `[]`. Widening the type on read means every `.models` access
// below can stay unguarded instead of repeating the fallback at each call site.
function normalizeTestResult(raw: PresentedProviderT["last_test"]): ProviderProbeResultT | null {
  if (!raw) return null;
  return {
    reachable: raw.reachable ?? false,
    api: (raw.api as string | null) ?? null,
    version: (raw.version as string | null) ?? null,
    latency_ms: raw.latency_ms ?? 0,
    error: raw.error ?? null,
    key: (raw.key as ProviderProbeResultT["key"]) ?? { spend: null, max_budget: null },
    models: (raw.models as ProviderProbeResultT["models"]) ?? [],
  };
}

function formatCtx(n: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(/\.0M$/, "M");
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Connection form: the add page's Connection section and a user-added row's
// editable Connection tab share this exact set of fields (spec: "Connection
// for a user-added row is the add form with the last test result shown in
// place").
// ---------------------------------------------------------------------------
function ConnectionForm({
  meta, name, setName, endpoint, setEndpoint, apiKey, setApiKey, showKey, setShowKey,
  apiShape, setApiShape, served, servesLabel, testState, testResult, testError, onTest, keyPlaceholder,
}: {
  meta: { type: ProviderType; hasKey: boolean };
  name: string; setName: (v: string) => void;
  endpoint: string; setEndpoint: (v: string) => void;
  apiKey: string; setApiKey: (v: string) => void;
  showKey: boolean; setShowKey: (v: boolean) => void;
  apiShape: "anthropic" | "openai"; setApiShape: (v: "anthropic" | "openai") => void;
  served: readonly string[]; servesLabel: string;
  testState: "idle" | "busy" | "ok" | "bad";
  testResult: ProviderProbeResultT | null;
  testError: string | null;
  onTest: () => void;
  keyPlaceholder?: string;
}) {
  return (
    <div className="mv-form">
      <div className="field">
        <div className="lab">Name</div>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <div className="hlp">Shown next to the model in the picker when a model is reachable from more than one place.</div>
      </div>
      <div className="field">
        <div className="lab">Endpoint</div>
        <input className="ctx-mono" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://…" />
      </div>
      {meta.type === "custom" && (
        <div className="field">
          <div className="lab">API shape</div>
          <div className="seg" style={{ maxWidth: 340 }}>
            <button className={apiShape === "openai" ? "on" : ""} onClick={() => setApiShape("openai")}>OpenAI-compatible</button>
            <button className={apiShape === "anthropic" ? "on" : ""} onClick={() => setApiShape("anthropic")}>Anthropic-compatible</button>
          </div>
        </div>
      )}
      {meta.hasKey && (
        <div className="field">
          <div className="lab">API key</div>
          <div className="mv-keyrow">
            <input className="ctx-mono" type={showKey ? "text" : "password"} value={apiKey} placeholder={keyPlaceholder ?? "sk-…"}
              autoComplete="off" onChange={(e) => setApiKey(e.target.value)} />
            <button type="button" className="mv-eye" aria-label={showKey ? "Hide key" : "Show key"} onClick={() => setShowKey(!showKey)}>
              {Icon.eye()}
            </button>
          </div>
          <div className="hlp">Stored on this instance. Never written to a task&apos;s environment as plain text.</div>
        </div>
      )}
      <div className="field">
        <div className="lab">Will serve</div>
        <div className="mv-serves">
          <EnvDots served={served} />
          <span>{servesLabel}</span>
          <span className="opt">· decided by Calandria from the provider type</span>
        </div>
      </div>
      <div className={`mv-test ${testState}`}>
        <div className="mv-trow">
          <button className="btn btn-line btn-sm" onClick={onTest} disabled={testState === "busy" || !endpoint.trim()}>
            {testState === "busy" ? "Connecting…" : "Test connection"}
          </button>
          <span className="mv-tmsg">
            {testState === "ok" && testResult
              ? `Reached in ${testResult.latency_ms} ms · ${(testResult.models ?? []).filter((m) => m.chat).length} models listed · auth OK`
              : testState === "bad"
                ? testError || "The connection failed."
                : testState === "busy"
                  ? "Connecting…"
                  : "Models load once the connection works."}
          </span>
        </div>
        {testState === "bad" && testError && <pre className="mv-errlog">{testError}</pre>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model policy block: the allowlist/everything-available header, the on/off
// count line and the model rows. Shared by the add page's post-test preview
// and the detail modal's Models tab, which is why family/duplicate columns
// are optional: a freshly-tested, unsaved provider has no placement yet
// (POST /api/providers/test does not run placeModel()), only a saved row's
// GET /api/providers/[id]/models does.
// ---------------------------------------------------------------------------
interface DisplayModel { id: string; ctx: number; family: string; version: string; duplicate_of: string | null; on: boolean }

function ModelPolicyBlock({ models, gateway, onToggle, onAll, showFamily, refreshedAt, onRefresh, refreshing }: {
  models: DisplayModel[];
  gateway: boolean;
  onToggle: (id: string, on: boolean) => void;
  onAll?: (on: boolean) => void;
  showFamily: boolean;
  refreshedAt?: number | null;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const onCount = models.filter((m) => m.on).length;
  const unsorted = showFamily ? models.filter((m) => !m.family || m.family === "other").length : 0;
  return (
    <>
      <div className="mv-pol">
        {gateway ? (
          <div>
            <b>Allowlist</b>
            <span>
              The gateway lists {models.length} chat model{models.length === 1 ? "" : "s"}. Only the ones turned on reach
              the picker. Models the gateway adds later stay off until you turn them on.
            </span>
          </div>
        ) : (
          <div>
            <b>Everything listed is available</b>
            <span>Local servers and bundled logins expose every model they have. Turn one off to hide it from the picker.</span>
          </div>
        )}
        {onAll && gateway && (
          <div className="mv-pacts">
            <button className="btn btn-sm" onClick={() => onAll(true)}>Turn on all</button>
            <button className="btn btn-sm" onClick={() => onAll(false)}>Turn off all</button>
          </div>
        )}
      </div>
      <div className="mv-mhead">
        <span>{onCount} of {models.length} on</span>
        {showFamily && unsorted > 0 && <span className="mv-dim">{unsorted} in Other</span>}
        {refreshedAt != null && (
          <span className="ctx-mono" style={{ marginLeft: "auto" }}>
            refreshed {new Date(refreshedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
        )}
        {onRefresh && <button className="btn btn-sm" onClick={onRefresh} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh"}</button>}
      </div>
      <div className="mv-mlist">
        {models.length === 0 && <div className="hlp" style={{ padding: 12 }}>No chat models found.</div>}
        {models.map((m) => (
          <div key={m.id} className={`mv-mrow${m.on ? "" : " off"}`}>
            <button role="switch" aria-label={m.id} aria-checked={m.on} className={`in-switch${m.on ? " on" : ""}`}
              onClick={() => onToggle(m.id, !m.on)}><span /></button>
            <code>{m.id}</code>
            {m.duplicate_of && <span className="mv-tag">duplicate of <code>{m.duplicate_of}</code></span>}
            <span className="mv-ctx">{formatCtx(m.ctx)}</span>
            {showFamily && (
              <span className={`mv-fam${!m.family || m.family === "other" ? " un" : ""}`}>
                {m.family && m.family !== "other" ? `${m.family}${m.version ? ` › ${m.version}` : ""}` : "Other"}
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail modal: Connection (read-only for a bundled row), Models, Remove.
// ---------------------------------------------------------------------------
function usageSentence(u: ProviderUsageT): string {
  const parts: string[] = [];
  if (u.projects.length) parts.push(`${u.projects.length} project default${u.projects.length === 1 ? "" : "s"}`);
  if (u.tasks.length) parts.push(`${u.tasks.length} task${u.tasks.length === 1 ? "" : "s"}`);
  if (u.schedules.length) parts.push(`${u.schedules.length} schedule${u.schedules.length === 1 ? "" : "s"}`);
  if (u.runbooks.length) parts.push(`${u.runbooks.length} runbook${u.runbooks.length === 1 ? "" : "s"}`);
  return parts.length ? `Currently used by ${parts.join(", ")}.` : "Nothing points at this provider right now.";
}

function RemoveTab({ provider, onRemoved }: { provider: PresentedProviderT; onRemoved: () => void }) {
  const [usage, setUsage] = useState<ProviderUsageT | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    jget<{ usage: ProviderUsageT }>(`/api/providers/${provider.id}/usage`).then((d) => setUsage(d.usage)).catch(() => setUsage(null));
  }, [provider.id]);
  const remove = async () => {
    if (!confirm) { setConfirm(true); return; }
    setBusy(true);
    try { await jsend(`/api/providers/${provider.id}`, "DELETE"); onRemoved(); } finally { setBusy(false); }
  };
  return (
    <div className="mv-danger">
      <div>
        <b>Remove {provider.label}</b>
        <span>
          Tasks already running keep their model until they finish. Tasks whose default pointed here fall back to the
          project default. {usage ? usageSentence(usage) : "Checking what points at it…"}
        </span>
      </div>
      <button className={confirm ? "btn-danger on" : "btn-danger"} disabled={busy} onClick={remove}>
        {confirm ? "Click again to remove" : "Remove provider"}
      </button>
    </div>
  );
}

function ModelsTab({ provider, onChanged }: { provider: PresentedProviderT; onChanged: () => void }) {
  const [flat, setFlat] = useState<ProviderModelsResponseT | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    setFlat(null);
    jget<ProviderModelsResponseT>(`/api/providers/${provider.id}/models`).then((r) => { setFlat(r); onChanged(); }).catch(() => setFlat(null));
    // Deliberately keyed on provider.id alone: onChanged's identity changes
    // every render (it closes over ProviderModal's loadProvider), and
    // re-running this fetch on that alone would loop.
  }, [provider.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every write here can move the header's "N models on" count (present.ts's
  // enabledModelCount reads model_policy, which this route just changed), so
  // each one tells the modal to re-fetch the provider row too, not just this
  // tab's own flat list.
  const put = (ids: string[]) =>
    jsend<ProviderModelsResponseT>(`/api/providers/${provider.id}/models`, "PUT", { ids }).then((r) => { setFlat(r); onChanged(); });
  const toggle = (id: string, on: boolean) => {
    if (!flat) return;
    const ids = new Set(flat.models.filter((m) => m.on).map((m) => m.id));
    if (on) ids.add(id); else ids.delete(id);
    void put([...ids]);
  };
  const onAll = (on: boolean) => {
    if (!flat) return;
    void put(on ? flat.models.filter((m) => m.chat).map((m) => m.id) : []);
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await jsend<ProviderModelsResponseT>(`/api/providers/${provider.id}/models/refresh`, "POST");
      setFlat(r);
      onChanged();
    } finally {
      setRefreshing(false);
    }
  };

  if (!flat) return <LoadNote style={{ padding: 0 }}>Loading models…</LoadNote>;
  const chatModels: FlatProviderModelT[] = flat.models.filter((m) => m.chat);
  return (
    <ModelPolicyBlock
      models={chatModels.map((m) => ({ id: m.id, ctx: m.ctx, family: m.family, version: m.version, duplicate_of: m.duplicate_of, on: m.on }))}
      gateway={flat.mode === "allow"}
      onToggle={toggle}
      onAll={flat.mode === "allow" ? onAll : undefined}
      showFamily
      refreshedAt={flat.refreshed_at}
      onRefresh={refresh}
      refreshing={refreshing}
    />
  );
}

function BundledConnection({ provider, agents, appDefaults, setAppDefault }: {
  provider: PresentedProviderT; agents: AgentInfoT[];
  appDefaults: Record<string, string>; setAppDefault: (key: string, value: string | null) => void;
}) {
  const env = agents.find((a) => a.id === provider.bundled);
  const planUsage = usePlanUsage();
  const showToggle = !!(env && planUsage[env.id]?.available && planUsage[env.id].windows.length > 0);
  return (
    <div className="mv-ro">
      <div className="mv-rrow"><dt>Managed by</dt><dd>{env ? EnvMark[env.id]?.() : null} {env?.label ?? provider.bundled}</dd></div>
      <div className="mv-rrow">
        <dt>Account</dt>
        <dd>{env?.account?.email ?? "—"}{env?.account?.plan ? ` · ${env.account.plan}` : ""}</dd>
      </div>
      <div className="mv-rrow"><dt>Config</dt><dd className="ctx-mono">{provider.bundled ? CONFIG_DIR[provider.bundled] ?? "" : ""}</dd></div>
      <div className="mv-rrow">
        <dt>Serves</dt>
        <dd>
          <EnvDots served={provider.environments} /> <span className="opt">only {env?.label ?? provider.bundled}; bundled logins don&apos;t travel</span>
        </dd>
      </div>
      {showToggle && env && (
        <div className="mv-rrow">
          <dt>Titlebar usage</dt>
          <dd>
            <button
              role="switch" aria-label={`Show ${env.label}'s plan usage in the titlebar`} aria-checked={planUsageShown(appDefaults, env.id)}
              className={`in-switch${planUsageShown(appDefaults, env.id) ? " on" : ""}`}
              onClick={() => setAppDefault(`plan_usage:${env.id}`, planUsageShown(appDefaults, env.id) ? "off" : null)}
            ><span /></button>
          </dd>
        </div>
      )}
      <p className="mv-fine">
        There is nothing to edit here: the endpoint and credential belong to {env?.label ?? provider.bundled}. Sign out
        there, or from Environments, and this provider leaves with it.
      </p>
    </div>
  );
}

type DetailTab = "Connection" | "Models" | "Remove";

function ProviderDetail({ provider, agents, appDefaults, setAppDefault, tab, setTab, onClose, onChanged, onRemoved }: {
  provider: PresentedProviderT;
  agents: AgentInfoT[];
  appDefaults: Record<string, string>;
  setAppDefault: (key: string, value: string | null) => void;
  tab: DetailTab;
  setTab: (t: DetailTab) => void;
  onClose: () => void;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const isBundled = !!provider.bundled;
  const tabs: DetailTab[] = isBundled ? ["Connection", "Models"] : ["Connection", "Models", "Remove"];
  const typeLine = providerTypeLine(provider, agents);

  const [name, setName] = useState(provider.label);
  const [endpoint, setEndpoint] = useState(provider.config.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [apiShape, setApiShape] = useState<"anthropic" | "openai">(provider.config.api ?? "openai");
  const [testState, setTestState] = useState<"idle" | "busy" | "ok" | "bad">(
    provider.last_test?.reachable ? "ok" : provider.last_test ? "bad" : "idle",
  );
  const [testResult, setTestResult] = useState<ProviderProbeResultT | null>(normalizeTestResult(provider.last_test));
  const [testError, setTestError] = useState<string | null>(provider.last_test?.error ?? null);

  const meta = { type: provider.type, hasKey: provider.has_key !== undefined };

  const runTest = async () => {
    setTestState("busy");
    try {
      const body: Record<string, unknown> = {
        type: provider.type,
        config: { base_url: endpoint.trim(), ...(provider.type === "custom" ? { api: apiShape } : {}) },
      };
      if (meta.hasKey && apiKey.trim()) body.key = apiKey.trim();
      const r = await jsend<ProviderProbeResultT>("/api/providers/test", "POST", body);
      setTestResult(r);
      setTestState(r.reachable ? "ok" : "bad");
      setTestError(r.error);
    } catch (e) {
      setTestState("bad");
      setTestError(e instanceof Error ? e.message : String(e));
    }
  };

  const done = async () => {
    const body: Record<string, unknown> = {
      label: name.trim() || undefined,
      config: { base_url: endpoint.trim(), ...(provider.type === "custom" ? { api: apiShape } : {}) },
    };
    if (apiKey.trim()) body.key = apiKey.trim();
    try { await jsend(`/api/providers/${provider.id}`, "PATCH", body); onChanged(); } catch { /* the field values stay on screen either way */ }
    onClose();
  };

  return (
    <Modal
      width={720}
      onClose={onClose}
      header={
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flex: 1, minWidth: 0 }}>
          <span className="mv-bigmark">{ProviderMark[provider.type]?.()}</span>
          <div className="mv-ttl">
            <h2>{provider.label} <StatusChip status={provider.status} /></h2>
            <div className="mv-sub">{typeLine} · {provider.model_count} model{provider.model_count === 1 ? "" : "s"} on</div>
          </div>
        </div>
      }
      footer={
        tab === "Connection" && !isBundled ? (
          <><span className="hint">Changes save when you close.</span><span className="spacer" /><button className="btn btn-accent" onClick={done}>Done</button></>
        ) : (
          <><span className="spacer" /><button className="btn btn-line" onClick={onClose}>Close</button></>
        )
      }
    >
      <div className="mv-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`mv-tab${t === "Remove" ? " dng" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="mv-bd">
        {tab === "Connection" && (
          isBundled
            ? <BundledConnection provider={provider} agents={agents} appDefaults={appDefaults} setAppDefault={setAppDefault} />
            : (
              <ConnectionForm
                meta={meta} name={name} setName={setName} endpoint={endpoint} setEndpoint={setEndpoint}
                apiKey={apiKey} setApiKey={setApiKey} showKey={showKey} setShowKey={setShowKey}
                apiShape={apiShape} setApiShape={setApiShape}
                served={provider.environments} servesLabel={provider.environments.map((e) => envLabel(agents, e)).join(", ")}
                testState={testState} testResult={testResult} testError={testError} onTest={runTest}
                keyPlaceholder={provider.has_key ? "a key is set, type a new one to replace it" : undefined}
              />
            )
        )}
        {tab === "Models" && <ModelsTab provider={provider} onChanged={onChanged} />}
        {tab === "Remove" && !isBundled && <RemoveTab provider={provider} onRemoved={onRemoved} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Add mode: one page, type grid then Connection then Models-once-tested.
// ---------------------------------------------------------------------------
export function ProviderModal({ providerId, prefill, agents, appDefaults, setAppDefault, onClose, onChanged }: {
  /** null opens the add page; an id opens that row's detail modal directly. */
  providerId: string | null;
  /** Seeds the add page's type + endpoint from a detected local server. */
  prefill?: { type: ProviderType; base_url: string };
  agents: AgentInfoT[];
  appDefaults: Record<string, string>;
  setAppDefault: (key: string, value: string | null) => void;
  onClose: () => void;
  /** The providers list changed; ModelsSection should reload it. */
  onChanged: () => void;
}) {
  const [id, setId] = useState<string | null>(providerId);
  const [provider, setProvider] = useState<PresentedProviderT | null>(null);
  const [tab, setTab] = useState<DetailTab>("Connection");

  const loadProvider = (pid: string) => jget<{ provider: PresentedProviderT }>(`/api/providers/${pid}`).then((d) => setProvider(d.provider));
  useEffect(() => { if (id) void loadProvider(id); }, [id]);

  const [type, setType] = useState<ProviderType | null>(null);
  const meta = USER_TYPES.find((t) => t.type === type) ?? null;
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [apiShape, setApiShape] = useState<"anthropic" | "openai">("openai");
  const [testState, setTestState] = useState<"idle" | "busy" | "ok" | "bad">("idle");
  const [testResult, setTestResult] = useState<ProviderProbeResultT | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [onIds, setOnIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const pickType = (t: ProviderType, seedEndpoint?: string) => {
    const found = USER_TYPES.find((x) => x.type === t)!;
    setType(t);
    setName(found.label);
    setEndpoint(seedEndpoint ?? DEFAULT_ENDPOINT[t] ?? "");
    setApiKey("");
    setShowKey(false);
    setTestState("idle");
    setTestResult(null);
    setTestError(null);
    setOnIds(new Set());
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (prefill) pickType(prefill.type, prefill.base_url); }, []);

  const runTest = async () => {
    if (!type) return;
    setTestState("busy");
    setTestError(null);
    try {
      const body: Record<string, unknown> = {
        type,
        config: { base_url: endpoint.trim(), ...(type === "custom" ? { api: apiShape } : {}) },
      };
      if (meta?.hasKey && apiKey.trim()) body.key = apiKey.trim();
      const r = await jsend<ProviderProbeResultT>("/api/providers/test", "POST", body);
      setTestResult(r);
      if (r.reachable) {
        setTestState("ok");
        setOnIds(new Set(r.models.filter((m) => m.chat).map((m) => m.id)));
      } else {
        setTestState("bad");
        setTestError(r.error);
      }
    } catch (e) {
      setTestState("bad");
      setTestError(e instanceof Error ? e.message : String(e));
      setTestResult(null);
    }
  };

  const submit = async () => {
    if (!type || !meta || testState !== "ok" || !testResult) return;
    setSaving(true);
    setSaveError(null);
    try {
      const chatIds = (testResult.models ?? []).filter((m) => m.chat).map((m) => m.id);
      const policy: ModelPolicyT = meta.policyMode === "allow"
        ? { mode: "allow", ids: [...onIds], known: chatIds, unavailable: [] }
        : { mode: "deny", ids: chatIds.filter((mid) => !onIds.has(mid)), known: chatIds, unavailable: [] };
      const body: Record<string, unknown> = {
        type,
        label: name.trim() || undefined,
        config: { base_url: endpoint.trim(), ...(type === "custom" ? { api: apiShape } : {}) },
        model_policy: policy,
      };
      if (meta.hasKey && apiKey.trim()) body.key = apiKey.trim();
      const r = await jsend<{ provider: PresentedProviderT }>("/api/providers", "POST", body);
      onChanged();
      setProvider(r.provider);
      setTab("Connection");
      setId(r.provider.id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (id) {
    return provider
      ? (
        <ProviderDetail
          provider={provider} agents={agents} appDefaults={appDefaults} setAppDefault={setAppDefault}
          tab={tab} setTab={setTab} onClose={onClose}
          onChanged={() => { onChanged(); void loadProvider(id); }}
          onRemoved={() => { onChanged(); onClose(); }}
        />
      )
      : <Modal title="Provider" onClose={onClose}><LoadNote style={{ padding: 0 }}>Loading…</LoadNote></Modal>;
  }

  return (
    <Modal
      title="Add a model provider"
      onClose={onClose}
      width={720}
      footer={<>
        <span className="hint">
          {testState === "ok" && type ? `${onIds.size} models will show in the picker for ${TYPE_ENVS[type].map((e) => envLabel(agents, e)).join(", ")}.` : saveError}
        </span>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-accent" disabled={testState !== "ok" || saving} onClick={submit}>{saving ? "Adding…" : "Add provider"}</button>
      </>}
    >
      <div className="mv-types" role="radiogroup" aria-label="Provider type">
        {USER_TYPES.map((t) => (
          <button key={t.type} type="button" className={`mv-tc${type === t.type ? " on" : ""}`} role="radio"
            aria-checked={type === t.type} onClick={() => pickType(t.type)}>
            <span className="mv-t">{ProviderMark[t.type]?.()} {t.label}</span>
            <EnvDots served={TYPE_ENVS[t.type]} />
          </button>
        ))}
      </div>
      <p className="mv-fine">
        Claude Code, Codex and Antigravity logins aren&apos;t added here. Sign in under <strong>Environments</strong> and
        their models arrive on their own.
      </p>
      {type && meta && (
        <div className="mv-sect">
          <h3>Connection</h3>
          <ConnectionForm
            meta={meta} name={name} setName={setName} endpoint={endpoint} setEndpoint={setEndpoint}
            apiKey={apiKey} setApiKey={setApiKey} showKey={showKey} setShowKey={setShowKey}
            apiShape={apiShape} setApiShape={setApiShape}
            served={TYPE_ENVS[type]} servesLabel={TYPE_ENVS[type].map((e) => envLabel(agents, e)).join(", ")}
            testState={testState} testResult={testResult} testError={testError} onTest={runTest}
          />
        </div>
      )}
      {testState === "ok" && testResult && meta && (
        <div className="mv-sect">
          <h3>Models</h3>
          <ModelPolicyBlock
            models={(testResult.models ?? []).filter((m) => m.chat).map((m) => ({ id: m.id, ctx: m.context_window ?? 0, family: "", version: "", duplicate_of: null, on: onIds.has(m.id) }))}
            gateway={meta.policyMode === "allow"}
            onToggle={(mid, on) => setOnIds((prev) => {
              const next = new Set(prev);
              if (on) next.add(mid); else next.delete(mid);
              return next;
            })}
            onAll={(on) => setOnIds(on ? new Set((testResult.models ?? []).filter((m) => m.chat).map((m) => m.id)) : new Set())}
            showFamily={false}
          />
        </div>
      )}
    </Modal>
  );
}
