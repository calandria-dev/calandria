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
#   CALANDRIA_TEST_VOLUME   named volume holding node_modules (default below).
#                           Shared by every worktree; `docker volume rm` it to
#                           reset. Renamed from ORCH_TEST_VOLUME; `docker
#                           volume rm` any leftover orch-test-node-modules
#                           and `docker image rm` old orch-test:* tags too.
#   CALANDRIA_TEST_USER     "uid:gid" to run as. Unset (root) is right on a host
#                           whose bind mounts remap ownership (OrbStack/Docker
#                           Desktop do; a plain Linux daemon does not, and there
#                           root leaves you root-owned .next/ and test-results/).
#   CALANDRIA_TEST_REBUILD  =1 to rebuild the image even though the tag exists
#                           (needed after editing docker/test/*).
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
image="calandria-test:${target}-pw${pw}"
volume=${CALANDRIA_TEST_VOLUME:-calandria-test-node-modules}

if [ "${CALANDRIA_TEST_REBUILD:-}" = "1" ] || ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "[docker-test] building $image (once; ~a few minutes for the e2e target)" >&2
  docker build --target "$target" --build-arg "PLAYWRIGHT_VERSION=$pw" -t "$image" docker/test
fi

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
if [ -n "${CALANDRIA_TEST_USER:-}" ]; then run+=(--user "$CALANDRIA_TEST_USER" -e HOME=/tmp); fi
run+=(-v "$PWD":/work -v "$volume":/work/node_modules -w /work "$image")

exec "${run[@]}" "$@"
