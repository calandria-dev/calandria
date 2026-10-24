"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionView, ArtifactManifest, ReviewView, SubmissionView } from "@/lib/reviews/types";
import type { CodePreview } from "@/lib/reviews/artifacts";
import { apiFetch } from "./api";
import { WC_EVENT } from "./useWorkCenter";

// Client readers for the review read routes (contract work-center/1):
// GET /api/tasks/[id]/reviews and .../submissions/[sid]/artifact. Reads stay
// available with CALANDRIA_REVIEW_REQUESTS off, so a task keeps its Review tab
// after creation is switched off.

export type ReviewCollection = {
  requests: ReviewView[];
  history: { submissions: SubmissionView[]; actions: ActionView[]; nextCursor: string | null };
};

export type ArtifactRead = {
  artifactId: string;
  kind: "code" | "document";
  manifest: ArtifactManifest;
  manifestSha256: string;
  preview: CodePreview | { text: string | null; byteLength: number; pathCount: null; truncated: false; reason: null };
};

export type ReviewLoad<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

async function errorOf(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return typeof j?.error?.message === "string" ? j.error.message : `request failed (${res.status})`;
  } catch {
    return `request failed (${res.status})`;
  }
}

/**
 * Fetches `url` and refetches when `url` changes, when `tick` bumps, when the
 * Work Center feed reports a change, and when the page regains focus. A
 * response for a superseded url never lands. The last good value stays through
 * a failed refetch.
 */
function useReviewFetch<T>(url: string | null, tick: number): ReviewLoad<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(url !== null);
  const [local, setLocal] = useState(0);
  const issued = useRef(0);
  const lastUrl = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!url) return;
    const mine = ++issued.current;
    try {
      const res = await apiFetch(url, { cache: "no-store" });
      if (mine !== issued.current) return;
      if (!res.ok) { setError(await errorOf(res)); return; }
      const json = (await res.json()) as T;
      if (mine !== issued.current) return;
      setData(json);
      setError(null);
    } catch (e) {
      if (mine === issued.current) setError(e instanceof Error ? e.message : "request failed");
    } finally {
      if (mine === issued.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    if (lastUrl.current !== url) {
      lastUrl.current = url;
      setData(null);
      setError(null);
      setLoading(url !== null);
    }
    void load();
  }, [url, load, tick, local]);

  useEffect(() => {
    if (!url) return;
    const again = () => { void load(); };
    const visible = () => { if (document.visibilityState === "visible") again(); };
    window.addEventListener(WC_EVENT, again);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener(WC_EVENT, again);
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [url, load]);

  return { data, error, loading, reload: () => setLocal((n) => n + 1) };
}

/** Current requests for a task. `limit=1` keeps the history page minimal; the pane reads history per request. */
export function useTaskReviews(taskId: string | null, tick = 0): ReviewLoad<ReviewCollection> {
  return useReviewFetch<ReviewCollection>(taskId ? `/api/tasks/${taskId}/reviews?limit=1` : null, tick);
}

/** One request's revisions and actions, all pages the first fetch returns (up to 100). */
export function useRequestHistory(taskId: string, requestId: string | null, stamp: string): ReviewLoad<ReviewCollection> {
  // `stamp` (version + current submission id) is part of the url so a new revision refetches.
  return useReviewFetch<ReviewCollection>(requestId ? `/api/tasks/${taskId}/reviews?request_id=${encodeURIComponent(requestId)}&limit=100&s=${encodeURIComponent(stamp)}` : null, 0);
}

export function useArtifact(taskId: string, requestId: string | null, submissionId: string | null, stamp: string): ReviewLoad<ArtifactRead> {
  const url = requestId && submissionId
    ? `/api/tasks/${taskId}/reviews/${encodeURIComponent(requestId)}/submissions/${encodeURIComponent(submissionId)}/artifact?s=${encodeURIComponent(stamp)}`
    : null;
  return useReviewFetch<ArtifactRead>(url, 0);
}
