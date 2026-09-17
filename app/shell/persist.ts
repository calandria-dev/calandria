// localStorage + URL persistence for the open project/task, layout and prefs.
import type { Appearance, Layout, Settings, TaskView } from "./types";

export const LS = "calandria_ui_v1";
// Renamed from the orchestrator-era key; an existing install's old value is
// adopted once (and the old key deleted) so it keeps its layout/selection.
const LEGACY_LS = "orchestrator_ui_v2";

export type Persisted = { selProj?: string; selTask?: string; appearance?: Partial<Appearance>; layout?: Layout; settings?: Settings; taskView?: TaskView };

// The selection half of a persisted blob: everything `landingSelection` reads.
// Nullable as well as optional: the live shell state is `string | null`, and a
// blob written before boot landed (see `selectionToPersist`) round-trips those
// nulls.
export type StoredSel = { selProj?: string | null; selTask?: string | null };

export type UrlSel = { project?: string; task?: string; view?: string; home?: boolean };

export function loadPersist(): Persisted {
  if (typeof window === "undefined") return {};
  try {
    // `appearance` was previously stored under `tweaks`; read the legacy key so
    // an existing install keeps its theme/density across the rename (dropped
    // fields are ignored by the DEFAULT_APPEARANCE spread at the call site).
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
export function readUrlSel(): UrlSel {
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

// Where the shell lands on boot. The last project the user had open is the
// answer whenever it is still there and still active; `active[0]` is only the
// backstop for a first run, a wiped store, or a project since deleted or
// deprecated, not the default. Pure so the precedence is pinned by a test
// instead of by reading a fetch callback.
export function landingSelection(active: readonly { id: string }[], url: UrlSel, stored: StoredSel): {
  proj: string | null;
  task: string | null;
  /** Land on the project-home pane (Runbooks/Schedules) instead of a task. */
  home: boolean;
} {
  const wantProj = url.project ?? stored.selProj;
  const wantTask = url.task ?? stored.selTask;
  // Never land on a deprecated project: it must be restored before building.
  const landProj = active.find((p) => p.id === wantProj)?.id ?? active[0]?.id ?? null;
  // A missing or deprecated wantProj fell back to active[0]; the remembered task
  // and home pane belong to a different project, so neither carries over.
  const onWantedProject = landProj !== null && landProj === wantProj;
  return {
    proj: landProj,
    task: onWantedProject && wantTask ? wantTask : null,
    home: onWantedProject && !wantTask && url.home === true,
  };
}

// Which selection a persist write should carry. Until boot has applied
// `landingSelection`, the live `selProj`/`selTask` are still null, and writing
// them would erase the very value the next start reads back, landing a
// restart on the first project. Before then, re-write what is already
// stored, so a tab closed mid-boot still remembers where it was.
export function selectionToPersist(ready: boolean, live: StoredSel, stored: StoredSel): StoredSel {
  return ready ? live : { selProj: stored.selProj, selTask: stored.selTask };
}
