"use client";

// The client half of local-model endpoints: one hook that asks the server what
// a project's endpoint reports, and the one place the answer is put into words.
//
// The browser never probes the endpoint itself: it is loopback on the machine
// the server runs on (lib/modelEndpoint.ts says why at length), so every read
// goes through GET /api/projects/[id]/models.

import { useEffect, useMemo, useRef, useState } from "react";
import { jget } from "./api";
import type { EndpointModelsT, EndpointStatusT } from "./types";

const EMPTY: EndpointModelsT = { base_url: "", reachable: false, api: null, models: [], error: null };

// Typing a base URL fires a request per keystroke otherwise, and each one opens
// a socket on the server's behalf.
const DEBOUNCE_MS = 400;

export interface EndpointModelsState {
  data: EndpointModelsT | null; // null until the first answer arrives
  loading: boolean;
  /** Model ids to suggest. Empty for a cloud project, or an endpoint that is
   *  down, in both cases the field stays free-form with no list. */
  models: string[];
}

/**
 * What `baseUrl` (or, when that's blank, the project's saved override) reports.
 *
 * `enabled` is the cloud case: a cloud project has no endpoint to ask about, and
 * asking anyway would put a pointless request behind every dialog open. The
 * hook still returns a stable shape so callers don't branch on it.
 */
export function useEndpointModels(projectId: string | null | undefined, baseUrl: string, enabled: boolean): EndpointModelsState {
  const [data, setData] = useState<EndpointModelsT | null>(null);
  const [loading, setLoading] = useState(false);
  // A slow probe of an old URL must not land on top of a fast probe of the new
  // one; only the latest request is allowed to write.
  const seq = useRef(0);

  useEffect(() => {
    if (!projectId || !enabled) { setData(null); setLoading(false); return; }
    const mine = ++seq.current;
    setLoading(true);
    const url = `/api/projects/${projectId}/models${baseUrl ? `?base_url=${encodeURIComponent(baseUrl)}` : ""}`;
    const t = setTimeout(() => {
      jget<EndpointModelsT>(url)
        .then((r) => { if (seq.current === mine) { setData(r); setLoading(false); } })
        // A failed request is an unreachable endpoint as far as the picker is
        // concerned, so it renders the reason.
        .catch((e: unknown) => {
          if (seq.current !== mine) return;
          setData({ ...EMPTY, base_url: baseUrl, error: e instanceof Error ? e.message : "couldn't ask the server" });
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [projectId, baseUrl, enabled]);

  const models = useMemo(() => data?.models ?? [], [data]);
  return { data, loading, models };
}

/** "Ollama", "An OpenAI-compatible server", or the neutral fallback before
 *  anything has answered. */
function serverName(api: EndpointModelsT["api"]): string {
  return api === "ollama" ? "Ollama" : api === "openai" ? "An OpenAI-compatible server" : "No server";
}

/**
 * One sentence for a probe result, used by Settings, the project dialog and the
 * New-task dialog so the three can't describe the same endpoint differently:
 *
 *   "Ollama at localhost:11434: reachable, 4 models"
 *   "No server at localhost:11434: connection refused, is the server running?"
 */
export function endpointSummary(e: EndpointStatusT | EndpointModelsT | null | undefined, loading = false): string {
  if (loading && !e) return "Checking the endpoint…";
  if (!e || !e.base_url) return "";
  const where = e.base_url.replace(/^https?:\/\//, "");
  if (!e.reachable) return `${serverName(e.api)} at ${where}: ${e.error || "not reachable"}`;
  const n = "model_count" in e ? e.model_count : e.models.length;
  return `${serverName(e.api)} at ${where}: reachable, ${n} ${n === 1 ? "model" : "models"}`;
}

