#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const RELEASE_PR_FILES = [
  ".release-please-manifest.json",
  "CHANGELOG.md",
  "desktop/package.json",
  "package-lock.json",
  "package.json",
];

function fail(message) {
  throw new Error(message);
}

function parseJson(contents, file) {
  try {
    return JSON.parse(contents);
  } catch (error) {
    fail(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function withoutVersion(value, file) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${file} must contain an object`);
  const copy = structuredClone(value);
  delete copy.version;
  if (file === "package-lock.json") {
    if (!copy.packages?.[""] || typeof copy.packages[""] !== "object") {
      fail("package-lock.json must contain packages['']");
    }
    delete copy.packages[""].version;
  }
  return copy;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateReleaseContents({ changedFiles, baseFiles, headFiles }) {
  const changed = [...changedFiles].sort();
  if (!sameJson(changed, [...RELEASE_PR_FILES].sort())) {
    fail(`release PR must change exactly: ${RELEASE_PR_FILES.join(", ")}; changed: ${changed.join(", ")}`);
  }

  const basePackage = parseJson(baseFiles["package.json"], "package.json at base");
  const headPackage = parseJson(headFiles["package.json"], "package.json at head");
  const baseDesktop = parseJson(baseFiles["desktop/package.json"], "desktop/package.json at base");
  const headDesktop = parseJson(headFiles["desktop/package.json"], "desktop/package.json at head");
  const baseLock = parseJson(baseFiles["package-lock.json"], "package-lock.json at base");
  const headLock = parseJson(headFiles["package-lock.json"], "package-lock.json at head");
  const baseManifest = parseJson(baseFiles[".release-please-manifest.json"], "release manifest at base");
  const headManifest = parseJson(headFiles[".release-please-manifest.json"], "release manifest at head");

  for (const [file, before, after] of [
    ["package.json", basePackage, headPackage],
    ["desktop/package.json", baseDesktop, headDesktop],
    ["package-lock.json", baseLock, headLock],
  ]) {
    if (!sameJson(withoutVersion(before, file), withoutVersion(after, file))) {
      fail(`${file} changes fields outside the release version`);
    }
  }

  const baseManifestKeys = Object.keys(baseManifest);
  const headManifestKeys = Object.keys(headManifest);
  if (!sameJson(baseManifestKeys, ["."]) || !sameJson(headManifestKeys, ["."])) {
    fail("release manifest must contain only the root package version");
  }

  const version = headPackage.version;
  const versions = [version, headDesktop.version, headLock.version, headLock.packages?.[""]?.version, headManifest["."]];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || versions.some((candidate) => candidate !== version)) {
    fail(`release versions must agree and use X.Y.Z: ${versions.join(", ")}`);
  }
  if ([basePackage.version, baseDesktop.version, baseLock.version, baseLock.packages?.[""]?.version, baseManifest["."]]
    .some((candidate) => candidate === version)) {
    fail(`release version must change from the base version: ${version}`);
  }
  if (headFiles["CHANGELOG.md"] === baseFiles["CHANGELOG.md"] || !headFiles["CHANGELOG.md"].includes(`## [${version}]`)) {
    fail(`CHANGELOG.md must add the ${version} release section`);
  }
  return version;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function validateReleaseTrees(base, head) {
  if (!base || !head || /[\0\r\n]/.test(base) || /[\0\r\n]/.test(head)) fail("base and head revisions are required");
  const changedFiles = git("diff", "--name-only", `${base}...${head}`).trim().split("\n").filter(Boolean);
  const baseFiles = {};
  const headFiles = {};
  for (const file of RELEASE_PR_FILES) {
    baseFiles[file] = git("show", `${base}:${file}`);
    headFiles[file] = git("show", `${head}:${file}`);
  }
  return validateReleaseContents({ changedFiles, baseFiles, headFiles });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
      if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
      return pairs;
    }, []));
    const version = validateReleaseTrees(args.base, args.head);
    console.log(`validated release-please PR for ${version}`);
  } catch (error) {
    console.error(`release PR validation: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
