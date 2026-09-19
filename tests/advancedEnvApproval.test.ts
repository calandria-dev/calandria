// lib/advanced-env/proposals.ts: the only path that can write
// advanced-environment.json on an agent's behalf. Every mutation rides
// lib/permissionPrompt.ts's mandatory mode (no auto-allow, no remembered
// rule, no durable/session grant), settles only through the dedicated
// browser decision endpoint's underlying primitives
// (lib/advanced-env/capabilities.ts), and commits only after that fresh,
// one-use decision arrives. Synthetic sentinels throughout; nothing here is
// a real credential.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CALANDRIA_PERMISSION_UNATTENDED_MS = "200";
});

import fs from "node:fs";

import { discardPrivateInput, proposeEnvironmentMutation, stagePrivateInput, type ProposalContext } from "@/lib/advanced-env/proposals";
import {
  createVariable,
  environmentFilePath,
  listEnvironment,
  setRuntimeStateAdapter,
  setStoreIo,
} from "@/lib/advanced-env/store";
import { hasMandatoryDecision, submitMandatoryDecision } from "@/lib/advanced-env/capabilities";
import { submitAnswer } from "@/lib/asks";
import { addPermissionRule, createProject } from "@/lib/store";
import { subscribeGlobal } from "@/lib/events";
import type { StreamEvent } from "@/lib/types";

const SECRET_VALUE = "synthetic-sentinel-9f2a";

function reset() {
  fs.rmSync(environmentFilePath(), { force: true });
  setRuntimeStateAdapter(null);
  setStoreIo(null);
}
beforeEach(reset);
afterEach(reset);

function fixtureCtx(taskId: string, projectId: string, pushed: StreamEvent[], signal?: AbortSignal): ProposalContext {
  return { taskId, projectId, push: (ev) => pushed.push(ev), signal };
}

/** A connected client, as far as watcherCount() is concerned. */
function withWatcher<T>(fn: () => T): T {
  const unsub = subscribeGlobal(() => {});
  try {
    return fn();
  } finally {
    unsub();
  }
}

let counter = 0;
const taskId = () => `env-approve-${++counter}`;
const cardId = (pushed: StreamEvent[]): string => {
  const card = pushed.find((e): e is Extract<StreamEvent, { type: "permission" }> => e.type === "permission");
  if (!card) throw new Error("no permission card was pushed");
  return card.request.id;
};

describe("proposeEnvironmentMutation: the card", () => {
  it("always raises a mandatory, unscoped card, even in a task with a matching remembered rule", async () => {
    const project = createProject({ name: "env-approve-bypass-project" });
    addPermissionRule({ project_id: project.id, tool: "change_environment_setting", match_kind: "bash_exact", value: "anything" });
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = proposeEnvironmentMutation(fixtureCtx(id, project.id, pushed), {
      operation: "create",
      scope: "app",
      name: "MY_CUSTOM_VAR",
      value: "v1",
      secret: false,
      expectedRevision: 0,
    });
    const card = pushed.find((e): e is Extract<StreamEvent, { type: "permission" }> => e.type === "permission");
    expect(card).toBeDefined();
    expect(card?.request.kind).toBe("environment");
    expect(card?.request.scope).toBeUndefined(); // no "always allow" is ever offered
    submitMandatoryDecision(id, cardId(pushed), "deny");
    await p;
  });

  it("identifies an existing secret row by opaque id, never its name, on the card", async () => {
    const created = createVariable({ scope: "agent", name: "SUPER_SECRET_TOKEN", value: SECRET_VALUE, secret: true, expectedRevision: 0 });
    if (!created.ok) throw new Error("fixture create failed");
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "delete",
      id: created.row!.id,
      expectedRevision: created.revision,
    });
    const card = pushed.find((e): e is Extract<StreamEvent, { type: "permission" }> => e.type === "permission");
    const rendered = JSON.stringify(card);
    expect(rendered).not.toContain("SUPER_SECRET_TOKEN");
    expect(rendered).not.toContain(SECRET_VALUE);
    expect(rendered).toContain(created.row!.id.slice(0, 4));
    submitMandatoryDecision(id, cardId(pushed), "deny");
    await p;
  });

  it("rejects a tool-supplied value for a secret create before ever raising a card", async () => {
    const pushed: StreamEvent[] = [];
    const result = await proposeEnvironmentMutation(fixtureCtx(taskId(), "proj-x", pushed), {
      operation: "create",
      scope: "agent",
      name: "LEAKY_TOKEN",
      value: SECRET_VALUE,
      secret: true,
      expectedRevision: 0,
    });
    expect(result.kind).toBe("invalid");
    expect(pushed).toEqual([]);
    expect(listEnvironment().rows).toEqual([]);
  });

  it("marks the card's privateInput for a secret create, so the UI collects a value out of band", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "create",
      scope: "agent",
      name: "NEW_SECRET",
      secret: true,
      expectedRevision: 0,
    });
    const card = pushed.find((e): e is Extract<StreamEvent, { type: "permission" }> => e.type === "permission");
    expect(card?.request.privateInput).toEqual({ name: true, value: true });
    submitMandatoryDecision(id, cardId(pushed), "deny");
    await p;
  });
});

