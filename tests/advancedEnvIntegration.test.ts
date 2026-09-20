/* Task 10: the full-stack seams the per-task unit suites (tasks 1-9) do not
 * chain together on their own.
 *
 * 1. A value saved through the real browser CRUD route reaches a real boot
 *    (lib/advanced-env/bootstrap.mjs), including delete and a host override,
 *    not just a hand-written file (tests/advancedEnvBootstrap.test.ts) or the
 *    route in isolation (tests/advancedEnvRoutes.test.ts).
 * 2. The mandatory approval card survives a task configured for
 *    bypassPermissions: changeEnvironmentSettingForAgent never reads
 *    task.permission_mode, so this pins that a later "skip the card when the
 *    task trusts itself" change would be a regression, not a refactor.
 * 3. A secret's plaintext, staged through the real browser decision route,
 *    never reaches the persisted transcript row, a published event, or a
 *    console log line, end to end through the same internal routes and
 *    persistingEnvPush() path the stdio bridge uses in production.
 *
 * Synthetic sentinels throughout; nothing here is a real credential.
 */
import fs from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/settings/environment/route";
import { DELETE } from "@/app/api/settings/environment/[id]/route";
import { applyAppEnvironment, APPLIED_ENV_SLOT } from "@/lib/advanced-env/bootstrap.mjs";
import { createVariable, environmentFilePath, savedRows, setRuntimeStateAdapter, setStoreIo } from "@/lib/advanced-env/store";
import { mintTurnCapability, revokeTurnCapability, submitMandatoryDecision, TURN_CAPABILITY_HEADER } from "@/lib/advanced-env/capabilities";
import { createProject, createTask, listMessages } from "@/lib/store";
import { subscribe } from "@/lib/events";
import type { TaskStreamEvent } from "@/lib/types";

const HOST = "localhost:3000";
const ORIGIN = "http://localhost:3000";
const BROWSER = { host: HOST, origin: ORIGIN, "sec-fetch-site": "same-origin" };

function reset() {
  fs.rmSync(environmentFilePath(), { force: true });
  setRuntimeStateAdapter(null);
  setStoreIo(null);
  delete (globalThis as Record<symbol, unknown>)[APPLIED_ENV_SLOT];
}
beforeEach(reset);
afterEach(reset);

function request(method: string, body: unknown, headers: Record<string, string> = BROWSER, url = "http://localhost:3000/api/settings/environment") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type ListBody = { rows: { id: string; scope: string; name: string | null; overriddenByHost: boolean }[]; revision: number; restartRequired: boolean };
type RowBody = { row?: { id: string; name: string | null }; revision?: number; error?: string };

async function list(): Promise<ListBody> {
  return (await GET(request("GET", undefined))).json();
}

