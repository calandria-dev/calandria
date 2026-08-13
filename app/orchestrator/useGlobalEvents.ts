"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import type { GlobalWireEvent } from "@/lib/events";
import { jget } from "./api";
import type { ProjectRow, TaskRow } from "./types";

// One always-open EventSource on GET /api/events: coarse lifecycle events for
// EVERY task across EVERY project (turn started / awaiting input / answered /
// suggestion created / turn ended / mutation-route settles and deletions).
// This is what clears spinners and updates
// the "needs you" badges for tasks whose transcript stream isn't open — only
// the selected task has one (useTaskStream) — replacing the old 10s poll.
export function useGlobalEvents({ selProjRef, setTaskRunning, setTasks, setProjects, loadTasks, reconcileRunning, refreshAgents }: {
  selProjRef: MutableRefObject<string | null>;
  setTaskRunning: (id: string, on: boolean) => void;
  setTasks: React.Dispatch<React.SetStateAction<TaskRow[]>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectRow[]>>;
  loadTasks: (projectId: string, selectFirst?: boolean) => Promise<void>;
  reconcileRunning: () => Promise<void>;
  refreshAgents: () => Promise<void>;
}) {
  // Apply one lifecycle event. The payload is a fresh snapshot of the task
  // row's running/awaiting_input/status (read after the runner persisted it),
  // so applying it is idempotent — overlaps with the selected task's own
  // stream, which fires for the same boundaries, are harmless.
  const handle = (ev: GlobalWireEvent) => {
    // An agent's login died or came back. Refetch the shared agents bundle
    // rather than patching state locally, so the reconnect banner, the Settings
    // cards, and the New-task picker all read one server-side truth. Rare event
    // (once per outage), so the extra fetch costs nothing.
    if (ev.type === "agent_auth") { void refreshAgents(); return; }
    // A task was hard-deleted (possibly in another tab — in this one the local
    // removal already happened, so the replay is a no-op). Drop it and adopt
    // the recomputed project badge the event carries; there's no row left to
    // re-fetch.
    if (ev.type === "task_deleted") {
      setTaskRunning(ev.taskId, false);
      setTasks((prev) => prev.filter((t) => t.id !== ev.taskId));
      setProjects((prev) => prev.map((p) => (p.id === ev.projectId ? { ...p, awaiting_count: ev.awaiting_count } : p)));
      return;
    }
    // Tasks were re-parented (possibly in another tab). Every affected project's
    // task count and badge moved, and no event carries task_count — so refetch
    // the project list once; a move is a rare, hand-driven mutation. A tray on
    // screen is refetched rather than patched: the destination gains rows it has
    // never seen, and a source doesn't just lose them — the move severs every
    // dependency edge with one end left behind, so its neighbours' depends_on
    // and auto_start are stale too. One event for the whole selection, so
    // eleven tasks re-filed at once cost this tab one re-sync, not eleven.
    if (ev.type === "tasks_moved") {
      jget<ProjectRow[]>("/api/projects").then(setProjects).catch(() => {});
      const sel = selProjRef.current;
      if (sel && (sel === ev.toProjectId || ev.fromProjectIds.includes(sel))) void loadTasks(sel, false);
      return;
    }
    if (ev.type !== "task") return;
    setTaskRunning(ev.taskId, ev.running);
    setTasks((prev) => prev.map((t) => {
      if (t.id !== ev.taskId) return t;
      // A launch publishes turn_started before the agent session opens, i.e.
      // while the row's status is still "not_started" — don't regress a task
      // the client already optimistically flipped to in_progress; the session-
      // open event re-fires turn_started with the settled status moments later.
      const status = ev.running && ev.status === "not_started" && t.status === "in_progress" ? t.status : ev.status;
      return { ...t, running: ev.running ? 1 : 0, awaiting_input: ev.awaiting_input ? 1 : 0, status };
    }));
    // Project badge + titlebar pill: the event carries the project's fresh
    // awaiting count, so no /api/projects refetch is needed.
    setProjects((prev) => prev.map((p) => (p.id === ev.projectId ? { ...p, awaiting_count: ev.awaiting_count } : p)));
    // A suggested task was created — surface it in the Suggested tray right
    // away if that project is on screen. The turn that filed it may have been
    // running in a DIFFERENT project (suggest_task can target any of them), so
    // the tray to refresh is the one the event names, not the caller's.
    if (ev.event === "suggested") {
      const filedInto = ev.suggestedProjectId ?? ev.projectId;
      if (selProjRef.current === filedInto) void loadTasks(filedInto, false);
    }
    // An agent rewrote its own task's title/description/priority (update_task).
    // The snapshot above only carries running/awaiting_input/status, so the rest
    // would stay stale until a reload — refetch the tray it lives in.
    if (ev.event === "task_edited" && selProjRef.current === ev.projectId) void loadTasks(ev.projectId, false);
  };
  // Route through a ref so the EventSource effect never re-subscribes.
  const handleRef = useRef(handle);
  useEffect(() => { handleRef.current = handle; });

  useEffect(() => {
    const es = new EventSource("/api/events");
    let opens = 0;
    es.onopen = () => {
      // This stream is a live tail with no snapshot: anything published while
      // we were disconnected (laptop sleep, tunnel drop) is gone. On every
      // REconnect, refetch the authoritative lists once to catch up. The first
      // open is skipped — boot() and the project-selection effect already load
      // them. reconcileRunning drains the running set fleet-wide: a turn_end
      // missed while dark, on a task in a project we've navigated away from,
      // is invisible to the two refetches below (they only cover the selected
      // project's rows) and would leave that spinner stuck forever.
      opens += 1;
      if (opens === 1) return;
      jget<ProjectRow[]>("/api/projects").then(setProjects).catch(() => {});
      if (selProjRef.current) void loadTasks(selProjRef.current, false);
      void reconcileRunning();
      // An agent_auth event fired while we were dark would be lost (this stream
      // is a live tail), leaving a stale banner — or none when the login is in
      // fact dead. The bundle carries the persisted flag, so refetch it too.
      void refreshAgents();
    };
    es.onmessage = (e) => {
      try { handleRef.current(JSON.parse(e.data) as GlobalWireEvent); } catch {}
    };
    return () => es.close();
    // All deps are stable (a ref, a setState, []-memoized callbacks).
  }, [selProjRef, setProjects, loadTasks, reconcileRunning, refreshAgents]);
}
