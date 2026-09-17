"use client";

// The one place a probed endpoint's status is put into words, shared by
// Settings' instance-wide local-endpoint card and the gateway health card, so
// the two can't describe the same endpoint differently. The per-project
// probe (GET /api/projects/[id]/models) and its client hook are gone: every
// model list now comes from the provider tree (app/shell/ModelPicker.tsx,
// GET /api/models); this file only formats a reachability sentence.

import type { EndpointApiT, EndpointModelsT, EndpointStatusT } from "./types";

/** "Ollama", "An OpenAI-compatible server", or the neutral fallback before
 *  anything has answered. */
function serverName(api: EndpointApiT | null): string {
  return api === "ollama" ? "Ollama" : api === "openai" ? "An OpenAI-compatible server" : "No server";
}

/**
 * One sentence for a probe result:
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
