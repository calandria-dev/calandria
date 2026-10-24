"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "@/lib/workCenter/types";

// The one client reader of GET /api/work-center (contract work-center/1). The
// global feed (useGlobalEvents) relays two window events: `calandria:work-center`
// carries the transport identity of a change, and `calandria:work-center-stream`
// says whether the feed is up. A fetch runs on mount, on an epoch change or a
// newer sequence, on feed reconnect, and when the page resumes. A fetch started
// while another is in flight is remembered and re-run, so an invalidation that
// lands mid-fetch is never lost. A response older than what is on screen never
// replaces it. Failed fetches retry after 1, 2, 4, 8, 16, then 30 seconds with
// 20% jitter while the page is visible, and the last good snapshot stays.

export const WC_EVENT = "calandria:work-center";
export const WC_STREAM_EVENT = "calandria:work-center-stream";

export type WcTransport = { instanceEpoch: string; sequence: number };

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
export const backoffDelay = (failures: number, rand: number = Math.random()): number => {
  const base = BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1];
  return Math.round(base * (0.8 + 0.4 * rand));
};

export type WorkCenterData = {
  snap: Snapshot | null;
  /** Message of the last failed fetch; null after a success. */
  error: string | null;
  /** The live feed is down. */
  disconnected: boolean;
  lastOkAt: number | null;
  /** True until the first fetch settles, success or failure. */
  loading: boolean;
  /** Fetch now; resolves once the fetch settles. */
  refresh: () => void;
  /** Fetch shortly after `ts` (a snooze deadline), since expiry changes the list with no event. */
  refetchAt: (ts: number) => void;
};

export function useWorkCenter(): WorkCenterData {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const snapRef = useRef<Snapshot | null>(null);
  const issued = useRef(0);
  const applied = useRef(0);
  const inflight = useRef(false);
  const dirty = useRef(false);
  const failures = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadlines = useRef(new Set<ReturnType<typeof setTimeout>>());
  const alive = useRef(true);
  const loadRef = useRef<() => void>(() => {});

  const load = useCallback(() => {
    if (!alive.current) return;
    if (inflight.current) { dirty.current = true; return; }
    inflight.current = true;
    dirty.current = false;
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    const mine = ++issued.current;
    void (async () => {
      try {
        const res = await fetch("/api/work-center?recent_limit=20", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = (await res.json()) as Snapshot;
        if (!alive.current) return;
        const cur = snapRef.current;
        const older = !!cur && cur.instanceEpoch === next.instanceEpoch && next.sequence < cur.sequence;
        if (mine >= applied.current && !older) {
          applied.current = mine;
          snapRef.current = next;
          setSnap(next);
        }
        failures.current = 0;
        setError(null);
        setLastOkAt(Date.now());
      } catch (e) {
        if (!alive.current) return;
        failures.current += 1;
        setError(e instanceof Error ? e.message : String(e));
        if (document.visibilityState === "visible") {
          retryTimer.current = setTimeout(() => loadRef.current(), backoffDelay(failures.current));
        }
      } finally {
        inflight.current = false;
        if (alive.current) setLoading(false);
        if (dirty.current) loadRef.current();
      }
    })();
  }, []);
  loadRef.current = load;

  useEffect(() => {
    alive.current = true;
    load();
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<WcTransport>).detail;
      const cur = snapRef.current;
      if (!cur || d.instanceEpoch !== cur.instanceEpoch || d.sequence > cur.sequence) load();
    };
    const onStream = (e: Event) => {
      const up = (e as CustomEvent<{ up: boolean }>).detail.up;
      setDisconnected(!up);
      if (up && snapRef.current) load();
    };
    const onResume = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener(WC_EVENT, onChange);
    window.addEventListener(WC_STREAM_EVENT, onStream);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("online", onResume);
    const timers = deadlines.current;
    return () => {
      alive.current = false;
      window.removeEventListener(WC_EVENT, onChange);
      window.removeEventListener(WC_STREAM_EVENT, onStream);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("online", onResume);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, [load]);

  const refetchAt = useCallback((ts: number) => {
    const t = setTimeout(() => { deadlines.current.delete(t); loadRef.current(); }, Math.max(0, ts - Date.now()) + 400);
    deadlines.current.add(t);
  }, []);

  return { snap, error, disconnected, lastOkAt, loading, refresh: load, refetchAt };
}
