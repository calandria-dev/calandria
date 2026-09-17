"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { jsend } from "./api";
import { LoadNote } from "./shared";
import type { ServiceInfo, ServiceLogLine, ServiceEvent, ServiceStatus, ServiceVisibility } from "@/lib/types";

const LOG_CAP = 1500;

const STATUS_LABEL: Record<ServiceStatus, string> = {
  stopped: "Stopped", starting: "Starting…", running: "Running", exited: "Exited", errored: "Error",
};

type ServiceAction = "start" | "stop" | "restart" | "visibility";

// Status dot class: green running, amber starting, red errored, grey otherwise.
function dotClass(s: ServiceStatus): string {
  if (s === "running") return "g";
  if (s === "starting") return "a";
  if (s === "errored") return "r";
  return "x";
}

// A service is live (stop/restart rather than start) while starting or running.
function isLive(s: ServiceInfo): boolean {
  return s.status === "running" || s.status === "starting";
}

function statusText(s: ServiceInfo): string {
  return `${STATUS_LABEL[s.status]}${s.exitCode != null && s.status !== "running" ? ` (${s.exitCode})` : ""}`;
}

/**
 * The services data layer, shared by the desktop drawer and the phone pane:
 * the live SSE stream (status + logs) and the action POST. The processes live
 * in the server (lib/services.ts), so each connect re-snapshots and a tab
 * reload costs nothing.
 *
 * Selection is not held here. The drawer shows a list beside a log pane and
 * wants a service selected from the first snapshot; the phone pane shows the
 * list first and opens a log only when one is tapped.
 */
