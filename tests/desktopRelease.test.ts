// The wiring that decides WHERE a release's desktop artifacts land, and under
// what version. None of it can be exercised without cutting a real release, and
// every failure mode is silent — nothing throws, nothing goes red, the artifacts
// simply end up somewhere nobody looks.
//
// Three facts are pinned:
//
//   1. desktop/package.json's version equals the release manifest's. This is not
//      tidiness. electron-builder's github publisher looks the Release up BY TAG
//      and derives that tag from `v${version}` in desktop/package.json, so a
//      desktop package left at 0.3.0 during a v0.4.2 release does not fail — it
//      creates a DRAFT release named v0.3.0, uploads every artifact into it, and
//      leaves the real Release holding nothing but the Docker image.
//   2. release-please-config.json carries the `extra-files` entry that keeps (1)
//      true without anyone remembering to. JSON takes no comments, so this test
//      is the only place that reasoning can live next to the configuration.
//   3. The `publish` block exists and names this repository. Its presence is
//      what makes electron-builder write latest.yml / latest-mac.yml /
//      latest-linux.yml and the .blockmap files beside each artifact — the feed
//      electron-updater reads. Without it a release publishes downloads that no
//      updater can ever discover.
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
        publish: Array<{ provider: string; owner: string; repo: string }>;
      };
      expect(config.publish).toEqual([
        { provider: "github", owner: "calandria-dev", repo: "calandria" },
      ]);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
