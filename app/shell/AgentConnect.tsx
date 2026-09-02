"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { jget, jsend } from "./api";
import { Modal } from "./Modal";
import { AUTH_BANNER_HINT } from "@/lib/authFailure";
import type { AgentInfo, AgentInfoT, AgentsResponseT, AgentLoginT, ClaudeVerifyT } from "./types";

const NUDGE_DISMISSED = "calandria_agent_nudge_dismissed";
const LEGACY_NUDGE_DISMISSED = "orch_agent_nudge_dismissed";

// The instance-wide "your agent login died" strip, under the titlebar.
//
// An expired OAuth session is per-INSTANCE (one login per agent, shared by every
// task), but it only shows up as a failed turn inside whichever task ran first —
// so without this you'd have to open that task to learn that nothing can run.
// The flag is server-persisted (lib/agents/connections.ts) and broadcast on
// GET /api/events, so this appears in every tab within a moment of the failure
// and disappears the instant a turn succeeds again. Deliberately not
// dismissible: no session can run until it's fixed.
export function AgentAuthBanner({ broken, onReconnect }: { broken: AgentInfo[]; onReconnect: () => void }) {
  if (broken.length === 0) return null;
  const names = broken.map((a) => a.label).join(" & ");
  // One agent: show what the provider actually said, so "expired session" isn't
  // confused with "revoked key" or a network blip. Several: keep it to the names.
  const detail = broken.length === 1 ? broken[0].authBroken?.reason : null;
  // Flagged while still connected on record means the login died in flight.
  // Flagged with NO record means the record was dropped on purpose — the CLI's
  // provider changed under a verified login (lib/agents/connections.ts) — and
  // "expired" would send the user chasing the wrong fix.
  const expired = broken.every((a) => a.authenticated);
  return (
    <div className="auth-banner" role="alert">
      <span className="ab-ic">{Icon.bolt()}</span>
      <span className="ab-msg">
        <b>{names} {broken.length === 1 ? "has" : "have"} stopped working. {expired ? "The sign-in expired." : "The connection no longer applies."}</b> {AUTH_BANNER_HINT}
        {detail && <span className="ab-why" title={detail}>{detail}</span>}
      </span>
      <span className="ab-spacer" />
      <button className="btn btn-sm btn-accent" onClick={onReconnect}>
        Reconnect {broken.length === 1 ? broken[0].label : "agents"}
      </button>
    </div>
  );
}

// Post-setup nudge: once the wizard's one required connection is done, gently
// suggest connecting the agents that are still unconnected (any of Codex,
// Antigravity, Claude) so tasks can run on them too.
// Optional and dismissible (once, via localStorage) — the wizard never requires
// a second agent. Renders nothing until it confirms there's an unconnected agent
// to offer, so it never flashes for a single-agent instance.
export function AgentNudge({ ready, onConnect }: { ready: boolean; onConnect: () => void }) {
  const [pending, setPending] = useState<AgentInfoT[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!ready) return;
    try { if (localStorage.getItem(NUDGE_DISMISSED) === "1" || localStorage.getItem(LEGACY_NUDGE_DISMISSED) === "1") return; } catch {}
    jget<AgentsResponseT>("/api/agents")
      .then((r) => {
        const unconnected = r.agents.filter((a) => !a.connected);
        if (unconnected.length) { setPending(unconnected); setOpen(true); }
      })
      .catch(() => {});
  }, [ready]);

  if (!open || !pending || pending.length === 0) return null;
  const names = pending.map((a) => a.label).join(" & ");
  const close = () => { setOpen(false); try { localStorage.setItem(NUDGE_DISMISSED, "1"); } catch {} };

  return (
    <Modal
      title="Add another agent"
      sub="Run tasks on more than one coding agent (entirely optional)."
      onClose={close}
      width={480}
      footer={<>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={close}>Not now</button>
        <button className="btn btn-accent" onClick={() => { close(); onConnect(); }}>
          {Icon.bolt()} Connect {pending.length === 1 ? pending[0].label : "an agent"}
        </button>
      </>}
    >
      <p style={{ margin: 0, color: "var(--ink-2)", lineHeight: 1.55 }}>
        Connect {names} with your subscription login (no API key needed) to also pick{" "}
        {pending.length > 1 ? "them" : "it"} for a task. You can always do this later from{" "}
        <strong>Settings → Agents</strong>.
      </p>
    </Modal>
  );
}

