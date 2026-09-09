"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/app/icons";
import { Markdown } from "@/app/Markdown";
import { Popover } from "./shared";
import type { Updates } from "./useUpdates";
import type { UpdateTarget } from "./updateTargets";

/**
 * The titlebar's update indicator and the popover behind it.
 *
 * Renders nothing until there is something to say, so an instance that is
 * current has no pill at all. What the popover offers depends on how the
 * server was installed and which shell the page is in: the desktop app updates
 * itself, and a container or a source checkout gets the commands to run. See
 * updateTargets.ts for that decision and docs/superpowers/specs for the table
 * it implements.
 */

/** How many releases are expanded before the popover asks. */
const SHOWN = 3;

function upgradeCommands(target: Extract<UpdateTarget, { kind: "server" }>): string[] {
  if (target.method === "container") {
    return [
      "docker exec -u calandria <container> npm run backup -- --out /home/calandria/backups",
      `export CALANDRIA_IMAGE=ghcr.io/calandria-dev/calandria:${target.to}`,
      "docker compose pull",
      "docker compose up -d --no-build",
    ];
  }
  if (target.method === "source") {
    return ["npm run backup -- --out <backup dir>", "git pull", "npm ci", "npm run build"];
  }
  return [];
}

function releasedOn(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

function CommandBlock({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = lines.join("\n");
  return (
    <div className="um-cmds">
      <pre>{text}</pre>
      <button
        className="btn btn-line btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // No clipboard permission. The commands are on screen either way.
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function ServerBlock({ target }: { target: Extract<UpdateTarget, { kind: "server" }> }) {
  const commands = upgradeCommands(target);
  const what = target.instanceName ? `This instance (${target.instanceName})` : "This instance";
  return (
    <div className="um-target">
      <div className="um-tt">
        {what} runs {target.from}
      </div>
      {commands.length > 0 ? (
        <details>
          <summary>How to update</summary>
          <CommandBlock lines={commands} />
          {target.method === "source" && <div className="hlp">Then restart the server.</div>}
        </details>
      ) : (
        <div className="hlp">This server was started by the desktop app, which updates it.</div>
      )}
    </div>
  );
}

function ShellBlock({ target, onInstall, onCheck }: { target: Extract<UpdateTarget, { kind: "shell" }>; onInstall: () => void; onCheck: () => void }) {
  const { phase, disposition } = target;
  return (
    <div className="um-target">
      <div className="um-tt">This app runs {target.from}</div>
      {!disposition.enabled ? (
        <div className="hlp">{disposition.reason}</div>
      ) : phase === "ready" ? (
        <button className="btn btn-sm" onClick={onInstall}>
          Restart to update
        </button>
      ) : phase === "downloading" ? (
        <div className="um-prog">
          <span className="spinner" />
          Downloading {target.to}
          {target.percent !== null ? ` (${Math.round(target.percent)}%)` : ""}
        </div>
      ) : phase === "checking" ? (
        <div className="um-prog">
          <span className="spinner" />
          Checking for an update
        </div>
      ) : (
        <button className="btn btn-line btn-sm" onClick={onCheck}>
          Check now
        </button>
      )}
      {target.error && <div className="hlp um-err">{target.error}</div>}
    </div>
  );
}

export function UpdatePill({ updates, isMobile }: { updates: Updates; isMobile: boolean }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { state, targets, install, checkNow, skip } = updates;

  // Settings links here, so its "is available" line opens this popover.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("calandria:open-updates", onOpen);
    return () => window.removeEventListener("calandria:open-updates", onOpen);
  }, []);

  if (!state?.latest || targets.length === 0) return null;

  const latest = state.latest;
  const shell = targets.find((t) => t.kind === "shell");
  const ready = shell?.phase === "ready";
  const downloading = shell?.phase === "downloading";
  const checking = shell?.phase === "checking";

  const label = ready
    ? "Restart to update"
    : downloading
      ? `Downloading ${shell.to}`
      : checking
        ? "Checking…"
        : latest.version;
  const tooltip = ready
    ? `${shell.to} is downloaded. Restart to install it.`
    : `Calandria ${latest.version} is available`;

  // A downloaded shell update is the one case where Skip has nothing to hide:
  // the bytes are on disk and the only thing left is the restart.
  const skippable = !(targets.length === 1 && shell && (ready || downloading));

  const releases = state.releases;
  const shownReleases = expanded ? releases : releases.slice(0, SHOWN);

  return (
    <div style={{ position: "relative" }}>
      {isMobile ? (
        <button
          className={`tb-icon${open ? " on" : ""}`}
          title={tooltip}
          aria-label={tooltip}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {Icon.arrowUp()}
          <span className="upd-dot" />
        </button>
      ) : (
        <button
          className={`update-pill${ready ? " ready" : ""}`}
          title={tooltip}
          aria-label={tooltip}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {downloading || checking ? <span className="spinner" /> : Icon.arrowUp()}
          {label}
        </button>
      )}
      {open && (
        <Popover onClose={() => setOpen(false)}>
          <div className="update-menu">
            <div className="um-head">
              <div className="um-title">Calandria {latest.version}</div>
              <div className="hlp">
                {releasedOn(latest.publishedAt) ? `Released ${releasedOn(latest.publishedAt)}. ` : ""}
                This instance runs {state.current.version}.
              </div>
            </div>
            {targets.map((t) =>
              t.kind === "server" ? (
                <ServerBlock key="server" target={t} />
              ) : (
                <ShellBlock key="shell" target={t} onInstall={install} onCheck={() => void checkNow()} />
              ),
            )}
            {shownReleases.length > 0 && (
              <div className="um-notes">
                {shownReleases.map((r, i) => (
                  <div className="um-note" key={r.version}>
                    {/* The popover header already names the newest one. */}
                    {i > 0 && <div className="um-nv">{r.version}</div>}
                    <Markdown>{r.notes}</Markdown>
                  </div>
                ))}
                {!expanded && releases.length > SHOWN && (
                  <button className="btn btn-line btn-sm" onClick={() => setExpanded(true)}>
                    Show {releases.length - SHOWN} more
                  </button>
                )}
              </div>
            )}
            <div className="um-foot">
              {skippable && (
                <button className="btn btn-line btn-sm" onClick={() => void skip()}>
                  Skip this version
                </button>
              )}
              <a className="btn btn-line btn-sm" href={latest.url} target="_blank" rel="noreferrer">
                Release page
              </a>
            </div>
          </div>
        </Popover>
      )}
    </div>
  );
}
