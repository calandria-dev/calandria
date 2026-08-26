// localStorage + URL persistence for the open project/task, layout and prefs.
import type { Appearance, Layout, Settings, TaskView } from "./types";

export const LS = "calandria_ui_v1";
// Renamed from the orchestrator-era key; an existing install's old value is
// adopted once (and the old key deleted) so it keeps its layout/selection.
const LEGACY_LS = "orchestrator_ui_v2";

type Persisted = { selProj?: string; selTask?: string; appearance?: Partial<Appearance>; layout?: Layout; settings?: Settings; taskView?: TaskView };

export function loadPersist(): Persisted {
  if (typeof window === "undefined") return {};
  try {
    // `appearance` used to be called `tweaks` — read the legacy key so an existing
    // install keeps its theme/density across the rename (dropped fields are ignored
    // by the DEFAULT_APPEARANCE spread at the call site).
    let stored = localStorage.getItem(LS);
    if (stored === null) {
      const legacy = localStorage.getItem(LEGACY_LS);
      if (legacy !== null) {
        localStorage.setItem(LS, legacy);
        localStorage.removeItem(LEGACY_LS);
        stored = legacy;
      }
    }
    const raw = JSON.parse(stored || "{}") as Persisted & { tweaks?: Partial<Appearance> };
    if (!raw.appearance && raw.tweaks) raw.appearance = raw.tweaks;
    return raw;
  } catch { return {}; }
}

// The open project/task live in the URL query (?project=…&task=…) so a refresh
// lands back where you were and the view is shareable. URL wins over localStorage.
export function readUrlSel(): { project?: string; task?: string; view?: string; home?: boolean } {
  if (typeof window === "undefined") return {};
  const q = new URLSearchParams(window.location.search);
  return {
    project: q.get("project") ?? undefined,
    task: q.get("task") ?? undefined,
    view: q.get("view") ?? undefined,
    // The project home is its own pane on mobile (Runbooks/Schedules live only
    // there), so a refresh has to be able to land back on it.
    home: q.get("home") === "1",
  };
}
