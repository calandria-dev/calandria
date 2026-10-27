#!/usr/bin/env bash
# Runs a command against this checkout inside a throwaway Linux test container.
#
#   scripts/docker-test.sh [--e2e] [command…]     (default: npm test)
#
# Prefer the npm aliases: test:docker, typecheck:docker, test:e2e:docker,
# preflight:docker. Extra args pass straight through, e.g.
#   npm run test:docker -- tests/merge.test.ts
#
# Env knobs:
#   CALANDRIA_TEST_VOLUME   named volume holding node_modules. When unset, a
#                           volume name is derived from package.json,
#                           package-lock.json and the resolved image ID.
#                           Newly created volumes use the
#                           `com.calandria.cache=disposable` label; `docker
#                           volume rm` resets the cache. Renamed from ORCH_TEST_VOLUME;
#                           `docker volume rm` any leftover orch-test-node-modules
#                           and `docker image rm` old orch-test:* tags too.
#   CALANDRIA_TEST_USER     "uid:gid" to run as, or "root". Unset means your own
#                           uid:gid on a Linux daemon running rootful, so .next/,
#                           test-results/ and next-env.d.ts stay deletable by
#                           you (and by a reclaim). Unset means root elsewhere:
#                           OrbStack, Docker Desktop and rootless Docker remap
#                           bind-mount ownership, so root writes land as you.
#   CALANDRIA_TEST_REBUILD  =1 to rebuild the image even though the tag exists.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

target=base
if [ "${1:-}" = "--e2e" ]; then
  target=e2e
  shift
fi
[ "$#" -gt 0 ] || set -- npm test

# The browsers baked into the image must match the @playwright/test that npm ci
# installs, or playwright re-downloads chromium on every run. Read the resolved
# version from the lockfile instead of the ^range in package.json, so a
# dependency bump changes the image tag (and forces a rebuild) instead of
# leaving the two out of sync.
pw=$(node -p "require('./package-lock.json').packages['node_modules/@playwright/test'].version")
harness_hash=$(node -e 'const fs=require("node:fs");const c=require("node:crypto").createHash("sha256");for(const p of process.argv.slice(1))c.update(fs.readFileSync(p));process.stdout.write(c.digest("hex"))' docker/test/Dockerfile docker/test/entrypoint.sh)
image="calandria-test:${target}-pw${pw}-${harness_hash}"
volume=${CALANDRIA_TEST_VOLUME:-}

if [ "${CALANDRIA_TEST_REBUILD:-}" = "1" ] || ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "[docker-test] building $image (once; ~a few minutes for the e2e target)" >&2
  docker build --target "$target" --build-arg "PLAYWRIGHT_VERSION=$pw" -t "$image" docker/test
fi

# Resolve the built image once so concurrent runs cannot share a mutable tag
# while Docker rebuilds it.
image_id=$(docker image inspect --format '{{.Id}}' "$image")
if [ -z "$image_id" ]; then
  echo "[docker-test] failed to resolve image ID for $image" >&2
  exit 1
fi
cache_id=$(node -e 'const fs=require("node:fs");const c=require("node:crypto").createHash("sha256");c.update(fs.readFileSync("package.json"));c.update(fs.readFileSync("package-lock.json"));c.update(process.argv[1]);process.stdout.write(c.digest("hex"))' "$image_id")

# Rootful Linux daemons write bind-mount files with the container's own uid.
user=${CALANDRIA_TEST_USER-}
if [ -z "${CALANDRIA_TEST_USER+set}" ] && [ "$(uname -s)" = Linux ] && [ "$(id -u)" != 0 ] \
  && ! docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
  user="$(id -u):$(id -g)"
fi
[ "$user" = root ] && user=

# The cache key covers the user too: an install made as root leaves files a
# different uid can't replace when the lockfile changes.
if [ -z "$volume" ]; then volume="calandria-test-node-modules-$cache_id${user:+-u${user%%:*}}"; fi

# Newly created test caches carry a disposable label so a Linux host can clean
# dangling caches without selecting unrelated Docker volumes. Docker leaves an
# existing volume unchanged, including its labels.
docker volume create --label "com.calandria.cache=disposable" --name "$volume" >/dev/null

# --init: tini as PID 1. Without it the test process is PID 1, which doesn't
# reap orphans, and tests/services.test.ts's orphaned-process-group case fails
# for a reason unrelated to the code under test.
#
# One array, appended to and never empty: `"${maybe_empty[@]}"` under `set -u`
# is an unbound-variable error in the bash 3.2 that macOS still ships.
run=(docker run --rm --init)
if [ -t 0 ] && [ -t 1 ]; then run+=(-it); fi
# HOME as well as --user: an arbitrary uid has no passwd entry, so npm falls
# back to writing its cache at /.npm and dies with EACCES before a test runs.
if [ -n "$user" ]; then run+=(--user "$user" -e HOME=/tmp); fi
run+=(-e "CALANDRIA_TEST_IMAGE_ID=$image_id" -e "CALANDRIA_TEST_CACHE_ID=$cache_id" -v "$PWD":/work -v "$volume":/work/node_modules -w /work "$image_id")

exec "${run[@]}" "$@"
