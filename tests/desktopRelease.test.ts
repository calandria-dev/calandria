// The wiring that decides where a release's desktop artifacts land, and under
// what version. None of it can be exercised without cutting a real release, and
// every failure mode is silent: nothing throws, nothing goes red, the
// artifacts simply end up somewhere nobody looks.
//
// Four facts are pinned:
//
//   1. desktop/package.json's version equals the release manifest's. This is not
//      tidiness. electron-builder's github publisher looks the Release up BY TAG
//      and derives that tag from `v${version}` in desktop/package.json, so a
//      desktop package left behind during a release does not fail: it creates a
//      DRAFT release named after the stale version, uploads every artifact into
//      it, and leaves the real Release holding nothing but the Docker image.
//   2. release-please-config.json carries the `extra-files` entry that keeps (1)
//      true without anyone remembering to. JSON takes no comments, so this test
//      is the only place that reasoning can live next to the configuration.
//   3. The `publish` block exists and names this repository. Its presence is
//      what makes electron-builder write latest.yml / latest-mac.yml /
//      latest-linux.yml and the .blockmap files beside each artifact, the feed
//      electron-updater reads. Without it a release publishes downloads that no
//      updater can ever discover.
//   4. That block says `releaseType: "release"`. This one is not hypothetical:
//      several early releases had zero assets attached. electron-publish
//      defaults the type to "draft"; release-please has already cut a
//      published release for the tag; the publisher finds them incompatible,
//      logs `GitHub release not created … existingType=release
//      publishingType=draft`, logs `skipped publishing` once per artifact,
//      installers and update feeds alike, and exits 0. The lane now also
//      asserts the assets really landed, because this publisher's way of
//      refusing is to keep going.
//
// tests/desktopSigning.test.ts pins the other half of this config: that it is
// found at all, and that signing is off unless asked for.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const DESKTOP = path.join(ROOT, "desktop");

// desktop/ has its own package tree (Electron is never installed in the app's),
// so its files are loaded by absolute path rather than through "@/*".
const require = createRequire(import.meta.url);

const readJson = (...segments: string[]) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, ...segments), "utf8"));

describe("desktop release version", () => {
  it("keeps desktop/package.json at the version release-please last shipped", () => {
    const manifest = readJson(".release-please-manifest.json") as Record<string, string>;
    const pkg = readJson("desktop", "package.json") as { version: string };
    expect(pkg.version).toBe(manifest["."]);
  });

  it("has release-please rewrite desktop/package.json on every bump", () => {
    const config = readJson("release-please-config.json") as {
      packages: Record<string, { "extra-files"?: Array<{ type: string; path: string; jsonpath?: string }> }>;
    };
    // Manifest mode: `extra-files` is a per-package option, not a top-level one,
    // and this repository has exactly one package at the root.
    const extras = config.packages["."]?.["extra-files"] ?? [];
    expect(extras).toContainEqual({
      type: "json",
      path: "desktop/package.json",
      jsonpath: "$.version",
    });
  });
});

describe("desktop release publishing", () => {
  it("publishes to this repository's GitHub Releases, so the update feed lands with the artifacts", () => {
    // The config reads process.env; scrub the signing variables so a developer
    // with an Apple ID exported loads the same object CI does.
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("APPLE_") || key.startsWith("CALANDRIA_MAC_") || key.startsWith("AZURE_")) {
        delete process.env[key];
      }
    }
    try {
      const configPath = path.join(DESKTOP, "electron-builder.cjs");
      delete require.cache[configPath];
      const config = require(configPath) as {
        publish: Array<{ provider: string; owner: string; repo: string; releaseType: string }>;
      };
      expect(config.publish).toEqual([
        { provider: "github", owner: "calandria-dev", repo: "calandria", releaseType: "release" },
      ]);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

// The `publish` block pinned above is what makes a release work, and it is also
// what makes every other lane fail unless it says otherwise. electron-builder
// does not treat a missing `--publish` as "don't": PublishManager fills the
// policy in itself, and on CI with no tag that default is `onTagOrDraft`, which
// still constructs a GitHubPublisher to go looking for a draft. That constructor
// throws before it does anything useful:
//
//   Error: GitHub Personal Access Token is not set, neither programmatically,
//   nor using env "GH_TOKEN"
//
// So `npx electron-builder --win nsis` fails after a full package build, at the
// last step, for a credential the lane has no business holding.
//
// That is not hypothetical: it went red on the first push to main that packaged
// a real Windows target, stayed red across several consecutive pushes, and took
// a release's desktop artifacts and Docker image with it, because both publish
// workflows refuse a tag whose push-to-main Test run is not green. Nobody caught
// it on a pull request: electron-publish's isPullRequest() reads a non-empty
// GITHUB_BASE_REF and skips publishing outright, so the PR that introduced the
// `publish` block was structurally incapable of showing the bug it introduced.
//
// A grep is a poor test of a workflow and a good test of exactly this, because
// the defect is a missing argument on a command line: there is nothing to
// import, nothing to call, and the only way to observe it otherwise is to cut a
// release and watch it not happen.
describe("no lane publishes by accident", () => {
  const WORKFLOWS = path.join(ROOT, ".github", "workflows");

  // The release lane passes `--publish` as an expression: `always` when its
  // gate job decided this run publishes, `never` otherwise, so it is asserted
  // on separately rather than being expected to read literally "never". The
  // gate is where "only from a tag" is actually enforced: a tag push publishes,
  // a dispatch publishes only if asked, and asking off a tag is refused there.
  const RELEASE_LANE = "release-desktop.yml";

  const invocations = fs
    .readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .flatMap((name) =>
      fs
        .readFileSync(path.join(WORKFLOWS, name), "utf8")
        .split("\n")
        .map((line, index) => ({ file: name, line: index + 1, text: line.trim() }))
        // Comments discuss these commands at length; only the ones a runner
        // executes count.
        .filter(({ text }) => !text.startsWith("#") && /(^|\s)npx electron-builder\b/.test(text)),
    );

  // Without this the whole block passes vacuously the day someone renames a
  // workflow, moves packaging into a composite action, or drops `npx`.
  it("finds the packaging commands it is meant to be guarding", () => {
    const files = new Set(invocations.map((i) => i.file));
    expect(files).toContain("test.yml");
    expect(files).toContain("desktop-bench.yml");
    expect(files).toContain(RELEASE_LANE);
    // Three lanes in test.yml (linux, win, mac), one on the bench, one release.
    expect(invocations.length).toBeGreaterThanOrEqual(5);
  });

  it("passes --publish never everywhere but the release lane", () => {
    const offenders = invocations
      .filter((i) => i.file !== RELEASE_LANE)
      .filter((i) => !/--publish\s+never\b/.test(i.text))
      .map((i) => `${i.file}:${i.line}: ${i.text}`);
    expect(offenders).toEqual([]);
  });

  it("has the release lane publish only from a tag", () => {
    const release = invocations.filter((i) => i.file === RELEASE_LANE);
    expect(release).not.toHaveLength(0);
    for (const { text } of release) {
      // Explicit either way: an expression is fine, an omission is not.
      expect(text).toMatch(/--publish\s/);
      expect(text).toContain("always");
      expect(text).toContain("never");
    }
  });
});
