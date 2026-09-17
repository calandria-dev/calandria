"use client";

import { useEffect, useRef } from "react";
import {
  HEARTBEAT_MS, LIFECYCLE_CHANGED, LIFECYCLE_LS, heartbeatGap, isIOS, isStandaloneDisplay,
  parseLifecycleLog, pushLifecycleEvent, shouldReloadOnResume, type LifecycleEvent,
} from "./lifecycle";

// Reads the persisted log. Shared with Diagnostics.tsx, which shows it.
export function readLifecycleLog(): LifecycleEvent[] {
  if (typeof window === "undefined") return [];
  try { return parseLifecycleLog(localStorage.getItem(LIFECYCLE_LS)); } catch { return []; }
}

export function clearLifecycleLog(): void {
  try { localStorage.removeItem(LIFECYCLE_LS); } catch {}
  window.dispatchEvent(new Event(LIFECYCLE_CHANGED));
}

function heapMB(): number | undefined {
  const mem = (performance as { memory?: { usedJSHeapSize?: number } }).memory;
  const used = mem?.usedJSHeapSize;
  return typeof used === "number" ? Math.round(used / 1_048_576) : undefined;
}

// Appends one event to the persisted log. Exported so a component that isn't
// the hook can record something the hook can't see (Terminal.tsx records a
// socket stuck at CONNECTING) without owning the listeners.
//
// Re-reads before every append rather than holding the log in memory: Clear in
// the panel empties storage, and a cached copy would write the old entries
// straight back on the next event.
export function recordLifecycleEvent(ev: Omit<LifecycleEvent, "t">): void {
  if (typeof window === "undefined") return;
  const heap = heapMB();
  const log = pushLifecycleEvent(readLifecycleLog(), { t: Date.now(), ...ev, ...(heap === undefined ? {} : { heapMB: heap }) });
  try { localStorage.setItem(LIFECYCLE_LS, JSON.stringify(log)); } catch {}
  window.dispatchEvent(new Event(LIFECYCLE_CHANGED));
}

// Records page-lifecycle events into a small persisted log and decides the
// one recovery the page can attempt on its own (lifecycle.ts has the policy).
// Every write lands in localStorage at once, so the record survives the
// force-quit the user reaches for when the app comes back dead. Nothing here
// reads a task, a transcript or a title.
export function useLifecycleDiagnostics({ resumeReloadMinutes }: { resumeReloadMinutes: number }) {
  const thresholdRef = useRef(resumeReloadMinutes);
  thresholdRef.current = resumeReloadMinutes;

  useEffect(() => {
    const record = recordLifecycleEvent;

    const standalone = isStandaloneDisplay(navigator as { standalone?: boolean }, (q) => window.matchMedia(q).matches);
    const ios = isIOS(navigator.userAgent, navigator.maxTouchPoints);
    record({ kind: "boot", standalone, ios, online: navigator.onLine, ua: navigator.userAgent.slice(0, 160) });

    // When the page went hidden, for the reload decision. Held in memory on
    // purpose: a page iOS relaunched from scratch is a fresh boot with nothing
    // to reload, and the boot event above says so.
    let hiddenSince: number | null = document.visibilityState === "hidden" ? Date.now() : null;

    const onResume = (kind: "visible" | "pageshow", persisted?: boolean) => {
      const now = Date.now();
      record({ kind, online: navigator.onLine, ...(persisted === undefined ? {} : { persisted }) });
      if (shouldReloadOnResume({ thresholdMinutes: thresholdRef.current, standalone, ios, hiddenSinceMs: hiddenSince, nowMs: now })) {
        record({ kind: "resume_reload", hiddenMs: now - (hiddenSince ?? now) });
        hiddenSince = null;
        window.location.reload();
        return;
      }
      hiddenSince = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenSince = Date.now();
        record({ kind: "hidden", online: navigator.onLine });
      } else {
        onResume("visible");
      }
    };
    const onPageShow = (e: PageTransitionEvent) => onResume("pageshow", e.persisted);
    const onPageHide = () => { if (hiddenSince === null) hiddenSince = Date.now(); record({ kind: "pagehide" }); };
    const onFocus = () => record({ kind: "focus" });
    const onBlur = () => record({ kind: "blur" });
    const onOnline = () => record({ kind: "online", online: true });
    const onOffline = () => record({ kind: "offline", online: false });
    const onFreeze = () => record({ kind: "freeze" });
    const onPageResume = () => record({ kind: "resume" });

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("freeze", onFreeze);
    document.addEventListener("resume", onPageResume);

    // The heartbeat. A tick that lands a whole interval late means timers
    // were suspended or throttled; the two clocks together say which.
    let prevWall = Date.now();
    let prevMono = performance.now();
    const timer = window.setInterval(() => {
      const nowWall = Date.now();
      const nowMono = performance.now();
      const gap = heartbeatGap(prevWall, nowWall, prevMono, nowMono, HEARTBEAT_MS);
      prevWall = nowWall;
      prevMono = nowMono;
      if (gap) record({ kind: "heartbeat_gap", ...gap, online: navigator.onLine });
    }, HEARTBEAT_MS);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onPageResume);
    };
  }, []);
}