// Generic "connect an agent" card, driven entirely by the agent-scoped auth
// routes (/api/agents/[id]/{login,login/code,verify,api-key}) and the driver's
// capabilities from GET /api/agents. One component serves every agent — Claude's
// paste-a-code OAuth, Codex's device-code flow and Antigravity's Google login
// all fit. Where the third one didn't fit it was made to fit with DATA rather
// than a branch on an agent id: `loginCompletesOutOfBand` (this login can land
// without the code box, so watch authStatus too) and `connectHint` (the one
// caveat the generic prose can't carry — Antigravity's is that a container has
// no keyring for its token). Used by the Settings "Agents" section and the
// post-setup "connect another agent" nudge. (The first-run wizard keeps its own
// Claude-specific step so it can drive the onboarding funnel.)
export function AgentConnect({
  agent,
  onConnected,
  compact,
}: {
  agent: AgentInfoT;
  onConnected?: () => void;
  compact?: boolean;
}) {
  const canApiKey = !!agent.capabilities.apiKeyHint;
  const [mode, setMode] = useState<"subscription" | "api_key">(agent.account?.method === "api_key" ? "api_key" : "subscription");
  const [reconnect, setReconnect] = useState(false);

  // Connected on record, but its credentials died in flight (lib/authFailure.ts).
  // Never show the green "is connected" state here: the banner sends people to
  // this card to FIX it, so lead with what broke and put the login one click away.
  if (agent.connected && agent.authBroken && !reconnect) {
    return (
      <div className="wiz-connected broken">
        <span className="wiz-warn">{Icon.bolt()}</span>
        <div>
          <div className="wiz-ok-t">
            {agent.label}&apos;s sign-in stopped working
            {agent.account?.email ? <> for <strong>{agent.account.email}</strong></> : ""}
          </div>
          <div className="hlp" style={{ margin: "3px 0 0" }}>{agent.authBroken.reason}</div>
          <button className="btn btn-accent btn-sm" style={{ marginTop: 9 }} onClick={() => setReconnect(true)}>
            {Icon.bolt()} Sign in again
          </button>
        </div>
      </div>
    );
  }

  // Already connected from a prior run — show the state + a reconnect affordance.
  if (agent.connected && !reconnect) {
    return (
      <div className="wiz-connected">
        <span className="wiz-ok">{Icon.check()}</span>
        <div>
          <div className="wiz-ok-t">
            {agent.label} is connected
            {agent.account?.email ? <> as <strong>{agent.account.email}</strong></> : ""}
            {agent.account?.plan ? ` (${agent.account.plan})` : ""}
          </div>
          <div className="hlp" style={{ margin: "3px 0 0" }}>
            <button className="linkbtn" onClick={() => setReconnect(true)}>Reconnect a different account</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* No record, but flagged: the record was dropped because the CLI's
          provider changed under it (lib/agents/connections.ts). Lead with
          why, so the fresh sign-in below reads as the fix and not a regression. */}
      {!agent.connected && agent.authBroken && (
        <div className="wiz-connected broken" style={{ marginBottom: 14 }}>
          <span className="wiz-warn">{Icon.bolt()}</span>
          <div>
            <div className="wiz-ok-t">{agent.label} needs to be connected again</div>
            <div className="hlp" style={{ margin: "3px 0 0" }}>{agent.authBroken.reason}</div>
          </div>
        </div>
      )}
      {canApiKey && (
        <div className="seg" style={{ maxWidth: 460, marginBottom: 16 }}>
          <button className={mode === "subscription" ? "on" : ""} onClick={() => setMode("subscription")}>
            {Icon.bolt()} Sign in
          </button>
          <button className={mode === "api_key" ? "on" : ""} onClick={() => setMode("api_key")}>
            {Icon.lock()} I have an API key
          </button>
        </div>
      )}
      {mode === "subscription" ? (
        <SubscriptionConnect agent={agent} compact={compact} onConnected={onConnected} />
      ) : (
        <ApiKeyConnect agent={agent} onConnected={onConnected} />
      )}
    </div>
  );
}

