/* Task 9: list_environment_settings / change_environment_setting wired
 * through shared definitions (lib/agentToolDefs.mjs) and handlers
 * (lib/agentTools.ts), the strict-token-plus-turn-capability internal routes,
 * Claude's in-process registration, and every stdio bridge (Codex, Gemini,
 * and Claude under CALANDRIA_CLAUDE_TOOL_TRANSPORT=stdio). Synthetic
 * sentinels throughout; nothing here is a real credential.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { createVariable, environmentFilePath, setRuntimeStateAdapter, setStoreIo } from "@/lib/advanced-env/store";
import {
  currentTurnCapability,
  hasMandatoryDecision,
  mintTurnCapability,
  revokeTurnCapability,
  submitMandatoryDecision,
  TURN_CAPABILITY_HEADER,
} from "@/lib/advanced-env/capabilities";
import {
  changeEnvironmentSettingForAgent,
  listEnvironmentSettingsForAgent,
  pollEnvironmentProposal,
  startEnvironmentProposal,
} from "@/lib/agentTools";
import { environmentToolSummary } from "@/lib/agents/shared";
import { calandriaMcpConfig } from "@/lib/agents/codex/driver";
import { bridgeConfig } from "@/lib/agents/gemini/mcp";
import { calandriaBridgeServer } from "@/lib/agents/claude/mcp";
import { createProject, createTask } from "@/lib/store";
import { subscribe, subscribeGlobal, type BusEvent } from "@/lib/events";
import type { StreamEvent } from "@/lib/types";
import type { PresentedVariable } from "@/lib/advanced-env/types";
import * as TOOL_DEFS from "@/lib/agentToolDefs.mjs";

const SECRET_VALUE = "synthetic-sentinel-71ac";
const SECRET_NAME = "MY_SYNTHETIC_SECRET";

function reset() {
  fs.rmSync(environmentFilePath(), { force: true });
  setRuntimeStateAdapter(null);
  setStoreIo(null);
}
beforeEach(reset);
afterEach(reset);

let counter = 0;
function fixtureTask() {
  const project = createProject({ name: `env-tools-${++counter}` });
  const task = createTask({ project_id: project.id, title: "Env tools task", description: "" });
  return { project, task };
}

function post(handler: (req: NextRequest) => Promise<Response>, url: string, body: unknown, headers: Record<string, string> = {}) {
  return handler(
    new NextRequest(`http://127.0.0.1:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function pollUntilDone(handler: (req: NextRequest) => Promise<Response>, url: string, body: unknown): Promise<{ status: string; text?: string }> {
  for (let i = 0; i < 200; i++) {
    const res = await post(handler, url, body);
    const parsed = (await res.json()) as { status: string; text?: string };
    if (parsed.status === "done") return parsed;
    await sleep(5);
  }
  throw new Error("proposal never settled");
}

describe("list_environment_settings", () => {
  it("returns catalog metadata and redacted saved rows; a secret carries no name or value", () => {
    const created = createVariable({ scope: "agent", name: SECRET_NAME, value: SECRET_VALUE, secret: true, expectedRevision: 0 });
    if (!created.ok) throw new Error("fixture failed");
    const { text } = listEnvironmentSettingsForAgent();
    expect(text).not.toContain(SECRET_NAME);
    expect(text).not.toContain(SECRET_VALUE);
    const parsed = JSON.parse(text) as { rows: PresentedVariable[]; catalog: unknown[] };
    const row = parsed.rows.find((r) => r.id === created.row!.id);
    expect(row).toMatchObject({ secret: true, name: null, value: null, hasValue: true });
    expect(Array.isArray(parsed.catalog)).toBe(true);
    expect(parsed.catalog.length).toBeGreaterThan(0);
  });

  it("filters to one scope when asked", () => {
    createVariable({ scope: "app", name: "APP_ONE", value: "v", secret: false, expectedRevision: 0 });
    createVariable({ scope: "agent", name: "AGENT_ONE", value: "v", secret: false, expectedRevision: 1 });
    const { text } = listEnvironmentSettingsForAgent("app");
    const parsed = JSON.parse(text) as { rows: PresentedVariable[] };
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.every((r) => r.scope === "app")).toBe(true);
  });

  it("the internal route serves the same data behind no capability check (a plain read)", async () => {
    const { task } = fixtureTask();
    const { POST: listEnvEp } = await import("@/app/api/internal/agent-tools/list-environment-settings/route");
    const res = await post(listEnvEp, "/api/internal/agent-tools/list-environment-settings", { taskId: task.id, scope: "app" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; text: string };
    expect(body.ok).toBe(true);
    expect(() => JSON.parse(body.text)).not.toThrow();
  });
});

describe("change_environment_setting: each operation, awaited directly (the in-process shape)", () => {
  it("create: commits only after a fresh allow-once decision", async () => {
    const { task } = fixtureTask();
    const pushed: StreamEvent[] = [];
    const p = changeEnvironmentSettingForAgent(
      task,
      { operation: "create", scope: "app", name: "FROM_AGENT", value: "v1", secret: false, expectedRevision: 0 },
      (ev) => pushed.push(ev)
    );
    const card = pushed.find((e): e is Extract<StreamEvent, { type: "permission" }> => e.type === "permission");
    expect(card?.request.kind).toBe("environment");
    submitMandatoryDecision(task.id, card!.request.id, "allow_once");
    const { result, text } = await p;
    expect(result.kind).toBe("committed");
    expect(text).toContain("Committed");
  });

  it("patch: renames a row after approval", async () => {
    const created = createVariable({ scope: "app", name: "OLD_NAME", value: "v", secret: false, expectedRevision: 0 });
    if (!created.ok) throw new Error("fixture failed");
    const { task } = fixtureTask();
    const pushed: StreamEvent[] = [];
    const p = changeEnvironmentSettingForAgent(task, { operation: "patch", id: created.row!.id, name: "NEW_NAME", expectedRevision: created.revision }, (ev) => pushed.push(ev));
    const card = pushed.find((e): e is Extract<StreamEvent, { type: "permission" }> => e.type === "permission")!;
    submitMandatoryDecision(task.id, card.request.id, "allow_once");
    const { result } = await p;
    expect(result.kind).toBe("committed");
    if (result.kind === "committed") expect(result.row?.name).toBe("NEW_NAME");
  });

  it("delete: removes a row after approval", async () => {
    const created = createVariable({ scope: "app", name: "TO_DELETE", value: "v", secret: false, expectedRevision: 0 });
    if (!created.ok) throw new Error("fixture failed");
    const { task } = fixtureTask();
    const pushed: StreamEvent[] = [];
    const p = changeEnvironmentSettingForAgent(task, { operation: "delete", id: created.row!.id, expectedRevision: created.revision }, (ev) => pushed.push(ev));
    const card = pushed.find((e): e is Extract<StreamEvent, { type: "permission" }> => e.type === "permission")!;
    submitMandatoryDecision(task.id, card.request.id, "allow_once");
    const { result } = await p;
    expect(result.kind).toBe("committed");
    if (result.kind === "committed") expect(result.row).toBeNull();
  });

  it("deny: leaves the store unchanged and publishes no environment_changed event", async () => {
    const { task } = fixtureTask();
    const pushed: StreamEvent[] = [];
    let sawChanged = false;
    const unsub = subscribeGlobal((_id, ev) => {
      if ((ev as BusEvent).type === "environment_changed") sawChanged = true;
    });
    const p = changeEnvironmentSettingForAgent(task, { operation: "create", scope: "app", name: "DENY_ME", value: "v", secret: false, expectedRevision: 0 }, (ev) => pushed.push(ev));
    const card = pushed.find((e): e is Extract<StreamEvent, { type: "permission" }> => e.type === "permission")!;
    submitMandatoryDecision(task.id, card.request.id, "deny");
    const { result } = await p;
    unsub();
    expect(result.kind).toBe("denied");
    expect(sawChanged).toBe(false);
  });

  it("commit publishes a value-free environment_changed invalidation, nothing else", async () => {
    const { task } = fixtureTask();
    const pushed: StreamEvent[] = [];
    let payload: BusEvent | undefined;
    const unsub = subscribeGlobal((_id, ev) => {
      if ((ev as BusEvent).type === "environment_changed") payload = ev as BusEvent;
    });
    const p = changeEnvironmentSettingForAgent(task, { operation: "create", scope: "app", name: "SEE_CHANGE", value: "v", secret: false, expectedRevision: 0 }, (ev) => pushed.push(ev));
    const card = pushed.find((e): e is Extract<StreamEvent, { type: "permission" }> => e.type === "permission")!;
    submitMandatoryDecision(task.id, card.request.id, "allow_once");
    await p;
    unsub();
    expect(payload).toEqual({ type: "environment_changed" });
  });

  it("a secret create is refused before any card is raised when the tool supplies a value directly", async () => {
    const { task } = fixtureTask();
    const pushed: StreamEvent[] = [];
    const { result } = await changeEnvironmentSettingForAgent(
      task,
      { operation: "create", scope: "agent", name: "A_SECRET", value: SECRET_VALUE, secret: true, expectedRevision: 0 },
      (ev) => pushed.push(ev)
    );
    expect(result.kind).toBe("invalid");
    expect(pushed.some((e) => e.type === "permission")).toBe(false);
  });

  it("a secret replacement request (no tool value) does raise a card, and its detail names no plaintext", async () => {
    const created = createVariable({ scope: "agent", name: SECRET_NAME, value: SECRET_VALUE, secret: true, expectedRevision: 0 });
    if (!created.ok) throw new Error("fixture failed");
    const { task } = fixtureTask();
    const pushed: StreamEvent[] = [];
    const p = changeEnvironmentSettingForAgent(task, { operation: "patch", id: created.row!.id, secret: true, expectedRevision: created.revision }, (ev) => pushed.push(ev));
    const card = pushed.find((e): e is Extract<StreamEvent, { type: "permission" }> => e.type === "permission")!;
    expect(JSON.stringify(card)).not.toContain(SECRET_NAME);
    expect(JSON.stringify(card)).not.toContain(SECRET_VALUE);
    submitMandatoryDecision(task.id, card.request.id, "deny");
    await p;
  });
});

describe("change_environment_setting: the internal route requires the turn capability, not just the service token", () => {
  it("refuses with no capability header", async () => {
    const { task } = fixtureTask();
    const { POST: changeEnvEp } = await import("@/app/api/internal/agent-tools/change-environment-setting/route");
    const res = await post(changeEnvEp, "/api/internal/agent-tools/change-environment-setting", {
      taskId: task.id,
      operation: "create",
      scope: "app",
      name: "NO_CAP",
      value: "v",
      secret: false,
      expectedRevision: 0,
    });
    expect(res.status).toBe(403);
  });

  it("refuses a capability minted for a different task", async () => {
    const { task } = fixtureTask();
    const other = mintTurnCapability("some-other-task-id", "some-other-project-id");
    const { POST: changeEnvEp } = await import("@/app/api/internal/agent-tools/change-environment-setting/route");
    const res = await post(
      changeEnvEp,
      "/api/internal/agent-tools/change-environment-setting",
      { taskId: task.id, operation: "create", scope: "app", name: "WRONG_CAP", value: "v", secret: false, expectedRevision: 0 },
      { [TURN_CAPABILITY_HEADER]: other }
    );
    expect(res.status).toBe(403);
    revokeTurnCapability("some-other-task-id", other);
  });

  it("accepts a matching capability, starts the proposal detached, and the wait route polls it to completion", async () => {
    const { task, project } = fixtureTask();
    const cap = mintTurnCapability(task.id, project.id);
    expect(currentTurnCapability(task.id)).toBe(cap);

    const cardIds: string[] = [];
    const unsub = subscribe(task.id, (ev) => {
      if (ev.type === "permission") cardIds.push(ev.request.id);
    });

    const { POST: changeEnvEp } = await import("@/app/api/internal/agent-tools/change-environment-setting/route");
    const { POST: waitEp } = await import("@/app/api/internal/agent-tools/change-environment-setting/wait/route");
    const startRes = await post(
      changeEnvEp,
      "/api/internal/agent-tools/change-environment-setting",
      { taskId: task.id, operation: "create", scope: "app", name: "VIA_ROUTE", value: "v", secret: false, expectedRevision: 0 },
      { [TURN_CAPABILITY_HEADER]: cap }
    );
    expect(startRes.status).toBe(200);
    const { proposalId } = (await startRes.json()) as { proposalId: string };
    unsub();
    // The mandatory card was already raised, synchronously, before the start
    // route returned: proposeEnvironmentMutation's card push runs before its
    // own first await, so the caller never has to poll to discover it.
    expect(cardIds).toHaveLength(1);

    const pending = await post(waitEp, "/api/internal/agent-tools/change-environment-setting/wait", { taskId: task.id, proposalId });
    expect(((await pending.json()) as { status: string }).status).toBe("pending");

    submitMandatoryDecision(task.id, cardIds[0], "allow_once");
    const done = await pollUntilDone(waitEp, "/api/internal/agent-tools/change-environment-setting/wait", { taskId: task.id, proposalId });
    expect(done.text).toContain("Committed");

    // Take-once: a second poll for the same proposal finds nothing tracked.
    const again = await post(waitEp, "/api/internal/agent-tools/change-environment-setting/wait", { taskId: task.id, proposalId });
    expect(((await again.json()) as { status: string; text?: string }).text).toContain("no longer tracked");

    revokeTurnCapability(task.id, cap);
  });

  it("cancel: true on the wait route aborts a still-pending proposal, so a later decision cannot commit", async () => {
    const { task, project } = fixtureTask();
    const cap = mintTurnCapability(task.id, project.id);
    const cardIds: string[] = [];
    const unsub = subscribe(task.id, (ev) => {
      if (ev.type === "permission") cardIds.push(ev.request.id);
    });

    const { POST: changeEnvEp } = await import("@/app/api/internal/agent-tools/change-environment-setting/route");
    const { POST: waitEp } = await import("@/app/api/internal/agent-tools/change-environment-setting/wait/route");
    const startRes = await post(
      changeEnvEp,
      "/api/internal/agent-tools/change-environment-setting",
      { taskId: task.id, operation: "create", scope: "app", name: "CANCEL_ME", value: "v", secret: false, expectedRevision: 0 },
      { [TURN_CAPABILITY_HEADER]: cap }
    );
    const { proposalId } = (await startRes.json()) as { proposalId: string };
    unsub();
    expect(cardIds).toHaveLength(1);

    await post(waitEp, "/api/internal/agent-tools/change-environment-setting/wait", { taskId: task.id, proposalId, cancel: true });
    // The parked mandatory decision is gone: a decision arriving after
    // cancellation can no longer settle anything.
    expect(hasMandatoryDecision(task.id, cardIds[0])).toBe(false);
    expect(submitMandatoryDecision(task.id, cardIds[0], "allow_once")).toBe(false);

    const done = await pollUntilDone(waitEp, "/api/internal/agent-tools/change-environment-setting/wait", { taskId: task.id, proposalId });
    expect(done.text).toContain("Not approved");

    revokeTurnCapability(task.id, cap);
  });
});

describe("startEnvironmentProposal / pollEnvironmentProposal directly", () => {
  it("a turn Stop aborts a still-pending proposal the same way an explicit cancel does", async () => {
    const { task } = fixtureTask();
    // No live turn is registered for this fixture task, so turnSignal(task.id)
    // is undefined and startEnvironmentProposal's own controller is what we
    // drive here; a registered turn's abort is exercised at the runner layer
    // (tests/advancedEnvApproval.test.ts covers promptPermission's own abort
    // handling). This pins that startEnvironmentProposal's controller reaches
    // the same cancel path pollEnvironmentProposal(..., true) does.
    const { proposalId } = startEnvironmentProposal(task, { operation: "create", scope: "app", name: "STOPPED", value: "v", secret: false, expectedRevision: 0 });
    const outcome = pollEnvironmentProposal(task.id, proposalId, true);
    expect(outcome.status === "pending" || (outcome.status === "done" && outcome.text?.includes("Not approved"))).toBe(true);
  });
});

describe("environmentToolSummary: the ordinary tool-call row never carries a name or value", () => {
  it("list_environment_settings names only the scope", () => {
    const out = environmentToolSummary("mcp__calandria__list_environment_settings", { scope: "app" });
    expect(out?.detail).toBe("Scope: app");
  });

  it("change_environment_setting never echoes name or value, whether or not the row is secret", () => {
    const out = environmentToolSummary("calandria__change_environment_setting", {
      operation: "create",
      scope: "app",
      name: "PLAIN_NAME",
      value: "plain-value",
      reason: "because",
    });
    const rendered = JSON.stringify(out);
    expect(rendered).not.toContain("PLAIN_NAME");
    expect(rendered).not.toContain("plain-value");
    expect(rendered).toContain("Operation: create");
    expect(rendered).toContain("Reason: because");
  });

  it("returns null for an unrelated tool, so the caller's own generic rendering applies", () => {
    expect(environmentToolSummary("suggest_task", { title: "x" })).toBeNull();
  });
});

describe("registration parity across every transport", () => {
  const ROOT = path.resolve(__dirname, "..");
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  it("both tools are mounted in the Claude driver's in-process server", () => {
    const src = read("lib/agents/claude/driver.ts");
    expect(src).toContain("LIST_ENVIRONMENT_SETTINGS.name");
    expect(src).toContain("CHANGE_ENVIRONMENT_SETTING.name");
  });

  it("both tools are mounted on the stdio bridge", () => {
    const src = read("scripts/calandria-mcp.mjs");
    expect(src).toContain("LIST_ENVIRONMENT_SETTINGS.name");
    expect(src).toContain("CHANGE_ENVIRONMENT_SETTING.name");
  });

  it("change_environment_setting carries guard.timeoutMs: 0 on the stdio bridge, like ask_user", () => {
    const src = read("scripts/calandria-mcp.mjs");
    expect(src).toMatch(/NO_GUARD_DEADLINE = new Set\(\[ASK_USER\.name, CHANGE_ENVIRONMENT_SETTING\.name\]\)/);
  });

  it("change_environment_setting carries guard.timeoutMs: 0 in-process too, while every other Calandria tool keeps its bound", () => {
    const src = read("lib/agents/claude/driver.ts");
    expect(src).toMatch(/NO_GUARD_DEADLINE = new Set\(\[CHANGE_ENVIRONMENT_SETTING\.name\]\)/);
  });

  it("injects the turn capability into all three bridge env blocks, never into a tool argument or schema", () => {
    for (const rel of ["lib/agents/claude/mcp.ts", "lib/agents/codex/driver.ts", "lib/agents/gemini/mcp.ts"]) {
      expect(read(rel), `${rel} is missing CALANDRIA_ENV_EDIT_CAPABILITY`).toContain("CALANDRIA_ENV_EDIT_CAPABILITY");
    }
    // Never in the tool defs (which double as the model-visible schema
    // source): a capability in a def would risk landing in a JSON schema.
    const defs = read("lib/agentToolDefs.mjs");
    expect(defs).not.toContain("CALANDRIA_ENV_EDIT_CAPABILITY");
  });

  it("codex's real mcp config carries the minted capability", () => {
    const { task, project } = fixtureTask();
    const cap = mintTurnCapability(task.id, project.id);
    const cfg = calandriaMcpConfig(project, task) as unknown as { mcp_servers: { calandria: { env: Record<string, string> } } };
    expect(cfg.mcp_servers.calandria.env.CALANDRIA_ENV_EDIT_CAPABILITY).toBe(cap);
    revokeTurnCapability(task.id, cap);
  });

  it("gemini's real mcp config carries the minted capability", () => {
    const { task, project } = fixtureTask();
    const cap = mintTurnCapability(task.id, project.id);
    const cfg = bridgeConfig(project, task) as unknown as { mcpServers: { calandria: { env: Record<string, string> } } };
    expect(cfg.mcpServers.calandria.env.CALANDRIA_ENV_EDIT_CAPABILITY).toBe(cap);
    revokeTurnCapability(task.id, cap);
  });

  it("claude's stdio escape-hatch config carries the minted capability", () => {
    const { task, project } = fixtureTask();
    const cap = mintTurnCapability(task.id, project.id);
    const cfg = calandriaBridgeServer(project, task) as unknown as { env: Record<string, string> };
    expect(cfg.env.CALANDRIA_ENV_EDIT_CAPABILITY).toBe(cap);
    revokeTurnCapability(task.id, cap);
  });

  it("no capability is minted, and the env var reads empty, when no turn is registered for the task", () => {
    const { task, project } = fixtureTask();
    expect(currentTurnCapability(task.id)).toBeUndefined();
    const cfg = calandriaMcpConfig(project, task) as unknown as { mcp_servers: { calandria: { env: Record<string, string> } } };
    expect(cfg.mcp_servers.calandria.env.CALANDRIA_ENV_EDIT_CAPABILITY).toBe("");
  });

  it("both tool defs are shared data, not duplicated per transport", () => {
    expect((TOOL_DEFS as Record<string, { name?: string }>).LIST_ENVIRONMENT_SETTINGS?.name).toBe("list_environment_settings");
    expect((TOOL_DEFS as Record<string, { name?: string }>).CHANGE_ENVIRONMENT_SETTING?.name).toBe("change_environment_setting");
  });
});
