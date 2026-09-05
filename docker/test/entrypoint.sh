#!/bin/bash
# Bring the node_modules volume in step with the mounted checkout, then run the
# command. A task worktree has no node_modules, and the main checkout's can't
# be borrowed: it is a macOS tree (@rollup/rollup-darwin-arm64, no linux
# binary) and vitest won't start against it. The container installs its own
# once, and every later run of every worktree reuses it.
set -euo pipefail

stamp=/work/node_modules/.docker-test-lockfile
want=$(md5sum /work/package-lock.json | cut -d' ' -f1)

if [ ! -r "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
  echo "[docker-test] installing node_modules (first run or lockfile changed)…" >&2
  # Removes the contents, not the directory: /work/node_modules is a mount
  # point, so npm's own clean step would fail to unlink it.
  find /work/node_modules -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  npm ci
  echo "$want" > "$stamp"
fi

exec "$@"
