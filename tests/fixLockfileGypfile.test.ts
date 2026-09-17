// Tests scripts/fix-lockfile-gypfile.mjs, the script that re-adds "gypfile":
// false to lockfile entries after npm strips it (see
// tests/lockfileGypfile.test.ts for why the field has to exist at all).
//
// Runs the real script as a subprocess against a fixture lockfile in a temp
// directory, never importing its internals, so a change to its argument
// parsing or exit codes shows up the same way it would for a real caller.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "fix-lockfile-gypfile.mjs");

let dir: string | null = null;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/**
 * A minimal lockfile: a root entry, an unrelated entry, and
 * node_modules/better-sqlite3 with no gypfile field. No node_modules
 * directory on disk, so only the named better-sqlite3 fallback applies, not
 * the binding.gyp scan.
 */
function fixtureLock() {
  return {
    lockfileVersion: 3,
    packages: {
      "": {
        name: "fixture",
        version: "0.0.0",
      },
      "node_modules/better-sqlite3": {
        version: "13.0.3",
        resolved: "https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz",
        integrity: "sha512-fake",
        license: "MIT",
      },
      "node_modules/some-other-package": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/some-other-package/-/some-other-package-1.0.0.tgz",
        integrity: "sha512-alsofake",
        license: "MIT",
      },
    },
  };
}

function writeFixture(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-fix-lockfile-"));
  const lockfilePath = path.join(dir, "package-lock.json");
  fs.writeFileSync(lockfilePath, JSON.stringify(fixtureLock(), null, 2) + "\n");
  return lockfilePath;
}

/** execFileSync throws on a non-zero exit; this captures the status instead. */
function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("scripts/fix-lockfile-gypfile.mjs", () => {
  it("adds gypfile: false to node_modules/better-sqlite3 and leaves the unrelated entry untouched", () => {
    const lockfilePath = writeFixture();
    const before = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));

    const result = run([lockfilePath]);
    expect(result.status).toBe(0);

    const after = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
    expect(after.packages["node_modules/better-sqlite3"].gypfile).toBe(false);
    expect(after.packages["node_modules/some-other-package"]).toEqual(
      before.packages["node_modules/some-other-package"],
    );
  });

  it("parses, ends with exactly one trailing newline, and places gypfile between integrity and license", () => {
    const lockfilePath = writeFixture();
    run([lockfilePath]);

    const raw = fs.readFileSync(lockfilePath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.endsWith("\n\n")).toBe(false);

    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed.packages["node_modules/better-sqlite3"]);
    expect(keys.indexOf("gypfile")).toBe(keys.indexOf("integrity") + 1);
    expect(keys.indexOf("gypfile")).toBe(keys.indexOf("license") - 1);
  });

  it("is a no-op on a second run", () => {
    const lockfilePath = writeFixture();
    run([lockfilePath]);
    const afterFirst = fs.readFileSync(lockfilePath, "utf8");

    const second = run([lockfilePath]);
    expect(second.status).toBe(0);

    const afterSecond = fs.readFileSync(lockfilePath, "utf8");
    expect(afterSecond).toBe(afterFirst);
  });

  it("--check on a lockfile missing the field exits 1 and writes nothing", () => {
    const lockfilePath = writeFixture();
    const before = fs.readFileSync(lockfilePath, "utf8");

    const result = run(["--check", lockfilePath]);
    expect(result.status).toBe(1);

    const after = fs.readFileSync(lockfilePath, "utf8");
    expect(after).toBe(before);
  });

  it("--check on a repaired lockfile exits 0", () => {
    const lockfilePath = writeFixture();
    run([lockfilePath]);

    const result = run(["--check", lockfilePath]);
    expect(result.status).toBe(0);
  });
});
