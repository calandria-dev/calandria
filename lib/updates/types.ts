/**
 * Shapes shared by the update checker, the two update routes and the client.
 *
 * Types only, so `app/shell/` can import them without pulling the server's
 * database or fetch code into the browser bundle.
 */

/** How the server that serves this page was installed. See installMethod.ts. */
export type InstallMethod = "container" | "source" | "bundled";

/** One published release newer than the running version. */
export type ReleaseEntry = {
  version: string;
  url: string;
  publishedAt: string;
  /** The release body with the desktop-artifacts table cut off. */
  notes: string;
};

/** Everything GET /api/updates answers. */
export type UpdateState = {
  /** False when CALANDRIA_UPDATE_CHECK=off or the update_check setting is off. */
  enabled: boolean;
  current: {
    version: string;
    sha: string;
    builtAt: string;
    installMethod: InstallMethod;
    instanceName: string | null;
  };
  latest: { version: string; tag: string; url: string; publishedAt: string } | null;
  available: boolean;
  /** Every release newer than `current.version`, newest first. */
  releases: ReleaseEntry[];
  dismissedVersion: string | null;
  checkedAt: string | null;
  error: string | null;
};

/**
 * What the Electron main process dispatches into the page as
 * `calandria:desktop-update`. Mirrors desktop/updater.js's own state, so the
 * page can show the shell's update beside the server's.
 */
export type DesktopUpdateDetail = {
  shellVersion: string;
  phase: "idle" | "checking" | "downloading" | "ready" | "error";
  version: string | null;
  percent: number | null;
  disposition: { enabled: boolean; code: string; reason: string };
  error: string | null;
};
