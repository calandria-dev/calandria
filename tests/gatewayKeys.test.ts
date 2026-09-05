import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject, createTask, getTask, listTasks, updateProject, taskGatewayKeyState, setTaskGatewayKey } from "../lib/store";
import { getDb } from "../lib/db";
import { startFakeGateway, type FakeGateway } from "./fakeGateway";
import type { Project, Task } from "../lib/types";

// Per-task LiteLLM virtual keys and exact spend reconciliation
// (docs/AGENTS.md, "Per-task virtual keys"; lib/gatewayKeys.ts).
//
// gatewayKeysEnabled(), ensureTaskGatewayKey(), deleteTaskGatewayKey(),
// sweepPrunableGatewayKeys() and reconcileTaskGatewaySpend() all read
// lib/config.ts's LITELLM_ADMIN_KEY, a const resolved at import time from
// CALANDRIA_LITELLM_ADMIN_KEY. lib/agentEnv.ts's gatewayBaseUrl() instead
// re-reads CALANDRIA_LITELLM_BASE_URL live on every call. Changing the admin
// key between tests needs a module reset before re-importing
// lib/gatewayKeys.ts, the same recipe tests/storageDefaults.test.ts's
// bootStore() uses for its own import-time config. getDb() memoizes the
// connection on globalThis, so resetting the module graph does not open a
// second database or lose fixture rows created through the top-level
// lib/store.ts import, which is never reset.
const ADMIN_KEY = "test-admin-key";

async function loadGatewayKeys(opts: { adminKey?: string; baseUrl?: string } = {}) {
  if (opts.adminKey === undefined) delete process.env.CALANDRIA_LITELLM_ADMIN_KEY;
  else process.env.CALANDRIA_LITELLM_ADMIN_KEY = opts.adminKey;
  if (opts.baseUrl === undefined) delete process.env.CALANDRIA_LITELLM_BASE_URL;
  else process.env.CALANDRIA_LITELLM_BASE_URL = opts.baseUrl;
  vi.resetModules();
  return (await import("../lib/gatewayKeys")) as typeof import("../lib/gatewayKeys");
}

let gw: FakeGateway | null = null;
let savedAdmin: string | undefined;
let savedBase: string | undefined;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  savedAdmin = process.env.CALANDRIA_LITELLM_ADMIN_KEY;
  savedBase = process.env.CALANDRIA_LITELLM_BASE_URL;
  // gatewayKeys.ts warns at most once per instance-wide `warned` Set kept on
  // globalThis (see its warnOnce/clearWarned). That set survives a module
  // reset, so a fixed instance still logs again if it breaks a second time.
  // Console noise is silenced here; a couple of tests assert on the message
  // directly via the spy.
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  warnSpy.mockRestore();
  await gw?.close();
  gw = null;
  if (savedAdmin === undefined) delete process.env.CALANDRIA_LITELLM_ADMIN_KEY;
  else process.env.CALANDRIA_LITELLM_ADMIN_KEY = savedAdmin;
  if (savedBase === undefined) delete process.env.CALANDRIA_LITELLM_BASE_URL;
  else process.env.CALANDRIA_LITELLM_BASE_URL = savedBase;
  // Clear the warned-once memory between tests so each one starts fresh.
  (globalThis as { __calandriaGatewayKeyWarned?: Set<string> }).__calandriaGatewayKeyWarned?.clear();
});

/** A project whose turns run against the fake gateway (ANTHROPIC_BASE_URL ==
 *  the gateway's own origin), so taskProvider() reports kind "gateway". */
async function gatewayProject(): Promise<Project> {
  const project = createProject({ name: `gw-${Math.random().toString(36).slice(2)}` });
  return updateProject(project.id, { agent_env: JSON.stringify({ ANTHROPIC_BASE_URL: gw!.url }) })!;
}

/** A project with no provider override at all; taskProvider() reports "cloud". */
function cloudProject(): Project {
  return createProject({ name: `cloud-${Math.random().toString(36).slice(2)}` });
}

function makeTask(project: Project, title = "task"): Task {
  return createTask({ project_id: project.id, title });
}

describe("gatewayKeysEnabled", () => {
  it("is false with no admin key even when a gateway is configured", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ baseUrl: gw.url });
    expect(gk.gatewayKeysEnabled()).toBe(false);
  });

  it("is false with an admin key but no gateway configured", async () => {
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY });
    expect(gk.gatewayKeysEnabled()).toBe(false);
  });

  it("is true with both an admin key and a gateway", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    expect(gk.gatewayKeysEnabled()).toBe(true);
  });
});