describe("browser CRUD reaches a real boot", () => {
  it("applies a custom app variable, and a delete needs a restart to take it back out", async () => {
    const before = await list();
    const created = (await (
      await POST(request("POST", { scope: "app", name: "MY_INTEGRATION_VAR", value: "hello", secret: false, expectedRevision: before.revision }))
    ).json()) as RowBody;
    expect(created.row?.name).toBe("MY_INTEGRATION_VAR");

    // The route wrote the same file format the entrypoints read; nothing here
    // hand-writes it the way tests/advancedEnvBootstrap.test.ts does.
    const onDisk = JSON.parse(fs.readFileSync(environmentFilePath(), "utf8"));
    expect(onDisk.rows.some((r: { name: string }) => r.name === "MY_INTEGRATION_VAR")).toBe(true);

    // Simulate the restart: a real boot call against the file the route wrote.
    const env: Record<string, string | undefined> = {};
    const state = applyAppEnvironment({ env, filePath: environmentFilePath() });
    expect(state.applied.MY_INTEGRATION_VAR).toBe("hello");
    expect(env.MY_INTEGRATION_VAR).toBe("hello");

    const afterBoot = await list();
    expect(afterBoot.restartRequired).toBe(false);

    // Delete through the route. The process already booted with the old
    // value, so it still needs a restart to actually drop it.
    const row = created.row!;
    const del = await DELETE(request("DELETE", { expectedRevision: afterBoot.revision }, BROWSER, `http://localhost:3000/api/settings/environment/${row.id}`), {
      params: Promise.resolve({ id: row.id }),
    });
    expect(del.status).toBe(200);

    const afterDelete = await list();
    expect(afterDelete.rows.some((r) => r.id === row.id)).toBe(false);
    expect(afterDelete.restartRequired).toBe(true);

    // The next real boot restores the inherited value: applyAppEnvironment
    // undoes its own prior overlay before reading the file again.
    const state2 = applyAppEnvironment({ env, filePath: environmentFilePath() });
    expect(state2.applied.MY_INTEGRATION_VAR).toBeUndefined();
    expect(env.MY_INTEGRATION_VAR).toBeUndefined();
    expect((await list()).restartRequired).toBe(false);
  });

  it("a host-set value shadows a saved row and needs no restart, through the real route", async () => {
    const before = await list();
    const created = (await (
      await POST(request("POST", { scope: "app", name: "CALANDRIA_LOG_FORMAT", value: "json", secret: false, expectedRevision: before.revision }))
    ).json()) as RowBody;
    expect(created.row?.name).toBe("CALANDRIA_LOG_FORMAT");

    // No boot has applied anything yet, and the launch environment already
    // carries the host's own value for this name: exactly what a restart
    // would see on a machine whose launcher sets CALANDRIA_LOG_FORMAT itself.
    setRuntimeStateAdapter({
      appliedAppEnvironment: () => ({ appliedRevision: 0, applied: {}, preOverlay: {}, loadError: null }),
      hostEnv: () => ({ CALANDRIA_LOG_FORMAT: "text" }),
    });

    const shadowed = await list();
    const row = shadowed.rows.find((r) => r.name === "CALANDRIA_LOG_FORMAT");
    expect(row?.overriddenByHost).toBe(true);
    expect(shadowed.restartRequired).toBe(false);

    // With no host value, the same saved row does need a restart.
    setRuntimeStateAdapter(null);
    const unshadowed = await list();
    expect(unshadowed.rows.find((r) => r.name === "CALANDRIA_LOG_FORMAT")?.overriddenByHost).toBe(false);
    expect(unshadowed.restartRequired).toBe(true);
  });
});

describe("change_environment_setting keeps its mandatory card under bypassPermissions", () => {
  it("still raises a card, awaiting a fresh decision, for a task running full-access", async () => {
    const project = createProject({ name: "env-bypass-project" });
    const task = createTask({ project_id: project.id, title: "Bypass task", description: "", permission_mode: "bypassPermissions" });
    expect(task.permission_mode).toBe("bypassPermissions");

    const cap = mintTurnCapability(task.id, project.id);
    const cardIds: string[] = [];
    const unsub = subscribe(task.id, (ev) => {
      if (ev.type === "permission") cardIds.push(ev.request.id);
    });

    const { POST: changeEnvEp } = await import("@/app/api/internal/agent-tools/change-environment-setting/route");
    const { POST: waitEp } = await import("@/app/api/internal/agent-tools/change-environment-setting/wait/route");
    const startRes = await changeEnvEp(
      new NextRequest("http://127.0.0.1:3000/api/internal/agent-tools/change-environment-setting", {
        method: "POST",
        headers: { "content-type": "application/json", [TURN_CAPABILITY_HEADER]: cap },
        body: JSON.stringify({ taskId: task.id, operation: "create", scope: "app", name: "BYPASS_STILL_ASKS", value: "v", secret: false, expectedRevision: 0 }),
      })
    );
    expect(startRes.status).toBe(200);
    unsub();

    // The card is unconditional: it never consulted the task's permission
    // mode. This is the invariant, not the mechanism of any one route.
    expect(cardIds).toHaveLength(1);

    const { proposalId } = (await startRes.json()) as { proposalId: string };
    submitMandatoryDecision(task.id, cardIds[0], "allow_once");
    for (let i = 0; i < 200; i++) {
      const res = await waitEp(
        new NextRequest("http://127.0.0.1:3000/api/internal/agent-tools/change-environment-setting/wait", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId: task.id, proposalId }),
        })
      );
      const parsed = (await res.json()) as { status: string; text?: string };
      if (parsed.status === "done") {
        expect(parsed.text).toContain("Committed");
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    revokeTurnCapability(task.id, cap);
  });
});

