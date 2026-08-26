"use client";

import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import { jget, jsend } from "./api";
import type { RecapInfo, TaskRow } from "./types";

// Owns project "where you left off" recaps plus the selection-on-landing logic:
// fetch/generate a recap when entering a project, sweep stale projects on an
// interval, and decide whether to land on the recap or auto-pick the first task.
export function useRecaps({ selProj, selTask, tasks, setSelTask, selProjRef, settingsReady, backgroundJobs, recapMode, homeRequested }: {
  selProj: string | null;
  selTask: string | null;
  tasks: TaskRow[];
  setSelTask: (id: string | null) => void;
  selProjRef: MutableRefObject<string | null>;
  settingsReady: boolean;
  backgroundJobs: boolean;
  recapMode: "automatic" | "on_open" | "off";
  /** The user explicitly asked for the project home — don't pick a task over it. */
  homeRequested: boolean;
}) {
  const [recaps, setRecaps] = useState<Record<string, RecapInfo>>({});

  // Fetch a project's recap status; if it's gone stale with new activity and
  // none is ready yet, generate one on demand (so it's there the moment you land).
  const fetchRecap = useCallback(async (pid: string, regen = false) => {
    try {
      let info = await jget<RecapInfo>(`/api/projects/${pid}/recap`);
      setRecaps((m) => ({ ...m, [pid]: info }));
      const unattended = !regen;
      const canGenerate = regen || (settingsReady && backgroundJobs && recapMode !== "off");
      if (canGenerate && (regen || (info.needsRecap && !info.recap && !info.generating))) {
        setRecaps((m) => ({ ...m, [pid]: { ...info, generating: true } }));
        const g = await jsend<{ recap: string; recap_at: number }>(`/api/projects/${pid}/recap`, "POST", { unattended });
        info = { ...info, recap: g.recap, recap_at: g.recap_at, needsRecap: false, generating: false, hasHistory: true };
        setRecaps((m) => ({ ...m, [pid]: info }));
      }
    } catch (e) {
      // Keep whatever we had (an older recap is still useful) and record the
      // failure so the landing pane can offer a retry.
      const msg = e instanceof Error ? e.message : String(e);
      setRecaps((m) => ({ ...m, [pid]: { ...(m[pid] as RecapInfo), generating: false, error: msg } }));
    }
  }, [backgroundJobs, recapMode, settingsReady]);

  useEffect(() => { if (selProj && settingsReady) fetchRecap(selProj); }, [selProj, settingsReady, fetchRecap]);

  // Landing decision: once tasks + recap status are in, auto-select the first
  // task ONLY when there's no recap to show. If you're returning to a project
  // with a recap (or one brewing), land on the recap so you can reorient first.
  //
  // Never on mobile: there the task list is its own pane, so auto-selecting a
  // task forces you into the session view and you can never see the list — in
  // particular it would instantly undo a Back press that cleared the task,
  // making it impossible to switch tasks. On mobile, no task selected = show the
  // task list, which is exactly what we want.
  // An explicit ASK for the project home always wins. Without it this effect
  // made the tasks banner's project-home button a dead control on any project
  // with a task and no recap: it cleared selTask, this ran (selTask is in its
  // deps), and a task went straight back — so the landing pane, the recap, and
  // the Schedules card with its pause control were unreachable exactly where
  // they matter most, in the project you're actively working in.
  useEffect(() => {
    if (!selProj || selTask || homeRequested) return;
    if (window.matchMedia("(max-width: 760px)").matches) return;
    const info = recaps[selProj];
    if (info === undefined) return; // wait for recap status
    const showRecap = !!info.recap || info.needsRecap || info.generating;
    if (!showRecap) {
      const first = tasks.find((t) => !t.suggested);
      if (first) setSelTask(first.id);
    }
  }, [selProj, selTask, homeRequested, recaps, tasks, setSelTask]);

  // A task restored from the URL may have been deleted since. Once the current
  // project's tasks are loaded, drop a selTask that isn't among them so the
  // landing decision can pick a valid target. The project_id gate avoids firing
  // during the window where `tasks` still holds the previous project's list.
  useEffect(() => {
    if (!selTask || tasks.length === 0 || tasks[0].project_id !== selProj) return;
    if (!tasks.some((t) => t.id === selTask)) setSelTask(null);
  }, [selTask, tasks, selProj, setSelTask]);

  // Proactively sweep for stale projects on load and on an interval, then
  // refresh the currently-open project's recap so a freshly-baked one appears.
  useEffect(() => {
    if (!settingsReady || !backgroundJobs || recapMode !== "automatic") return;
    const sweep = () => {
      jsend("/api/recaps/sweep", "POST")
        .then(() => { if (selProjRef.current) fetchRecap(selProjRef.current); })
        .catch(() => {});
    };
    sweep();
    const t = setInterval(sweep, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [backgroundJobs, fetchRecap, recapMode, selProjRef, settingsReady]);

  return { recaps, fetchRecap };
}
