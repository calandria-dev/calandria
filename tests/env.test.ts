import { beforeEach, describe, expect, it } from "vitest";
import { ALIASED_ENV_VARS, deprecatedEnvInUse, deprecatedEnvWarning, legacyNameOf, readEnv } from "../lib/env.mjs";
import fs from "node:fs";
import path from "node:path";

// Every case passes an explicit env object rather than mutating process.env —
// same pattern as tests/envKeys.test.ts and tests/resolveHostname.test.ts.

// readEnv records every ORCH_* fallback it serves into a module-level Set on
// globalThis (shared across module realms, see lib/env.mjs). That set unions
// into deprecatedEnvInUse()'s result regardless of the env object passed in,
// so a case that calls readEnv with a fake ORCH_* fixture would otherwise leak
// that name into a LATER deprecatedEnvInUse() assertion made with a clean env.
// Clear it before every case rather than relying on test order.
beforeEach(() => {
  (globalThis as { __calandriaDeprecatedEnv?: Set<string> }).__calandriaDeprecatedEnv?.clear();
});

describe("readEnv", () => {
  it("prefers the new name when both are set", () => {
    expect(readEnv("CALANDRIA_HOSTNAME", { CALANDRIA_HOSTNAME: "new", ORCH_HOSTNAME: "old" })).toBe("new");
  });

  it("falls back to the old name when the new one is absent", () => {
    expect(readEnv("CALANDRIA_HOSTNAME", { ORCH_HOSTNAME: "old" })).toBe("old");
  });

  it("does not let a present-but-empty CALANDRIA_X shadow a real ORCH_X", () => {
    // .env.example ships every key blank and compose forwards blanks for
    // anything the host has not exported — an empty string must count as
    // unset, not as "the new name wins".
    expect(readEnv("CALANDRIA_HOSTNAME", { CALANDRIA_HOSTNAME: "", ORCH_HOSTNAME: "old" })).toBe("old");
  });

  it("does not let a whitespace-only CALANDRIA_X shadow a real ORCH_X", () => {
    expect(readEnv("CALANDRIA_HOSTNAME", { CALANDRIA_HOSTNAME: "   ", ORCH_HOSTNAME: "old" })).toBe("old");
  });

  it("returns undefined when both are absent", () => {
    expect(readEnv("CALANDRIA_HOSTNAME", {})).toBeUndefined();
  });

  it("returns undefined when both are present but empty", () => {
    expect(readEnv("CALANDRIA_HOSTNAME", { CALANDRIA_HOSTNAME: "", ORCH_HOSTNAME: "   " })).toBeUndefined();
  });
});

describe("legacyNameOf", () => {
  it("maps a CALANDRIA_* name to its ORCH_* spelling", () => {
    expect(legacyNameOf("CALANDRIA_HOSTNAME")).toBe("ORCH_HOSTNAME");
  });

  it("returns null for a name with no CALANDRIA_ prefix", () => {
    expect(legacyNameOf("ANTHROPIC_API_KEY")).toBeNull();
    expect(legacyNameOf("ORCH_HOSTNAME")).toBeNull();
  });
});

describe("deprecatedEnvInUse", () => {
  it("returns [] for a clean env", () => {
    expect(deprecatedEnvInUse({})).toEqual([]);
  });

  it("lists an ORCH_X that is set while CALANDRIA_X is not", () => {
    expect(deprecatedEnvInUse({ ORCH_HOSTNAME: "0.0.0.0" })).toContain("ORCH_HOSTNAME");
  });

  it("omits an ORCH_X once its CALANDRIA_X replacement is set", () => {
    expect(deprecatedEnvInUse({ CALANDRIA_HOSTNAME: "0.0.0.0", ORCH_HOSTNAME: "0.0.0.0" })).not.toContain(
      "ORCH_HOSTNAME"
    );
  });

  it("is sorted", () => {
    const env = { ORCH_WORKTREES_DIR: "/tmp/a", ORCH_HOSTNAME: "0.0.0.0", ORCH_DB_DIR: "/tmp/b" };
    const names = deprecatedEnvInUse(env);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(["ORCH_DB_DIR", "ORCH_HOSTNAME", "ORCH_WORKTREES_DIR"]);
  });

  it("answers about the env it was handed, not about names readEnv fell back to elsewhere", () => {
    // The recorded-fallback safety net is scoped to the DEFAULT env, because it
    // describes what THIS process read. A caller passing an explicit object is
    // asking about that object — which is also what keeps a fixture in one case
    // from bleeding into a clean-env assertion in the next.
    readEnv("CALANDRIA_HOSTNAME", { ORCH_HOSTNAME: "0.0.0.0" });
    expect(deprecatedEnvInUse({})).toEqual([]);
  });

  it("does fold a recorded fallback into the answer for the process's own env", () => {
    // The net exists for a name read through readEnv but missing from
    // ALIASED_ENV_VARS — the scan alone would never see it.
    process.env.ORCH_NOT_IN_THE_TABLE = "x";
    try {
      readEnv("CALANDRIA_NOT_IN_THE_TABLE");
      expect(deprecatedEnvInUse()).toContain("ORCH_NOT_IN_THE_TABLE");
    } finally {
      delete process.env.ORCH_NOT_IN_THE_TABLE;
    }
  });
});

describe("deprecatedEnvWarning", () => {
  it("returns null on a clean env", () => {
    expect(deprecatedEnvWarning({})).toBeNull();
  });

  it("names both the old and new spelling", () => {
    const warning = deprecatedEnvWarning({ ORCH_HOSTNAME: "0.0.0.0" });
    expect(warning).toContain("ORCH_HOSTNAME");
    expect(warning).toContain("CALANDRIA_HOSTNAME");
  });
});

describe("ALIASED_ENV_VARS", () => {
  it("is all CALANDRIA_-prefixed", () => {
    for (const name of ALIASED_ENV_VARS) expect(name.startsWith("CALANDRIA_")).toBe(true);
  });

  it("has no duplicates", () => {
    expect(new Set(ALIASED_ENV_VARS).size).toBe(ALIASED_ENV_VARS.length);
  });
});

describe("lib/env.mjs stays import-free and fs-free", () => {
  it("has no import/require statements in its own source", () => {
    // Both plain-Node entrypoints (server.js, pty-server.js) dynamic-import
    // this module before Next exists, and it must stay SDK-free — a static
    // import or an fs read would drag in state this module explicitly avoids.
    // Statement-shaped match, not a substring: the file's own comments talk
    // about who imports it, so a bare "import " search would fail on prose.
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "env.mjs"), "utf8");
    expect(src).not.toMatch(/^\s*import[\s(]/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});