describe("ensureTaskGatewayKey", () => {
  it("mints a key on a gateway task's first call and persists it", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    const project = await gatewayProject();
    const task = makeTask(project);

    const live = getTask(task.id)!;
    expect(live.gateway_key).toBe(""); // redacted even before minting
    await gk.ensureTaskGatewayKey(live, project);

    expect(live.gateway_key).not.toBe("");
    expect(gw.mintedKeys.size).toBe(1);
    expect([...gw.mintedKeys.keys()]).toContain(live.gateway_key);

    // Written to the DB too, not just the in-memory task object.
    const state = taskGatewayKeyState(task.id);
    expect(state?.key).toBe(live.gateway_key);
    expect(state?.spend).toBe(0);
  });

  it("reuses the same key on a second call without minting again", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    const project = await gatewayProject();
    const task = makeTask(project);

    const first = getTask(task.id)!;
    await gk.ensureTaskGatewayKey(first, project);
    const mintedKey = first.gateway_key;
    const generateCalls = gw.calls.filter((c) => c.path === "/key/generate").length;
    expect(generateCalls).toBe(1);

    const second = getTask(task.id)!;
    await gk.ensureTaskGatewayKey(second, project);
    expect(second.gateway_key).toBe(mintedKey);
    expect(gw.calls.filter((c) => c.path === "/key/generate").length).toBe(1);
  });

  it("scopes a minted key to the project's hosted-MCP selection via object_permission.mcp_servers", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    let project = await gatewayProject();
    project = updateProject(project.id, { gateway_mcp: JSON.stringify(["demo", "search"]) })!;
    const task = makeTask(project);

    const live = getTask(task.id)!;
    await gk.ensureTaskGatewayKey(live, project);

    const minted = gw.mintedKeys.get(live.gateway_key);
    expect(minted?.object_permission).toEqual({ mcp_servers: ["demo", "search"] });
  });

  it("omits object_permission entirely when the project selected no hosted MCP servers", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    const project = await gatewayProject();
    const task = makeTask(project);

    const live = getTask(task.id)!;
    await gk.ensureTaskGatewayKey(live, project);

    const minted = gw.mintedKeys.get(live.gateway_key);
    expect(minted?.object_permission).toBeUndefined();
  });

  it("never calls /key/generate for a non-gateway (plain cloud) task", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    const project = cloudProject();
    const task = makeTask(project);

    const live = getTask(task.id)!;
    await gk.ensureTaskGatewayKey(live, project);

    expect(live.gateway_key).toBe("");
    expect(gw.calls.some((c) => c.path === "/key/generate")).toBe(false);
    expect(gw.mintedKeys.size).toBe(0);
  });

  it("with gatewayKeysEnabled() false (no admin key), never calls /key/generate", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ baseUrl: gw.url }); // no adminKey
    const project = await gatewayProject();
    const task = makeTask(project);

    const live = getTask(task.id)!;
    await gk.ensureTaskGatewayKey(live, project);

    expect(live.gateway_key).toBe("");
    expect(gw.calls.some((c) => c.path === "/key/generate")).toBe(false);
  });

  it("falls back silently (no throw) when the gateway has no database", async () => {
    gw = await startFakeGateway({ database: false, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    const project = await gatewayProject();
    const task = makeTask(project);

    const live = getTask(task.id)!;
    await expect(gk.ensureTaskGatewayKey(live, project)).resolves.toBeUndefined();
    expect(live.gateway_key).toBe("");
    expect(taskGatewayKeyState(task.id)?.key).toBe("");
  });
});

describe("deleteTaskGatewayKey", () => {
  it("deletes a task's key and clears the DB column", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    const project = await gatewayProject();
    const task = makeTask(project);
    const live = getTask(task.id)!;
    await gk.ensureTaskGatewayKey(live, project);
    const mintedKey = live.gateway_key;
    expect(mintedKey).not.toBe("");

    await gk.deleteTaskGatewayKey(task.id);

    expect(taskGatewayKeyState(task.id)?.key).toBe("");
    expect(gw.mintedKeys.has(mintedKey)).toBe(false);
    expect(gw.calls.some((c) => c.path === "/key/delete")).toBe(true);
  });

  it("is a no-op (no fetch at all) for a task with no key", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    const project = cloudProject();
    const task = makeTask(project);

    await gk.deleteTaskGatewayKey(task.id);

    expect(gw.calls.length).toBe(0);
  });

  it("leaves the column set (not cleared) on a gateway failure, so a retry can happen later", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    const project = await gatewayProject();
    const task = makeTask(project);
    const live = getTask(task.id)!;
    await gk.ensureTaskGatewayKey(live, project);
    const mintedKey = live.gateway_key;

    // Simulate the gateway going unreachable for the delete call.
    await gw.close();
    gw = null;
    process.env.CALANDRIA_LITELLM_BASE_URL = "http://127.0.0.1:1";

    await gk.deleteTaskGatewayKey(task.id);

    expect(taskGatewayKeyState(task.id)?.key).toBe(mintedKey);
  });
});

