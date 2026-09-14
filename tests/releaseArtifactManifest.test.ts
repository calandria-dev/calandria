import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createManifest, verifyReleaseArtifacts } from "../scripts/release-artifact-manifest.mjs";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-release-manifest-"));
  roots.push(root);
  return root;
}

function platform(root: string, name: string, files: Record<string, string>) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const [file, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), contents);
  createManifest({ dir, platform: name, version: "1.2.3", sourceSha: "deadbeef", sourceTree: "main", sourcePr: "42" });
}

const complete = {
  linux: { "calandria.deb": "deb", "calandria.AppImage": "app", "latest-linux.yml": "feed" },
  mac: { "calandria.dmg": "dmg", "calandria.zip": "zip", "latest-mac.yml": "feed", "calandria.zip.blockmap": "map" },
  win: { "calandria.exe": "exe", "calandria.zip": "zip", "latest.yml": "feed", "calandria.exe.blockmap": "map" },
};

describe("release artifact manifests", () => {
  it("creates deterministic metadata and hashes sorted artifact names", () => {
    const dir = path.join(tempRoot(), "linux");
    fs.mkdirSync(dir);
    for (const [file, contents] of Object.entries(complete.linux)) fs.writeFileSync(path.join(dir, file), contents);
    const manifest = createManifest({ dir, platform: "linux", version: "1.2.3", sourceSha: "deadbeef", sourceTree: "main", sourcePr: "42" });
    expect(manifest.artifacts.map((entry) => entry.name)).toEqual(["calandria.AppImage", "calandria.deb", "latest-linux.yml"]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "release-artifact-manifest.json"), "utf8"))).toEqual(manifest);
  });

  it("rejects empty and non-file artifact entries", () => {
    const empty = path.join(tempRoot(), "empty");
    fs.mkdirSync(empty);
    expect(() => createManifest({ dir: empty, platform: "linux", version: "1.2.3", sourceSha: "deadbeef", sourceTree: "main", sourcePr: "42" })).toThrow(/empty/);
    const nested = path.join(tempRoot(), "nested");
    fs.mkdirSync(path.join(nested, "child"), { recursive: true });
    expect(() => createManifest({ dir: nested, platform: "linux", version: "1.2.3", sourceSha: "deadbeef", sourceTree: "main", sourcePr: "42" })).toThrow(/non-file/);
    const incomplete = path.join(tempRoot(), "incomplete");
    fs.mkdirSync(incomplete);
    fs.writeFileSync(path.join(incomplete, "calandria.AppImage"), "app");
    expect(() => createManifest({ dir: incomplete, platform: "linux", version: "1.2.3", sourceSha: "deadbeef", sourceTree: "main", sourcePr: "42" })).toThrow(/missing/);
  });

  it("verifies all platforms and writes sorted root-relative asset paths", () => {
    const root = tempRoot();
    platform(root, "win", complete.win);
    platform(root, "linux", complete.linux);
    platform(root, "mac", complete.mac);
    const list = path.join(root, "assets.txt");
    expect(verifyReleaseArtifacts({ root, version: "1.2.3", sourceSha: "deadbeef", sourceTree: "main", sourcePr: "42", assetList: list })).toEqual([
      "linux/calandria.AppImage", "linux/calandria.deb", "linux/latest-linux.yml",
      "mac/calandria.dmg", "mac/calandria.zip", "mac/calandria.zip.blockmap", "mac/latest-mac.yml",
      "win/calandria.exe", "win/calandria.exe.blockmap", "win/calandria.zip", "win/latest.yml",
    ]);
    expect(fs.readFileSync(list, "utf8")).toContain("linux/latest-linux.yml\n");
  });

  it("detects changed artifacts and metadata mismatches", () => {
    const root = tempRoot();
    platform(root, "linux", complete.linux);
    platform(root, "mac", complete.mac);
    platform(root, "win", complete.win);
    fs.writeFileSync(path.join(root, "linux", "calandria.deb"), "changed");
    expect(() => verifyReleaseArtifacts({ root, version: "1.2.3", sourceSha: "deadbeef", sourceTree: "main", sourcePr: "42", assetList: path.join(root, "assets.txt") })).toThrow(/checksum/);
    fs.writeFileSync(path.join(root, "linux", "calandria.deb"), "deb");
    expect(() => verifyReleaseArtifacts({ root, version: "1.2.4", sourceSha: "deadbeef", sourceTree: "main", sourcePr: "42", assetList: path.join(root, "assets.txt") })).toThrow(/metadata/);
  });
});
