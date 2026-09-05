/**
 * Instance-level feature flags.
 *
 * In-progress features default off and are turned on per-instance via env, the
 * same env-driven approach as lib/config.ts. Flags are resolved server-side
 * (`resolveFeatures`) and handed to the client by injecting `window.__FEATURES`
 * in app/layout.tsx, the same way PUBLIC_BASE_URL crosses the boundary, so both
 * sides gate identically without a per-flag NEXT_PUBLIC_ var.
 *
 * To add a flag: extend `Features` + `DEFAULT_FEATURES`, read its env var in
 * `resolveFeatures`, document it in .env.example, and gate the UI on
 * `clientFeatures().<flag>` (client) or `resolveFeatures().<flag>` (server).
 */
import { readEnv } from "./env.mjs";

export interface Features {
  /** PREVIEW tab (project live-URL view). Depends on the remote-execution
   *  backend landing first, so it stays off until the live URL is real. Default off. */
  livePreview: boolean;
  /** Command palette: the toolbar "Jump to project, session, or command…"
   *  omni-search bar and its Cmd-K/Ctrl-K shortcut (app/shell/CommandPalette). Default off. */
  omniSearch: boolean;
  /** Managed Services: the toolbar "Services" button, the Services config
   *  block in the project-context editor, and the persisted supervisor
   *  (lib/services.ts). Default on; set CALANDRIA_FEATURE_SERVICES=0 to
   *  disable. Public service hostnames are a separate opt-in via
   *  CALANDRIA_SERVICE_HOSTS (lib/service-host.mjs), so enabling services
   *  exposes nothing publicly on its own. */
  services: boolean;
}

export const DEFAULT_FEATURES: Features = {
  livePreview: false,
  omniSearch: false,
  services: true,
};

const truthy = (v: string | undefined) => v === "1" || v === "true" || v === "on";
// Unset/empty env keeps the flag's shipped default; any explicit value decides.
// A shipped flag (default on) is disabled with =0, not by omission.
// lib/service-router.mjs (plain JS, can't import this file) mirrors this read.
const flag = (v: string | undefined, dflt: boolean) => (v ? truthy(v) : dflt);

/** Server-side resolve from env. Never call this from client code (reads env). */
export function resolveFeatures(): Features {
  return {
    livePreview: flag(readEnv("CALANDRIA_FEATURE_LIVE_PREVIEW"), DEFAULT_FEATURES.livePreview),
    omniSearch: flag(readEnv("CALANDRIA_FEATURE_OMNI_SEARCH"), DEFAULT_FEATURES.omniSearch),
    services: flag(readEnv("CALANDRIA_FEATURE_SERVICES"), DEFAULT_FEATURES.services),
  };
}

/** Client-side read of the flags injected onto `window` by the root layout. */
export function clientFeatures(): Features {
  // SSR of a client component has no `window` yet. Resolve from env, the same
  // values layout.tsx injects as window.__FEATURES, so the server HTML and the
  // client's first render agree; returning DEFAULT_FEATURES here would make
  // every enabled flag a hydration mismatch. In the browser this branch never
  // runs, so the process.env reads never execute client-side.
  if (typeof window === "undefined") return resolveFeatures();
  const w = window as unknown as { __FEATURES?: Partial<Features> };
  return { ...DEFAULT_FEATURES, ...(w.__FEATURES ?? {}) };
}
