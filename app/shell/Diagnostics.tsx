"use client";

import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { LIFECYCLE_CHANGED, formatLifecycleLog, type LifecycleEvent } from "./lifecycle";
import { clearLifecycleLog, readLifecycleLog } from "./useLifecycleDiagnostics";
import type { Settings } from "./types";

const RELOAD_CHOICES: { label: string; minutes: number }[] = [
  { label: "Off", minutes: 0 },
  { label: "5 min", minutes: 5 },
  { label: "30 min", minutes: 30 },
  { label: "2 h", minutes: 120 },
];

function when(t: number): string {
  return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function detail(e: LifecycleEvent): string {
  const parts: string[] = [];
  if (e.gapMs !== undefined) parts.push(`${(e.gapMs / 1000).toFixed(0)}s late`);
  if (e.monoMs !== undefined) parts.push(`clock advanced ${(e.monoMs / 1000).toFixed(0)}s`);
  if (e.hiddenMs !== undefined) parts.push(`hidden ${(e.hiddenMs / 60000).toFixed(0)} min`);
  if (e.persisted !== undefined) parts.push(e.persisted ? "from back/forward cache" : "fresh");
  if (e.standalone !== undefined) parts.push(e.standalone ? "installed app" : "browser tab");
  if (e.ios !== undefined && e.ios) parts.push("iOS");
  if (e.online === false) parts.push("offline");
  if (e.heapMB !== undefined) parts.push(`${e.heapMB} MB heap`);
  return parts.join(" · ");
}

// Settings -> Diagnostics: the page-lifecycle log useLifecycleDiagnostics
// keeps, newest first, with Copy for pasting into an issue, and the one
// per-device recovery the page can attempt (lifecycle.ts). The log holds
// event kinds, times and numbers only; no task content reaches it.
export function Diagnostics({ settings, setSetting }: {
  settings: Settings;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
}) {
  const [log, setLog] = useState<LifecycleEvent[]>([]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const sync = () => setLog(readLifecycleLog());
    sync();
    window.addEventListener(LIFECYCLE_CHANGED, sync);
    return () => window.removeEventListener(LIFECYCLE_CHANGED, sync);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatLifecycleLog(log));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const reloadMinutes = settings.resumeReloadMinutes ?? 0;
  const newestFirst = [...log].reverse();

  return (
    <>
      <div className="field">
        <div className="lab">{Icon.clock()} Page lifecycle</div>
        <div className="hlp" style={{ marginTop: 4 }}>
          The last {log.length} lifecycle events this browser recorded: going to the background and back, focus, network, and any heartbeat that
          fired late because timers were suspended. It survives a force-quit. If the installed app comes back frozen, check whether anything
          was recorded at the moment it resumed: an entry means the page was running and the freeze is in the page; no entry means the browser
          never resumed JavaScript, which nothing in the page can recover from.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="btn" onClick={copy} disabled={log.length === 0}>{Icon.copy()} {copied ? "Copied" : "Copy log"}</button>
          <button className="btn" onClick={() => { clearLifecycleLog(); setLog([]); }} disabled={log.length === 0}>{Icon.clear()} Clear</button>
        </div>
        {newestFirst.length > 0 && (
          <div className="diag-log" data-testid="lifecycle-log" style={{ marginTop: 10 }}>
            {newestFirst.map((e, i) => (
              <div key={`${e.t}-${i}`} className="diag-row">
                <span className="diag-when">{when(e.t)}</span>
                <span className={`diag-kind${e.kind === "heartbeat_gap" || e.kind === "resume_reload" ? " warn" : ""}`}>{e.kind.replace("_", " ")}</span>
                <span className="diag-detail">{detail(e)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="field">
        <div className="lab">{Icon.restore()} Reload after a long background <span className="opt">installed iOS app only</span></div>
        <div className="hlp" style={{ marginTop: 4 }}>
          When the app added to the Home Screen returns after at least this long in the background, reload the page instead of resuming it.
          Only try this after the log shows events being recorded on a frozen resume: it can only run when the page runs. Off elsewhere,
          and off in a browser tab.
        </div>
        <div className="seg" style={{ marginTop: 8 }} role="radiogroup" aria-label="Reload after a long background">
          {RELOAD_CHOICES.map((c) => (
            <button key={c.minutes} role="radio" aria-checked={reloadMinutes === c.minutes} className={reloadMinutes === c.minutes ? "on" : ""}
              onClick={() => setSetting("resumeReloadMinutes", c.minutes)}>{c.label}</button>
          ))}
        </div>
      </div>
    </>
  );
}
