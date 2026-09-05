// `gypfile: false` must be written into package-lock.json by hand; npm
// deletes it whenever it regenerates the lockfile. This test makes that
// deletion visible.
//
// A lockfile entry carries only a subset of a package's manifest, and
// `gypfile` is not one of the copied fields. Under `npm ci`, which builds
// its tree from the lockfile instead of the real manifests, arborist reads
// `gypfile` as undefined, sees the `binding.gyp` still in the published
// tarball, and runs `node-gyp rebuild` for a package that ships prebuilt
// binaries (`#addToBuildSet` in @npmcli/arborist/lib/arborist/rebuild.js:
// `gypfile !== false && !install && !preinstall && isNodeGypPackage(path)`).
// `npm install` reads the real manifest and is unaffected.
//
// On Windows this fails `npm ci` outright: `node-gyp rebuild` dies at `gyp
// ERR! find VS` when no MSVC toolchain matches node-gyp's expectations. On
// Linux/macOS it produces no visible failure: better-sqlite3's binding.gyp
// compiles nothing without `force_build`, so the run leaves a half-finished
// `build/` and exits 0, since require-time resolution falls back to the
// bundled prebuild regardless.
//
// Writing the field into the lockfile fixes every caller of `npm ci` at
// once (CI lanes, the Dockerfile builder, a fresh clone), instead of adding
// `--ignore-scripts` plus explicit rebuilds everywhere `npm ci` runs. The
// cost is this test: any lockfile regeneration (`npm install`, a dependency
// bump, a Dependabot PR) drops the field again, and this test reports it
// instead of leaving CI green on Linux and red only on Windows.
//
// To fix a failure: re-add the named field to the named entry in
// package-lock.json by hand, and commit it with the lockfile change that
// removed it.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..");

type LockEntry = {
  gypfile?: boolean;
  scripts?: Record<string, string>;
};
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
  packages: Record<string, LockEntry>;
};

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// The packages arborist would run `node-gyp rebuild` for if the lockfile
// did not say otherwise: an installed package that carries a binding.gyp,
// sets `gypfile: false` in its own manifest, and declares no
// install/preinstall script of its own. This reads from node_modules
// instead of a list of names, so a dependency that arrives with this shape
// is caught the first time the suite runs, not the first time a Windows
// user installs it.
function needsGypfileInLock(): string[] {
  const out: string[] = [];
  for (const [lockPath] of Object.entries(lock.packages)) {
    if (!lockPath.startsWith("node_modules/")) continue;
    const dir = path.join(root, lockPath);
    if (!fs.existsSync(path.join(dir, "binding.gyp"))) continue;
    const manifest = readJson(path.join(dir, "package.json"));
    if (!manifest || manifest.gypfile !== false) continue;
    const scripts = (manifest.scripts ?? {}) as Record<string, string>;
    if (scripts.install || scripts.preinstall) continue;
    out.push(lockPath);
  }
  return out;
}

describe("package-lock.json carries gypfile:false for packages that need it", () => {
  it("keeps better-sqlite3 from compiling under npm ci", () => {
    // Named explicitly, not just swept up by the scan below: this is the
    // package the defect was found on, and the scan can only see what is
    // installed. A run against a tree missing node_modules would pass it
    // vacuously; this assertion cannot.
    expect(
      lock.packages["node_modules/better-sqlite3"]?.gypfile,
      'package-lock.json lost `"gypfile": false` on node_modules/better-sqlite3 — npm strips it every time it rewrites the lockfile. Re-add it by hand; without it `npm ci` runs `node-gyp rebuild` and fails on Windows with `gyp ERR! find VS`.',
    ).toBe(false);
  });

  it("keeps it for every installed package with the same shape", () => {
    const shouldHave = needsGypfileInLock();
    // Canary: if node_modules is absent or the detection above stops matching
    // anything, the loop passes vacuously and this test stops testing.
    expect(
      shouldHave,
      "the gypfile scan found nothing at all — node_modules is missing, or the detection no longer matches better-sqlite3",
    ).toContain("node_modules/better-sqlite3");
    for (const lockPath of shouldHave) {
      expect(
        lock.packages[lockPath]?.gypfile,
        `${lockPath} ships a binding.gyp and sets \`gypfile: false\` in its own manifest, but package-lock.json does not repeat it — so \`npm ci\` will run \`node-gyp rebuild\` on it. Add \`"gypfile": false\` to that entry in package-lock.json.`,
      ).toBe(false);
    }
  });
});
