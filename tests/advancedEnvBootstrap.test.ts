// The boot half of the advanced settings feature: lib/advanced-env/bootstrap.mjs
// applies the saved app scope to the process environment before anything that
// reads configuration loads, and publishes what it did on a well-known symbol
// both the plain Node entrypoints and the Next bundle can read.
//
// Several cases run in a real child process. The behavior under test is what
// `node server.js` and `node pty-server.js` see at startup, and an in-process
// assertion cannot show that a second module realm reads the same slot, or
// that a fresh process starts from the launch environment again.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APPLIED_ENV_SLOT,
  appliedAppEnvironment,
  applyAppEnvironment,
  environmentFilePathFor,
  restoreAppOverlay,
} from "@/lib/advanced-env/bootstrap.mjs";
import { createVariable, deleteVariable, listEnvironment } from "@/lib/advanced-env/store";
import type { StoredVariable } from "@/lib/advanced-env/types";

const ROOT = path.resolve(__dirname, "..");

let dir: string;
let savedDbDir: string | undefined;

function settingsPath(): string {
  return path.join(dir, "advanced-environment.json");
}

function writeStore(rows: Array<Partial<StoredVariable>>, revision = rows.length): void {
  const full = rows.map((row, i) => ({
    id: row.id ?? `row-${i}`,
    scope: row.scope ?? "app",
    name: row.name ?? `NAME_${i}`,
    value: row.value ?? "",
    secret: row.secret ?? false,
    revision: row.revision ?? i + 1,
  }));
  fs.writeFileSync(settingsPath(), JSON.stringify({ version: 1, revision, rows: full }));
}

/** Run a script in a fresh Node process with a controlled environment. */
function runNode(script: string, env: Record<string, string | undefined>): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    // The child gets exactly the names the case names, so the type has to be
    // widened: this repo's ProcessEnv declares NODE_ENV as required.
    env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv,
  }).trim();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-advenv-boot-"));
  savedDbDir = process.env.CALANDRIA_DB_DIR;
  process.env.CALANDRIA_DB_DIR = dir;
});