// ---------- subscription (device / paste-code) login ----------

function SubscriptionConnect({ agent, onConnected, compact }: { agent: AgentInfoT; onConnected?: () => void; compact?: boolean }) {
  const [login, setLogin] = useState<AgentLoginT | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const fired = useRef(false);
  const pasteStyle = agent.capabilities.loginStyle === "paste_code";
  const base = `/api/agents/${agent.id}/login`;

  // Rejoin a login already underway (card re-mounted / page reload).
  useEffect(() => {
    jget<AgentLoginT | null>(base)
      .then((l) => { if (l && l.status !== "idle") setLogin(l); })
      .catch(() => {});
  }, [base]);

  const succeed = useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    // Prove it end-to-end before declaring victory (updates the connection record).
    jsend<ClaudeVerifyT>(`/api/agents/${agent.id}/verify`, "POST").catch(() => {}).finally(() => onConnected?.());
  }, [agent.id, onConnected]);

  // Escape hatch for a CLI that's already authenticated on this machine (login
  // done outside the app, restored home dir): skip the OAuth dance and just run
  // the verify test turn, which writes the connection record on success.
  const verifyExisting = async () => {
    setVerifying(true);
    setVerifyErr(null);
    try {
      const r = await jsend<ClaudeVerifyT>(`/api/agents/${agent.id}/verify`, "POST");
      if (r.connected) {
        fired.current = true; // verify already ran — succeed() would run it again
        onConnected?.();
      } else {
        setVerifyErr(r.error ?? `no working ${agent.label} sign-in found on this machine`);
      }
    } catch (e) {
      setVerifyErr((e instanceof Error ? e.message : String(e)).replace(/^\d+\s*/, ""));
    } finally {
      setVerifying(false);
    }
  };

  const start = async () => {
    setBusy(true);
    setCode("");
    fired.current = false;
    setVerifyErr(null);
    try {
      const l = await jsend<AgentLoginT>(base, "POST");
      setLogin(l);
      if (l.status === "success") succeed();
    } catch (e) {
      setLogin({ status: "error", url: null, email: null, plan: null, log: "", error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  // Poll while the CLI waits for the user to authorize / exchange the code.
  useEffect(() => {
    if (!login || (login.status !== "starting" && login.status !== "awaiting" && login.status !== "submitting")) return;
    const t = setInterval(() => {
      jget<AgentLoginT>(base).then((l) => {
        setLogin(l);
        if (l.status === "success") succeed();
      }).catch(() => {});
    }, 1800);
    return () => clearInterval(t);
  }, [login, base, succeed]);

  // Some logins can finish WITHOUT the code box ever being used: Antigravity's
  // OAuth redirect lands on Google's own callback page, which completes the
  // exchange for the CLI waiting on it, so a user who closes the tab without
  // copying anything is nonetheless signed in. The login session can't see
  // that (nothing is written to the pty), so ask the driver's authStatus —
  // its authoritative "is this CLI signed in" probe — alongside the poll
  // above. Opt-in per driver (capabilities.loginCompletesOutOfBand) because it
  // costs a real CLI probe each time, and pointless for a flow where the code
  // IS the exchange.
  //
  // Keyed on the login's STATUS, never on the login object: the poll above
  // replaces that object every 1.8s, so an effect depending on it would clear
  // and re-arm this interval before it could ever fire.
  const phase = login?.status ?? "idle";
  useEffect(() => {
    if (!agent.capabilities.loginCompletesOutOfBand) return;
    if (phase !== "awaiting" && phase !== "submitting") return;
    let stopped = false;
    // One probe at a time: the answer is a CLI call of unknown latency, and a
    // queue of them would outlive the login they were asked about.
    let inflight = false;
    const t = setInterval(() => {
      if (inflight) return;
      inflight = true;
      jget<{ authenticated?: boolean; email?: string | null; plan?: string | null }>(`/api/agents/${agent.id}/status`)
        .finally(() => { inflight = false; })
        .then((s) => {
          if (stopped || !s?.authenticated) return;
          stopped = true;
          clearInterval(t);
          // Signed in, so nothing further is wanted from the pty the login is
          // holding open on the CLI's onboarding screens.
          jsend(base, "DELETE").catch(() => {});
          setLogin((p) => ({ ...(p as AgentLoginT), status: "success", email: s.email ?? null, plan: s.plan ?? null }));
          succeed();
        })
        .catch(() => {});
    }, 3000);
    return () => { stopped = true; clearInterval(t); };
  }, [agent.capabilities.loginCompletesOutOfBand, agent.id, phase, base, succeed]);

  const submitCode = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const l = await jsend<AgentLoginT>(`${base}/code`, "POST", { code: code.trim() });
      setLogin(l);
      if (l.status === "success") succeed();
    } catch (e) {
      setLogin((p) => ({ ...(p as AgentLoginT), status: "error", error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  if (login?.status === "success") {
    return (
      <div className="wiz-connected">
        <span className="wiz-ok">{Icon.check()}</span>
        <div className="wiz-ok-t">Signed in{login.email ? <> as <strong>{login.email}</strong></> : ""}{login.plan ? ` (${login.plan})` : ""}</div>
      </div>
    );
  }

  if (login?.status === "error") {
    return (
      <div className="field" style={{ maxWidth: 560 }}>
        <div className="hlp" style={{ marginTop: 0, color: "var(--red)" }}>⚠ {login.error ?? "sign-in failed"}</div>
        <button className="btn btn-line" onClick={start} disabled={busy} style={{ alignSelf: "flex-start" }}>{Icon.restore()} Try again</button>
        <LogToggle log={login.log} show={showLog} setShow={setShowLog} />
      </div>
    );
  }

  if (login && (login.status === "awaiting" || login.status === "submitting")) {
    return (
      <div className="wiz-codecard">
        <div className="hlp" style={{ marginTop: 0 }}>1. Open this link and sign in to your {agent.label} account:</div>
        <div style={{ display: "flex", gap: 10, margin: "10px 0 16px", flexWrap: "wrap" }}>
          <a className="btn btn-accent" href={login.url ?? undefined} target="_blank" rel="noreferrer">{Icon.bolt()} Open sign-in page</a>
          <button className="btn btn-line" onClick={() => login.url && navigator.clipboard?.writeText(login.url)}>Copy link</button>
        </div>
        {pasteStyle ? (
          <>
            <div className="hlp" style={{ marginTop: 0 }}>2. Paste the code it shows here:</div>
            <div style={{ display: "flex", gap: 8, marginTop: 8, maxWidth: 460 }}>
              <input
                type="text" className="ctx-mono" autoFocus value={code} placeholder="paste authorization code"
                style={{ flex: 1, minWidth: 0 }}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitCode(); }}
              />
              <button className="btn btn-accent" disabled={busy || !code.trim()} onClick={submitCode}>
                {login.status === "submitting" || busy ? "Verifying…" : "Submit"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="hlp" style={{ marginTop: 0 }}>
              2. When prompted, enter this one-time code{login.code ? "" : " (shown on the sign-in page)"}:
            </div>
            {login.code && <div className="ctx-mono" style={{ fontSize: 20, letterSpacing: 2, margin: "8px 0 2px", fontWeight: 600 }}>{login.code}</div>}
            <div className="wiz-verify" style={{ marginTop: 10 }}><span className="wiz-spin" /> <span>Waiting for you to authorize in the browser…</span></div>
          </>
        )}
        {/* Always reachable from here, not only from the error card. A login
            can stall in this state with nothing to click: the authorization
            link expires on the provider's clock (Antigravity's is 60s and not
            configurable), and the code the user is holding is bound to THIS
            child's PKCE verifier, so the only recovery is a fresh child and a
            fresh URL — which is exactly what this does. */}
        <div className="hlp" style={{ marginTop: 14 }}>
          Link expired, or the code refused?{" "}
          <button className="linkbtn" onClick={start} disabled={busy}>Start again</button>
        </div>
        {agent.capabilities.connectHint && (
          <div className="hlp" style={{ marginTop: 6 }}>{agent.capabilities.connectHint}</div>
        )}
        <LogToggle log={login.log} show={showLog} setShow={setShowLog} />
      </div>
    );
  }

  if (login?.status === "starting") {
    return <div className="wiz-verify"><span className="wiz-spin" /> <span>Starting sign-in… preparing your authorization link.</span></div>;
  }

  // idle — initial CTA
  return (
    <div className="field" style={{ maxWidth: 560 }}>
      {!compact && (
        <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
          You&apos;ll get a sign-in link to open in any browser. This stores your login in this workspace and survives restarts. You only do it once.
        </div>
      )}
      <button className="btn btn-accent" disabled={busy || verifying} onClick={start} style={{ alignSelf: "flex-start" }}>
        {Icon.bolt()} {busy ? "Starting…" : `Connect ${agent.label} account`}
      </button>
      {verifying ? (
        <div className="wiz-verify" style={{ marginTop: 10 }}>
          <span className="wiz-spin" /> <span>Checking your existing sign-in: running a quick test turn…</span>
        </div>
      ) : (
        <div className="hlp" style={{ marginTop: 10 }}>
          Already signed in to {agent.label} on this machine?{" "}
          <button className="linkbtn" onClick={verifyExisting}>Verify connection</button>
        </div>
      )}
      {verifyErr && !verifying && (
        <div className="hlp" style={{ color: "var(--red)", marginTop: 6 }}>⚠ {verifyErr}</div>
      )}
      {/* The one caveat the generic prose above can't carry, supplied by the
          driver's capability descriptor rather than branched on here — the
          card stays agent-agnostic (lib/agents/types.ts connectHint). */}
      {agent.capabilities.connectHint && (
        <div className="hlp" style={{ marginTop: 10 }}>{agent.capabilities.connectHint}</div>
      )}
    </div>
  );
}

function LogToggle({ log, show, setShow }: { log: string; show: boolean; setShow: (b: boolean) => void }) {
  if (!log) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <button className="linkbtn" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"} terminal output</button>
      {show && <pre className="wiz-termlog">{log}</pre>}
    </div>
  );
}

// ---------- API-key path ----------

function ApiKeyConnect({ agent, onConnected }: { agent: AgentInfoT; onConnected?: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hint = agent.capabilities.apiKeyHint ?? "sk-…";

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await jsend(`/api/agents/${agent.id}/api-key`, "POST", { key: key.trim() });
      setSaved(true);
      onConnected?.();
    } catch (e) {
      setErr((e instanceof Error ? e.message : String(e)).replace(/^\d+\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  if (saved && !key) {
    return (
      <div className="wiz-connected">
        <span className="wiz-ok">{Icon.check()}</span>
        <div>
          <div className="wiz-ok-t">API key saved</div>
          <div className="hlp" style={{ margin: "3px 0 0" }}>Billed per-token. <button className="linkbtn" onClick={() => setSaved(false)}>Replace key</button></div>
        </div>
      </div>
    );
  }

  return (
    <div className="field" style={{ maxWidth: 560 }}>
      <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
        Paste an API key (<code>{hint}</code>). Stored in this workspace only and used to bill {agent.label} usage per-token. Most people should use the subscription sign-in instead.
      </div>
      <div style={{ display: "flex", gap: 8, maxWidth: 520 }}>
        <input type="password" className="ctx-mono" value={key} placeholder={hint} style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) save(); }} />
        <button className="btn btn-accent" disabled={busy || !key.trim()} onClick={save}>{busy ? "Saving…" : "Save key"}</button>
      </div>
      {err && <div className="hlp" style={{ color: "var(--red)", marginTop: 8 }}>⚠ {err}</div>}
    </div>
  );
}
