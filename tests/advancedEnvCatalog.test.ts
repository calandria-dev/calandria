import { describe, expect, it } from "vitest";
import {
  CATALOG,
  canonicalizeForUniqueness,
  findDuplicateRow,
  isAgentScopeReservedName,
  isGloballyReservedName,
  listEditableDescriptors,
  lookupDescriptor,
  redactStoredVariable,
  validateNameForScope,
  validateNameShape,
  validateValue,
} from "@/lib/advanced-env/catalog.mjs";
import type { StoredVariable } from "@/lib/advanced-env/types";

function row(overrides: Partial<StoredVariable> = {}): StoredVariable {
  return {
    id: "row-1",
    scope: "app",
    name: "CALANDRIA_SCHEDULER",
    value: "1",
    secret: false,
    revision: 1,
    ...overrides,
  };
}

describe("advanced-env catalog", () => {
  it("carries a source citation for every descriptor", () => {
    expect(CATALOG.length).toBeGreaterThan(20);
    for (const d of CATALOG) {
      expect(d.source, `${d.name} missing a source citation`).toMatch(/\S/);
      expect(d.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  it("is free of duplicate names", () => {
    const names = CATALOG.map((d) => d.name.toUpperCase());
    expect(new Set(names).size).toBe(names.length);
  });

  describe("scope filtering", () => {
    it("lists only editable descriptors, optionally filtered by scope", () => {
      const app = listEditableDescriptors("app");
      const agent = listEditableDescriptors("agent");
      expect(app.every((d) => d.scope === "app" && d.ownership === "editable")).toBe(true);
      expect(agent.every((d) => d.scope === "agent" && d.ownership === "editable")).toBe(true);
      expect(listEditableDescriptors().length).toBe(app.length + agent.length);
    });

    it("excludes provider-owned descriptors from the editable selector", () => {
      const all = listEditableDescriptors();
      expect(all.some((d) => d.name === "ANTHROPIC_AUTH_TOKEN")).toBe(false);
    });
  });

  describe("known defaults preserved from their parsers", () => {
    it.each([
      ["CALANDRIA_PERMISSION_PROMPT_TIMEOUT_MS", "app", "duration_ms"],
      ["CALANDRIA_TURN_IDLE_NUDGE", "app", "boolean"],
      ["CALANDRIA_RETENTION_VACUUM", "app", "boolean"],
      ["CALANDRIA_LOG_FORMAT", "app", "enum"],
      ["CODEX_APPROVAL_POLICY", "agent", "enum"],
      ["CODEX_TRANSPORT", "agent", "enum"],
      ["CODEX_INHERIT_MCP", "agent", "boolean"],
      ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "agent", "boolean"],
    ])("%s is classified as %s scope, %s input", (name: string, scope: string, inputType: string) => {
      const d = lookupDescriptor(name);
      expect(d).toBeDefined();
      expect(d!.scope).toBe(scope);
      expect(d!.inputType).toBe(inputType);
      expect(d!.defaultDescription).toMatch(/\S/);
    });

    it("preserves the CODEX_APPROVAL_POLICY default and enum, including the untrusted alias", () => {
      const d = lookupDescriptor("CODEX_APPROVAL_POLICY")!;
      expect(d.enumValues).toContain("never");
      expect(d.enumValues).toContain("untrusted");
      expect(d.defaultDescription).toMatch(/never/);
    });

    it("preserves the CODEX_INHERIT_MCP on-by-default posture", () => {
      const d = lookupDescriptor("CODEX_INHERIT_MCP")!;
      expect(d.defaultDescription.toLowerCase()).toContain("on");
    });

    it("marks every app descriptor restart-effect and every agent descriptor next-turn", () => {
      for (const d of CATALOG.filter((x) => x.ownership === "editable")) {
        expect(d.effect).toBe(d.scope === "app" ? "restart" : "next_turn");
      }
    });
  });

  describe("reserved names and aliases", () => {
    it.each(["CALANDRIA_DB_DIR", "CALANDRIA_WORKTREES_DIR", "PORT", "SERVICE_TOKEN", "HOME", "CODEX_HOME"])(
      "rejects %s in app scope as reserved",
      (name: string) => {
        const result = validateNameForScope(name, "app");
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe("reserved_name");
      },
    );

    it("rejects the ORCH_ legacy alias of a reserved name, case-insensitively", () => {
      const result = validateNameForScope("orch_db_dir", "app");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("reserved_name");
    });

    it("rejects a case-variant of a reserved name", () => {
      const result = validateNameForScope("Calandria_Db_Dir", "app");
      expect(result.ok).toBe(false);
    });

    it("rejects task/turn identity names only in agent scope", () => {
      expect(isAgentScopeReservedName("CALANDRIA_TASK_ID")).toBe(true);
      const agentResult = validateNameForScope("CALANDRIA_TASK_ID", "agent");
      expect(agentResult.ok).toBe(false);
      if (!agentResult.ok) expect(agentResult.code).toBe("reserved_name");
    });

    it("rejects the CALANDRIA_GATEWAY_ prefix in agent scope", () => {
      const result = validateNameForScope("CALANDRIA_GATEWAY_KEY", "agent");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("reserved_name");
    });

    it("rejects process loader identity names in either scope", () => {
      expect(isGloballyReservedName("XDG_CONFIG_HOME")).toBe(true);
      expect(isGloballyReservedName("LD_PRELOAD")).toBe(true);
      expect(isGloballyReservedName("DYLD_LIBRARY_PATH")).toBe(true);
      expect(isGloballyReservedName("ELECTRON_RUN_AS_NODE")).toBe(true);
    });

    it("rejects an unclassified CALANDRIA_ name instead of accepting it as custom", () => {
      const result = validateNameForScope("CALANDRIA_TOTALLY_MADE_UP", "app");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("unsupported_name");
    });

    it("rejects an unclassified ORCH_ name the same way", () => {
      const result = validateNameForScope("ORCH_TOTALLY_MADE_UP", "app");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("unsupported_name");
    });

    it("rejects provider-owned names and points at Settings -> Models", () => {
      const result = validateNameForScope("ANTHROPIC_AUTH_TOKEN", "agent");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("provider_owned");
    });

    it.each(["__proto__", "prototype", "constructor"])("rejects the forbidden identifier %s", (name: string) => {
      const result = validateNameForScope(name, "app");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_name");
    });
  });

  describe("wrong-context known names", () => {
    it("rejects an app-scope descriptor when added under agent scope", () => {
      const result = validateNameForScope("CALANDRIA_SCHEDULER", "agent");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("wrong_scope");
    });

    it("rejects an agent-scope descriptor when added under app scope", () => {
      const result = validateNameForScope("CODEX_APPROVAL_POLICY", "app");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("wrong_scope");
    });
  });

  describe("custom names", () => {
    it("accepts a name outside every reserved/provider/catalog set, in either scope", () => {
      expect(validateNameForScope("MY_TEAM_FLAG", "app").ok).toBe(true);
      expect(validateNameForScope("MY_TEAM_FLAG", "agent").ok).toBe(true);
    });

    it("allows the same custom name to be added independently in both scopes", () => {
      const app = validateNameForScope("SHARED_CUSTOM_NAME", "app");
      const agent = validateNameForScope("SHARED_CUSTOM_NAME", "agent");
      expect(app.ok).toBe(true);
      expect(agent.ok).toBe(true);
    });
  });

  describe("value validation", () => {
    it("accepts an empty string as a value", () => {
      expect(validateValue(undefined, "").ok).toBe(true);
    });

    it("rejects a NUL character in any value", () => {
      const result = validateValue(undefined, "abc\0def");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_value");
    });

    it("keeps shell-looking literals as literal values", () => {
      const shellLike = ['$(rm -rf /)', "`whoami`", "a; b && c", 'name="quoted value"', "line1\nline2", "50%"];
      for (const value of shellLike) {
        expect(validateValue(undefined, value).ok).toBe(true);
      }
    });

    it("rejects a value outside a known boolean descriptor's literal set", () => {
      const d = lookupDescriptor("CALANDRIA_SCHEDULER")!;
      expect(validateValue(d, "on").ok).toBe(true);
      expect(validateValue(d, "yes").ok).toBe(true);
      expect(validateValue(d, "maybe").ok).toBe(false);
    });

    it("rejects a value outside a known enum descriptor's set", () => {
      const d = lookupDescriptor("CODEX_APPROVAL_POLICY")!;
      expect(validateValue(d, "never").ok).toBe(true);
      expect(validateValue(d, "sometimes").ok).toBe(false);
    });

    it("rejects a non-integer value for a duration_ms descriptor and enforces its floor", () => {
      const d = lookupDescriptor("CALANDRIA_PERMISSION_PROMPT_TIMEOUT_MS")!;
      expect(validateValue(d, "not-a-number").ok).toBe(false);
      expect(validateValue(d, "0").ok).toBe(true);
      expect(validateValue(d, "-1").ok).toBe(false);
    });
  });

  describe("portable duplicate-name detection", () => {
    it("treats a case variant as a duplicate within the same scope", () => {
      const rows = [row({ id: "a", name: "MY_CUSTOM_VAR" })];
      const dup = findDuplicateRow(rows, "app", "my_custom_var");
      expect(dup?.id).toBe("a");
    });

    it("does not collide across scopes", () => {
      const rows = [row({ id: "a", scope: "app", name: "MY_CUSTOM_VAR" })];
      expect(findDuplicateRow(rows, "agent", "MY_CUSTOM_VAR")).toBeUndefined();
    });

    it("excludes the row's own id, for a rename that keeps its name", () => {
      const rows = [row({ id: "a", name: "MY_CUSTOM_VAR" })];
      expect(findDuplicateRow(rows, "app", "MY_CUSTOM_VAR", "a")).toBeUndefined();
    });

    it("canonicalizes by trimming and upper-casing", () => {
      expect(canonicalizeForUniqueness("  my_var  ")).toBe("MY_VAR");
    });
  });

  describe("redaction", () => {
    it("hides both name and value for a secret row", () => {
      const presented = redactStoredVariable(row({ secret: true, name: "MY_SECRET", value: "hunter2" }));
      expect(presented.name).toBeNull();
      expect(presented.value).toBeNull();
      expect(presented.secret).toBe(true);
      expect(presented.hasValue).toBe(true);
    });

    it("marks hasValue true even for an explicitly stored empty secret value", () => {
      const presented = redactStoredVariable(row({ secret: true, name: "MY_SECRET", value: "" }));
      expect(presented.value).toBeNull();
      expect(presented.hasValue).toBe(true);
    });

    it("passes through name and value for a non-secret row", () => {
      const presented = redactStoredVariable(row({ secret: false, name: "MY_VAR", value: "hello" }));
      expect(presented.name).toBe("MY_VAR");
      expect(presented.value).toBe("hello");
    });

    it("derives effect from the catalog when the row matches a known descriptor", () => {
      const presented = redactStoredVariable(row({ name: "CALANDRIA_SCHEDULER", scope: "app" }));
      expect(presented.effect).toBe("restart");
    });

    it("falls back to a scope-based default effect for a custom name", () => {
      const appPresented = redactStoredVariable(row({ name: "MY_CUSTOM_VAR", scope: "app" }));
      const agentPresented = redactStoredVariable(row({ name: "MY_CUSTOM_VAR", scope: "agent" }));
      expect(appPresented.effect).toBe("restart");
      expect(agentPresented.effect).toBe("next_turn");
    });

    it("reports overriddenByHost only when the caller supplies it", () => {
      expect(redactStoredVariable(row()).overriddenByHost).toBe(false);
      expect(redactStoredVariable(row(), { overriddenByHost: true }).overriddenByHost).toBe(true);
    });
  });

  it("runs from a plain Node import with no filesystem, database, or SDK dependency", () => {
    // A regression here means catalog.mjs picked up a disallowed import; the
    // module graph test also pins this, but a direct import failure is the
    // most direct signal.
    expect(typeof lookupDescriptor).toBe("function");
    expect(typeof validateNameShape).toBe("function");
  });
});