afterEach(() => {
  if (savedDbDir === undefined) delete process.env.CALANDRIA_DB_DIR;
  else process.env.CALANDRIA_DB_DIR = savedDbDir;
  delete (globalThis as Record<symbol, unknown>)[APPLIED_ENV_SLOT];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("applyAppEnvironment", () => {
  it("applies saved app rows and records what the launch environment held", () => {
    writeStore([
      { name: "CALANDRIA_SCHEDULE_TICK_MS", value: "45000" },
      { name: "CALANDRIA_LOG_FORMAT", value: "json" },
      { name: "CALANDRIA_CODEX_HOOK_TRACE", value: "1", scope: "agent" },
    ]);
    const env: Record<string, string | undefined> = { CALANDRIA_DB_DIR: dir };

    const state = applyAppEnvironment({ env, dbDir: dir });

    expect(env.CALANDRIA_SCHEDULE_TICK_MS).toBe("45000");
    expect(env.CALANDRIA_LOG_FORMAT).toBe("json");
    // The agent scope belongs to the turn snapshot, never the server process.
    expect(env.CALANDRIA_CODEX_HOOK_TRACE).toBeUndefined();
    expect(state.applied).toEqual({ CALANDRIA_SCHEDULE_TICK_MS: "45000", CALANDRIA_LOG_FORMAT: "json" });
    expect(Object.prototype.hasOwnProperty.call(state.preOverlay, "CALANDRIA_LOG_FORMAT")).toBe(true);
    expect(state.preOverlay.CALANDRIA_LOG_FORMAT).toBeUndefined();
    expect(state.appliedRevision).toBe(3);
    expect(state.loadError).toBeNull();
  });

  it("lets the launch environment win under either spelling, and treats blank as unset", () => {
    writeStore([
      { name: "CALANDRIA_SCHEDULE_TICK_MS", value: "45000" },
      { name: "CALANDRIA_RETENTION_DAYS", value: "90" },
      { name: "CALANDRIA_PR_POLL_MS", value: "7000" },
    ]);
    const env: Record<string, string | undefined> = {
      CALANDRIA_DB_DIR: dir,
      CALANDRIA_SCHEDULE_TICK_MS: "9000",
      // The pre-rename alias is the same host layer as the canonical name.
      ORCH_RETENTION_DAYS: "30",
      // Blank is unset for lib/env.mjs, so the saved value still applies.
      CALANDRIA_PR_POLL_MS: "   ",
    };

    const state = applyAppEnvironment({ env, dbDir: dir });

    expect(env.CALANDRIA_SCHEDULE_TICK_MS).toBe("9000");
    expect(env.CALANDRIA_RETENTION_DAYS).toBeUndefined();
    expect(env.CALANDRIA_PR_POLL_MS).toBe("7000");
    expect(state.applied).toEqual({ CALANDRIA_PR_POLL_MS: "7000" });
    expect(state.preOverlay.CALANDRIA_PR_POLL_MS).toBe("   ");
  });

  it("skips a name the write path would refuse and reports a count with no name", () => {
    writeStore([
      { name: "PORT", value: "1" },
      { name: "LD_PRELOAD", value: "/tmp/evil.so" },
      { name: "CALANDRIA_SCHEDULE_TICK_MS", value: "45000" },
    ]);
    const env: Record<string, string | undefined> = { CALANDRIA_DB_DIR: dir, PORT: "3000" };

    const state = applyAppEnvironment({ env, dbDir: dir });

    expect(env.PORT).toBe("3000");
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(state.applied).toEqual({ CALANDRIA_SCHEDULE_TICK_MS: "45000" });
    expect(state.loadError).toContain("2 saved app variable(s)");
    expect(state.loadError).not.toContain("LD_PRELOAD");
  });

  it("leaves the environment untouched and preserves the file when it cannot be parsed", () => {
    fs.writeFileSync(settingsPath(), "{ not json");
    const env: Record<string, string | undefined> = { CALANDRIA_DB_DIR: dir };

    const state = applyAppEnvironment({ env, dbDir: dir });

    expect(state.applied).toEqual({});
    expect(state.loadError).toBeTruthy();
    expect(env).toEqual({ CALANDRIA_DB_DIR: dir });
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe("{ not json");
  });

  it("treats a missing file as no saved settings", () => {
    const state = applyAppEnvironment({ env: {}, dbDir: dir });
    expect(state).toMatchObject({ appliedRevision: 0, loadError: null });
    expect(Object.keys(state.applied)).toEqual([]);
  });

  it("does not accumulate pre-overlay values when applied twice in one process", () => {
    writeStore([{ name: "CALANDRIA_SCHEDULE_TICK_MS", value: "45000" }]);
    const env: Record<string, string | undefined> = { CALANDRIA_DB_DIR: dir };

    applyAppEnvironment({ env, dbDir: dir });
    writeStore([{ name: "CALANDRIA_SCHEDULE_TICK_MS", value: "60000" }], 2);
    const second = applyAppEnvironment({ env, dbDir: dir });

    expect(env.CALANDRIA_SCHEDULE_TICK_MS).toBe("60000");
    // The baseline is still the launch environment, not the first overlay.
    expect(second.preOverlay.CALANDRIA_SCHEDULE_TICK_MS).toBeUndefined();
  });

  it("resolves the settings file beside a pre-rename database", () => {
    fs.writeFileSync(path.join(dir, "orchestrator.db"), "");
    expect(environmentFilePathFor({ env: { CALANDRIA_DB_DIR: dir } })).toBe(settingsPath());
    // The deprecated spelling of the directory input resolves the same file.
    expect(environmentFilePathFor({ env: { ORCH_DB_DIR: dir } })).toBe(settingsPath());
  });
});

describe("restoreAppOverlay", () => {
  it("keeps an app-only secret out of the base an agent turn composes on", () => {
    writeStore([
      { name: "APP_ONLY_SENTINEL", value: "app-secret-sentinel", secret: true },
      { name: "CALANDRIA_LOG_FORMAT", value: "json" },
    ]);
    const env: Record<string, string | undefined> = {
      CALANDRIA_DB_DIR: dir,
      CALANDRIA_LOG_FORMAT: "",
      HOME: "/home/tester",
    };

    const state = applyAppEnvironment({ env, dbDir: dir });
    expect(env.APP_ONLY_SENTINEL).toBe("app-secret-sentinel");

    const base = restoreAppOverlay(env, state);

    expect(Object.prototype.hasOwnProperty.call(base, "APP_ONLY_SENTINEL")).toBe(false);
    expect(JSON.stringify(base)).not.toContain("app-secret-sentinel");
    // A name the launch environment carried goes back to the launch value.
    expect(base.CALANDRIA_LOG_FORMAT).toBe("");
    expect(base.HOME).toBe("/home/tester");
    // The server process keeps its own overlay.
    expect(env.APP_ONLY_SENTINEL).toBe("app-secret-sentinel");
    expect(Object.getPrototypeOf(base)).toBeNull();
  });

  it("reads the published slot when no state is supplied", () => {
    writeStore([{ name: "CALANDRIA_SCHEDULE_TICK_MS", value: "45000" }]);
    const env: Record<string, string | undefined> = { CALANDRIA_DB_DIR: dir };
    applyAppEnvironment({ env, dbDir: dir });

    expect(appliedAppEnvironment()?.applied).toEqual({ CALANDRIA_SCHEDULE_TICK_MS: "45000" });
    expect(restoreAppOverlay(env).CALANDRIA_SCHEDULE_TICK_MS).toBeUndefined();
  });
});

describe("restart state, computed against what boot applied", () => {
  it("is clear after a boot that applied the saved rows, and set by a later change", () => {
    const created = createVariable({
      scope: "app",
      name: "CALANDRIA_SCHEDULE_TICK_MS",
      value: "45000",
      secret: false,
      expectedRevision: 0,
    });
    expect(created.ok).toBe(true);

    expect(listEnvironment().restartRequired).toBe(true);

    applyAppEnvironment({ env: { CALANDRIA_DB_DIR: dir }, dbDir: dir });
    expect(listEnvironment().restartRequired).toBe(false);

    const added = createVariable({
      scope: "app",
      name: "CALANDRIA_RETENTION_DAYS",
      value: "90",
      secret: false,
      expectedRevision: listEnvironment().revision,
    });
    expect(added.ok).toBe(true);
    expect(listEnvironment().restartRequired).toBe(true);
  });

  it("is set by a delete, and a host-shadowed row needs no restart", () => {
    const created = createVariable({
      scope: "app",
      name: "CALANDRIA_SCHEDULE_TICK_MS",
      value: "45000",
      secret: false,
      expectedRevision: 0,
    });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.row!.id : "";

    // The host sets the same name, so boot applies nothing and the row is
    // shadowed: removing it changes nothing this process is running on. The
    // store reads the host layer off process.env, so the case has to be set
    // up there. A detached object would be invisible to it.
    process.env.CALANDRIA_SCHEDULE_TICK_MS = "9000";
    try {
      applyAppEnvironment({ env: process.env, dbDir: dir });
      const view = listEnvironment("app");
      expect(view.restartRequired).toBe(false);
      expect(view.rows[0].overriddenByHost).toBe(true);
    } finally {
      delete process.env.CALANDRIA_SCHEDULE_TICK_MS;
    }

    // Without the host value, boot applies it and the delete needs a restart.
    applyAppEnvironment({ env: { CALANDRIA_DB_DIR: dir }, dbDir: dir });
    expect(listEnvironment().restartRequired).toBe(false);
    const removed = deleteVariable(id, { expectedRevision: listEnvironment().revision });
    expect(removed.ok).toBe(true);
    expect(listEnvironment().restartRequired).toBe(true);
  });
});

describe("a real process boot", () => {
  it("applies saved settings before a configuration consumer loads, in both entrypoints' shape", () => {
    writeStore([{ name: "CALANDRIA_LOG_FORMAT", value: "json" }]);

    // The ordering both entrypoints use: await the bootstrap, then import the
    // module that reads the value. lib/log.mjs resolves its format from the
    // environment, so its answer shows whether the overlay landed in time.
    const script = `
      const { applyAppEnvironment } = await import("./lib/advanced-env/bootstrap.mjs");
      applyAppEnvironment();
      const log = await import("./lib/log.mjs");
      console.log(JSON.stringify({ format: log.resolveLogFormat(), env: process.env.CALANDRIA_LOG_FORMAT }));
    `;

    const out = JSON.parse(runNode(script, { CALANDRIA_DB_DIR: dir }));
    expect(out).toEqual({ format: "json", env: "json" });
  });

  it("starts from the launch environment again on the next launch", () => {
    writeStore([{ name: "CALANDRIA_LOG_FORMAT", value: "json" }]);
    const script = `
      const { applyAppEnvironment } = await import("./lib/advanced-env/bootstrap.mjs");
      const state = applyAppEnvironment();
      console.log(JSON.stringify({ applied: state.applied, pre: Object.keys(state.preOverlay), value: process.env.CALANDRIA_LOG_FORMAT }));
    `;

    const first = JSON.parse(runNode(script, { CALANDRIA_DB_DIR: dir }));
    expect(first).toEqual({ applied: { CALANDRIA_LOG_FORMAT: "json" }, pre: ["CALANDRIA_LOG_FORMAT"], value: "json" });

    // A second launch with the same file reaches the same conclusion: nothing
    // from the first process persists into the second.
    const second = JSON.parse(runNode(script, { CALANDRIA_DB_DIR: dir }));
    expect(second).toEqual(first);

    // A second launch whose host sets the name keeps the host value.
    const withHost = JSON.parse(runNode(script, { CALANDRIA_DB_DIR: dir, CALANDRIA_LOG_FORMAT: "text" }));
    expect(withHost).toEqual({ applied: {}, pre: [], value: "text" });
  });

  it("shares the applied state between module realms through the well-known symbol", () => {
    writeStore([{ name: "CALANDRIA_LOG_FORMAT", value: "json" }]);

    // Two query strings are two module instances of the same file, which is
    // the relationship server.js's copy of the module graph has with the Next
    // bundle's copy. A module-local variable would not survive the crossing;
    // globalThis[Symbol.for("calandria.advancedEnvironment")] does.
    const script = `
      const first = await import("./lib/advanced-env/bootstrap.mjs?realm=a");
      first.applyAppEnvironment();
      const second = await import("./lib/advanced-env/bootstrap.mjs?realm=b");
      console.log(JSON.stringify({
        distinctModules: first !== second,
        slot: globalThis[Symbol.for("calandria.advancedEnvironment")]?.applied ?? null,
        seenByOtherRealm: second.appliedAppEnvironment()?.applied ?? null,
      }));
    `;

    const out = JSON.parse(runNode(script, { CALANDRIA_DB_DIR: dir }));
    expect(out.distinctModules).toBe(true);
    expect(out.slot).toEqual({ CALANDRIA_LOG_FORMAT: "json" });
    expect(out.seenByOtherRealm).toEqual({ CALANDRIA_LOG_FORMAT: "json" });
  });

  it("reports no applied overlay to a realm that never ran the bootstrap", () => {
    const script = `
      const m = await import("./lib/advanced-env/bootstrap.mjs");
      console.log(JSON.stringify({ state: m.appliedAppEnvironment() }));
    `;
    expect(JSON.parse(runNode(script, { CALANDRIA_DB_DIR: dir }))).toEqual({ state: null });
  });
});

describe("the entrypoints gate their configuration consumers on the bootstrap", () => {
  // A drift guard, not a boot test: adding a plain-Node import to either
  // entrypoint without chaining it defeats the ordering the whole feature
  // rests on, and that failure is invisible until a saved value is ignored.
  //
  // Module-scope statements only, matched by starting at column 0. An import
  // nested inside one of these chains (lib/schema-version.mjs, loaded from
  // inside the db-lock chain) is already gated by the chain it sits in.
  for (const entry of ["server.js", "pty-server.js"]) {
    it(`${entry} awaits the bootstrap before every other lib import`, () => {
      const source = fs.readFileSync(path.join(ROOT, entry), "utf8");
      const imports = [...source.matchAll(/^[^\s].*import\("\.\/(lib|scripts)\/[^"]+"\)/gm)];
      expect(imports.length).toBeGreaterThan(3);
      for (const match of imports) {
        const line = match[0];
        if (line.includes("advanced-env/bootstrap.mjs")) continue;
        expect(line, `${entry}: ${line.trim()} does not chain off appEnvApplied`).toContain("appEnvApplied");
      }
    });
  }
});