function useServiceStream(projectId: string) {
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [logs, setLogs] = useState<Record<string, ServiceLogLine[]>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/projects/${projectId}/services/stream`);
    es.onmessage = (e) => {
      let ev: ServiceEvent;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type === "snapshot") {
        setServices(ev.services);
        setLogs(ev.logs);
      } else if (ev.type === "status") {
        setServices((prev) => {
          const i = prev.findIndex((s) => s.name === ev.service.name);
          if (i === -1) return [...prev, ev.service];
          const next = prev.slice();
          next[i] = ev.service;
          return next;
        });
      } else if (ev.type === "log") {
        setLogs((prev) => {
          const cur = prev[ev.name] ?? [];
          const next = cur.length >= LOG_CAP ? [...cur.slice(cur.length - LOG_CAP + 1), ev.line] : [...cur, ev.line];
          return { ...prev, [ev.name]: next };
        });
      } else if (ev.type === "removed") {
        setServices((prev) => prev.filter((s) => s.name !== ev.name));
      }
    };
    return () => es.close();
  }, [projectId]);

  const act = useCallback(async (name: string, action: ServiceAction, value?: ServiceVisibility) => {
    setErr(null);
    try {
      await jsend(`/api/projects/${projectId}/services`, "POST", { name, action, value });
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      try { const j = JSON.parse(msg); if (j?.error) msg = j.error; } catch { /* raw */ }
      setErr(msg);
    }
  }, [projectId]);

  return { services, logs, err, act };
}

// Copy the link worth handing out: the tokened share link when shared, else the
// plain URL. Returns null when there is nothing to copy.
function useCopyUrl(url: string | null) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked */ }
  };
  return { copied, copy };
}

// A managed service is busy (no controls) only while starting; everything else is
// actionable. An exposed (unmanaged) entry has no process to control.
function ServiceRow({
  svc, selected, onSelect, onAction, onVisibility,
}: {
  svc: ServiceInfo;
  selected: boolean;
  onSelect: () => void;
  onAction: (action: "start" | "stop" | "restart") => void;
  onVisibility: (value: ServiceVisibility) => void;
}) {
  const live = isLive(svc);
  // The link worth handing out: the tokened share link when shared, else the URL.
  const copyUrl = svc.shareUrl ?? svc.url;
  const { copied, copy } = useCopyUrl(copyUrl);
  // Visibility only matters once the service has a public identity (a slug is
  // assigned at first start/expose; until then there is no URL to gate).
  const showShare = !!svc.slug;
  return (
    <button className={`svc-row${selected ? " on" : ""}`} onClick={onSelect}>
      <span className={`svc-dot ${dotClass(svc.status)}`} />
      <span className="svc-name">{svc.name}</span>
      <span className="svc-status" title={svc.error ?? undefined}>{statusText(svc)}</span>
      <span style={{ flex: 1 }} />
      {showShare && (
        <select
          className="svc-vis"
          value={svc.visibility}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onVisibility(e.target.value as ServiceVisibility)}
          title="Who can open this service's URL"
        >
          <option value="private">Private</option>
          <option value="shared">Link</option>
          <option value="public">Public</option>
        </select>
      )}
      {copyUrl && live && (
        <span className="icon-btn" role="button" tabIndex={0} title={copied ? "Copied" : `Copy ${copyUrl}`} onClick={copy}>
          {copied ? Icon.check() : Icon.copy()}
        </span>
      )}
      {svc.url && live && (
        <a className="svc-url" href={svc.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={`Open ${svc.url}`}>
          :{svc.port}
        </a>
      )}
      {svc.managed && (
        <span className="svc-actions" onClick={(e) => e.stopPropagation()}>
          {live ? (
            <>
              <span className="icon-btn" role="button" tabIndex={0} title="Restart" onClick={() => onAction("restart")}>{Icon.clear()}</span>
              <span className="icon-btn" role="button" tabIndex={0} title="Stop" onClick={() => onAction("stop")}>{Icon.stop()}</span>
            </>
          ) : (
            <span className="icon-btn" role="button" tabIndex={0} title="Start" onClick={() => onAction("start")}>{Icon.play()}</span>
          )}
        </span>
      )}
    </button>
  );
}

function LogView({ lines }: { lines: ServiceLogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Auto-scroll to the tail unless the user has scrolled up to read history.
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return (
    <div className="svc-logs" ref={ref} onScroll={onScroll}>
      {lines.length === 0 ? (
        <div className="svc-logs-empty">No output yet.</div>
      ) : (
        lines.map((l, i) => (
          <div key={i} className={`svc-log-line ${l.stream}`}>{l.text || " "}</div>
        ))
      )}
    </div>
  );
}

function NoServices({ hasConfig, className }: { hasConfig: boolean; className?: string }) {
  if (hasConfig) return <LoadNote style={{ padding: "14px 10px" }}>Loading services…</LoadNote>;
  return (
    <div className={className ?? "svc-empty"}>
      No services configured. Add a dev, setup or test command to the project context.
    </div>
  );
}

// Bottom drawer mirroring the terminal drawer: live status + controls + logs for a
// project's managed services, fed by the services SSE stream so it survives a tab
// reload (the processes live in the server, lib/services.ts).
export function ServicesDrawer({
  projectId, hasConfig, visible, height, onClose, onResize,
}: {
  projectId: string;
  hasConfig: boolean;
  visible: boolean;
  height: number;
  onClose: () => void;
  onResize: (h: number) => void;
}) {
  const dragging = useRef(false);
  const { services, logs, err, act } = useServiceStream(projectId);
  const [picked, setPicked] = useState<string | null>(null);

  // Resize handle (drag the top edge). Mouse-only, and this drawer is mounted
  // on desktop only, where that is the pointer: the phone gets ServicesPane.
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      const h = window.innerHeight - e.clientY;
      onResize(Math.max(140, Math.min(h, Math.round(window.innerHeight * 0.78))));
    };
    const up = () => { dragging.current = false; document.body.style.userSelect = ""; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [onResize]);

  // The log pane always has something in it: the user's pick, else the first
  // service the stream reported.
  const selected = picked ?? services[0]?.name ?? null;
  const current = selected ? logs[selected] ?? [] : [];
  // Supervisor-level failure (port conflict, spawn failure) for the selected
  // service, shown as a banner over the logs instead of buried in them.
  const selectedError = selected ? services.find((s) => s.name === selected)?.error ?? null : null;

  return (
    <div className={`term-drawer svc-drawer${visible ? "" : " collapsed"}`} style={visible ? { height } : undefined}>
      <div className="term-resize" onMouseDown={() => { dragging.current = true; document.body.style.userSelect = "none"; }} />
      <div className="term-bar">
        {Icon.sliders()}
        <span className="term-title">Services</span>
        {err && <span className="svc-err">⚠ {err}</span>}
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Hide services (processes keep running)">{Icon.chevDown()}</button>
      </div>
      <div className="svc-body">
        <div className="svc-list">
          {services.length === 0 ? (
            <NoServices hasConfig={hasConfig} />
          ) : (
            services.map((s) => (
              <ServiceRow
                key={s.name}
                svc={s}
                selected={selected === s.name}
                onSelect={() => setPicked(s.name)}
                onAction={(a) => { setPicked(s.name); act(s.name, a); }}
                onVisibility={(v) => { setPicked(s.name); act(s.name, "visibility", v); }}
              />
            ))
          )}
        </div>
        <div className="svc-log-pane">
          {selectedError && <div className="svc-banner">⚠ {selectedError}</div>}
          <LogView lines={current} />
        </div>
      </div>
    </div>
  );
}

// One service on a phone: a full-width tappable card. The status line and the
// command wrap onto their own rows instead of competing for a 390px strip, and
// the primary control (Start, or Stop while live) sits on the card so the
// common action costs no drill-down. Tapping anywhere else opens the log.
function MobileServiceRow({ svc, onOpen, onAction }: {
  svc: ServiceInfo;
  onOpen: () => void;
  onAction: (action: "start" | "stop") => void;
}) {
  const live = isLive(svc);
  return (
    <button className="msvc-row" onClick={onOpen}>
      <span className="msvc-row-top">
        <span className={`svc-dot ${dotClass(svc.status)}`} />
        <span className="msvc-name">{svc.name}</span>
        <span className="msvc-status">{statusText(svc)}</span>
        <span style={{ flex: 1 }} />
        {svc.managed && (
          <span
            className="msvc-act" role="button" tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onAction(live ? "stop" : "start"); }}
          >
            {live ? Icon.stop() : Icon.play()}
            {live ? "Stop" : "Start"}
          </span>
        )}
      </span>
      <span className="msvc-cmd">{svc.command || (svc.url ?? "exposed by an agent")}</span>
      {svc.error && <span className="msvc-err">⚠ {svc.error}</span>}
    </button>
  );
}

// One service's log, full pane, with its controls in the header. This is the
// second level of the phone's Services tab; Back returns to the list.
function MobileServiceDetail({ svc, lines, onBack, onAction, onVisibility }: {
  svc: ServiceInfo;
  lines: ServiceLogLine[];
  onBack: () => void;
  onAction: (action: "start" | "stop" | "restart") => void;
  onVisibility: (value: ServiceVisibility) => void;
}) {
  const live = isLive(svc);
  const copyUrl = svc.shareUrl ?? svc.url;
  const { copied, copy } = useCopyUrl(copyUrl);
  return (
    <>
      <div className="msvc-bar">
        <button className="mobile-back" onClick={onBack} title="Back to services" aria-label="Back to services">
          {Icon.chevRight({ style: { transform: "rotate(180deg)" } })}
        </button>
        <span className={`svc-dot ${dotClass(svc.status)}`} />
        <span className="msvc-title">{svc.name}</span>
        <span className="msvc-status">{statusText(svc)}</span>
      </div>
      {svc.managed && (
        <div className="msvc-controls">
          {live ? (
            <>
              <button className="btn btn-line btn-sm" onClick={() => onAction("stop")}>{Icon.stop()} Stop</button>
              <button className="btn btn-line btn-sm" onClick={() => onAction("restart")}>{Icon.clear()} Restart</button>
            </>
          ) : (
            <button className="btn btn-accent btn-sm" onClick={() => onAction("start")}>{Icon.play()} Start</button>
          )}
          <span style={{ flex: 1 }} />
          {copyUrl && live && (
            <button className="btn btn-line btn-sm" onClick={copy} title={`Copy ${copyUrl}`}>
              {copied ? Icon.check() : Icon.copy()} {copied ? "Copied" : "Copy link"}
            </button>
          )}
          {svc.url && live && (
            <a className="btn btn-line btn-sm" href={svc.url} target="_blank" rel="noopener noreferrer" title={`Open ${svc.url}`}>
              {Icon.external()} :{svc.port}
            </a>
          )}
        </div>
      )}
      {/* Visibility only matters once the service has a public identity (a slug
          is assigned at first start/expose; until then there is no URL to gate). */}
      {svc.slug && (
        <label className="msvc-vis">
          Who can open this URL
          <select value={svc.visibility} onChange={(e) => onVisibility(e.target.value as ServiceVisibility)}>
            <option value="private">Private</option>
            <option value="shared">Link</option>
            <option value="public">Public</option>
          </select>
        </label>
      )}
      {svc.error && <div className="svc-banner">⚠ {svc.error}</div>}
      <LogView lines={lines} />
    </>
  );
}

/**
 * Managed services on a phone: the Services tab's full pane, the counterpart to
 * the desktop bottom drawer. Same stream and same routes; a different shape,
 * because the drawer is a pixel-height bottom sheet with a mouse-drag resize
 * handle and a list sitting beside its log pane, none of which survives 390px.
 *
 * Two levels: the service list, then one service's log. The list is the tab's
 * root, so it has no Back of its own; the tab bar below it is the way out.
 */
export function ServicesPane({ projectId, projectName, hasConfig }: {
  projectId: string;
  projectName: string;
  hasConfig: boolean;
}) {
  const { services, logs, err, act } = useServiceStream(projectId);
  const [open, setOpen] = useState<string | null>(null);
  // Re-read the open service from the stream each render, so its status and
  // controls stay live. A service removed underneath us drops back to the list.
  const svc = open ? services.find((s) => s.name === open) ?? null : null;

  return (
    <div className="col col-services">
      {err && <div className="svc-banner">⚠ {err}</div>}
      {svc ? (
        <MobileServiceDetail
          svc={svc}
          lines={logs[svc.name] ?? []}
          onBack={() => setOpen(null)}
          onAction={(a) => act(svc.name, a)}
          onVisibility={(v) => act(svc.name, "visibility", v)}
        />
      ) : (
        <>
          <div className="msvc-bar">
            {Icon.sliders()}
            <span className="msvc-title">Services</span>
            <span className="msvc-sub">{projectName}</span>
          </div>
          <div className="msvc-list">
            {services.length === 0 ? (
              <NoServices hasConfig={hasConfig} className="msvc-empty" />
            ) : (
              services.map((s) => (
                <MobileServiceRow
                  key={s.name}
                  svc={s}
                  onOpen={() => setOpen(s.name)}
                  onAction={(a) => act(s.name, a)}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
