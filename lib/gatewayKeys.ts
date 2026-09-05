// Per-task LiteLLM virtual keys and spend reconciliation (docs/AGENTS.md).
// Opt-in behind CALANDRIA_LITELLM_ADMIN_KEY: unset, this module is inert and
// every gateway turn runs on the shared instance key.
//
// SDK-free and Node-free beyond fetch (tests/importGraph.test.ts pins the
// set). Must never import lib/runner.ts or lib/agents/registry.ts, since
// lib/runner.ts imports this module and the reverse edge would cycle.
//
// Three best-effort, non-blocking operations: mint (ensureTaskGatewayKey) on
// a task's first gateway turn, delete (deleteTaskGatewayKey) when a task
// goes terminal, and reconcile (reconcileTaskGatewaySpend) after a turn ends
// to correct spend against LiteLLM's own ledger.

import { LITELLM_ADMIN_KEY, LITELLM_KEY_TIMEOUT_MS } from "./config";
import { gatewayBaseUrl, taskProvider } from "./agentEnv";
import { resolveGatewayMcp } from "./gatewayMcp";
import { taskGatewayKeyState, setTaskGatewayKey, setTaskGatewayKeySpend, addUsage } from "./store";
import { prunableTaskIds } from "./retention";
import type { Project, Task } from "./types";

/** Whether per-task virtual keys are switched on at all: an admin key with a
 *  gateway to mint against. Every operation below is a no-op without this. */
export function gatewayKeysEnabled(): boolean {
  return !!LITELLM_ADMIN_KEY && !!gatewayBaseUrl();
}

// Same shape as lib/gatewayHealth.ts's reason(): a Node fetch failure's useful
// text is on `message`/`cause`, and "timed out" reads better than an
// AbortError's default message.
function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /timed? ?out|abort/i.test(m) ? "timed out" : m.replace(/^TypeError: /, "");
}

// Logged once, instance-wide, per kind of failure: a live turn is the wrong
// place to surface a config problem, and the gateway health card (Settings
// -> Agents) already states the "Database not connected" case for /key/info.
// Reset on the next success of the same kind, so a fixed instance logs again
// if it breaks a second time instead of staying silent forever.
const store = globalThis as { __calandriaGatewayKeyWarned?: Set<string> };
const warned = (store.__calandriaGatewayKeyWarned ??= new Set());
function warnOnce(kind: string, detail: string): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  console.warn(`[gatewayKeys] ${kind}: ${detail} — falling back to the instance key`);
}
function clearWarned(kind: string): void {
  warned.delete(kind);
}