describe("a secret proposal's plaintext never reaches the transcript, an event, or a log line", () => {
  it("a secret replacement, approved through the real decision route, is redacted everywhere it is observable", async () => {
    const SECRET_NAME = "MY_SYNTHETIC_SECRET";
    const OLD_VALUE = "synthetic-old-9f21";
    const NEW_VALUE = "synthetic-new-4b7a";

    const project = createProject({ name: "env-redact-project" });
    const task = createTask({ project_id: project.id, title: "Redact task", description: "" });
    const secretRow = createVariable({ scope: "agent", name: SECRET_NAME, value: OLD_VALUE, secret: true, expectedRevision: 0 });
    if (!secretRow.ok) throw new Error("fixture failed to create the secret row");

    const cap = mintTurnCapability(task.id, project.id);
    const captured: TaskStreamEvent[] = [];
    const unsub = subscribe(task.id, (ev) => captured.push(ev));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { POST: changeEnvEp } = await import("@/app/api/internal/agent-tools/change-environment-setting/route");
      const startRes = await changeEnvEp(
        new NextRequest("http://127.0.0.1:3000/api/internal/agent-tools/change-environment-setting", {
          method: "POST",
          headers: { "content-type": "application/json", [TURN_CAPABILITY_HEADER]: cap },
          body: JSON.stringify({ operation: "patch", taskId: task.id, id: secretRow.row!.id, secret: true, expectedRevision: secretRow.revision }),
        })
      );
      expect(startRes.status).toBe(200);
      const { proposalId } = (await startRes.json()) as { proposalId: string };
      unsub();

      const card = captured.find((e): e is Extract<TaskStreamEvent, { type: "permission" }> => e.type === "permission");
      if (!card) throw new Error("no permission card was pushed");

      // The real browser decision route: the only place a secret's plaintext
      // is allowed to travel, and it goes here, never into the tool call or
      // the card body above.
      const { POST: decisionEp } = await import("@/app/api/settings/environment/proposals/[id]/decision/route");
      const decisionRes = await decisionEp(
        new Request(`http://localhost:3000/api/settings/environment/proposals/${card.request.id}/decision`, {
          method: "POST",
          headers: { "content-type": "application/json", ...BROWSER },
          body: JSON.stringify({ taskId: task.id, decision: "allow_once", privateValue: NEW_VALUE }),
        }),
        { params: Promise.resolve({ id: card.request.id }) }
      );
      expect(decisionRes.status).toBe(200);

      const { POST: waitEp } = await import("@/app/api/internal/agent-tools/change-environment-setting/wait/route");
      let text = "";
      for (let i = 0; i < 200 && !text; i++) {
        const res = await waitEp(
          new NextRequest("http://127.0.0.1:3000/api/internal/agent-tools/change-environment-setting/wait", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ taskId: task.id, proposalId }),
          })
        );
        const parsed = (await res.json()) as { status: string; text?: string };
        if (parsed.status === "done") text = parsed.text ?? "";
        else await new Promise((r) => setTimeout(r, 5));
      }
      expect(text).toContain("Committed");

      const sentinels = [SECRET_NAME, OLD_VALUE, NEW_VALUE];
      const eventDump = JSON.stringify(captured);
      const transcriptDump = JSON.stringify(listMessages(task.id));
      const logDump = JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]);
      for (const s of sentinels) {
        expect(eventDump).not.toContain(s);
        expect(transcriptDump).not.toContain(s);
        expect(logDump).not.toContain(s);
      }

      // Redaction is about presentation, not about the commit silently
      // failing to apply the private value: the row really changed.
      const updated = savedRows("agent").find((r) => r.id === secretRow.row!.id);
      expect(updated?.value).toBe(NEW_VALUE);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      revokeTurnCapability(task.id, cap);
    }
  });
});
