#!/usr/bin/env node
// Re-adds "gypfile": false to package-lock.json entries that need it. npm
// never writes this field into a lockfile entry (npm/cli#9837, fix PR
// npm/cli#9859 still unmerged), so every lockfile regeneration drops it. Its
// absence makes `npm ci` run `node-gyp rebuild` on a package that ships a
// binding.gyp but builds nothing under `npm ci`, and on Windows that fails
// outright with `gyp ERR! find VS`. tests/lockfileGypfile.test.ts is what
// reports the omission; this script applies the fix its failure message
// describes.
//
// Usage:
//   node scripts/fix-lockfile-gypfile.mjs
//     repair the repo-root package-lock.json
//   node scripts/fix-lockfile-gypfile.mjs --check
//     report what is missing on the repo-root lockfile, write nothing
//   node scripts/fix-lockfile-gypfile.mjs [--check] <path/to/package-lock.json>
//     operate on the given lockfile instead, --check may come before or after the path
//
// Exit codes: 0 lockfile already correct or repaired, 1 --check found a
// missing entry, 2 usage error, missing lockfile, or a JSON parse failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCKFILE = path.join(SCRIPT_DIR, "..", "package-lock.json");

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/fix-lockfile-gypfile.mjs [--check] [path/to/package-lock.json]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  let check = false;
  let lockfilePath = null;
  for (const arg of argv) {
    if (arg === "--check") {
      check = true;
    } else if (arg.startsWith("-")) {
      usage(`unrecognized argument: ${arg}`);
    } else if (lockfilePath === null) {
      lockfilePath = arg;
    } else {
      usage(`unexpected extra argument: ${arg}`);
    }
  }
  return { check, lockfilePath: lockfilePath ?? DEFAULT_LOCKFILE };
}

/** Reads and parses package.json at dir. Returns null when absent or invalid. */
function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Lockfile keys that need "gypfile": false. node_modules/better-sqlite3 is
 * always included when the key exists in lock.packages: it is the entry the
 * defect was found on, and the only one this reports on when node_modules is
 * absent from disk. The scan adds every other node_modules/ entry whose
 * installed directory carries a binding.gyp, whose installed package.json
 * sets gypfile to exactly false, and whose installed package.json declares
 * no install or preinstall script, matching tests/lockfileGypfile.test.ts's
 * detection. An entry whose installed directory is missing is skipped by the
 * binding.gyp existence check, so a tree with no node_modules still works.
 */
function findTargets(lock, lockfileDir) {
  const targets = new Set();
  const packages = lock.packages ?? {};
  if (Object.prototype.hasOwnProperty.call(packages, "node_modules/better-sqlite3")) {
    targets.add("node_modules/better-sqlite3");
  }
  for (const lockPath of Object.keys(packages)) {
    if (!lockPath.startsWith("node_modules/")) continue;
    const dir = path.join(lockfileDir, lockPath);
    if (!fs.existsSync(path.join(dir, "binding.gyp"))) continue;
    const manifest = readManifest(dir);
    if (!manifest || manifest.gypfile !== false) continue;
    const scripts = manifest.scripts ?? {};
    if (scripts.install || scripts.preinstall) continue;
    targets.add(lockPath);
  }
  return [...targets];
}

/**
 * Rebuilds a lockfile entry with gypfile: false inserted right after
 * integrity when present, else resolved, else version, else as the first
 * key. Every other key keeps its original position.
 */
function withGypfile(entry) {
  const keys = Object.keys(entry);
  const anchor = ["integrity", "resolved", "version"].find((key) => keys.includes(key));
  const out = {};
  if (!anchor) out.gypfile = false;
  for (const key of keys) {
    out[key] = entry[key];
    if (key === anchor) out.gypfile = false;
  }
  return out;
}

function main() {
  const { check, lockfilePath } = parseArgs(process.argv.slice(2));

  let raw;
  try {
    raw = fs.readFileSync(lockfilePath, "utf8");
  } catch (err) {
    console.error(`could not read ${lockfilePath}: ${err.message}`);
    process.exit(2);
  }

  let lock;
  try {
    lock = JSON.parse(raw);
  } catch (err) {
    console.error(`${lockfilePath} is not valid JSON: ${err.message}`);
    process.exit(2);
  }

  const lockfileDir = path.dirname(lockfilePath);
  const packages = lock.packages ?? {};

  if (!Object.prototype.hasOwnProperty.call(packages, "node_modules/better-sqlite3")) {
    console.log(
      "node_modules/better-sqlite3 is not in this lockfile's packages, continuing with the scan",
    );
  }

  const targets = findTargets(lock, lockfileDir);
  const missing = targets.filter((key) => packages[key]?.gypfile !== false);

  if (missing.length === 0) {
    console.log(
      `package-lock.json already carries "gypfile": false for ${targets.length} entr${
        targets.length === 1 ? "y" : "ies"
      }`,
    );
    process.exit(0);
  }

  if (check) {
    for (const key of missing) {
      console.log(`missing "gypfile": false on ${key}`);
    }
    process.exit(1);
  }

  for (const key of missing) {
    packages[key] = withGypfile(packages[key]);
    console.log(`added "gypfile": false to ${key}`);
  }
  fs.writeFileSync(lockfilePath, JSON.stringify(lock, null, 2) + "\n");
  process.exit(0);
}

main();