async function adminCall(path: string, body: unknown): Promise<{ ok: true; body: unknown } | { ok: false; detail: string }> {
  const gw = gatewayBaseUrl();
  if (!gw || !LITELLM_ADMIN_KEY) return { ok: false, detail: "no gateway or admin key configured" };
  try {
    const r = await fetch(`${gw}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(LITELLM_KEY_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        // LiteLLM's key-management surface takes the admin/master key as a
        // bearer token, distinct from the x-litellm-api-key header every
        // other gateway call in this codebase sends a virtual key on.
        authorization: `Bearer ${LITELLM_ADMIN_KEY}`,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      // The documented no-database response (500 "Database not connected"),
      // distinguished from a transient outage so the log line names the
      // actual cause instead of a bare status code.
      const detail = /database not connected|db not connected/i.test(text)
        ? "LiteLLM has no database (key management needs one)"
        : `${r.status} ${r.statusText || "error"}${text ? `: ${text.slice(0, 200)}` : ""}`;
      return { ok: false, detail };
    }
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      return { ok: false, detail: "unparseable response" };
    }
    return { ok: true, body: parsed };
  } catch (e) {
    return { ok: false, detail: reason(e) };
  }
}

// ---------------------------------------------------------------------------
// mint
// ---------------------------------------------------------------------------

/**
 * Mint (or reuse) `task`'s LiteLLM virtual key and set it on the in-memory
 * `task` object, the same pattern lib/runner.ts uses for `worktree_path`.
 * Called from `run()` before the driver runs, so `agentTurnEnv()`
 * (lib/agentEnv.ts) sees the real key on `task.gateway_key`.
 *
 * A no-op (leaves `task.gateway_key` at "") when per-task keys are off, the
 * task isn't running against the gateway, or the task already has a key from
 * an earlier turn: minting happens once per task, not once per turn.
 * `project` comes from the caller, which already has it in scope.
 */
export async function ensureTaskGatewayKey(task: Task, project: Project): Promise<void> {
  task.gateway_key = "";
  if (!gatewayKeysEnabled()) return;
  const provider = taskProvider(project, task);
  if (provider.kind !== "gateway") return;
  const state = taskGatewayKeyState(task.id);
  if (state?.key) {
    task.gateway_key = state.key;
    return;
  }
  const body: Record<string, unknown> = {
    key_alias: `calandria-task-${task.id}`,
    // Names the project and task on both metadata (LiteLLM's UI reads this)
    // and tags (what its spend views group and filter by), matching what
    // applyGatewayEnv() (lib/agentEnv.ts) puts in x-litellm-tags for the
    // instance-key path, so ledger entries read consistently either way.
    metadata: { calandria_project: project.id, calandria_project_name: project.name, calandria_task: task.id, calandria_task_title: task.title },
    tags: ["calandria", `project:${project.id}`, `task:${task.id}`],
  };
  // The project's picker choice, if pinned. An omitted `models` means
  // "unrestricted" (LiteLLM allows every model the admin key can see); an
  // empty `models: []` means "no models allowed", so it stays omitted when
  // there's no pinned choice.
  if (provider.model) body.models = [provider.model];
  if (project.gateway_max_budget != null) body.max_budget = project.gateway_max_budget;
  if (project.gateway_key_duration) body.duration = project.gateway_key_duration;
  // Hosted MCP servers (docs/AGENTS.md): the task's resolved selection scopes
  // the minted key itself, so a per-task key can only reach the servers this
  // task was actually given. Left omitted when empty, same as `models` above.
  const mcp = resolveGatewayMcp(project, task);
  if (mcp.length) body.object_permission = { mcp_servers: mcp };

  const res = await adminCall("/key/generate", body);
  if (!res.ok) {
    warnOnce("mint", res.detail);
    return;
  }
  clearWarned("mint");
  const key = res.body && typeof res.body === "object" ? (res.body as { key?: unknown }).key : undefined;
  if (typeof key !== "string" || !key) {
    warnOnce("mint", "response carried no key");
    return;
  }
  setTaskGatewayKey(task.id, key);
  task.gateway_key = key;
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

/**
 * Best-effort POST /key/delete for `taskId`'s minted key, if it has one. Safe
 * to call on a task with no key (a no-op) or repeatedly (idempotent: the
 * column clears only once a delete is believed to have taken).
 *
 * On a network/5xx failure the column stays set, so sweepPrunableGatewayKeys()
 * can retry later instead of orphaning a live key on LiteLLM's side with no
 * local record of it. A 404-shaped "key not found" counts as success, since
 * LiteLLM already agrees there's nothing left to delete.
 */
export async function deleteTaskGatewayKey(taskId: string): Promise<void> {
  if (!gatewayKeysEnabled()) return;
  const state = taskGatewayKeyState(taskId);
  if (!state?.key) return;
  const res = await adminCall("/key/delete", { keys: [state.key] });
  if (!res.ok && !/not found|no such key|404/i.test(res.detail)) {
    warnOnce("delete", res.detail);
    return;
  }
  clearWarned("delete");
  setTaskGatewayKey(taskId, "");
}

/**
 * The retention backstop (docs/AGENTS.md): finds any task that is terminal,
 * idle and has no pending follow-up (prunableTaskIds()'s own predicate,
 * reused verbatim) but still carries a live key, because the real-time
 * delete in lib/autoStart.ts's maybeAutoStartDependents() didn't run for it
 * (a process crash, a bug, a row edited directly).
 *
 * `cutoff = now` makes prunableTaskIds() ignore its own age window: a
 * forgotten key is a live credential on LiteLLM's proxy regardless of how
 * long ago the task went terminal, unlike transcript/usage rows, which
 * retention ages out on a clock measured in months. Called from
 * lib/scheduler.ts's ticker alongside maybeSweepRetention and
 * maybeSweepWorktrees, on the same cadence, only when keys are on.
 */
export async function sweepPrunableGatewayKeys(now = Date.now()): Promise<number> {
  if (!gatewayKeysEnabled()) return 0;
  let deleted = 0;
  for (const id of prunableTaskIds(now, now)) {
    const state = taskGatewayKeyState(id);
    if (!state?.key) continue;
    await deleteTaskGatewayKey(id);
    if (!taskGatewayKeyState(id)?.key) deleted++;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

/**
 * Exact spend reconciliation (docs/AGENTS.md): no CLI exposes
 * `x-litellm-response-cost`, so this reads GET /key/info on the task's own
 * key (a key may read its own info, no admin key needed) and records the
 * delta between its cumulative `spend` and the baseline this module last
 * saw, as a task_usage correction row. That makes the task's running total
 * match LiteLLM's ledger exactly, replacing Calandria's own per-token
 * estimate (lib/gatewayPricing.ts), which still runs live during the turn so
 * the on-screen ledger has something to show as it streams.
 *
 * Called fire-and-forget from lib/runner.ts's finally, never awaited, so it
 * cannot delay turn_end or interleave with that block's synchronous settle.
 * Guards its own staleness: if the task's key changed (rotated, cleared)
 * since the turn that's reconciling started, this is a no-op instead of
 * crediting spend to a key that's no longer the task's.
 */
export async function reconcileTaskGatewaySpend(input: {
  taskId: string;
  projectId: string;
  generation: number;
  key: string;
  host: string;
  agent: string;
}): Promise<void> {
  const gw = gatewayBaseUrl();
  if (!gw || !input.key) return;
  const state = taskGatewayKeyState(input.taskId);
  if (!state?.key || state.key !== input.key) return;
  let spend: number;
  try {
    const r = await fetch(`${gw}/key/info`, {
      signal: AbortSignal.timeout(LITELLM_KEY_TIMEOUT_MS),
      headers: { accept: "application/json", "x-litellm-api-key": `Bearer ${input.key}` },
      cache: "no-store",
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      warnOnce("reconcile", /database not connected|db not connected/i.test(text) ? "LiteLLM has no database" : `${r.status} ${r.statusText}`);
      return;
    }
    const body = (await r.json()) as { info?: { spend?: unknown } };
    const s = body?.info?.spend;
    if (typeof s !== "number" || !Number.isFinite(s)) return;
    spend = s;
  } catch (e) {
    warnOnce("reconcile", reason(e));
    return;
  }
  clearWarned("reconcile");
  // Guards against a spend figure that went backwards (a key rotated or
  // reset server-side between reads): clamps instead of recording a negative
  // delta that would subtract from the task's total for no real reason.
  const delta = Math.max(0, spend - state.spend);
  setTaskGatewayKeySpend(input.taskId, spend);
  if (delta < 0.000001) return;
  addUsage({
    project_id: input.projectId,
    task_id: input.taskId,
    generation: input.generation,
    agent: input.agent,
    provider: input.host,
    usage: { cost_usd: delta, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
  });
}
