#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST_NAME = "release-artifact-manifest.json";
export const MANIFEST_SCHEMA_VERSION = 1;
export const PLATFORMS = ["linux", "mac", "win"];

function fail(message) {
  throw new Error(message);
}

function requireDirectory(value, label) {
  if (!value || typeof value !== "string") fail(`${label} is required`);
  const resolved = path.resolve(value);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fail(`${label} does not exist: ${value}`);
  }
  if (!stat.isDirectory()) fail(`${label} is not a directory: ${value}`);
  return resolved;
}

function requireSafeMetadata(value, label) {
  if (!value || typeof value !== "string" || /[\0\r\n]/.test(value)) {
    fail(`${label} must be a non-empty safe value`);
  }
  return value;
}

function requireVersion(value) {
  if (!value || !/^\d+\.\d+\.\d+$/.test(value)) {
    fail(`version must be X.Y.Z: ${value ?? ""}`);
  }
  return value;
}

function requirePlatform(value) {
  if (!PLATFORMS.includes(value)) fail(`platform must be linux, mac, or win: ${value ?? ""}`);
  return value;
}

function requirePr(value) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) fail(`source-pr must be a positive integer: ${text}`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1) fail(`source-pr must be a positive integer: ${text}`);
  return number;
}

function fileDigest(file) {
  const data = fs.readFileSync(file);
  return { size: data.byteLength, sha256: crypto.createHash("sha256").update(data).digest("hex") };
}

function artifactEntries(dir, { allowManifest = true } = {}) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const artifacts = [];
  for (const entry of entries) {
    if (entry.name === MANIFEST_NAME && allowManifest) continue;
    if (entry.name === MANIFEST_NAME) fail(`reserved artifact name: ${entry.name}`);
    if (entry.name !== path.basename(entry.name) || entry.name === "." || entry.name === ".." || entry.name.includes("\0")) {
      fail(`unsafe artifact name: ${entry.name}`);
    }
    if (!entry.isFile()) fail(`unexpected non-file entry in ${dir}: ${entry.name}`);
    const details = fileDigest(path.join(dir, entry.name));
    artifacts.push({ name: entry.name, size: details.size, sha256: details.sha256 });
  }
  artifacts.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (artifacts.length === 0) fail(`artifact directory is empty: ${dir}`);
  return artifacts;
}

function requirePlatformAssets(platform, artifacts) {
  const names = artifacts.map((artifact) => artifact.name);
  const has = (suffix) => names.some((name) => name.endsWith(suffix));
  const required = platform === "linux"
    ? [[".deb", has(".deb")], [".AppImage", has(".AppImage")], ["latest-linux.yml", names.includes("latest-linux.yml")]]
    : platform === "mac"
      ? [[".dmg", has(".dmg")], [".zip", has(".zip")], ["latest-mac.yml", names.includes("latest-mac.yml")], [".blockmap", has(".blockmap")]]
      : [[".exe", has(".exe")], [".zip", has(".zip")], ["latest.yml", names.includes("latest.yml")], [".blockmap", has(".blockmap")]];
  const missing = required.filter(([, present]) => !present).map(([name]) => name);
  if (missing.length > 0) fail(`${platform} artifact set is missing: ${missing.join(", ")}`);
}

function feedScalar(value) {
  const text = value.trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function feedReferenceName(value) {
  const raw = feedScalar(value);
  let pathname = raw;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    // Relative feed paths are the normal electron-builder format.
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    fail(`invalid update feed artifact reference: ${raw}`);
  }
  const name = path.basename(pathname);
  if (!name || name !== pathname.replace(/^.*\//, "") || name === "." || name === "..") {
    fail(`unsafe update feed artifact reference: ${raw}`);
  }
  return name;
}

function validateWindowsFeed(dir, artifacts) {
  const feedPath = path.join(dir, "latest.yml");
  const text = fs.readFileSync(feedPath, "utf8");
  const referenced = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:-\s*)?(?:url|path):\s*(.+?)\s*$/.exec(line);
    if (match) referenced.add(feedReferenceName(match[1]));
  }
  if (referenced.size === 0) fail(`latest.yml has no artifact references: ${feedPath}`);
  const available = new Set(artifacts.map((artifact) => artifact.name));
  const missing = [...referenced].filter((name) => !available.has(name));
  for (const name of referenced) {
    if (name.toLowerCase().endsWith(".exe")) {
      const blockmap = `${name}.blockmap`;
      if (!available.has(blockmap)) missing.push(blockmap);
    }
  }
  if (missing.length > 0) fail(`latest.yml references missing artifacts: ${missing.join(", ")}`);
}

