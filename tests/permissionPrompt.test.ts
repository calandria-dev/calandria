// lib/permissionPrompt.ts: promptPermission(), the one gate both drivers park
// on. Ordinary behavior (the allowlist, remembered rules, the ordinary
// /answer path) is pinned first as a regression backstop, then the mandatory
// mode Advanced Settings mutations use: no auto-allow, no durable/session
// grant ever offered, and a decision that can only arrive through the
// dedicated waiter (lib/advanced-env/capabilities.ts), never through the
// generic ask registry POST /api/tasks/[id]/answer settles.

import { describe, it, expect, vi } from "vitest";

// Shrunk so the unattended-expiry test below waits milliseconds, not the
// production default (45s), over a real timer rather than a faked one (same
// approach as tests/permissionParity.test.ts). vi.hoisted runs before the
// imports below are evaluated; a plain top-level assignment would not, since
// ESM import declarations are hoisted ahead of ordinary module-body code.
vi.hoisted(() => {
  process.env.CALANDRIA_PERMISSION_UNATTENDED_MS = "200";
});

import { promptPermission, type PromptContext } from "@/lib/permissionPrompt";
import { submitMandatoryDecision, hasMandatoryDecision } from "@/lib/advanced-env/capabilities";
import { submitAnswer } from "@/lib/asks";
import { addPermissionRule, createProject } from "@/lib/store";
import { subscribeGlobal } from "@/lib/events";
import type { StreamEvent } from "@/lib/types";

function fixtureCtx(taskId: string, projectId: string, pushed: StreamEvent[], signal?: AbortSignal): PromptContext {
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
const taskId = () => `pp-task-${++counter}`;

describe("ordinary permission behavior is unchanged", () => {
  it("auto-allows a read-only tool with no card and no wait", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const decision = await promptPermission(fixtureCtx(id, "proj-x", pushed), {
      id: "perm:read",
      tool: "Read",
      input: { file_path: "/tmp/x" },
    });
    expect(decision).toEqual({ kind: "allow", always: false, auto: true });
    expect(pushed).toEqual([]);
  });

  it("auto-allows a Bash call covered by a remembered project rule, no card", async () => {
    const project = createProject({ name: "ordinary-rule-project" });
    addPermissionRule({ project_id: project.id, tool: "Bash", match_kind: "bash_prefix", value: "npm test" });
    const pushed: StreamEvent[] = [];
    const decision = await promptPermission(fixtureCtx(taskId(), project.id, pushed), {
      id: "perm:npm",
      tool: "Bash",
      input: { command: "npm test --watch" },
    });
    expect(decision).toEqual({ kind: "allow", always: false, auto: true });
    expect(pushed).toEqual([]);
  });

  it("raises a card for an ungoverned call and settles through the ordinary /answer path", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = promptPermission(fixtureCtx(id, "proj-x", pushed), {
      id: "perm:bash",
      tool: "Bash",
      input: { command: "rm -rf /tmp/whatever" },
    });
    // The card is pushed synchronously, before the first await inside promptPermission.
    expect(pushed.some((e) => e.type === "permission")).toBe(true);
    expect(submitAnswer(id, "perm:bash", [["allow_once"]])).toBe(true);
    await expect(p).resolves.toEqual({ kind: "allow", always: false });
  });
});

