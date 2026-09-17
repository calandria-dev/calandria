import { isNewer } from "@/lib/updates/semver";
import type { DesktopUpdateDetail, InstallMethod, UpdateState } from "@/lib/updates/types";

/**
 * What the update popover has to offer, given three facts: what the server
 * knows about releases, what the desktop updater is doing, and which shell the
 * page is in.
 *
 * Two different things can be behind. The server is the thing that serves the
 * page, and how it was installed decides whether it gets instructions or
 * nothing at all. The shell is the Electron app around the page, which updates
 * itself. A desktop app attached to a remote instance can be behind on either,
 * or both.
 *
 * Pure, so the whole state table is a unit test.
 */
export type UpdateTarget =
  | { kind: "server"; from: string; to: string; method: InstallMethod; instanceName: string | null }
  | {
      kind: "shell";
      from: string;
      to: string;
      phase: DesktopUpdateDetail["phase"];
      percent: number | null;
      disposition: DesktopUpdateDetail["disposition"];
      error: string | null;
    };

export function updateTargets({
  server,
  desktop,
  shell,
}: {
  server: UpdateState | null;
  desktop: DesktopUpdateDetail | null;
  shell: { kind: "desktop" | "browser"; version: string | null };
}): UpdateTarget[] {
  if (!server?.enabled || !server.latest) return [];
  const latest = server.latest.version;
  // Skipping hides everything up to and including the skipped version. A newer
  // release than the one somebody skipped brings the pill back on its own.
  const skipped = !!server.dismissedVersion && !isNewer(latest, server.dismissedVersion);
  const inShell = shell.kind === "desktop";
  const targets: UpdateTarget[] = [];

  // A bundled server inside the desktop app is not a separate thing to update:
  // the shell's own installer carries it. Everywhere else the server is its
  // own target, including a bundled server reached from a browser, which gets
  // the release page and no instructions because there are none to give.
  const serverIsTheShell = inShell && server.current.installMethod === "bundled";
  if (server.available && !skipped && !serverIsTheShell) {
    targets.push({
      kind: "server",
      from: server.current.version,
      to: latest,
      method: server.current.installMethod,
      instanceName: server.current.instanceName,
    });
  }

  if (inShell && desktop) {
    const from = desktop.shellVersion || shell.version || "";
    // A download in flight or waiting to install is shown whatever anyone
    // skipped: the bytes are already on disk and the restart is one press.
    const busy = desktop.phase === "downloading" || desktop.phase === "ready";
    if (busy || (isNewer(latest, from) && !skipped)) {
      targets.push({
        kind: "shell",
        from,
        to: desktop.version || latest,
        phase: desktop.phase,
        percent: desktop.percent,
        disposition: desktop.disposition,
        error: desktop.error,
      });
    }
  }

  return targets;
}
