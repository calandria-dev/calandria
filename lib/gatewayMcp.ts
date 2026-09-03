// Hosted MCP servers from the LiteLLM gateway (docs/design/litellm.md,
// "Hosted MCP servers"): the catalog probe (GET <gateway>/v1/mcp/server, GET
// <gateway>/mcp-rest/tools/list), the per-project/per-task selection stored
// as a JSON array of aliases, and the mount shape a driver hands to its
// client for those aliases.
//
// SDK-free and Node-free beyond fetch, mirroring lib/gatewayModels.ts and
// lib/gatewayHealth.ts — so a driver (itself SDK-free) can build a turn's
// mcpServers entry with no SDK in the graph. tests/importGraph.test.ts pins
// the SDK-free set this belongs to.
//
// LiteLLM's exact JSON envelope for these two routes wasn't captured verbatim
// in the spike's appendix beyond the field names measured (docs/design/litellm.md,
// "LiteLLM surface": server_name, alias, description, transport, auth_type,
// mcp_access_groups, allowed_tools; tool entries carry mcp_info.server_name).
// Parsed tolerantly — a bare array or a `{data: [...]}` envelope, the shape
// /model/info was measured using — so an envelope this wasn't tested against
// degrades to an empty catalog instead of throwing.

import { MODEL_PROBE_MS, LITELLM_MCP } from "./config";
import { gatewayBaseUrl, normalizeBaseUrl } from "./agentEnv";
import { gatewayKey } from "./litellm-key";
import type { Project, Task } from "./types";

// ---------- selection: projects.gateway_mcp / tasks.gateway_mcp ----------

/** A JSON array of aliases, tolerant of a JSON string, an array, or garbage
 *  (which reads as "nothing selected" rather than throwing). Deduplicated and
 *  trimmed, so a stray blank entry from a form can't mount as an alias. */
export function parseGatewayMcp(input: unknown): string[] {
  let raw: unknown = input;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const alias = v.trim();
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    out.push(alias);
  }
  return out;
}

/** The stored form of a selection — always a valid JSON array string, never
 *  what was typed. Mirrors serializeAgentEnv's contract in lib/agentEnv.ts. */
export function serializeGatewayMcp(input: unknown): string {
  return JSON.stringify(parseGatewayMcp(input));
}

/**
 * The effective selection for a task's turn: its own override when one is
 * SET (including an explicit "mount nothing", `[]`), else the project's.
 * `null`/`undefined` on the task is "inherit" — the same null-means-inherit
 * contract `tasks.gateway_mcp`'s column comment states.
 */
export function resolveGatewayMcp(
  project: Pick<Project, "gateway_mcp"> | null | undefined,
  task?: Pick<Task, "gateway_mcp"> | null,
): string[] {
  if (task && task.gateway_mcp != null) return parseGatewayMcp(task.gateway_mcp);
  return parseGatewayMcp(project?.gateway_mcp);
}

// ---------- catalog: GET /v1/mcp/server + GET /mcp-rest/tools/list ----------

export interface GatewayMcpServerInfo {
  /** `alias || server_name` — what a turn mounts under and what canUseTool
   *  namespaces the tools by (`mcp__<alias>__…`). */
  alias: string;
  server_name: string;
  description: string;
  transport: string;
  auth_type: string;
  mcp_access_groups: string[];
  /** oauth2 + authorization_code needs a browser sign-in a detached turn can't
   *  perform (docs/design/litellm.md, "Auth types") — the picker marks it, but
   *  mounts it anyway, since LiteLLM holds the token once authorised there. */
  needs_browser_signin: boolean;
  /** Tool names from /mcp-rest/tools/list, for the picker's preview. */
  tools: string[];
}

export interface GatewayMcpCatalog {
  base_url: string;
  reachable: boolean;
  servers: GatewayMcpServerInfo[];
  error: string | null;
}

function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /timed? ?out|abort/i.test(m) ? "timed out" : m.replace(/^TypeError: /, "");
}

/** `{data: [...]}` (measured for /model/info) or a bare array — whichever
 *  this instance's LiteLLM answers with. */
function arrayify(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const data = body && typeof body === "object" ? (body as Record<string, unknown>).data : undefined;
  return Array.isArray(data) ? data : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// oauth2's browser-required grant, named literally in docs/design/litellm.md's
// "Auth types": everything else in that list (none, api_key, bearer_token,
// basic, oauth2 client_credentials, oauth2_token_exchange, aws_sigv4) works
// headless. Matched loosely against whatever string shape auth_type turns out
// to be, since the exact spelling wasn't captured — "oauth2" alone, without an
// authorization_code marker, is assumed headless (client_credentials is the
// other oauth2 grant this list names, and it needs no browser).
function needsBrowserSignin(authType: string): boolean {
  return /oauth ?2/i.test(authType) && /authorization[_ -]?code/i.test(authType);
}

function parseServerEntry(raw: unknown): GatewayMcpServerInfo | null {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!rec) return null;
  const serverName = str(rec.server_name);
  const alias = str(rec.alias) || serverName;
  if (!alias) return null;
  const authType = str(rec.auth_type);
  const groups = Array.isArray(rec.mcp_access_groups) ? rec.mcp_access_groups.filter((g): g is string => typeof g === "string") : [];
  return {
    alias,
    server_name: serverName || alias,
    description: str(rec.description),
    transport: str(rec.transport),
    auth_type: authType,
    mcp_access_groups: groups,
    needs_browser_signin: needsBrowserSignin(authType),
    tools: [],
  };
}

