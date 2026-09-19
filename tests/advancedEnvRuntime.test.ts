import { describe, expect, it } from "vitest";

import { buildAgentSnapshot, resolveCodexControls } from "@/lib/advanced-env/runtime";
import type { AppliedAppEnvironment, StoredVariable } from "@/lib/advanced-env/types";

// Synthetic sentinels. Nothing here is a real credential.
const SECRET_VALUE = "synthetic-sentinel-9f2a";

function row(over: Partial<StoredVariable> = {}): StoredVariable {
  return {
    id: "row-1",
    scope: "agent",
    name: "MY_CUSTOM_VAR",
    value: "hello",
    secret: false,
    revision: 1,
    ...over,
  };
}

function applied(over: Partial<AppliedAppEnvironment> = {}): AppliedAppEnvironment {
  return {
    appliedRevision: 1,
    applied: {},
    preOverlay: {},
    loadError: null,
    ...over,
  };
}

describe("buildAgentSnapshot", () => {
  it("restores the app baseline before layering saved agent rows", () => {
    const snapshot = buildAgentSnapshot({
      inheritedEnv: { APP_ONLY_SECRET: "from-app-overlay", HOST_VAR: "kept" },
      appliedAppEnvironment: applied({
        applied: { APP_ONLY_SECRET: "from-app-overlay" },
        preOverlay: { APP_ONLY_SECRET: undefined },
      }),
      savedAgentRows: [],
    });

    // The app overlay's applied key is undone (it had no pre-overlay value,
    // i.e. the host never set it), so an app-only secret never reaches a
    // child session just because the server process happened to carry it.
    expect(snapshot.env.APP_ONLY_SECRET).toBeUndefined();
    expect(snapshot.env.HOST_VAR).toBe("kept");
  });

  it("restores the host's own pre-overlay value when the app overlay shadowed it", () => {
    const snapshot = buildAgentSnapshot({
      inheritedEnv: { SHADOWED: "app-value" },
      appliedAppEnvironment: applied({
        applied: { SHADOWED: "app-value" },
        preOverlay: { SHADOWED: "host-value" },
      }),
      savedAgentRows: [],
    });

    expect(snapshot.env.SHADOWED).toBe("host-value");
  });

  it("layers saved agent rows on top of the restored baseline", () => {
    const snapshot = buildAgentSnapshot({
      inheritedEnv: { EXISTING: "from-host" },
      appliedAppEnvironment: null,
      savedAgentRows: [row({ name: "EXISTING", value: "from-agent-row" }), row({ id: "row-2", name: "CUSTOM_TWO", value: SECRET_VALUE, secret: true })],
    });

    expect(snapshot.env.EXISTING).toBe("from-agent-row");
    expect(snapshot.env.CUSTOM_TWO).toBe(SECRET_VALUE);
  });

  it("applies a custom (non-catalog) agent variable literally, with no shell expansion", () => {
    const literal = "$(rm -rf /) `echo hi` \"quoted\" and\nnewline";
    const snapshot = buildAgentSnapshot({
      inheritedEnv: {},
      appliedAppEnvironment: null,
      savedAgentRows: [row({ name: "CUSTOM_LITERAL", value: literal })],
    });

    expect(snapshot.env.CUSTOM_LITERAL).toBe(literal);
  });

  it("ignores a row outside agent scope even if one somehow reaches the input", () => {
    const snapshot = buildAgentSnapshot({
      inheritedEnv: {},
      appliedAppEnvironment: null,
      savedAgentRows: [row({ scope: "app", name: "SHOULD_NOT_APPLY" })],
    });

    expect(snapshot.env.SHOULD_NOT_APPLY).toBeUndefined();
  });

  it("ignores a row naming a globally or agent-scope reserved variable", () => {
    const snapshot = buildAgentSnapshot({
      inheritedEnv: { PORT: "3000" },
      appliedAppEnvironment: null,
      savedAgentRows: [
        row({ id: "r-port", name: "PORT", value: "9999" }),
        row({ id: "r-cap", name: "CALANDRIA_ENV_EDIT_CAPABILITY", value: "forged" }),
        row({ id: "r-task", name: "CALANDRIA_TASK_ID", value: "forged-task" }),
      ],
    });

    expect(snapshot.env.PORT).toBe("3000");
    expect(snapshot.env.CALANDRIA_ENV_EDIT_CAPABILITY).toBeUndefined();
    expect(snapshot.env.CALANDRIA_TASK_ID).toBeUndefined();
  });

  it("tracks the highest saved-row revision folded in, and 0 with none applied", () => {
    const none = buildAgentSnapshot({ inheritedEnv: {}, appliedAppEnvironment: null, savedAgentRows: [] });
    expect(none.revision).toBe(0);

    const some = buildAgentSnapshot({
      inheritedEnv: {},
      appliedAppEnvironment: null,
      savedAgentRows: [row({ revision: 3 }), row({ id: "row-2", name: "OTHER", revision: 7 }), row({ id: "row-3", name: "THIRD", revision: 5 })],
    });
    expect(some.revision).toBe(7);
  });

  it("is immutable: freezes the snapshot and its env, without mutating inputs", () => {
    const inheritedEnv = Object.freeze({ UNCHANGED: "value" });
    const rows = [row()];
    const snapshot = buildAgentSnapshot({ inheritedEnv, appliedAppEnvironment: null, savedAgentRows: rows });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.env)).toBe(true);
    expect(() => {
      (snapshot.env as Record<string, string>).MY_CUSTOM_VAR = "mutated";
    }).toThrow();
    // The caller's own objects are untouched.
    expect(inheritedEnv).toEqual({ UNCHANGED: "value" });
    expect(rows).toEqual([row()]);
  });

  it("builds two independent snapshots for two concurrent turns with different applied state", () => {
    const first = buildAgentSnapshot({
      inheritedEnv: { SHARED: "host" },
      appliedAppEnvironment: applied({ appliedRevision: 1 }),
      savedAgentRows: [row({ revision: 1, value: "one" })],
    });
    const second = buildAgentSnapshot({
      inheritedEnv: { SHARED: "host" },
      appliedAppEnvironment: applied({ appliedRevision: 2 }),
      savedAgentRows: [row({ revision: 2, value: "two" })],
    });

    expect(first.revision).toBe(1);
    expect(first.env.MY_CUSTOM_VAR).toBe("one");
    expect(second.revision).toBe(2);
    expect(second.env.MY_CUSTOM_VAR).toBe("two");
    // Building the second snapshot did not retroactively change the first.
    expect(first.env.MY_CUSTOM_VAR).toBe("one");
  });
});

