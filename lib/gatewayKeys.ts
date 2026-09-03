// Per-task LiteLLM virtual keys and exact spend reconciliation
// (docs/design/litellm.md, "Per-task virtual keys"). Opt-in behind
// CALANDRIA_LITELLM_ADMIN_KEY: unset, this whole module is inert and every
// gateway turn keeps running on the shared instance key.
//
// SDK-free and Node-free beyond fetch (lib/store.ts for the task's key column,
// lib/retention.ts for the terminal/idle predicate, lib/agentEnv.ts for the
// provider description) — mirrors lib/gatewayHealth.ts and lib/gatewayModels.ts,
// so it can sit beside them in tests/importGraph.test.ts's SDK-free PINNED set.
// Must never import lib/runner.ts or lib/agents/registry.ts: lib/runner.ts
// imports THIS module (to mint a key before a turn and reconcile spend after
// one), and the opposite edge would be the exact cycle CLAUDE.md's "nothing
// behind registry.ts may import a launcher back" warns about.
//
// Three operations, each best-effort and never blocking the turn it's part of:
//
//  - mint (ensureTaskGatewayKey): POST /key/generate on a task's first gateway
//    turn, called from lib/runner.ts before the driver runs. Idempotent — a
//    task that already has a key just reuses it — and silent on failure: no
//    admin key, no gateway, a non-gateway task, or an unreachable/DB-less
//    proxy all fall back to the instance key exactly as if this module didn't
//    exist. The one thing it does on failure is log ONCE, instance-wide,
//    since a live turn is the wrong place to surface a config problem loudly
//    (the gateway health card already says "Database not connected" for the
//    same underlying condition).
//  - delete (deleteTaskGatewayKey): POST /key/delete when a task reaches a
//    terminal status (called from lib/autoStart.ts's maybeAutoStartDependents,
//    the one place every terminal-transition call site already converges —
//    see its own comment) and again from sweepPrunableGatewayKeys(), the
//    backstop lib/scheduler.ts's ticker runs alongside the retention sweep,
//    for any task that went terminal without that call ever firing (a crash,
//    a bug, a direct DB edit).
//  - reconcile (reconcileTaskGatewaySpend): GET /key/info after a turn ends,
//    fired-and-forgotten from lib/runner.ts's finally so it can never delay
//    turn_end or interleave with that block's synchronous settle. Writes a
//    CORRECTING task_usage row — the delta between LiteLLM's cumulative spend
//    and the baseline this module last recorded — rather than a second
//    estimate, so a task's total ends up EXACTLY what LiteLLM's own ledger
//    says regardless of what the live per-turn estimate guessed.

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

// Logged once, instance-wide, per kind of failure — a live turn is the wrong
// place for a config problem to shout, and the gateway health card (Settings
// -> Agents) already states the "Database not connected" case for /key/info.
// Reset on the next SUCCESS of the same kind, so a fixed instance logs again
// if it breaks a second time rather than staying silent forever.
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
      // The documented no-database answer (measured: 500 "Database not
      // connected"), not a transient outage — distinguished so the one log
      // line names the actual cause rather than a bare status code.
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
 * `task` object — the same self-heal-in-place pattern lib/runner.ts already
 * uses for `worktree_path` (see lib/runner.ts's startResumeTurn). Called from
 * `run()` before the driver runs, so `lib/agentEnv.ts`'s `agentTurnEnv()`
 * sees the real key on `task.gateway_key` when it builds the turn's env.
 *
 * A no-op (leaves `task.gateway_key` at "") when: per-task keys are off, the
 * task isn't running against the gateway at all, or the task already has a
 * key from an earlier turn — minting is a one-time event per task, not a
 * per-turn one. `project` is the task's own project row, read fresh by the
 * caller (not derived here) since lib/runner.ts already has it in scope.
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
    // Naming the project and task on both metadata (LiteLLM's own UI reads
    // this) and tags (what its spend views group and filter by) — the same
    // pair of facts lib/agentEnv.ts's applyGatewayEnv() puts in x-litellm-tags
    // for the instance-key path, so a per-task key's own ledger entries read
    // the same way LiteLLM's UI already shows tagged instance-key spend.
    metadata: { calandria_project: project.id, calandria_project_name: project.name, calandria_task: task.id, calandria_task_title: task.title },
    tags: ["calandria", `project:${project.id}`, `task:${task.id}`],
  };
  // The project's picker choice, if one is pinned — omitted (LiteLLM allows
  // every model the admin key can see) rather than sent empty, since an empty
  // `models: []` on /key/generate means "no models allowed", the opposite of
  // "unrestricted".
  if (provider.model) body.models = [provider.model];
  if (project.gateway_max_budget != null) body.max_budget = project.gateway_max_budget;
  if (project.gateway_key_duration) body.duration = project.gateway_key_duration;
  // Hosted MCP servers (docs/design/litellm.md, "Hosted MCP servers"): the
  // task's resolved selection scopes the minted key itself, so a per-task key
  // can only reach the servers this task was actually given — omitted rather
  // than sent empty for the same reason `models` is above.
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
 * column is cleared only once a delete is believed to have taken).
 *
 * On a network/5xx failure the column is LEFT SET rather than cleared, so
 * sweepPrunableGatewayKeys() can retry a transient failure later instead of
 * silently orphaning a live key on LiteLLM's side with no local record of it.
 * A 404-shaped "key not found" is treated as success — LiteLLM already agrees
 * there's nothing left to delete.
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
 * The retention backstop (docs/design/litellm.md: "again from
 * lib/retention.ts prunableTaskIds()"): any task that is terminal, idle and
 * has no pending follow-up — prunableTaskIds()'s own predicate, reused
 * verbatim rather than a second one — but still carries a live key, because
 * the real-time delete in lib/autoStart.ts's maybeAutoStartDependents()
 * didn't run for it (the process was down, a bug, a row edited directly).
 *
 * `cutoff = now` deliberately makes prunableTaskIds() ignore its own age
 * window: a forgotten KEY is a live credential sitting on LiteLLM's proxy
 * whether the task went terminal a minute ago or six months ago, unlike the
 * transcript/usage rows retention otherwise ages out on a clock measured in
 * months. Called from lib/scheduler.ts's ticker alongside maybeSweepRetention
 * and maybeSweepWorktrees, on the same cadence, and only when keys are on.
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
 * Exact spend reconciliation (docs/design/litellm.md: "the only exact
 * per-task path" — no CLI exposes `x-litellm-response-cost` and `/spend/logs`
 * has no tag filter or pagination, BerriAI/litellm#14218). GET /key/info on
 * the task's OWN key — a key may read its own info, no admin key needed —
 * and record the delta between its cumulative `spend` and the baseline this
 * module last saw as a task_usage CORRECTION row, so the task's running total
 * ends up exactly what LiteLLM's ledger says instead of Calandria's own
 * per-token estimate (lib/gatewayPricing.ts), which still runs live during
 * the turn for the on-screen ledger to have SOMETHING to show as it streams.
 *
 * Called fire-and-forget from lib/runner.ts's finally — never awaited there,
 * so it cannot delay turn_end or interleave with that block's synchronous
 * settle. Guards its own staleness: if the task's key changed (rotated,
 * cleared) since the turn that's reconciling started, this is a no-op rather
 * than crediting spend to a key that's no longer the task's.
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
  // Guard against a spend figure that went BACKWARDS (a key rotated/reset
  // server-side between reads) — clamp rather than record a negative delta
  // that would silently subtract from the task's total for no real reason.
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
