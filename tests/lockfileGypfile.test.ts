// `gypfile: false` has to be written into package-lock.json by hand, and npm
// deletes it again the next time it regenerates the lockfile. This test is what
// makes that deletion loud.
//
// The defect it guards: a lockfile entry carries only a subset of a package's
// manifest, and `gypfile` is not one of the fields npm copies into it. Under
// `npm ci` — which builds its tree from the lockfile, never from the real
// manifests — arborist therefore reads `gypfile` as `undefined` rather than
// `false`, sees the `binding.gyp` that is still in the published tarball, and
// synthesizes the default `node-gyp rebuild` for a package that ships prebuilt
// binaries and asks for no such thing (`#addToBuildSet` in
// @npmcli/arborist/lib/arborist/rebuild.js: `gypfile !== false && !install &&
// !preinstall && isNodeGypPackage(path)`). `npm install` has the real manifest
// and skips it. Present in every npm from 10.9.3 through 12.0.2 — measured, not
// assumed, so there is no "upgrade npm" version to wait for.
//
// What it costs, per platform, is why this is not cosmetic:
//
//   Windows — `node-gyp rebuild` dies at `gyp ERR! find VS` and `npm ci` exits
//     non-zero. This is what had main red. The runner's own MSVC does not
//     rescue it either: node-gyp 11.5.0 does not recognise the Visual Studio 18
//     that `windows-latest` now ships.
//   Linux/macOS — silent. better-sqlite3's binding.gyp compiles nothing unless
//     `force_build` is set, so the run leaves a half-finished `build/`
//     (config.gypi, an empty obj.target) and exits 0, because require-time
//     resolution falls back to the bundled prebuild regardless. Nothing is
//     broken; it is just a toolchain requirement nobody declared, waiting for
//     the next machine without a compiler.
//
// Writing the field into the lockfile fixes it everywhere at once — CI lanes,
// the Dockerfile builder, and anyone who clones and runs `npm ci` — which is
// why it is preferred to `--ignore-scripts` plus explicit rebuilds in the eleven
// places `npm ci` is invoked. The cost is exactly this test: any change that
// regenerates the lockfile (`npm install`, a dependency bump, a Dependabot PR)
// drops the field again, and CI has to say so rather than going quietly green
// on Linux and red only on Windows.
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

// The packages arborist would synthesize `node-gyp rebuild` for if the lockfile
// did not say otherwise: an installed package that carries a binding.gyp, sets
// `gypfile: false` in its own manifest, and declares no install/preinstall
// script of its own. Read from node_modules, not from a list of names, so a
// dependency that arrives with this shape later is caught the first time the
// suite runs rather than the first time a Windows user installs it.
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
