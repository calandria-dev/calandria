import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createVariable,
  deleteVariable,
  environmentFilePath,
  getEnvironmentRow,
  listEnvironment,
  patchVariable,
  savedRows,
  setRuntimeStateAdapter,
  setStoreIo,
} from "@/lib/advanced-env/store";
import { readEnvironmentFile } from "@/lib/advanced-env/disk.mjs";
import { onPosix } from "./platform";

// Synthetic sentinels. Nothing here is a real credential.
const SECRET_VALUE = "synthetic-sentinel-9f2a";
const SECRET_NAME = "MY_SYNTHETIC_TOKEN";

function reset() {
  fs.rmSync(environmentFilePath(), { force: true });
  setRuntimeStateAdapter(null);
  setStoreIo(null);
}

function add(over: Partial<Parameters<typeof createVariable>[0]> = {}) {
  const revision = listEnvironment().revision;
  const result = createVariable({
    scope: "app",
    name: "CALANDRIA_SCHEDULER",
    value: "off",
    secret: false,
    expectedRevision: revision,
    ...over,
  });
  if (!result.ok) throw new Error(`create failed: ${result.code} ${result.reason}`);
  return result;
}

beforeEach(() => {
  reset();
});
afterEach(() => {
  reset();
});

describe("advanced env store persistence", () => {
  it("starts empty when no file exists", () => {
    const view = listEnvironment();
    expect(view.rows).toEqual([]);
    expect(view.revision).toBe(0);
    expect(view.loadError).toBeNull();
  });

  it("survives a reload, reading the file back from disk", () => {
    const created = add({ name: "MY_CUSTOM_VAR", value: "kept value" });
    expect(created.revision).toBe(1);

    const read = readEnvironmentFile(environmentFilePath());
    expect(read.error).toBeNull();
    expect(read.store?.revision).toBe(1);
    expect(read.store?.rows[0]?.name).toBe("MY_CUSTOM_VAR");

    const view = listEnvironment();
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]?.value).toBe("kept value");
  });

  it("stores an empty string as a value and reports hasValue", () => {
    const created = add({ name: "MY_EMPTY_VAR", value: "" });
    expect(created.row?.value).toBe("");
    expect(created.row?.hasValue).toBe(true);
  });

  it("keeps custom values literal", () => {
    const literal = '$HOME `id` "quoted" = one\ntwo';
    add({ name: "MY_LITERAL_VAR", value: literal });
    expect(savedRows("app")[0]?.value).toBe(literal);
  });

  it("refuses a NUL byte in a value", () => {
    const result = createVariable({
      scope: "app",
      name: "MY_NUL_VAR",
      value: "a\0b",
      secret: false,
      expectedRevision: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  onPosix("writes the settings file owner-only", () => {
    add({ name: "MY_MODE_VAR", value: "1" });
    const mode = fs.statSync(environmentFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("leaves no temporary files behind", () => {
    add({ name: "MY_TMP_VAR", value: "1" });
    const dir = environmentFilePath().replace(/[^/\\]+$/, "");
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});

describe("advanced env store validation", () => {
  it("refuses a reserved name", () => {
    const result = createVariable({ scope: "app", name: "CALANDRIA_DB_DIR", value: "/tmp", secret: false, expectedRevision: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.code).toBe("reserved_name");
    }
  });

  it("refuses a known name in the wrong scope", () => {
    const result = createVariable({ scope: "agent", name: "CALANDRIA_SCHEDULER", value: "off", secret: false, expectedRevision: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("wrong_scope");
  });

  it("refuses a duplicate name portably, ignoring case", () => {
    add({ name: "MY_CUSTOM_VAR", value: "1" });
    const result = createVariable({
      scope: "app",
      name: "my_custom_var",
      value: "2",
      secret: false,
      expectedRevision: listEnvironment().revision,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.code).toBe("duplicate_name");
    }
  });

  it("allows the same custom name in both scopes", () => {
    add({ name: "MY_CUSTOM_VAR", value: "1" });
    const result = createVariable({
      scope: "agent",
      name: "MY_CUSTOM_VAR",
      value: "2",
      secret: false,
      expectedRevision: listEnvironment().revision,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a value outside a descriptor's bounds", () => {
    const result = createVariable({
      scope: "agent",
      name: "CODEX_APPROVAL_POLICY",
      value: "sometimes",
      secret: false,
      expectedRevision: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_value");
  });
});

describe("advanced env store revisions", () => {
  it("rejects a stale revision and reports the current one", () => {
    add({ name: "MY_FIRST_VAR", value: "1" });
    const stale = createVariable({ scope: "app", name: "MY_SECOND_VAR", value: "2", secret: false, expectedRevision: 0 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.status).toBe(409);
      expect(stale.code).toBe("revision_conflict");
      expect(stale.currentRevision).toBe(1);
    }
  });

  it("lets the second of two simultaneous edits fail instead of overwriting the first", () => {
    const created = add({ name: "MY_SHARED_VAR", value: "one" });
    const bothSaw = created.revision;

    const first = patchVariable(created.row!.id, { value: "edited by A", expectedRevision: bothSaw });
    const second = patchVariable(created.row!.id, { value: "edited by B", expectedRevision: bothSaw });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(savedRows("app")[0]?.value).toBe("edited by A");
  });

  it("stamps each row with the revision that last changed it", () => {
    const first = add({ name: "MY_FIRST_VAR", value: "1" });
    const second = add({ name: "MY_SECOND_VAR", value: "2" });
    expect(first.row?.revision).toBe(1);
    expect(second.row?.revision).toBe(2);
    expect(listEnvironment().revision).toBe(2);
  });
});

describe("advanced env store editing", () => {
  it("renames without touching the value", () => {
    const created = add({ name: "MY_OLD_NAME", value: "kept" });
    const patched = patchVariable(created.row!.id, { name: "MY_NEW_NAME", expectedRevision: created.revision });
    expect(patched.ok).toBe(true);
    expect(savedRows("app")[0]).toMatchObject({ name: "MY_NEW_NAME", value: "kept" });
  });

  it("treats an empty replacement value as different from keeping the old one", () => {
    const created = add({ name: "MY_VALUE_VAR", value: "before" });
    const kept = patchVariable(created.row!.id, { expectedRevision: created.revision });
    expect(kept.ok).toBe(true);
    expect(savedRows("app")[0]?.value).toBe("before");

    const emptied = patchVariable(created.row!.id, { value: "", expectedRevision: listEnvironment().revision });
    expect(emptied.ok).toBe(true);
    expect(savedRows("app")[0]?.value).toBe("");
  });

  it("refuses a null field instead of reading it as keep", () => {
    const created = add({ name: "MY_NULL_VAR", value: "before" });
    const result = patchVariable(created.row!.id, {
      value: null as unknown as string,
      expectedRevision: created.revision,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("renames a secret and changes its flag with no value supplied", () => {
    const created = add({ name: SECRET_NAME, value: SECRET_VALUE, secret: true });
    const renamed = patchVariable(created.row!.id, { name: "MY_RENAMED_TOKEN", expectedRevision: created.revision });
    expect(renamed.ok).toBe(true);
    expect(renamed.ok && renamed.row?.name).toBeNull();
    expect(savedRows("app")[0]).toMatchObject({ name: "MY_RENAMED_TOKEN", value: SECRET_VALUE, secret: true });
  });

  it("requires explicit confirmation before exposing a secret", () => {
    const created = add({ name: SECRET_NAME, value: SECRET_VALUE, secret: true });
    const refused = patchVariable(created.row!.id, { secret: false, expectedRevision: created.revision });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("confirm_expose");

    const confirmed = patchVariable(created.row!.id, {
      secret: false,
      confirmExpose: true,
      expectedRevision: listEnvironment().revision,
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.ok && confirmed.row?.name).toBe(SECRET_NAME);
  });

  it("reports a missing id as not found", () => {
    expect(patchVariable("no-such-id", { value: "x", expectedRevision: 0 })).toMatchObject({ ok: false, status: 404 });
    expect(deleteVariable("no-such-id", { expectedRevision: 0 })).toMatchObject({ ok: false, status: 404 });
  });

  it("deletes only the named row", () => {
    const first = add({ name: "MY_FIRST_VAR", value: "1" });
    add({ name: "MY_SECOND_VAR", value: "2" });
    const removed = deleteVariable(first.row!.id, { expectedRevision: listEnvironment().revision });
    expect(removed.ok).toBe(true);
    expect(savedRows("app").map((r) => r.name)).toEqual(["MY_SECOND_VAR"]);
  });
});

describe("advanced env store redaction", () => {
  it("hides both the name and the value of a secret row", () => {
    const created = add({ name: SECRET_NAME, value: SECRET_VALUE, secret: true });
    const view = listEnvironment();
    const serialized = JSON.stringify({ created, view, row: getEnvironmentRow(created.row!.id) });
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain(SECRET_NAME);
    expect(view.rows[0]).toMatchObject({ name: null, value: null, secret: true, hasValue: true });
  });

  it("keeps a rejected value out of the failure it returns", () => {
    add({ name: "MY_CUSTOM_VAR", value: "1" });
    const duplicate = createVariable({
      scope: "app",
      name: "my_custom_var",
      value: SECRET_VALUE,
      secret: true,
      expectedRevision: listEnvironment().revision,
    });
    expect(JSON.stringify(duplicate)).not.toContain(SECRET_VALUE);
  });
});

describe("advanced env store failure handling", () => {
  it("preserves the previous file when the write fails", () => {
    const created = add({ name: "MY_KEPT_VAR", value: "before" });
    setStoreIo({
      writeRestricted() {
        throw new Error("icacls refused");
      },
      rename() {
        throw new Error("unreachable");
      },
      restrict() {},
    });
    const result = patchVariable(created.row!.id, { value: "after", expectedRevision: created.revision });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.code).toBe("storage");
    }
    setStoreIo(null);
    expect(savedRows("app")[0]?.value).toBe("before");
    expect(listEnvironment().revision).toBe(created.revision);
  });

  it("preserves the previous file when the rename fails", () => {
    const created = add({ name: "MY_KEPT_VAR", value: "before" });
    setStoreIo({
      writeRestricted(filePath, contents) {
        fs.writeFileSync(filePath, contents, { mode: 0o600 });
      },
      rename() {
        throw new Error("EXDEV");
      },
      restrict() {},
    });
    const result = patchVariable(created.row!.id, { value: "after", expectedRevision: created.revision });
    expect(result.ok).toBe(false);
    setStoreIo(null);
    expect(savedRows("app")[0]?.value).toBe("before");
    const dir = environmentFilePath().replace(/[^/\\]+$/, "");
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("blocks reads and writes on a malformed file without deleting it", () => {
    fs.writeFileSync(environmentFilePath(), "{ not json", { mode: 0o600 });
    const view = listEnvironment();
    expect(view.rows).toEqual([]);
    expect(view.loadError).toMatch(/not valid JSON/);

    const result = createVariable({ scope: "app", name: "MY_VAR", value: "1", secret: false, expectedRevision: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("storage");
    expect(fs.readFileSync(environmentFilePath(), "utf8")).toBe("{ not json");
  });

  it("blocks writes on an unsupported version", () => {
    fs.writeFileSync(environmentFilePath(), JSON.stringify({ version: 2, revision: 0, rows: [] }), { mode: 0o600 });
    const view = listEnvironment();
    expect(view.loadError).toMatch(/unsupported version/);
    expect(createVariable({ scope: "app", name: "MY_VAR", value: "1", secret: false, expectedRevision: 0 }).ok).toBe(false);
  });

  it("keeps a stored value out of a malformed-file diagnostic", () => {
    fs.writeFileSync(
      environmentFilePath(),
      JSON.stringify({ version: 1, revision: 1, rows: [{ id: "a", scope: "app", name: SECRET_NAME, value: 7, secret: true, revision: 1 }] }),
      { mode: 0o600 },
    );
    const view = listEnvironment();
    expect(view.loadError).toBe("advanced-environment.json has an invalid rows[0].value.");
    expect(view.loadError).not.toContain(SECRET_NAME);
  });
});

describe("advanced env effective state", () => {
  it("needs a restart for a saved app value no boot has applied", () => {
    add({ name: "MY_APP_VAR", value: "1" });
    expect(listEnvironment().restartRequired).toBe(true);
  });

  it("needs no restart once boot applied the same value", () => {
    add({ name: "MY_APP_VAR", value: "1" });
    setRuntimeStateAdapter({
      appliedAppEnvironment: () => ({ appliedRevision: 1, applied: { MY_APP_VAR: "1" }, preOverlay: { MY_APP_VAR: undefined }, loadError: null }),
      hostEnv: () => ({}),
    });
    expect(listEnvironment().restartRequired).toBe(false);
  });

  it("needs a restart after a delete that boot still has applied", () => {
    const created = add({ name: "MY_APP_VAR", value: "1" });
    deleteVariable(created.row!.id, { expectedRevision: created.revision });
    setRuntimeStateAdapter({
      appliedAppEnvironment: () => ({ appliedRevision: 1, applied: { MY_APP_VAR: "1" }, preOverlay: {}, loadError: null }),
      hostEnv: () => ({}),
    });
    expect(listEnvironment().restartRequired).toBe(true);
  });

  it("marks a row the host shadows and needs no restart for it", () => {
    add({ name: "CALANDRIA_SCHEDULER", value: "off" });
    setRuntimeStateAdapter({
      appliedAppEnvironment: () => ({ appliedRevision: 1, applied: {}, preOverlay: {}, loadError: null }),
      hostEnv: () => ({ CALANDRIA_SCHEDULER: "on" }),
    });
    const view = listEnvironment();
    expect(view.rows[0]?.overriddenByHost).toBe(true);
    expect(view.restartRequired).toBe(false);
  });

  it("treats a legacy ORCH_ alias in the host environment as a shadow", () => {
    add({ name: "CALANDRIA_SCHEDULER", value: "off" });
    setRuntimeStateAdapter({
      appliedAppEnvironment: () => ({ appliedRevision: 1, applied: {}, preOverlay: {}, loadError: null }),
      hostEnv: () => ({ ORCH_SCHEDULER: "on" }),
    });
    expect(listEnvironment().rows[0]?.overriddenByHost).toBe(true);
  });

  it("does not call a blank host value a shadow", () => {
    add({ name: "CALANDRIA_SCHEDULER", value: "off" });
    setRuntimeStateAdapter({
      appliedAppEnvironment: () => ({ appliedRevision: 1, applied: { CALANDRIA_SCHEDULER: "off" }, preOverlay: { CALANDRIA_SCHEDULER: "" }, loadError: null }),
      hostEnv: () => ({ CALANDRIA_SCHEDULER: "" }),
    });
    const view = listEnvironment();
    expect(view.rows[0]?.overriddenByHost).toBe(false);
    expect(view.restartRequired).toBe(false);
  });

  it("leaves agent rows out of the restart comparison", () => {
    add({ scope: "agent", name: "MY_AGENT_VAR", value: "1" });
    setRuntimeStateAdapter({
      appliedAppEnvironment: () => ({ appliedRevision: 1, applied: {}, preOverlay: {}, loadError: null }),
      hostEnv: () => ({}),
    });
    const view = listEnvironment();
    expect(view.restartRequired).toBe(false);
    expect(view.rows[0]?.effect).toBe("next_turn");
  });

  it("filters the list by scope", () => {
    add({ name: "MY_APP_VAR", value: "1" });
    add({ scope: "agent", name: "MY_AGENT_VAR", value: "2" });
    expect(listEnvironment("agent").rows.map((r) => r.name)).toEqual(["MY_AGENT_VAR"]);
  });
});
