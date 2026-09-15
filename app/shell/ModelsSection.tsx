"use client";

import { useEffect, useState } from "react";
import { EnvMark, ProviderMark } from "../icons";
import { jget, jsend } from "./api";
import { Modal } from "./Modal";
import { AgentConnect } from "./AgentConnect";
import { LoadNote } from "./shared";
import { ProviderModal, EnvDots, StatusChip, providerTypeLine, envLabel } from "./ProviderModal";
import { invalidateModelPickerData } from "./ModelPicker";
import type { AgentInfoT, AgentsResponseT, PresentedProviderT, DetectedProviderT, ProviderType } from "./types";

function envStatusChip(status: "connected" | "installed" | "absent") {
  const cls = status === "connected" ? "ok" : status === "installed" ? "warn" : "mute";
  const label = status === "connected" ? "Connected" : status === "installed" ? "Installed, not signed in" : "Not installed";
  return <span className={`mv-chip ${cls}`}>{label}</span>;
}

// The binaries lib/agents/detect.ts looks for. Not served by GET /api/agents
// (only installed/installedVersion are), so this restates the small fixed
// table for the "installed, not signed in" and "not installed" subtitles.
const BINARY_NAME: Record<string, string> = { claude: "claude", codex: "codex", gemini: "agy" };

function envSubtitle(a: AgentInfoT): string {
  if (a.status === "connected") {
    const who = a.account?.email ? `Signed in as ${a.account.email}` : "Signed in";
    return a.account?.plan ? `${who} · ${a.account.plan}` : who;
  }
  const bin = BINARY_NAME[a.id] ?? a.id;
  if (a.status === "installed") {
    return `${bin}${a.installedVersion ? ` ${a.installedVersion}` : ""} · sign in to use its models`;
  }
  return `${bin} not found on this machine`;
}

function EnvironmentRow({ agent, onSignIn, onDisconnect }: { agent: AgentInfoT; onSignIn: () => void; onDisconnect: () => void }) {
  const connected = agent.status === "connected";
  const bundled = connected ? agent.providers.find((p) => p.type === agent.bundledProvider) : undefined;
  return (
    <div className={`mv-row${connected ? "" : " dimmed"}`}>
      <span className="mv-mark">{EnvMark[agent.id]?.()}</span>
      <div className="mv-id">
        <div className="mv-nm"><span>{agent.label}</span>{envStatusChip(agent.status)}</div>
        <div className="mv-ty">{envSubtitle(agent)}</div>
        {bundled && (
          <div className="mv-bund">
            {ProviderMark[bundled.type]?.()} Brings <strong>{bundled.label}</strong> models · listed under Providers
          </div>
        )}
      </div>
      <div className="mv-acts">
        {agent.status === "connected" && <button className="btn btn-sm" onClick={onDisconnect}>Disconnect</button>}
        {agent.status === "installed" && <button className="btn btn-sm btn-accent" onClick={onSignIn}>Sign in</button>}
        {agent.status === "absent" && <button className="btn btn-sm" disabled title="No binary was found on this machine">Install first</button>}
      </div>
    </div>
  );
}

function ProviderRow({ provider, agents, onOpen }: { provider: PresentedProviderT; agents: AgentInfoT[]; onOpen: () => void }) {
  const connectedEnvs = new Set(agents.filter((a) => a.status === "connected").map((a) => a.id));
  return (
    <button type="button" className="mv-row link" onClick={onOpen} aria-label={`${provider.label} details`}>
      <span className="mv-mark">{ProviderMark[provider.type]?.()}</span>
      <div className="mv-id">
        <div className="mv-nm"><span>{provider.label}</span><StatusChip status={provider.status} /></div>
        <div className="mv-ty">{providerTypeLine(provider, agents)}</div>
      </div>
      <EnvDots served={provider.environments} active={(e) => provider.environments.includes(e) && connectedEnvs.has(e)} />
      <span className="mv-count">{provider.model_count} model{provider.model_count === 1 ? "" : "s"}</span>
      <span className="mv-go">{"›"}</span>
    </button>
  );
}