describe("sweepPrunableGatewayKeys", () => {
  it("deletes only prunable (terminal, idle, cold) tasks' keys", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    const project = await gatewayProject();

    const prunableA = makeTask(project, "prunable a");
    const prunableB = makeTask(project, "prunable b");
    const liveTask = makeTask(project, "still running");

    for (const t of [prunableA, prunableB, liveTask]) {
      const live = getTask(t.id)!;
      await gk.ensureTaskGatewayKey(live, project);
      expect(live.gateway_key).not.toBe("");
    }

    const db = getDb();
    const markTerminal = (id: string) =>
      db
        .prepare(
          `UPDATE tasks SET status = 'done', running = 0, awaiting_input = 0, unread_run_at = 0, snoozed_until = 0 WHERE id = ?`
        )
        .run(id);
    markTerminal(prunableA.id);
    markTerminal(prunableB.id);
    // liveTask stays not_started/running=0 but is NOT terminal, so prunableTaskIds()
    // must never select it regardless of its running flag.

    const deleted = await gk.sweepPrunableGatewayKeys(Date.now());

    expect(deleted).toBe(2);
    expect(taskGatewayKeyState(prunableA.id)?.key).toBe("");
    expect(taskGatewayKeyState(prunableB.id)?.key).toBe("");
    expect(taskGatewayKeyState(liveTask.id)?.key).not.toBe("");
  });

  it("is a no-op with gatewayKeysEnabled() false", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ baseUrl: gw.url }); // no admin key
    const project = cloudProject();
    const task = makeTask(project);
    const db = getDb();
    db.prepare(`UPDATE tasks SET status = 'done', running = 0, awaiting_input = 0 WHERE id = ?`).run(task.id);

    const deleted = await gk.sweepPrunableGatewayKeys(Date.now());
    expect(deleted).toBe(0);
    expect(gw.calls.length).toBe(0);
  });
});

describe("reconcileTaskGatewaySpend", () => {
  it("records a task_usage row for the delta on the first call", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    const project = await gatewayProject();
    const task = makeTask(project);
    const live = getTask(task.id)!;
    await gk.ensureTaskGatewayKey(live, project);
    const key = live.gateway_key;
    gw.setKeySpend(key, 0.05);

    await gk.reconcileTaskGatewaySpend({
      taskId: task.id,
      projectId: project.id,
      generation: 1,
      key,
      host: "gateway",
      agent: "claude",
    });

    const rows = getDb().prepare("SELECT * FROM task_usage WHERE task_id = ?").all(task.id) as {
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
    }[];
    expect(rows.length).toBe(1);
    expect(rows[0].cost_usd).toBeCloseTo(0.05, 6);
    expect(rows[0].input_tokens).toBe(0);
    expect(rows[0].output_tokens).toBe(0);
    expect(rows[0].cache_read_tokens).toBe(0);
    expect(rows[0].cache_creation_tokens).toBe(0);
    expect(taskGatewayKeyState(task.id)?.spend).toBeCloseTo(0.05, 6);
  });

  it("records only the new delta on a second call, not the cumulative total again", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    const project = await gatewayProject();
    const task = makeTask(project);
    const live = getTask(task.id)!;
    await gk.ensureTaskGatewayKey(live, project);
    const key = live.gateway_key;

    gw.setKeySpend(key, 0.05);
    await gk.reconcileTaskGatewaySpend({ taskId: task.id, projectId: project.id, generation: 1, key, host: "gateway", agent: "claude" });

    gw.setKeySpend(key, 0.12);
    await gk.reconcileTaskGatewaySpend({ taskId: task.id, projectId: project.id, generation: 2, key, host: "gateway", agent: "claude" });

    const rows = getDb().prepare("SELECT cost_usd FROM task_usage WHERE task_id = ? ORDER BY created_at ASC").all(task.id) as {
      cost_usd: number;
    }[];
    expect(rows.length).toBe(2);
    expect(rows[0].cost_usd).toBeCloseTo(0.05, 6);
    expect(rows[1].cost_usd).toBeCloseTo(0.07, 6);
    expect(taskGatewayKeyState(task.id)?.spend).toBeCloseTo(0.12, 6);
  });

  it("is a no-op when the task's stored key no longer matches input.key (rotated/deleted)", async () => {
    gw = await startFakeGateway({ database: true, adminKey: ADMIN_KEY });
    const gk = await loadGatewayKeys({ adminKey: ADMIN_KEY, baseUrl: gw.url });
    const project = await gatewayProject();
    const task = makeTask(project);
    const live = getTask(task.id)!;
    await gk.ensureTaskGatewayKey(live, project);
    const staleKey = live.gateway_key;

    // Rotate: delete the old key and mint a fresh one directly on the DB, as if
    // another turn had already reconciled and moved on.
    setTaskGatewayKey(task.id, "sk-fake-rotated");

    await gk.reconcileTaskGatewaySpend({
      taskId: task.id,
      projectId: project.id,
      generation: 1,
      key: staleKey,
      host: "gateway",
      agent: "claude",
    });

    const rows = getDb().prepare("SELECT * FROM task_usage WHERE task_id = ?").all(task.id);
    expect(rows.length).toBe(0);
  });
});

describe("gateway_key redaction", () => {
  it("getTask and listTasks never return the real key even after setTaskGatewayKey", () => {
    const project = cloudProject();
    const task = makeTask(project);
    setTaskGatewayKey(task.id, "sk-real-secret");

    expect(getTask(task.id)!.gateway_key).toBe("");

    const rows = listTasks(project.id);
    const row = rows.find((t) => t.id === task.id)!;
    expect(row.gateway_key).toBe("");
  });
});