describe("proposeEnvironmentMutation: commit only follows a fresh decision", () => {
  it("commits a create only after allow_once, never before", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "create",
      scope: "app",
      name: "MY_CUSTOM_VAR",
      value: "v1",
      secret: false,
      expectedRevision: 0,
    });
    expect(listEnvironment().rows).toEqual([]); // nothing written while the card is pending
    submitMandatoryDecision(id, cardId(pushed), "allow_once");
    const result = await p;
    expect(result.kind).toBe("committed");
    const rows = listEnvironment().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("MY_CUSTOM_VAR");
  });

  it("writes nothing when declined", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "create",
      scope: "app",
      name: "MY_CUSTOM_VAR",
      value: "v1",
      secret: false,
      expectedRevision: 0,
    });
    submitMandatoryDecision(id, cardId(pushed), "deny", "not now");
    const result = await p;
    expect(result).toEqual({ kind: "denied", message: expect.stringContaining("not now") });
    expect(listEnvironment().rows).toEqual([]);
  });

  it("cannot be settled through the generic /answer path; a fabricated decision there does nothing", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "create",
      scope: "app",
      name: "MY_CUSTOM_VAR",
      value: "v1",
      secret: false,
      expectedRevision: 0,
    });
    const propId = cardId(pushed);
    expect(submitAnswer(id, propId, [["allow_once"]])).toBe(false);
    expect(hasMandatoryDecision(id, propId)).toBe(true);
    submitMandatoryDecision(id, propId, "deny");
    await p;
    expect(listEnvironment().rows).toEqual([]);
  });

  it("a decision cannot be replayed: the second submit finds nothing pending", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "create",
      scope: "app",
      name: "MY_CUSTOM_VAR",
      value: "v1",
      secret: false,
      expectedRevision: 0,
    });
    const propId = cardId(pushed);
    expect(submitMandatoryDecision(id, propId, "allow_once")).toBe(true);
    expect(submitMandatoryDecision(id, propId, "allow_once")).toBe(false);
    expect(submitMandatoryDecision(id, propId, "deny")).toBe(false);
    await p;
    expect(listEnvironment().rows).toHaveLength(1); // the one commit the first decision produced
  });

  it("a decision under the wrong task id settles nothing (caller mismatch)", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "create",
      scope: "app",
      name: "MY_CUSTOM_VAR",
      value: "v1",
      secret: false,
      expectedRevision: 0,
    });
    const propId = cardId(pushed);
    expect(submitMandatoryDecision("some-other-task", propId, "allow_once")).toBe(false);
    submitMandatoryDecision(id, propId, "deny");
    await p;
  });
});

describe("proposeEnvironmentMutation: revision revalidation", () => {
  it("re-checks the revision inside the write, and reports a conflict instead of writing over a change made while the card was pending", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "create",
      scope: "app",
      name: "MY_CUSTOM_VAR",
      value: "v1",
      secret: false,
      expectedRevision: 0,
    });
    // Something else lands while the human is still looking at the card.
    const other = createVariable({ scope: "app", name: "SOMETHING_ELSE", value: "x", secret: false, expectedRevision: 0 });
    if (!other.ok) throw new Error("fixture create failed");
    submitMandatoryDecision(id, cardId(pushed), "allow_once");
    const result = await p;
    expect(result).toEqual({ kind: "conflict", currentRevision: 1 });
    // The rejected proposal never landed; only the other change is on disk.
    const rows = listEnvironment().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("SOMETHING_ELSE");
  });
});

describe("proposeEnvironmentMutation: unattended and aborted turns", () => {
  it("denies automatically when nobody is watching, and writes nothing", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const result = await proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "create",
      scope: "app",
      name: "MY_CUSTOM_VAR",
      value: "v1",
      secret: false,
      expectedRevision: 0,
    });
    expect(result.kind).toBe("denied");
    expect(listEnvironment().rows).toEqual([]);
    expect(hasMandatoryDecision(id, cardId(pushed))).toBe(false);
  });

  it("does not expire while a client is watching", async () => {
    await withWatcher(async () => {
      const pushed: StreamEvent[] = [];
      const id = taskId();
      const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
        operation: "create",
        scope: "app",
        name: "MY_CUSTOM_VAR",
        value: "v1",
        secret: false,
        expectedRevision: 0,
      });
      await new Promise((r) => setTimeout(r, 5));
      const propId = cardId(pushed);
      expect(hasMandatoryDecision(id, propId)).toBe(true);
      submitMandatoryDecision(id, propId, "allow_once");
      const result = await p;
      expect(result.kind).toBe("committed");
    });
  });

  it("aborts when the turn's signal aborts, and the proposal stops being answerable", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const ac = new AbortController();
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed, ac.signal), {
      operation: "create",
      scope: "app",
      name: "MY_CUSTOM_VAR",
      value: "v1",
      secret: false,
      expectedRevision: 0,
    });
    await new Promise((r) => setTimeout(r, 5));
    const propId = cardId(pushed);
    ac.abort();
    const result = await p;
    expect(result.kind).toBe("denied");
    expect(submitMandatoryDecision(id, propId, "allow_once")).toBe(false);
    expect(listEnvironment().rows).toEqual([]);
  });
});