describe("mandatory mode", () => {
  it("ignores the read-only allowlist and always raises a card", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = promptPermission(fixtureCtx(id, "proj-x", pushed), {
      id: "cap:read",
      tool: "Read",
      input: {},
      mandatory: true,
    });
    expect(pushed.some((e) => e.type === "permission")).toBe(true);
    expect(submitMandatoryDecision(id, "cap:read", "allow_once")).toBe(true);
    await expect(p).resolves.toEqual({ kind: "allow", always: false });
  });

  it("ignores a remembered project rule that would otherwise auto-allow", async () => {
    const project = createProject({ name: "mandatory-ignores-rule-project" });
    addPermissionRule({ project_id: project.id, tool: "Bash", match_kind: "bash_prefix", value: "npm test" });
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = promptPermission(fixtureCtx(id, project.id, pushed), {
      id: "cap:npm",
      tool: "Bash",
      input: { command: "npm test --watch" },
      mandatory: true,
    });
    expect(pushed.some((e) => e.type === "permission")).toBe(true);
    expect(submitMandatoryDecision(id, "cap:npm", "deny")).toBe(true);
    await expect(p).resolves.toMatchObject({ kind: "deny" });
  });

  it("never offers a durable or session-scoped grant on the card", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = promptPermission(fixtureCtx(id, "proj-x", pushed), {
      id: "cap:scope",
      tool: "Bash",
      // A plain Bash command would normally earn a bash_prefix scope offer.
      input: { command: "npm test" },
      mandatory: true,
    });
    const card = pushed.find((e): e is Extract<StreamEvent, { type: "permission" }> => e.type === "permission");
    expect(card?.request.scope).toBeUndefined();
    submitMandatoryDecision(id, "cap:scope", "deny");
    await p;
  });

  it("never records a rule even if a forged allow_always payload reaches the waiter", async () => {
    // Defense in depth beyond the TypeScript-level guarantee (which admits
    // only "allow_once" | "deny"): promptPermission never sets `scope` for a
    // mandatory prompt, so even a payload the dedicated waiter's own type
    // should reject can't mint a remembered rule if it arrives anyway.
    const project = createProject({ name: "mandatory-no-record-project" });
    const { submitMandatoryDecision: submitForged } = (await import("@/lib/advanced-env/capabilities")) as unknown as {
      submitMandatoryDecision: (taskId: string, id: string, decision: string) => boolean;
    };
    const { listPermissionRules } = await import("@/lib/store");
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = promptPermission(fixtureCtx(id, project.id, pushed), {
      id: "cap:forced",
      tool: "Bash",
      input: { command: "npm test" },
      mandatory: true,
    });
    expect(submitForged(id, "cap:forged-missed", "allow_always")).toBe(false);
    expect(submitForged(id, "cap:forced", "allow_always")).toBe(true);
    await p;
    expect(listPermissionRules(project.id)).toEqual([]);
  });

  it("cannot be settled through the generic /answer path; only the dedicated waiter resolves it", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = promptPermission(fixtureCtx(id, "proj-x", pushed), {
      id: "cap:noanswer",
      tool: "Bash",
      input: { command: "curl https://example.invalid" },
      mandatory: true,
    });
    expect(hasMandatoryDecision(id, "cap:noanswer")).toBe(true);
    expect(submitAnswer(id, "cap:noanswer", [["allow_once"]])).toBe(false);
    expect(hasMandatoryDecision(id, "cap:noanswer")).toBe(true);
    submitMandatoryDecision(id, "cap:noanswer", "deny");
    await expect(p).resolves.toMatchObject({ kind: "deny" });
  });

  it("denies and carries the user's reason when declined", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const p = promptPermission(fixtureCtx(id, "proj-x", pushed), {
      id: "cap:deny",
      tool: "Bash",
      input: { command: "echo hi" },
      mandatory: true,
    });
    submitMandatoryDecision(id, "cap:deny", "deny", "not approved");
    const decision = await p;
    expect(decision.kind).toBe("deny");
    expect((decision as { message: string }).message).toContain("not approved");
  });

  it("expires as unattended when nobody is watching, like an ordinary prompt", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const decision = await promptPermission(fixtureCtx(id, "proj-x", pushed), {
      id: "cap:expire",
      tool: "Bash",
      input: { command: "echo hi" },
      mandatory: true,
    });
    expect(decision.kind).toBe("deny");
    // Nothing left parked to accidentally settle late.
    expect(hasMandatoryDecision(id, "cap:expire")).toBe(false);
  });

  it("does not expire as unattended while a client is watching", async () => {
    await withWatcher(async () => {
      const pushed: StreamEvent[] = [];
      const id = taskId();
      const p = promptPermission(fixtureCtx(id, "proj-x", pushed), {
        id: "cap:watched",
        tool: "Bash",
        input: { command: "echo hi" },
        mandatory: true,
      });
      // Give the event loop a tick; a watched prompt must still be parked.
      await new Promise((r) => setTimeout(r, 5));
      expect(hasMandatoryDecision(id, "cap:watched")).toBe(true);
      submitMandatoryDecision(id, "cap:watched", "allow_once");
      await expect(p).resolves.toEqual({ kind: "allow", always: false });
    });
  });

  it("aborts when the turn's signal aborts, and the prompt stops being answerable", async () => {
    const pushed: StreamEvent[] = [];
    const id = taskId();
    const ac = new AbortController();
    const p = promptPermission(fixtureCtx(id, "proj-x", pushed, ac.signal), {
      id: "cap:abort",
      tool: "Bash",
      input: { command: "echo hi" },
      mandatory: true,
    });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const decision = await p;
    expect(decision.kind).toBe("deny");
    expect((decision as { interrupted?: boolean }).interrupted).toBe(true);
    expect(submitMandatoryDecision(id, "cap:abort", "allow_once")).toBe(false);
  });
});