describe("resolveCodexControls", () => {
  function snapshotWithEnv(env: Record<string, string>) {
    return buildAgentSnapshot({
      inheritedEnv: env,
      appliedAppEnvironment: null,
      savedAgentRows: [],
    });
  }

  it("matches lib/config.ts's current defaults when nothing is set", () => {
    const controls = resolveCodexControls(snapshotWithEnv({}));
    expect(controls).toEqual({
      transport: "app-server",
      approvalPolicy: "never",
      writableRoots: "",
      externalSandbox: false,
      inheritMcp: true,
      hookTrace: false,
    });
  });

  it("resolves each control from the snapshot's env, not from process.env", () => {
    const controls = resolveCodexControls(
      snapshotWithEnv({
        CODEX_TRANSPORT: "exec",
        CODEX_APPROVAL_POLICY: "on-failure",
        CODEX_WRITABLE_ROOTS: "/tmp/a:/tmp/b",
        CODEX_EXTERNAL_SANDBOX: "true",
        CODEX_INHERIT_MCP: "off",
        CALANDRIA_CODEX_HOOK_TRACE: "1",
      }),
    );

    expect(controls).toEqual({
      transport: "exec",
      approvalPolicy: "on-failure",
      writableRoots: "/tmp/a:/tmp/b",
      externalSandbox: true,
      inheritMcp: false,
      hookTrace: true,
    });
  });

  it("maps 'untrusted' approval to 'on-request', same as lib/config.ts", () => {
    const controls = resolveCodexControls(snapshotWithEnv({ CODEX_APPROVAL_POLICY: "untrusted" }));
    expect(controls.approvalPolicy).toBe("on-request");
  });

  it("falls back to the safe default on an unknown approval policy value", () => {
    const controls = resolveCodexControls(snapshotWithEnv({ CODEX_APPROVAL_POLICY: "not-a-real-policy" }));
    expect(controls.approvalPolicy).toBe("never");
  });

  it("lets a saved agent-scope row override a Codex control for the next turn", () => {
    const snapshot = buildAgentSnapshot({
      inheritedEnv: { CODEX_APPROVAL_POLICY: "never" },
      appliedAppEnvironment: null,
      savedAgentRows: [row({ name: "CODEX_APPROVAL_POLICY", value: "on-request" })],
    });

    expect(resolveCodexControls(snapshot).approvalPolicy).toBe("on-request");
  });

  it("resolves independently per snapshot, so two concurrent turns keep their own Codex controls", () => {
    const first = resolveCodexControls(snapshotWithEnv({ CODEX_TRANSPORT: "exec" }));
    const second = resolveCodexControls(snapshotWithEnv({ CODEX_TRANSPORT: "app-server" }));

    expect(first.transport).toBe("exec");
    expect(second.transport).toBe("app-server");
  });
});
