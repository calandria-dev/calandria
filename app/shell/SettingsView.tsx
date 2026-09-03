"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import {
  DEFAULT_SETTINGS, modelOptions, reasoningOptions, permissionOptions, INHERIT_LABEL, MONO_FONTS, PROMPT_FONTS,
  type Settings, type AgentsBundle, type Appearance, type Palette, type MonoFontId, type PromptFontId,
} from "./types";
import { capsFor, agentLabel } from "./agents";
import { ModelField } from "./Modal";
import { GitHubSettings } from "./github";
import { WorktreePrune } from "./WorktreePrune";
import { AgentConnect } from "./AgentConnect";
import { endpointSummary } from "./modelEndpoint";
import { ErrNote, LoadNote } from "./shared";
import { jget, jsend } from "./api";
import { notificationPermission, type BrowserNotificationState } from "./useNotifications";
import { disablePush, enablePush, pushSupport, syncPushSubscription, type PushSupportState } from "./usePush";
import { modelLabel, relTime } from "./format";
import type { PushDevice } from "@/lib/push/types";
import type { AgentInfoT, AgentsResponseT, EndpointStatusT, GatewayHealthT } from "./types";
import type { PermissionMatchKind, PermissionRule } from "@/lib/types";

// Account / session panel. Shows who's signed in to this instance and a Logout
// control — but only when an origin provider is actually gating the box (first-
// party control-plane session or Cloudflare Access). In open local dev there's
// no session to end, so the panel says so and hides the button. The redirect
// target is provider-specific and decided server-side (see /api/auth/logout).
function AccountSection() {
  const [state, setState] = useState<
    { provider: string; signedIn: boolean; email: string | null } | null
  >(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/whoami")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setState(d);
      })
      .catch(() => {
        if (!cancelled) setState({ provider: "none", signedIn: false, email: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function logout() {
    setBusy(true);
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      // Top-level navigation so the CF logout (or CP login) loads as a real page.
      window.location.href = data?.redirect || "/";
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <div className="lab">{Icon.lock()} Signed in</div>
      {state == null ? (
        <LoadNote style={{ padding: 0 }}>Checking your session…</LoadNote>
      ) : state.signedIn ? (
        <>
          <div className="hlp" style={{ marginTop: 0, marginBottom: 12 }}>
            {state.email ? <strong>{state.email}</strong> : "Signed in"}
          </div>
          <button
            className="btn btn-line"
            onClick={logout}
            disabled={busy}
            style={{ alignSelf: "flex-start" }}
          >
            {Icon.external()} {busy ? "Signing out…" : "Log out"}
          </button>
          <div className="hlp" style={{ marginTop: 10 }}>
            {state.provider === "cf-access"
              ? "Ends your Cloudflare Access session for this instance."
              : "Ends your session and returns you to the sign-in page."}
          </div>
        </>
      ) : (
        <div className="hlp" style={{ marginTop: 0 }}>
          This instance isn&apos;t behind a sign-in (local/open mode). There&apos;s no session to end.
        </div>
      )}
    </div>
  );
}

// The "Agents" section: connect coding agents beyond the required first-run
// Claude one. Claude appears here as already-connected; Codex (and any future
// agent) gets a "connect another agent" card driven by AgentConnect against the
// generic /api/agents/[id]/* routes. Reads the same GET /api/agents the task
// pickers gate on, so connecting here immediately un-grays the agent there.
function AgentsSection({ defaultAgent, onChanged }: { defaultAgent: string; onChanged?: () => void }) {
  const [agents, setAgents] = useState<AgentInfoT[] | null>(null);
  const [def, setDef] = useState<string>(defaultAgent);
  // Reachability of the instance's local model endpoint, which is NOT any
  // agent's connection state: a project on Ollama runs through a Claude login
  // it never uses, and fails with a perfectly good one when Ollama is down. The
  // server probes it (lib/modelEndpoint.ts); this is the only place the
  // instance-wide default endpoint is reported.
  const [endpoint, setEndpoint] = useState<EndpointStatusT | null>(null);
  // Same fact for the LiteLLM gateway, and null unless one is configured.
  const [gateway, setGateway] = useState<GatewayHealthT | null>(null);

  const load = () =>
    jget<AgentsResponseT>("/api/agents")
      .then((r) => { setAgents(r.agents); setDef(r.default); setEndpoint(r.local_endpoint ?? null); setGateway(r.gateway ?? null); })
      .catch(() => setAgents([]));
  useEffect(() => { load(); }, []);

  if (agents == null) return <LoadNote style={{ padding: 0 }}>Loading agents…</LoadNote>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div className="hlp" style={{ marginTop: 0 }}>
        Each task runs as a coding agent. Connect an agent&apos;s subscription login (or API key) once and it becomes selectable for new tasks. {def === "claude" ? "Claude is the default and runs the app's own jobs (summaries, recaps), so keep it connected." : ""}
      </div>
      {agents.map((a) => (
        <div key={a.id} className="field" style={{ marginBottom: 0 }}>
          <div className="lab" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {Icon.spark()} {a.label}
            {a.id === def && <span className="opt">(default)</span>}
            {a.authBroken
              // Its login died (still on record) or its record was dropped for a
              // provider change — either way a green check here would contradict
              // the card below it (and the titlebar banner).
              ? <span className="wiz-warn" style={{ marginLeft: "auto" }} title="Needs reconnecting">{Icon.bolt()}</span>
              : a.connected && <span className="wiz-ok" style={{ marginLeft: "auto" }}>{Icon.check()}</span>}
          </div>
          <McpInheritance agent={a} />
          <AgentConnect agent={a} compact onConnected={() => { load(); onChanged?.(); }} />
        </div>
      ))}
      {endpoint?.base_url && (
        <div className="field" style={{ marginBottom: 0 }}>
          <div className="lab" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {Icon.spark()} Local model endpoint
            {endpoint.reachable
              ? <span className="wiz-ok" style={{ marginLeft: "auto" }}>{Icon.check()}</span>
              : <span className="wiz-warn" style={{ marginLeft: "auto" }} title="Nothing answered at this address">{Icon.bolt()}</span>}
          </div>
          <div className="hlp">
            {endpointSummary(endpoint)}. A project runs here by setting its <strong>Model provider</strong> to
            {" "}<em>Local model</em>; the address is <code className="ctx-mono">CALANDRIA_LOCAL_MODEL_BASE_URL</code>.
          </div>
        </div>
      )}
      {gateway?.base_url && <GatewayCard gateway={gateway} onChanged={load} />}
    </div>
  );
}

// The LiteLLM gateway's own card, beside the local-endpoint one above and for
// the same reason: an agent's `connected` is its CLI login and says nothing
// about whether the gateway is up. Rendered only when CALANDRIA_LITELLM_BASE_URL
// is set, which is also what puts the Gateway preset in a project's settings.
//
// The three facts come from lib/gatewayHealth.ts. `database: false` is the
// no-Postgres 500 from /key/info, and it is stated rather than shown as blank
// rows: every key, budget and spend feature on a LiteLLM proxy needs that
// database, so a card that just omitted them would read like a bug.
function GatewayCard({ gateway, onChanged }: { gateway: GatewayHealthT; onChanged: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const where = gateway.base_url.replace(/^https?:\/\//, "");

  const save = async (clear: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      if (clear) await jsend("/api/settings/gateway-key", "DELETE");
      else await jsend("/api/settings/gateway-key", "POST", { key: key.trim() });
      setKey("");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <div className="lab" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {Icon.spark()} LiteLLM gateway
        {gateway.reachable
          ? <span className="wiz-ok" style={{ marginLeft: "auto" }}>{Icon.check()}</span>
          : <span className="wiz-warn" style={{ marginLeft: "auto" }} title="Nothing answered at this address">{Icon.bolt()}</span>}
      </div>
      <div className="hlp">
        {gateway.reachable
          ? `${where}: reachable${gateway.version ? `, LiteLLM ${gateway.version}` : ""}${gateway.model_count === null ? "" : `, ${gateway.model_count} ${gateway.model_count === 1 ? "model" : "models"}`}.`
          : `${where}: ${gateway.error || "not reachable"}.`}
        {" "}A project runs here by setting its <strong>Model provider</strong> to <em>Gateway</em>; the address is
        {" "}<code className="ctx-mono">CALANDRIA_LITELLM_BASE_URL</code>.
      </div>
      {gateway.database === false && (
        <div className="hlp">Keys, budgets and spend need LiteLLM&apos;s database. This proxy is running without one, so the card shows liveness, version and model count only.</div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input type="password" className="ctx-mono" style={{ flex: 1, minWidth: 0 }} value={key} autoComplete="off"
          placeholder={gateway.has_key ? "a key is set — type a new one to replace it" : "virtual key (sk-…)"}
          title="The instance's LiteLLM virtual key. Stored 0600 beside the database, never in a project row and never returned to the browser."
          onChange={(e) => setKey(e.target.value)} />
        <button className="btn btn-line" disabled={busy || !key.trim()} onClick={() => save(false)}>{Icon.check()} Save key</button>
        {gateway.has_key && <button className="btn btn-ghost" disabled={busy} onClick={() => save(true)}>{Icon.x()} Clear</button>}
      </div>
      {err && <div className="hlp wiz-warn">{Icon.bolt()} {err}</div>}
      <div className="hlp">
        Sent as <code className="ctx-mono">x-litellm-api-key</code> on every gateway turn, alongside tags naming the project, task and agent.
        {" "}<code className="ctx-mono">CALANDRIA_LITELLM_KEY</code> sets the same thing from the environment.
      </div>
    </div>
  );
}

// Whether a task on this agent can use the MCP servers the user configured for
// its own CLI — the one capability difference between the agents that changes
// what a task can DO, rather than how its controls look. A Claude task reaches
// the tools in ~/.claude; an otherwise-identical Codex task reaches only
// Calandria's, so it's worth knowing before choosing an agent for a task. Both
// the verdict and the explanation come from the driver's descriptor
// (lib/agents/types.ts AgentCapabilities), never from the agent's id: a third
// agent states its own position here with no edit to this file.
function McpInheritance({ agent }: { agent: AgentInfoT }) {
  const { inheritsUserMcpServers: inherits, userMcpServersNote: note } = agent.capabilities;
  return (
    <div className="hlp" style={{ marginTop: 2, marginBottom: 12 }}>
      <strong style={{ color: "var(--ink-2)" }}>
        {inherits ? "Uses your own MCP servers." : "Calandria's tools only."}
      </strong>
      {note ? ` ${note}` : ""}
    </div>
  );
}

// The EFFECTIVE utility agent, resolved connected-first by the server
// (lib/agents/oneshots.ts). The buttons above show what's *configured*; this
// line shows what will actually run — they diverge whenever the configured
// agent isn't connected, and silently picking a different agent would be a
// worse surprise than saying so. When nothing is connected at all, internal
// jobs can't run, so this says that instead of naming a stand-in.
function UtilityEffective({ agents }: { agents: AgentsBundle }) {
  const u = agents.utility;
  if (!u) return null;
  if (!u.id)
    return (
      <div className="hlp" style={{ marginTop: 8 }}>
        {Icon.bolt()} No agent is connected. Recaps and context refresh are paused. Connect one in Settings → Agents.
      </div>
    );
  const label = agentLabel(agents, u.id);
  return (
    <div className="hlp" style={{ marginTop: 8 }}>
      Running on <strong>{label}</strong>
      {u.fallback && <span className="opt"> (fallback: {agentLabel(agents, u.configured)} isn&apos;t connected)</span>}
    </div>
  );
}

// The "always allow" answers given to tool-permission prompts (lib/permissions.ts),
// with a revoke on each, plus a row to add one WITHOUT waiting for a prompt.
// A grant nobody can find is a grant nobody can take back, so this list is the
// other half of the "Always allow" button — without it, one click in a
// transcript is permanent and invisible. The add row is the other direction:
// "always allow" was the only way to mint a rule, so pre-approving `npm test`
// for a project cost you one prompt in one task first — and an auto-started
// unattended turn declines that prompt before anyone can answer it.
//
// The form can't grant more than the card can. It sends the command the user
// typed; the server runs it through the same prefix policy and answers with the
// rule it actually stored (`git push origin main` asked for by prefix comes
// back as `git push`), or with an error when no honest prefix exists.
function PermissionRules() {
  const [rules, setRules] = useState<(PermissionRule & { project_name: string })[] | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState("");
  const [command, setCommand] = useState("");
  const [kind, setKind] = useState<PermissionMatchKind>("bash_prefix");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const load = () => jget<{ rules: (PermissionRule & { project_name: string })[]; projects: { id: string; name: string }[] }>("/api/settings/permissions")
    .then((d) => {
      setRules(d.rules);
      setProjects(d.projects);
      setProjectId((cur) => (d.projects.some((p) => p.id === cur) ? cur : d.projects[0]?.id ?? ""));
    })
    .catch(() => setRules([]));
  useEffect(() => { void load(); }, []);

  const revoke = async (id: string) => {
    setRules((prev) => (prev ?? []).filter((r) => r.id !== id)); // optimistic
    try { await jsend("/api/settings/permissions", "DELETE", { id }); } catch { void load(); }
  };

  const add = async () => {
    if (busy || !projectId || !command.trim()) return;
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      const { rule } = await jsend<{ rule: PermissionRule & { project_name: string } }>(
        "/api/settings/permissions", "POST", { project_id: projectId, command, match_kind: kind }
      );
      // The stored rule, not the typed line — say so whenever they differ, so a
      // narrowed prefix isn't a silent surprise the next time it doesn't match.
      setAdded(rule.match_kind === "bash_prefix" ? `${rule.value} …` : rule.value);
      setCommand("");
      setRules((prev) => [rule, ...(prev ?? []).filter((r) => r.id !== rule.id)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <div className="lab">{Icon.check()} Remembered approvals</div>
      <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
        Commands allowed without a prompt: the ones you chose <strong>Always allow</strong> for on a permission
        card, plus any you add here. They apply to one project and skip the prompt entirely, so revoke anything you
        no longer want run unattended. A remembered command names a script, not a behaviour: <code>npm test</code>
        {" "}is whatever the project says it is today.
      </div>
      {projects.length > 0 && (
        <>
          <div className="perm-add">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} title="Which project this applies to">
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input
              type="text" className="ctx-mono" placeholder="npm test" spellCheck={false} value={command}
              onChange={(e) => { setCommand(e.target.value); setError(null); setAdded(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
            />
            <select
              value={kind} title="How much of the command line the rule covers"
              onChange={(e) => { setKind(e.target.value as PermissionMatchKind); setError(null); setAdded(null); }}
            >
              <option value="bash_prefix">and its arguments</option>
              <option value="bash_exact">exactly, nothing else</option>
            </select>
            <button className="btn btn-line btn-sm" onClick={() => void add()} disabled={busy || !command.trim()}>
              {Icon.check()} {busy ? "Adding…" : "Allow"}
            </button>
          </div>
          <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
            <strong>And its arguments</strong> remembers only the leading command and subcommand, exactly as the
            permission card would: <code>git push origin main</code> is stored as <code>git push …</code>, and a line
            the shell could reinterpret (pipes, <code>$(…)</code>, <code>&amp;&amp;</code>) or one led by a wrapper
            like <code>sudo</code> can&apos;t be generalized at all. <strong>Exactly</strong> matches that one literal
            line and nothing else.
          </div>
          {error && <ErrNote style={{ marginBottom: 10 }}>{error}</ErrNote>}
          {added && !error && <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>Remembered as <code>{added}</code>.</div>}
        </>
      )}
      {rules === null ? (
        <div className="hlp">Loading…</div>
      ) : rules.length === 0 ? (
        <div className="hlp">Nothing remembered yet.</div>
      ) : (
        <div className="perm-rules">
          {rules.map((r) => (
            <div className="perm-rule" key={r.id}>
              <code>{r.match_kind === "bash_prefix" ? `${r.value} …` : r.value}</code>
              <span className="opt">{r.project_name}</span>
              <button className="btn btn-sm" onClick={() => void revoke(r.id)} title="Stop allowing this">Revoke</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Browser notifications. The permission grant is per-DEVICE and owned by the
// browser, so it is read live from Notification.permission rather than stored;
// everything else is server-side policy the webhook channel will inherit.
// Copy here is written to make sense whether or not the user saw the
// onboarding nudge (Welcome.tsx) that already offers this same grant — it
// neither assumes this is their first time nor references that earlier step.
function NotificationSettings({ appDefaults, setAppDefault }: {
  appDefaults: Record<string, string>;
  setAppDefault: (key: string, value: string | null) => void;
}) {
  const [perm, setPerm] = useState<BrowserNotificationState>("unsupported");
  const [testState, setTestState] = useState<"idle" | "sending" | "sent" | "off" | "failed" | "error">("idle");
  useEffect(() => { setPerm(notificationPermission()); }, []);

  // Web Push: the device list is server state (every subscribed browser),
  // "this device" is whichever row this browser's own subscription maps to.
  const [push, setPush] = useState<PushSupportState>("unsupported");
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState<string | null>(null);
  const loadDevices = async () => {
    const r = await jget<{ subscriptions: PushDevice[] }>("/api/notifications/push");
    setDevices(r.subscriptions);
  };
  useEffect(() => {
    setPush(pushSupport());
    loadDevices().catch((e) => setPushErr(e instanceof Error ? e.message : String(e)));
    // The re-sync also answers "is this browser subscribed?" — it returns the
    // row the browser's subscription upserted into, or null.
    syncPushSubscription().then((d) => { setThisDevice(d?.id ?? null); if (d) void loadDevices(); }).catch(() => {});
  }, []);
  async function togglePush() {
    setPushBusy(true); setPushErr(null);
    try {
      if (thisDevice) { await disablePush(); setThisDevice(null); }
      else { const d = await enablePush(); setThisDevice(d.id); }
      setPerm(notificationPermission());
      await loadDevices();
    } catch (e) {
      setPushErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPushBusy(false);
    }
  }
  async function removeDevice(id: string) {
    setPushErr(null);
    try {
      if (id === thisDevice) await disablePush();
      else await jsend(`/api/notifications/push/${id}`, "DELETE");
      if (id === thisDevice) setThisDevice(null);
      await loadDevices();
    } catch (e) {
      setPushErr(e instanceof Error ? e.message : String(e));
    }
  }
  // `desktop_shell` mirrors the Browser/Desktop notifications block above: the
  // shell denies the page's notification permission on purpose and raises
  // native toasts itself, so the subscribe button is withheld rather than left
  // to fail with a "browser site settings" hint the shell has no page for. The
  // shell exposes no bridge (no preload, by design), so there is nothing to
  // open the OS notification pane with — the copy names it instead. The device
  // list below still shows, and still removes, the phones subscribed elsewhere.
  const pushHelp = push === "desktop_shell"
    ? "Native notifications are already on: the desktop app raises them itself through your OS, so this window doesn't subscribe to push — that would deliver every event twice. Manage them in your OS notification settings. Push is for phones and other browsers: open Settings there to subscribe one, and it appears in the list here."
    : push === "insecure"
    ? "Push needs a secure origin, like every notification does. Reach the instance over https or as localhost."
    : push === "needs_install"
      ? "On iPhone and iPad, push only works for an app on the Home Screen: Share → Add to Home Screen, open Calandria from there, and enable it here."
      : push === "unsupported"
        ? "This browser can't receive push notifications."
        : thisDevice
          ? "This device is subscribed. It hears every notification even with Calandria closed."
          : "Subscribe this device to hear about a task that stopped even when Calandria isn't open. The notification arrives through the OS, like any app's.";

  const on = appDefaults.notifications !== "off";
  const kinds: [string, string, string][] = [
    ["notify_awaiting_input", "A task is waiting for input", "An agent asked a question, needs a tool approved, or ended its turn with the work back in your hands. Either way the task has stopped until you pick it up."],
    ["notify_turn_failed", "A turn failed", "The session died: a dead login, a spent quota, a full context window, or a crash."],
    ["notify_schedule_failed", "A scheduled run failed", "A schedule fired and got nowhere. Nobody is watching at 08:30, so this is the one failure with no other witness."],
  ];

  async function sendTest() {
    setTestState("sending");
    try {
      // `ok: false` has two causes and they need different answers: the master
      // switch is off (nothing was attempted, and the fix is right above this
      // button), or the emitter tried and the publish threw. Reporting the
      // second as "switched off" sends the user to a switch that is already on.
      const r = await jsend<{ ok: boolean; enabled: boolean }>("/api/notifications/test", "POST");
      setTestState(r.ok ? "sent" : r.enabled ? "failed" : "off");
    } catch {
      setTestState("error");
    }
  }

  return (
    <>
      <div className="field">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ flex: 1 }}>
            <div className="lab">{Icon.bell()} Notify me when a task needs me</div>
            <div className="hlp" style={{ marginTop: 4 }}>
              Calandria tells you when a session stops and waits. Turn this off to silence every notification at once.
            </div>
          </div>
          <button
            role="switch"
            aria-label="Notify me when a task needs me"
            aria-checked={on}
            className={`in-switch${on ? " on" : ""}`}
            onClick={() => setAppDefault("notifications", on ? "off" : null)}
          ><span /></button>
        </div>
      </div>

      <div className="field">
        <div className="lab">{Icon.bolt()} {perm === "desktop_shell" ? "Desktop notifications" : "Browser notifications"}</div>
        <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
          {perm === "desktop_shell"
            // The page's own channel really is switched off in here, and saying
            // so plainly is the point: read straight off Notification.permission
            // this card used to report "blocked", sending the user hunting for a
            // browser site setting that doesn't exist in the shell — while OS
            // notifications were arriving the whole time from a channel the page
            // can't see. The desktop app raises them from outside the window, so
            // it keeps working with this window hidden to the tray.
            ? "The desktop app handles these itself, so the page's own channel is switched off — that's what stops every event arriving twice. Notifications come through your OS whether or not this window is in front, and clicking one opens the task."
            : perm === "insecure"
            ? "Browsers only allow notifications on a secure origin, and this page is plain http. No site setting can change that. Reach the instance over https (a reverse proxy or tunnel, see the self-hosting docs and PUBLIC_BASE_URL) or open it as localhost."
            : perm === "unsupported"
              ? "This browser can't show notifications."
              : perm === "granted"
                ? "This browser is allowed to show notifications. They appear only when you aren't already looking at the task."
                : perm === "denied"
                  ? "You've blocked notifications for this site. Calandria can't ask again. Unblock it in your browser's site settings for this address."
                  : "Allow notifications so Calandria can reach you when this tab isn't in front of you."}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {perm === "default" && (
            <button className="btn btn-line btn-sm" onClick={async () => setPerm(await Notification.requestPermission())}>
              {Icon.bell()} Enable browser notifications
            </button>
          )}
          {/* `desktop_shell` counts as a live channel here even though it isn't
              "granted": the test goes through the server the same way a real
              notification does, and the shell's main process raises it. */}
          <button className="btn btn-line btn-sm" onClick={sendTest} disabled={(perm !== "granted" && perm !== "desktop_shell" && !(devices && devices.length > 0)) || testState === "sending"}>
            {Icon.send()} {testState === "sending" ? "Sending…" : "Send test notification"}
          </button>
        </div>
        {testState === "sent" && <div className="hlp" style={{ marginTop: 8 }}>Sent: it went through the same path a real notification takes{devices && devices.length > 0 ? `, including the push to ${devices.length === 1 ? "the subscribed device" : `all ${devices.length} subscribed devices`}` : ""}.</div>}
        {testState === "off" && <div className="hlp" style={{ marginTop: 8 }}>Nothing sent: notifications are switched off above.</div>}
        {testState === "failed" && <div className="hlp" style={{ marginTop: 8 }}>Notifications are on, but the server couldn&apos;t publish it. Check the server log.</div>}
        {testState === "error" && <div className="hlp" style={{ marginTop: 8 }}>Couldn&apos;t reach the server to send it.</div>}
      </div>

      <div className="field">
        <div className="lab">{Icon.send()} Push notifications</div>
        <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>{pushHelp}</div>
        {push === "ready" && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-line btn-sm" onClick={() => void togglePush()} disabled={pushBusy}>
              {Icon.bell()} {pushBusy ? "Working…" : thisDevice ? "Stop push on this device" : "Enable push on this device"}
            </button>
          </div>
        )}
        {pushErr && <ErrNote>{pushErr}</ErrNote>}
        {devices && devices.length > 0 && (
          <div className="perm-rules" style={{ marginTop: 10 }}>
            {devices.map((d) => (
              <div className="perm-rule" key={d.id}>
                <code>{d.label || "Unnamed device"}{d.id === thisDevice ? " (this device)" : ""}</code>
                <span className="opt" title={d.last_error || undefined}>
                  {d.last_status === 0
                    ? `added ${relTime(d.created_at)}`
                    : d.last_status >= 200 && d.last_status < 300
                      ? `delivered ${relTime(d.last_sent_at)}`
                      : `failing (${d.last_status || "no reply"})`}
                  {d.service ? ` · ${d.service}` : ""}
                </span>
                <button className="btn btn-sm" onClick={() => void removeDevice(d.id)} title="Stop sending to this device">Remove</button>
              </div>
            ))}
          </div>
        )}
        {devices && devices.length === 0 && push !== "ready" && (
          <div className="hlp" style={{ marginTop: 8 }}>No device is subscribed yet. Open Settings on the phone (or any browser that supports push) to add it.</div>
        )}
      </div>

      <div className="field">
        <div className="lab">{Icon.list()} What to notify me about</div>
        <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
          Each of these means a task has STOPPED. Finished turns and new suggestions deliberately stay quiet.
        </div>
        {kinds.map(([key, label, help]) => {
          const kindOn = appDefaults[key] !== "off";
          return (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12, opacity: on ? 1 : 0.5 }}>
              <div style={{ flex: 1 }}>
                <div className="lab" style={{ marginBottom: 2 }}>{label}</div>
                <div className="hlp" style={{ marginTop: 0 }}>{help}</div>
              </div>
              <button
                role="switch"
                aria-label={label}
                aria-checked={kindOn}
                disabled={!on}
                className={`in-switch${kindOn ? " on" : ""}`}
                onClick={() => setAppDefault(key, kindOn ? "off" : null)}
              ><span /></button>
            </div>
          );
        })}
      </div>
    </>
  );
}

// Static preview colors for each palette's dark variant — the design-system
// values from docs/design/handoff/styles.css, hardcoded here since the swatch
// has to show every theme at once regardless of which one is currently active
// (CSS custom properties only expose the LIVE theme, not the other three).
const PALETTE_PREVIEW: { id: Palette; label: string; bg: string; accent: string; ink: string }[] = [
  { id: "cherenkov", label: "Cherenkov", bg: "#081217", accent: "#45cabb", ink: "#d5e4ea" },
  { id: "heavywater", label: "Heavy water", bg: "#0d1414", accent: "#dd7f68", ink: "#dce7e4" },
  { id: "denoche", label: "De noche", bg: "#100e18", accent: "#f0a94e", ink: "#e5e0ee" },
  { id: "basic", label: "Basic", bg: "#101114", accent: "#6c9bd8", ink: "#dde0e6" },
];
const MONO_SAMPLE = "const ok = a !== b ? 0 : 1;";
const PROMPT_SAMPLE = "Refactor the auth flow to use refresh tokens.";

// The "Appearance" section: theme cards, mode, and the code/prompt font pickers
// (docs/design/handoff/ui/Settings.html). Density + text-width stay in the
// AppearancePanel popover only — no home for them here yet, and duplicating a
// setter across two surfaces just invites drift.
function AppearanceSection({ appearance, setAppearance }: {
  appearance: Appearance;
  setAppearance: (k: keyof Appearance, v: string) => void;
}) {
  // Chromium (and kin) treat focus that arrives through a wrapping <label>
  // click as :focus-visible, so a mouse selection left the radio wearing a
  // keyboard focus ring. CSS can't tell those apart, so a REAL pointer click
  // (e.detail > 0; keyboard-synthesized clicks are 0) drops focus after the
  // change lands — keyboard focus and its row treatment stay untouched.
  const unfocusOnPointer = (e: React.MouseEvent<HTMLLabelElement>) => {
    if (e.detail > 0) e.currentTarget.querySelector("input")?.blur();
  };
  return (
    <>
      <div className="field">
        <div className="ap-h2">Theme</div>
        <div className="ap-themes">
          {PALETTE_PREVIEW.map((t) => {
            const active = appearance.palette === t.id;
            return (
              <button
                key={t.id} type="button" className={`ap-th${active ? " on" : ""}`}
                onClick={() => setAppearance("palette", t.id)}
              >
                <div className="ap-prev" style={{ background: t.bg }}>
                  <i style={{ background: t.accent, height: 22 }} />
                  <i style={{ background: t.ink, opacity: 0.5, height: 16 }} />
                  <i style={{ background: t.ink, opacity: 0.25, height: 12 }} />
                </div>
                <div className="ap-lbl"><b>{t.label}</b><span>{active ? "active" : ""}</span></div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="field">
        <div className="ap-h2">Mode</div>
        <div className="seg" style={{ maxWidth: 320 }}>
          <button className={appearance.mode === "system" ? "on" : ""} onClick={() => setAppearance("mode", "system")}>Auto</button>
          <button className={appearance.mode === "light" ? "on" : ""} onClick={() => setAppearance("mode", "light")}>{Icon.sun()} Light</button>
          <button className={appearance.mode === "dark" ? "on" : ""} onClick={() => setAppearance("mode", "dark")}>{Icon.moon()} Dark</button>
        </div>
        <div className="hlp">Each theme has a matched light variant; Calandria follows your OS setting unless pinned.</div>
      </div>

      <div className="ap-row2">
        <div className="field" style={{ marginBottom: 0 }}>
          <div className="ap-h2">Code &amp; terminal font</div>
          <div className="ap-faces">
            {(Object.keys(MONO_FONTS) as MonoFontId[]).map((id) => {
              const font = MONO_FONTS[id];
              const active = appearance.monoFont === id;
              return (
                <label key={id} className={`ap-face${active ? " on" : ""}`} onClick={unfocusOnPointer}>
                  <input type="radio" name="ap-mono" checked={active} onChange={() => setAppearance("monoFont", id)} />
                  <span className="ap-nm">{font.label}{id === "jetbrains-mono" && <small>default</small>}</span>
                  <span className="ap-sam" style={{ fontFamily: font.cssFamily }}>{MONO_SAMPLE}</span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <div className="ap-h2">Prompt input font</div>
          <div className="ap-faces">
            {(Object.keys(PROMPT_FONTS) as PromptFontId[]).map((id) => {
              const font = PROMPT_FONTS[id];
              const active = appearance.promptFont === id;
              return (
                <label key={id} className={`ap-face${active ? " on" : ""}`} onClick={unfocusOnPointer}>
                  <input type="radio" name="ap-prompt" checked={active} onChange={() => setAppearance("promptFont", id)} />
                  <span className="ap-nm">{font.label}{id === "source-sans" && <small>default</small>}</span>
                  <span className="ap-sam" style={{ fontFamily: font.cssFamily }}>{PROMPT_SAMPLE}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

// The settings surface is a two-pane view that replaces the work area: a category
// nav (left) + the active section's content (right). Sections are data-driven so
// growing settings is adding an entry here + a branch in renderSection — no layout
// work. Today there's one section; appearance/models/integrations slot in later.
const SETTINGS_SECTIONS: { id: string; label: string; icon: () => React.ReactNode }[] = [
  { id: "general", label: "General", icon: Icon.gear },
  { id: "appearance", label: "Appearance", icon: Icon.sliders },
  { id: "background", label: "Background jobs", icon: Icon.clock },
  { id: "notifications", label: "Notifications", icon: Icon.bell },
  { id: "run", label: "Run defaults", icon: Icon.spark },
  { id: "agents", label: "Agents", icon: Icon.bolt },
  { id: "storage", label: "Storage", icon: Icon.archive },
  { id: "github", label: "GitHub", icon: Icon.github },
  { id: "account", label: "Account", icon: Icon.lock },
  { id: "setup", label: "Setup", icon: Icon.bolt },
];

export function SettingsView({ settings, setSetting, appearance, setAppearance, appDefaults, setAppDefault, agents, onAgentsRefresh, onReset, onRerunSetup, onClose, initialSection }: {
  settings: Settings;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  appearance: Appearance;
  setAppearance: (k: keyof Appearance, v: string) => void;
  appDefaults: Record<string, string>;
  setAppDefault: (key: string, value: string | null) => void;
  agents: AgentsBundle;
  onAgentsRefresh?: () => void;
  onReset: () => void;
  onRerunSetup: () => void;
  onClose: () => void;
  initialSection?: string;
}) {
  const [section, setSection] = useState<string>(
    initialSection && SETTINGS_SECTIONS.some((s) => s.id === initialSection) ? initialSection : SETTINGS_SECTIONS[0].id
  );
  // Which agent's run defaults are being edited (defaults are per-agent, keyed
  // "default_reasoning:<agent>"). Falls back to the app default agent.
  const appDefaultAgent = appDefaults.default_agent || agents.default;
  const [editAgent, setEditAgent] = useState(appDefaultAgent);
  const caps = capsFor(agents, editAgent);
  // Agent-scoped default, with legacy un-suffixed keys as a fallback (mirrors the
  // driver's resolution) so pre-existing settings still show as selected.
  const reasoningVal = appDefaults[`default_reasoning:${editAgent}`] ?? appDefaults.default_reasoning ?? null;
  const permissionVal = appDefaults[`default_permission_mode:${editAgent}`] ?? appDefaults.default_permission_mode ?? null;
  // The model default has no legacy un-suffixed key to fall back to: it shipped
  // agent-scoped, and a model id names one provider's catalog anyway.
  const modelVal = appDefaults[`default_model:${editAgent}`] ?? null;
  // The internal one-shots, in the two tiers lib/agents/oneshots.ts routes them
  // by. Agent-scoped like the model default above, and for the same reason.
  const lightJobModel = appDefaults[`job_model_light:${editAgent}`] ?? null;
  const heavyJobModel = appDefaults[`job_model_heavy:${editAgent}`] ?? null;
  // What the agent being edited calls its never-asks mode — the labels are the
  // provider's own vocabulary (Claude: "bypassPermissions", Codex:
  // "workspace-write"), so the help copy resolves the name per agent instead of
  // hardcoding one.
  const bypassLabel = caps?.permissionModes.find((p) => p.value === "bypassPermissions")?.label ?? "bypassPermissions";
  // Every picker's head is the same word ("Inherit") everywhere, but what it
  // inherits differs by surface: a task inherits THESE defaults, and these
  // defaults inherit the driver's own. Only the sub says so.
  const inheritSub = `hand the choice to ${agentLabel(agents, editAgent)}'s own default`;
  const multiAgent = agents.agents.length > 1;
  const backgroundJobs = appDefaults.background_jobs !== "off";
  const recapMode = appDefaults.recap_mode === "on_open" || appDefaults.recap_mode === "off"
    ? appDefaults.recap_mode
    : "automatic";
  type JobUsage = { runs: number; cost_usd: number; models: string[] };
  const [jobUsage, setJobUsage] = useState<Record<string, JobUsage> | null>(null);
  useEffect(() => {
    if (section !== "background" || jobUsage !== null) return;
    jget<{ jobs: { job: string; runs: number; cost_usd: number; models: string[] }[] }>("/api/settings/background-jobs")
      .then((data) => setJobUsage(Object.fromEntries(data.jobs.map((j) => [j.job, { runs: j.runs, cost_usd: j.cost_usd, models: j.models }]))))
      .catch(() => setJobUsage({}));
  }, [jobUsage, section]);
  const recapUsage: JobUsage = jobUsage?.summarizeProjectRecap ?? { runs: 0, cost_usd: 0, models: [] };
  const utilityUsage = [jobUsage?.summarizeProjectRecap, jobUsage?.draftProjectContext]
    .filter((u): u is JobUsage => !!u)
    .reduce<JobUsage>(
      (sum, u) => ({
        runs: sum.runs + u.runs,
        cost_usd: sum.cost_usd + u.cost_usd,
        models: [...sum.models, ...u.models.filter((m) => !sum.models.includes(m))],
      }),
      { runs: 0, cost_usd: 0, models: [] },
    );
  // A recorded model id belongs to one agent's catalog, and the row doesn't say
  // which, so try every connected agent and fall back to the raw id.
  // modelLabel() falls back to the raw id, so "it returned something" is not a
  // hit — take the first agent whose catalog actually names the model.
  const labelModel = (m: string) =>
    agents.agents.map((a) => modelLabel(m, capsFor(agents, a.id))).find((l) => l && l !== m) || m;
  const usageLine = (label: string, usage = recapUsage) =>
    `${label} · ${usage.runs.toLocaleString()} ${usage.runs === 1 ? "run" : "runs"} · ~$${usage.cost_usd.toFixed(2)} in the last 30 days`
    + (usage.models.length ? ` · on ${usage.models.map(labelModel).join(", ")}` : "");
  // Any server-backed run default set (agent-scoped, legacy, or default_agent)
  // means we're off the built-in defaults.
  const hasRunDefault = Object.keys(appDefaults).some((k) => k.startsWith("default_") || k === "utility_agent");
  const hasBackgroundDefault = !backgroundJobs || recapMode !== "automatic";
  const hasNotifyDefault = ["notifications", "notify_awaiting_input", "notify_turn_failed", "notify_schedule_failed"]
    .some((k) => appDefaults[k] === "off");
  const isDefault = settings.clearThresholdPct === DEFAULT_SETTINGS.clearThresholdPct
    && settings.clearThresholdTokens === DEFAULT_SETTINGS.clearThresholdTokens
    && !hasRunDefault
    && !hasBackgroundDefault
    && !hasNotifyDefault;
  // Clamp on commit so a half-typed value never persists out of range.
  const clampPct = (n: number) => Math.min(100, Math.max(1, Math.round(n)));
  const clampTokens = (n: number) => Math.max(1000, Math.round(n));
  const active = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];
  // On a phone the nav is a horizontal rail (see globals.css), so a section
  // past the third one — or a deep link straight into `initialSection` — starts
  // scrolled off the right edge with no sign it's selected. Pull it back into
  // view. `nearest` on both axes makes this a no-op for the desktop sidebar,
  // where every entry already fits.
  const navRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>(".nav-item.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [section]);
  return (
    <>
      <div className="col settings-nav">
        <div className="settings-nav-h">Settings</div>
        <div className="settings-nav-list" ref={navRef}>
          {SETTINGS_SECTIONS.map((s) => (
            <button key={s.id} className={`nav-item${section === s.id ? " active" : ""}`} onClick={() => setSection(s.id)}>
              {s.icon()} {s.label}
            </button>
          ))}
        </div>
        <div className="settings-nav-foot">{section === "appearance" ? "theme, mode & fonts · saved on this browser" : section === "background" ? "agent utility work · saved to this workspace" : section === "notifications" ? "alerts · saved to this workspace" : section === "run" ? "run defaults · saved to this workspace" : section === "agents" ? "coding agent logins · stored in this workspace" : section === "storage" ? "disk cleanup · acts on this workspace" : section === "github" ? "GitHub connection · stored in this workspace" : section === "account" ? "your sign-in to this instance" : section === "setup" ? "first-run setup · stored in this workspace" : "app-level preferences · saved on this browser"}</div>
      </div>
      <div className="col col-session">
        <div className="settings-head">
          <div className="settings-title">{active.label}</div>
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={onReset} disabled={isDefault} title="Restore every setting to its default">{Icon.restore()} Reset to defaults</button>
          <button className="btn btn-line btn-sm" onClick={onClose}>{Icon.chevRight({ style: { transform: "rotate(180deg)" } })} Back to workspace</button>
        </div>
        <div className="scroll">
          <div className="settings-body">
            {section === "general" && (
              <div className="field">
                <div className="lab">{Icon.clear()} /clear recommendation threshold</div>
                <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                  When a session&apos;s context window crosses either limit, the app nudges you to run <code>/clear</code> to start fresh. Whichever is hit first wins.
                </div>
                <div style={{ display: "flex", gap: 14, maxWidth: 420 }}>
                  <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                    <div className="lab">Percent of window <span className="opt">(%)</span></div>
                    <input
                      type="number" min={1} max={100} value={settings.clearThresholdPct}
                      onChange={(e) => setSetting("clearThresholdPct", Number(e.target.value) || 0)}
                      onBlur={(e) => setSetting("clearThresholdPct", clampPct(Number(e.target.value) || DEFAULT_SETTINGS.clearThresholdPct))}
                    />
                  </div>
                  <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                    <div className="lab">Absolute tokens <span className="opt">(count)</span></div>
                    <input
                      type="number" min={1000} step={1000} value={settings.clearThresholdTokens}
                      onChange={(e) => setSetting("clearThresholdTokens", Number(e.target.value) || 0)}
                      onBlur={(e) => setSetting("clearThresholdTokens", clampTokens(Number(e.target.value) || DEFAULT_SETTINGS.clearThresholdTokens))}
                    />
                  </div>
                </div>
                <div className="hlp" style={{ marginTop: 8 }}>
                  Defaults: {DEFAULT_SETTINGS.clearThresholdPct}% or {DEFAULT_SETTINGS.clearThresholdTokens.toLocaleString()} tokens.
                </div>
              </div>
            )}
            {section === "appearance" && <AppearanceSection appearance={appearance} setAppearance={setAppearance} />}
            {section === "background" && (
              <>
                <div className="field">
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ flex: 1 }}>
                      <div className="lab">{Icon.bolt()} Let Calandria use your agent for background work</div>
                      <div className="hlp" style={{ marginTop: 4 }}>
                        Turn this off to stop unattended agent work. Things you explicitly ask for (such as <code>/clear</code>, Refresh with AI, or manually refreshing a recap) still run.
                      </div>
                    </div>
                    <button
                      role="switch"
                      aria-label="Let Calandria use your agent for background work"
                      aria-checked={backgroundJobs}
                      className={`in-switch${backgroundJobs ? " on" : ""}`}
                      onClick={() => setAppDefault("background_jobs", backgroundJobs ? "off" : null)}
                    ><span /></button>
                  </div>
                  <div className="hlp" style={{ marginTop: 10 }}>{jobUsage === null ? "Loading last-30-day usage…" : usageLine("Project recap activity")}</div>
                </div>

                <div className="field">
                  <div className="lab">{Icon.clock()} Project recaps</div>
                  <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                    Choose when Calandria writes a fresh “where you left off” recap. Manual refreshes remain available in every mode.
                  </div>
                  <div className="seg wrap" style={{ maxWidth: 620 }}>
                    {([
                      ["automatic", "Automatic"],
                      ["on_open", "Only when I open a project"],
                      ["off", "Off"],
                    ] as const).map(([value, label]) => (
                      <button key={value} className={recapMode === value ? "on" : ""} onClick={() => setAppDefault("recap_mode", value === "automatic" ? null : value)}>{label}</button>
                    ))}
                  </div>
                  <div className="hlp" style={{ marginTop: 10 }}>{jobUsage === null ? "Loading last-30-day usage…" : usageLine("Project recaps")}</div>
                </div>

                <div className="field">
                  <div className="lab">{Icon.spark()} Utility agent</div>
                  <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                    Put Calandria&apos;s utility work on a cheaper or second login, for example running recaps on Codex while keeping Claude quota for your main tasks.
                  </div>
                  <div className="seg wrap" style={{ maxWidth: 520 }}>
                    {agents.agents.map((a) => (
                      <button
                        key={a.id}
                        className={(appDefaults.utility_agent || agents.utility?.configured || appDefaultAgent) === a.id ? "on" : ""}
                        title={a.authenticated ? `Run utility jobs on ${a.label}` : `${a.label} isn't connected yet`}
                        onClick={() => setAppDefault("utility_agent", a.id)}
                      >
                        {a.label}{!a.authenticated && <span className="opt"> · not connected</span>}
                      </button>
                    ))}
                  </div>
                  <UtilityEffective agents={agents} />
                  <div className="hlp" style={{ marginTop: 8 }}>
                    Which MODEL these jobs run on is set per agent under <strong>Run defaults</strong>, split into quick jobs
                    (recaps, <strong>/clear</strong> notes) and repo-reading ones (<strong>Refresh with AI</strong>). Left alone, each
                    inherits the agent&apos;s own default.
                  </div>
                  <div className="hlp" style={{ marginTop: 10 }}>{jobUsage === null ? "Loading last-30-day usage…" : usageLine("Utility agent jobs", utilityUsage)}</div>
                </div>
              </>
            )}
            {section === "notifications" && <NotificationSettings appDefaults={appDefaults} setAppDefault={setAppDefault} />}
            {section === "run" && (
              <>
                {multiAgent && (
                  <div className="field">
                    <div className="lab">{Icon.bolt()} Default agent</div>
                    <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                      The agent new tasks use when a project hasn&apos;t set its own default. A task&apos;s agent is fixed once created.
                    </div>
                    <div className="seg wrap" style={{ maxWidth: 520 }}>
                      {agents.agents.map((a) => (
                        <button
                          key={a.id}
                          className={appDefaultAgent === a.id ? "on" : ""}
                          title={a.authenticated ? `Default new tasks to ${a.label}` : `${a.label} isn't connected yet`}
                          onClick={() => setAppDefault("default_agent", a.id)}
                        >
                          {a.label}{!a.authenticated && <span className="opt"> · not connected</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {multiAgent && (
                  <div className="field">
                    <div className="lab">Run defaults for</div>
                    <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                      Each agent carries its own model, reasoning &amp; permission defaults. Pick which to edit.
                    </div>
                    <div className="seg wrap" style={{ maxWidth: 520 }}>
                      {agents.agents.map((a) => (
                        <button key={a.id} className={editAgent === a.id ? "on" : ""} onClick={() => setEditAgent(a.id)}>{a.label}</button>
                      ))}
                    </div>
                  </div>
                )}
                <ModelField
                  label="Default model"
                  options={modelOptions(caps, inheritSub)}
                  value={modelVal}
                  onChange={(m) => setAppDefault(`default_model:${editAgent}`, m)}
                  note={
                    <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                      The model a task runs on when its own picker is set to <strong>{INHERIT_LABEL}</strong>. Per-task choices
                      always override this, and <strong>{INHERIT_LABEL}</strong> here hands the choice back to {agentLabel(agents, editAgent)}&apos;s own.
                    </div>
                  }
                />
                <ModelField
                  label="Quick internal jobs"
                  options={modelOptions(caps, inheritSub)}
                  value={lightJobModel}
                  onChange={(m) => setAppDefault(`job_model_light:${editAgent}`, m)}
                  note={
                    <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                      Calandria&apos;s own short jobs on {agentLabel(agents, editAgent)}: <strong>/clear</strong> handoff notes and
                      project recaps. Both are one turn of text in, text out with no tools, so a small model is usually the right call.
                    </div>
                  }
                />
                <ModelField
                  label="Repo-reading internal jobs"
                  options={modelOptions(caps, inheritSub)}
                  value={heavyJobModel}
                  onChange={(m) => setAppDefault(`job_model_heavy:${editAgent}`, m)}
                  note={
                    <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                      The <strong>Refresh with AI</strong> project-context draft and the <strong>Refresh tag</strong> plan check, which
                      both explore the repository read-only before deciding something durable — context prepended to every new session,
                      or which of a tag&apos;s tasks have gone stale. Both read an unfamiliar codebase, so accuracy pays here.
                    </div>
                  }
                />
                <div className="field">
                  <div className="lab">{Icon.spark()} Default reasoning level</div>
                  <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                    The thinking level a task uses when its own picker is set to <strong>{INHERIT_LABEL}</strong>. Per-task choices always override this.
                  </div>
                  <div className="seg wrap" style={{ maxWidth: 520 }}>
                    {reasoningOptions(caps, inheritSub).map((r) => (
                      <Fragment key={r.label}>
                        <button
                          className={reasoningVal === r.value ? "on" : ""}
                          title={r.sub}
                          onClick={() => setAppDefault(`default_reasoning:${editAgent}`, r.value)}
                        >
                          {r.label}
                        </button>
                        {r.value === null && <span className="seg-sep" aria-hidden />}
                      </Fragment>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <div className="lab">{Icon.lock()} Default permission mode</div>
                  <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
                    How tasks run when their own picker is set to <strong>{INHERIT_LABEL}</strong>. Every mode except <strong>{bypassLabel}</strong>
                    {" "}parks the turn on a permission card for anything it won&rsquo;t auto-approve, including while you&rsquo;re
                    away, where an unanswered card declines itself. Pick <strong>{bypassLabel}</strong> for work that must never stop to ask.
                  </div>
                  <div className="seg wrap" style={{ maxWidth: 520 }}>
                    {permissionOptions(caps, inheritSub).map((p) => (
                      <Fragment key={p.label}>
                        <button
                          className={permissionVal === p.value ? "on" : ""}
                          title={p.sub}
                          onClick={() => setAppDefault(`default_permission_mode:${editAgent}`, p.value)}
                        >
                          {p.label}
                        </button>
                        {/* Rule after the inherit head — Claude's own list has a
                            mode spelled "default" right below it. */}
                        {p.value === null && <span className="seg-sep" aria-hidden />}
                      </Fragment>
                    ))}
                  </div>
                </div>
                <PermissionRules />
              </>
            )}
            {section === "agents" && <AgentsSection defaultAgent="claude" onChanged={onAgentsRefresh} />}
            {section === "storage" && <WorktreePrune />}
            {section === "github" && <GitHubSettings />}
            {section === "account" && <AccountSection />}
            {section === "setup" && (
              <div className="field">
                <div className="lab">{Icon.bolt()} First-run setup</div>
                <div className="hlp" style={{ marginTop: 0, marginBottom: 12 }}>
                  Re-run the guided setup to reconnect Claude, switch between your subscription and an API key, or add another project. Your existing projects and sessions are untouched.
                </div>
                <button className="btn btn-line" onClick={onRerunSetup} style={{ alignSelf: "flex-start" }}>
                  {Icon.restore()} Re-run setup wizard
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