function DetectedRow({ server, agents, onDismiss, onAdd }: {
  server: DetectedProviderT; agents: AgentInfoT[]; onDismiss: () => void; onAdd: () => void;
}) {
  const label = server.type === "ollama" ? "Ollama" : "LM Studio";
  const envs = server.type === "ollama" || server.type === "lmstudio" ? ["claude", "codex"] : [];
  const worksWith = envs.map((e) => envLabel(agents, e)).join(" and ");
  return (
    <div className="mv-detect">
      <span className="mv-mark">{ProviderMark[server.type]?.()}</span>
      <div className="mv-id">
        <div className="mv-nm"><span>{label} is running at <span className="ctx-mono">{server.base_url.replace(/^https?:\/\//, "")}</span></span></div>
        <div className="mv-ty">{server.model_count} model{server.model_count === 1 ? "" : "s"} found{worksWith ? ` · works with ${worksWith}` : ""}</div>
      </div>
      <div className="mv-acts">
        <button className="btn btn-sm" onClick={onDismiss}>Not now</button>
        <button className="btn btn-sm btn-accent" onClick={onAdd}>Add as provider</button>
      </div>
    </div>
  );
}

// Settings → Models: the coding CLIs (Environments) a task can run in, and
// every place models come from (Providers), including the ones an
// environment brought in by signing in. Replaces the old Settings → Agents
// section (AgentsSection): the local-endpoint status line and the LiteLLM gateway
// health card are gone, folded into a provider row and its detail modal.
export function ModelsSection({ appDefaults, setAppDefault, onChanged }: {
  appDefaults: Record<string, string>;
  setAppDefault: (key: string, value: string | null) => void;
  /** Tells the shell-level agents bundle (titlebar, task pickers) to refetch too. */
  onChanged?: () => void;
}) {
  const [agents, setAgents] = useState<AgentInfoT[] | null>(null);
  const [providers, setProviders] = useState<PresentedProviderT[] | null>(null);
  const [detected, setDetected] = useState<DetectedProviderT[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [signIn, setSignIn] = useState<AgentInfoT | null>(null);
  const [modal, setModal] = useState<{ providerId: string | null; prefill?: { type: ProviderType; base_url: string } } | null>(null);

  const loadAgents = () => jget<AgentsResponseT>("/api/agents").then((r) => setAgents(r.agents)).catch(() => setAgents([]));
  const loadProviders = () => jget<{ providers: PresentedProviderT[] }>("/api/providers").then((r) => setProviders(r.providers)).catch(() => setProviders([]));
  const loadDetected = () => jget<{ servers: DetectedProviderT[] }>("/api/providers/detect").then((r) => setDetected(r.servers)).catch(() => setDetected([]));

  const reload = () => { void loadAgents(); void loadProviders(); void loadDetected(); };
  const changed = () => {
    invalidateModelPickerData();
    reload();
    onChanged?.();
  };
  useEffect(() => { reload(); }, []);
  // The environments/providers lists keep their own fetch of GET /api/agents
  // (the shared AgentsBundle SettingsView already has drops the fields
  // AgentConnect needs), so a shell-level agent_auth refresh can't reach them
  // through props. useGlobalEvents.ts relays the same event as a window
  // CustomEvent for exactly this: a leaf settings surface with its own state.
  // useGlobalEvents invalidates the shared picker cache before relaying it.
  useEffect(() => {
    const onAuth = () => reload();
    window.addEventListener("calandria:agent_auth", onAuth);
    return () => window.removeEventListener("calandria:agent_auth", onAuth);
  }, []);

  if (agents == null || providers == null) return <LoadNote style={{ padding: 0 }}>Loading models…</LoadNote>;

  const disconnect = async (agent: AgentInfoT) => {
    await jsend(`/api/agents/${agent.id}/api-key`, "DELETE").catch(() => {});
    changed();
  };

  const dismiss = (type: string) => setDismissed((prev) => new Set(prev).add(type));
  const addDetected = async (server: DetectedProviderT) => {
    const r = await jsend<{ provider: PresentedProviderT }>("/api/providers", "POST", { type: server.type, config: { base_url: server.base_url } });
    changed();
    setModal({ providerId: r.provider.id });
  };

  return (
    <>
      <p className="mv-lede">
        <strong>Environments</strong> are the coding CLIs a task can run in; signing in to one brings its own models
        along. <strong>Providers</strong> are every place models come from, including the ones an environment
        brought. Calandria works out which providers each environment can use.
      </p>

      <div className="mv-sec">
        <div className="mv-sec-h"><h2>Environments</h2></div>
        <div className="mv-list">
          {agents.map((a) => (
            <EnvironmentRow key={a.id} agent={a} onSignIn={() => setSignIn(a)} onDisconnect={() => void disconnect(a)} />
          ))}
        </div>
      </div>

      <div className="mv-sec">
        <div className="mv-sec-h">
          <h2>Providers</h2>
          <span className="st"><button className="btn btn-sm btn-accent" onClick={() => setModal({ providerId: null })}>Add provider</button></span>
        </div>
        <div className="mv-list">
          {providers.map((p) => (
            <ProviderRow key={p.id} provider={p} agents={agents} onOpen={() => setModal({ providerId: p.id })} />
          ))}
        </div>
        {detected.filter((s) => !dismissed.has(s.type)).length > 0 && (
          <div className="mv-list" style={{ marginTop: 8 }}>
            {detected.filter((s) => !dismissed.has(s.type)).map((s) => (
              <DetectedRow key={s.type} server={s} agents={agents} onDismiss={() => dismiss(s.type)} onAdd={() => void addDetected(s)} />
            ))}
          </div>
        )}
      </div>

      {signIn && (
        <Modal title={`Connect ${signIn.label}`} sub="Sign in with your subscription login (no API key needed)." onClose={() => setSignIn(null)} width={520}>
          <AgentConnect agent={signIn} onConnected={() => { setSignIn(null); changed(); }} />
        </Modal>
      )}

      {modal && (
        <ProviderModal
          providerId={modal.providerId}
          prefill={modal.prefill}
          agents={agents}
          appDefaults={appDefaults}
          setAppDefault={setAppDefault}
          onClose={() => setModal(null)}
          onChanged={changed}
        />
      )}
    </>
  );
}
