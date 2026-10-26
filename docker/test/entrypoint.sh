#!/bin/bash
set -euo pipefail

image_id=${CALANDRIA_TEST_IMAGE_ID:-}
want=$(node -e 'const fs=require("node:fs");const c=require("node:crypto").createHash("sha256");c.update(fs.readFileSync("package.json"));c.update(fs.readFileSync("package-lock.json"));c.update(process.argv[1]);process.stdout.write(c.digest("hex"))' "$image_id")

if [ -n "${CALANDRIA_TEST_CACHE_ID:-}" ] && [ "$CALANDRIA_TEST_CACHE_ID" != "$want" ]; then
  echo "[docker-test] checkout changed after cache selection; retry the command" >&2
  exit 75
fi

modules=$(cd "$PWD/node_modules" && pwd -P)
stamp="$modules/.docker-test-cache-id"
# Lock the mounted directory inode. Keep fd 9 open through exec so active suites
# hold a shared lock while they use the dependencies.
exec 9<"$modules"

while true; do
  flock -s 9
  if [ -r "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
    exec "$@"
  fi

  flock -u 9
  flock -x 9
  if [ ! -r "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
    echo "[docker-test] installing node_modules (cache identity changed)…" >&2
    find "$modules" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    npm ci
    printf '%s\n' "$want" > "$stamp.tmp"
    mv "$stamp.tmp" "$stamp"
  fi
  flock -u 9
done