function unreachable(base: string, error: string): GatewayMcpCatalog {
  return { base_url: base, reachable: false, servers: [], error };
}

function authHeaders(key: string): Record<string, string> {
  return key ? { "x-litellm-api-key": `Bearer ${key}` } : {};
}

/**
 * The gateway's hosted MCP servers, with a tool-name preview merged in from
 * the tools listing. Never throws: an unreachable gateway is an ordinary
 * answer, the same contract lib/gatewayModels.ts and lib/gatewayHealth.ts keep.
 */
export async function gatewayMcpCatalog(
  baseUrl: string | null | undefined = gatewayBaseUrl(),
  key = "",
  timeoutMs = MODEL_PROBE_MS,
): Promise<GatewayMcpCatalog> {
  const base = normalizeBaseUrl(String(baseUrl ?? ""));
  if (!base) return unreachable("", "no base URL");
  const headers = { accept: "application/json", ...authHeaders(key) };
  let serversRes: Response;
  try {
    serversRes = await fetch(`${base}/v1/mcp/server`, { headers, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch (e) {
    return unreachable(base, reason(e));
  }
  if (!serversRes.ok) return unreachable(base, `${serversRes.status} ${serversRes.statusText || "error"}`);
  const servers: GatewayMcpServerInfo[] = [];
  try {
    for (const raw of arrayify(await serversRes.json())) {
      const parsed = parseServerEntry(raw);
      if (parsed) servers.push(parsed);
    }
  } catch (e) {
    return unreachable(base, reason(e));
  }

  // The tool preview is best-effort: a gateway that answers /v1/mcp/server but
  // not /mcp-rest/tools/list still lists its servers, just with no preview.
  try {
    const toolsRes = await fetch(`${base}/mcp-rest/tools/list`, { headers, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (toolsRes.ok) {
      const byServer = new Map<string, string[]>();
      for (const raw of arrayify(await toolsRes.json())) {
        const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
        const info = rec?.mcp_info && typeof rec.mcp_info === "object" ? (rec.mcp_info as Record<string, unknown>) : {};
        const serverName = str(info.server_name);
        const toolName = str(rec?.name);
        if (!serverName || !toolName) continue;
        const list = byServer.get(serverName) ?? [];
        list.push(toolName);
        byServer.set(serverName, list);
      }
      for (const s of servers) s.tools = byServer.get(s.server_name) ?? byServer.get(s.alias) ?? [];
    }
  } catch {
    /* preview only — the server list above already answered */
  }

  return { base_url: base, reachable: true, servers, error: null };
}

// ---------- mount health: does THIS alias actually answer with THIS key ----------

export interface GatewayMcpProbe {
  ok: boolean;
  error: string | null;
}

/**
 * A live JSON-RPC `tools/list` against `<gateway>/<alias>/mcp` — what a
 * project settings picker can offer as "test this server" before a turn ever
 * mounts it. A wrong key answers HTTP 400, not 401 (measured,
 * docs/design/litellm.md), so this reads the response BODY for a JSON-RPC or
 * LiteLLM error rather than trusting the status code alone.
 */
export async function probeGatewayMcpMount(
  baseUrl: string | null | undefined,
  alias: string,
  key = "",
  timeoutMs = MODEL_PROBE_MS,
): Promise<GatewayMcpProbe> {
  const base = normalizeBaseUrl(String(baseUrl ?? ""));
  const a = alias.trim();
  if (!base || !a) return { ok: false, error: "no base URL or alias" };
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${base}/${encodeURIComponent(a)}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...authHeaders(key) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, error: reason(e) };
  }
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON — fall through to the status-based answer below */
  }
  const rpcError = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
  if (rpcError) {
    const msg = rpcError && typeof rpcError === "object" ? (rpcError as Record<string, unknown>).message : rpcError;
    return { ok: false, error: typeof msg === "string" && msg ? msg : `HTTP ${res.status}` };
  }
  if (!res.ok) return { ok: false, error: text.slice(0, 300) || `HTTP ${res.status} ${res.statusText || ""}`.trim() };
  return { ok: true, error: null };
}

// ---------- mounting: what a driver hands its client for the resolved aliases ----------

export interface GatewayMcpHttpServer {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

type GatewayMount = { alias: string; url: string; key: string };

/**
 * The task's resolved hosted-MCP selection, filtered to what's actually
 * mountable — the shared gate behind every driver's mount function below.
 * `calandria` is reserved for the in-process/bridge Calandria server and is
 * dropped here even if picked, so a badly-named alias can't shadow it on any
 * driver. Independent of the task's model-provider kind: a Cloud-login Claude
 * task can still reach the gateway's hosted tools, so this only gates on
 * CALANDRIA_LITELLM_MCP, a configured gateway, and a non-empty selection —
 * not on `describeProvider(...).kind === "gateway"`. No network call and no
 * catalog lookup: mounting is blind to whether the alias still exists, the
 * same way a driver doesn't re-verify a Bash binary exists before running it.
 */
function resolvedGatewayMounts(
  project: Pick<Project, "gateway_mcp"> | null | undefined,
  task: (Pick<Task, "gateway_mcp"> & Partial<Pick<Task, "gateway_key">>) | null | undefined,
  gateway: string | null,
): GatewayMount[] {
  if (!LITELLM_MCP || !gateway) return [];
  const aliases = resolveGatewayMcp(project, task).filter((a) => a !== "calandria");
  if (!aliases.length) return [];
  const key = (task?.gateway_key || gatewayKey()).trim();
  return aliases.map((alias) => ({ alias, url: `${gateway}/${encodeURIComponent(alias)}/mcp`, key }));
}

/**
 * The `mcpServers` entries a Claude turn mounts for its resolved hosted-MCP
 * selection (docs/design/litellm.md: `mcpServers[alias] = { type: "http",
 * url: <gateway>/<alias>/mcp, headers: { "x-litellm-api-key": "Bearer …" } }`).
 * Never `Authorization` — LiteLLM reserves that header for the upstream
 * server's own OAuth (the documented collision).
 */
export function gatewayMcpServersFor(
  project: Pick<Project, "gateway_mcp"> | null | undefined,
  task?: (Pick<Task, "gateway_mcp"> & Partial<Pick<Task, "gateway_key">>) | null,
  gateway: string | null = gatewayBaseUrl(),
): Record<string, GatewayMcpHttpServer> {
  const out: Record<string, GatewayMcpHttpServer> = {};
  for (const { alias, url, key } of resolvedGatewayMounts(project, task, gateway)) {
    out[alias] = { type: "http", url, ...(key ? { headers: authHeaders(key) } : {}) };
  }
  return out;
}

export interface GatewayMcpCodexServer {
  url: string;
  http_headers?: Record<string, string>;
  default_tools_approval_mode: "approve";
}

/**
 * The `mcp_servers.<alias>` entries a Codex turn mounts for its resolved
 * hosted-MCP selection (docs/design/litellm.md, "Mounting, per driver").
 * `codex exec` has no approver, so every entry here also carries
 * `default_tools_approval_mode: "approve"` — this function is only ever
 * called by the driver under the task's bypass-equivalent permission mode
 * (see lib/agents/codex/driver.ts), so that auto-approval is scoped to a
 * task that already runs with no approvals asked of it.
 */
export function gatewayMcpServersForCodex(
  project: Pick<Project, "gateway_mcp"> | null | undefined,
  task?: (Pick<Task, "gateway_mcp"> & Partial<Pick<Task, "gateway_key">>) | null,
  gateway: string | null = gatewayBaseUrl(),
): Record<string, GatewayMcpCodexServer> {
  const out: Record<string, GatewayMcpCodexServer> = {};
  for (const { alias, url, key } of resolvedGatewayMounts(project, task, gateway)) {
    out[alias] = {
      url,
      ...(key ? { http_headers: authHeaders(key) } : {}),
      default_tools_approval_mode: "approve",
    };
  }
  return out;
}

export interface GatewayMcpGeminiServer {
  httpUrl: string;
  headers?: Record<string, string>;
}

/**
 * Gemini CLI's policy engine splits an MCP tool name on the first underscore
 * after `mcp_`, so an alias with an underscore breaks a wildcard policy rule
 * for it (docs/design/litellm.md, "Mounting, per driver"). Slugified to
 * hyphens for this driver's mount keys only — the URL still addresses the
 * real alias LiteLLM hosts. Two aliases that only differ by underscore vs.
 * hyphen collide here (last one mounted wins), which is an acceptable trade
 * against every alias otherwise breaking Gemini's own policy rules.
 */
export function slugifyGatewayAliasForGemini(alias: string): string {
  return alias.replace(/_/g, "-");
}

/**
 * The `mcpServers` entries an Antigravity turn mounts for its resolved
 * hosted-MCP selection, in the per-task `mcp_config.json`
 * (lib/agents/gemini/mcp.ts).
 */
export function gatewayMcpServersForGemini(
  project: Pick<Project, "gateway_mcp"> | null | undefined,
  task?: (Pick<Task, "gateway_mcp"> & Partial<Pick<Task, "gateway_key">>) | null,
  gateway: string | null = gatewayBaseUrl(),
): Record<string, GatewayMcpGeminiServer> {
  const out: Record<string, GatewayMcpGeminiServer> = {};
  for (const { alias, url, key } of resolvedGatewayMounts(project, task, gateway)) {
    out[slugifyGatewayAliasForGemini(alias)] = { httpUrl: url, ...(key ? { headers: authHeaders(key) } : {}) };
  }
  return out;
}