describe("proposeEnvironmentMutation: private inputs", () => {
  it("commits a secret create using only the privately staged value, never a tool-supplied one", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "create",
      scope: "agent",
      name: "NEW_SECRET",
      secret: true,
      expectedRevision: 0,
    });
    const propId = cardId(pushed);
    stagePrivateInput(id, propId, { value: SECRET_VALUE });
    submitMandatoryDecision(id, propId, "allow_once");
    const result = await p;
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") throw new Error("unreachable");
    // The redacted result never carries the secret's plaintext back.
    expect(result.row?.value).toBeNull();
    expect(result.row?.name).toBeNull();
    expect(result.row?.hasValue).toBe(true);
    // Nothing pushed to the turn's queue (the card, the outcome) ever
    // contains the plaintext either.
    expect(JSON.stringify(pushed)).not.toContain(SECRET_VALUE);
  });

  it("fails the commit, and stages nothing forever, when a secret create gets no private value at all", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "create",
      scope: "agent",
      name: "NEW_SECRET",
      secret: true,
      expectedRevision: 0,
    });
    submitMandatoryDecision(id, cardId(pushed), "allow_once");
    const result = await p;
    expect(result.kind).toBe("invalid");
    expect(listEnvironment().rows).toEqual([]);
  });

  it("discards a staged private value when the proposal is denied instead of committed", async () => {
    const created = createVariable({ scope: "agent", name: "EXISTING_SECRET", value: "old-value", secret: true, expectedRevision: 0 });
    if (!created.ok) throw new Error("fixture create failed");
    const pushed: StreamEvent[] = [];
    const id = taskId();
    // No tool-supplied value: the agent is only proposing to replace it, the
    // replacement itself arriving later, privately, from the browser.
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "patch",
      id: created.row!.id,
      expectedRevision: created.revision,
    });
    const propId = cardId(pushed);
    stagePrivateInput(id, propId, { value: "should-never-land" });
    submitMandatoryDecision(id, propId, "deny");
    await p;
    // Nothing was ever written: the revision never advanced past the fixture create.
    expect(listEnvironment().revision).toBe(created.revision);
    expect(JSON.stringify(pushed)).not.toContain("should-never-land");
  });

  it("lets the browser override a rename privately, invisible on the card that was already shown", async () => {
    const created = createVariable({ scope: "agent", name: "RENAME_ME_SECRET", value: "old-value", secret: true, expectedRevision: 0 });
    if (!created.ok) throw new Error("fixture create failed");
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = proposeEnvironmentMutation(fixtureCtx(id, "proj-x", pushed), {
      operation: "patch",
      id: created.row!.id,
      expectedRevision: created.revision,
    });
    const propId = cardId(pushed);
    stagePrivateInput(id, propId, { name: "PRIVATELY_RENAMED_SECRET" });
    submitMandatoryDecision(id, propId, "allow_once");
    const result = await p;
    expect(result.kind).toBe("committed");
    expect(JSON.stringify(pushed)).not.toContain("PRIVATELY_RENAMED_SECRET");
  });

  it("discardPrivateInput leaves nothing staged for a later proposal reusing the same id shape", () => {
    stagePrivateInput("stray-task", "stray-id", { value: "x" });
    discardPrivateInput("stray-task", "stray-id");
    // No observable API to assert an empty map directly; re-staging and
    // taking it via a fresh commit path (exercised above) is the real
    // guarantee. This just documents the call is safe with nothing pending.
    expect(() => discardPrivateInput("stray-task", "stray-id")).not.toThrow();
  });
});

describe("proposeEnvironmentMutation: ordinary validation still applies", () => {
  it("refuses an unknown row for a patch before ever raising a card", async () => {
    const pushed: StreamEvent[] = [];
    const result = await proposeEnvironmentMutation(fixtureCtx(taskId(), "proj-x", pushed), {
      operation: "patch",
      id: "no-such-row",
      value: "v",
      expectedRevision: 0,
    });
    expect(result).toEqual({ kind: "invalid", reason: "That variable no longer exists." });
    expect(pushed).toEqual([]);
  });

  it("refuses a reserved name before ever raising a card", async () => {
    const pushed: StreamEvent[] = [];
    const result = await proposeEnvironmentMutation(fixtureCtx(taskId(), "proj-x", pushed), {
      operation: "create",
      scope: "app",
      name: "PORT",
      value: "9999",
      secret: false,
      expectedRevision: 0,
    });
    expect(result.kind).toBe("invalid");
    expect(pushed).toEqual([]);
  });
});