export function createManifest({ dir, platform, version, sourceSha, sourceTree, sourcePr }) {
  const root = requireDirectory(dir, "dir");
  const checkedPlatform = requirePlatform(platform);
  const artifacts = artifactEntries(root);
  requirePlatformAssets(checkedPlatform, artifacts);
  if (checkedPlatform === "win") validateWindowsFeed(root, artifacts);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    platform: checkedPlatform,
    version: requireVersion(version),
    sourceSha: requireSafeMetadata(sourceSha, "source-sha"),
    sourceTree: requireSafeMetadata(sourceTree, "source-tree"),
    sourcePr: requirePr(sourcePr),
    artifacts,
  };
  fs.writeFileSync(path.join(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function readManifest(dir) {
  const file = path.join(dir, MANIFEST_NAME);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`could not read manifest ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || value.schemaVersion !== MANIFEST_SCHEMA_VERSION || !PLATFORMS.includes(value.platform)) {
    fail(`invalid manifest: ${file}`);
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) fail(`manifest has no artifacts: ${file}`);
  return value;
}

function verifyManifest(dir, manifest, expected) {
  const mismatches = ["version", "sourceSha", "sourceTree", "sourcePr"]
    .filter((field) => manifest[field] !== expected[field])
    .map((field) => `${field} expected ${JSON.stringify(expected[field])} but got ${JSON.stringify(manifest[field])}`);
  if (mismatches.length > 0) {
    fail(`manifest metadata mismatch: ${path.join(dir, MANIFEST_NAME)}: ${mismatches.join("; ")}`);
  }
  const listed = new Map();
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact.name !== "string" || listed.has(artifact.name) ||
        artifact.name === MANIFEST_NAME || artifact.name !== path.basename(artifact.name) ||
        !Number.isSafeInteger(artifact.size) || artifact.size < 0 ||
        !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      fail(`invalid artifact entry in ${path.join(dir, MANIFEST_NAME)}`);
    }
    listed.set(artifact.name, artifact);
  }
  const actual = artifactEntries(dir);
  if (manifest.platform === "win") validateWindowsFeed(dir, actual);
  if (actual.length !== listed.size || actual.some((entry) => !listed.has(entry.name))) {
    fail(`manifest file list mismatch: ${path.join(dir, MANIFEST_NAME)}`);
  }
  for (const entry of actual) {
    const expectedEntry = listed.get(entry.name);
    if (entry.size !== expectedEntry.size || entry.sha256 !== expectedEntry.sha256) {
      fail(`artifact checksum mismatch: ${path.join(dir, entry.name)}`);
    }
  }
}

export function verifyReleaseArtifacts({ root, version, sourceSha, sourceTree, sourcePr, assetList }) {
  const releaseRoot = requireDirectory(root, "root");
  const expected = {
    version: requireVersion(version),
    sourceSha: requireSafeMetadata(sourceSha, "source-sha"),
    sourceTree: requireSafeMetadata(sourceTree, "source-tree"),
    sourcePr: requirePr(sourcePr),
  };
  if (!assetList || typeof assetList !== "string") fail("asset-list is required");
  const output = path.resolve(assetList);
  const manifests = [];
  for (const entry of fs.readdirSync(releaseRoot, { withFileTypes: true })) {
    const entryPath = path.join(releaseRoot, entry.name);
    if (!entry.isDirectory()) {
      if (entryPath !== output || !entry.isFile()) fail(`unexpected non-directory entry in ${releaseRoot}: ${entry.name}`);
      continue;
    }
    const dir = entryPath;
    const manifestPath = path.join(dir, MANIFEST_NAME);
    if (fs.existsSync(manifestPath)) manifests.push({ dir, manifest: readManifest(dir) });
  }
  if (manifests.length !== PLATFORMS.length) fail(`expected exactly one manifest for each of linux, mac, and win`);
  const seen = new Set();
  const assets = [];
  for (const { dir, manifest } of manifests) {
    if (seen.has(manifest.platform)) fail(`duplicate platform manifest: ${manifest.platform}`);
    seen.add(manifest.platform);
    verifyManifest(dir, manifest, expected);
    requirePlatformAssets(manifest.platform, manifest.artifacts);
    for (const artifact of manifest.artifacts) assets.push(path.relative(releaseRoot, path.join(dir, artifact.name)).split(path.sep).join("/"));
  }
  if (seen.size !== PLATFORMS.length) fail(`missing platform manifest`);
  assets.sort();
  const parent = path.dirname(output);
  if (!fs.existsSync(parent)) fail(`asset-list parent does not exist: ${parent}`);
  fs.writeFileSync(output, `${assets.join("\n")}\n`, "utf8");
  return assets;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "create" && command !== "verify") fail("command must be create or verify");
  const args = { command };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith("--") || i + 1 >= rest.length || rest[i + 1].startsWith("--")) fail(`invalid argument: ${key}`);
    args[key.slice(2)] = rest[++i];
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === "create") createManifest({ dir: args.dir, platform: args.platform, version: args.version, sourceSha: args["source-sha"], sourceTree: args["source-tree"], sourcePr: args["source-pr"] });
    else verifyReleaseArtifacts({ root: args.root, version: args.version, sourceSha: args["source-sha"], sourceTree: args["source-tree"], sourcePr: args["source-pr"], assetList: args["asset-list"] });
  } catch (error) {
    console.error(`release artifact manifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
