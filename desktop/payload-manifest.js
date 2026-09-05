/* What a packaged desktop app has to carry so `node server.js` can boot.
 *
 * This is the same inventory the Dockerfile's runtime stage COPYs, for the
 * same reason: Next's build output does not include the plain-Node `.mjs`
 * files the two entrypoints dynamic-import, so every one of them has to be
 * named explicitly or the app boots into an unresolved import. The
 * Dockerfile carries the prose explaining why each file is in the set (which
 * entrypoint imports it, and what breaks without it); read it there instead
 * of duplicating it here, and add new entries to both. `tests/desktopPayload.test.ts`
 * fails the suite when they drift, keeping the two hand-maintained lists honest.
 *
 * CommonJS with no dependencies: the build script requires it, and so does a
 * vitest test in the root package, which must not need anything from
 * desktop/node_modules (Electron never enters the app's install; see
 * desktop/README.md).
 */
"use strict";

// Installed into the payload instead of copied from the repo, so the desktop
// build gets a pruned production tree instead of the dev checkout's.
const NODE_MODULES = "node_modules";

// Whole directories, copied verbatim.
const COPY_DIRS = [
  ".next",
  "public",
  "lib/auth",
];

// Individual files. Order mirrors the Dockerfile's COPY lines.
const COPY_FILES = [
  "server.js",
  "pty-server.js",
  "next.config.mjs",
  "package.json",
  "lib/cf-access.mjs",
  "lib/service-router.mjs",
  "lib/service-host.mjs",
  "lib/env-keys.mjs",
  "lib/db-lock.mjs",
  "lib/resolveHostname.js",
  "lib/env.mjs",
  "lib/storage.mjs",
  "lib/log.mjs",
  "lib/schema-version.mjs",
  "scripts/calandria-mcp.mjs",
  "lib/agentToolDefs.mjs",
  "lib/agentToolGuard.mjs",
  "scripts/start.mjs",
  "scripts/backup.mjs",
];

// The set the Dockerfile's runtime stage must agree with, exactly.
const DOCKER_PARITY = [NODE_MODULES, ...COPY_DIRS, ...COPY_FILES];

// Needed to produce the payload, not to run it, so they are not part of the
// parity set; the Dockerfile gets these in its build stage instead.
// `.npmrc` pins engine-strict + legacy-peer-deps, and `scripts/fix-pty.js` is
// the root package's postinstall (node-pty's exec bit), whose absence would
// fail the staged `npm ci`.
const BUILD_ONLY = [
  "package-lock.json",
  ".npmrc",
  "scripts/fix-pty.js",
];

module.exports = { NODE_MODULES, COPY_DIRS, COPY_FILES, DOCKER_PARITY, BUILD_ONLY };
