#!/usr/bin/env bash
# Container entrypoint: run both Calandria processes (Next.js custom server
# and node-pty sidecar) and exit if either dies, so the container's restart
# policy brings the pair back as a unit. tini is PID 1 above us and reaps
# orphans.
set -euo pipefail

# Recreate the per-user state layout. A named volume copies the image's
# /home/calandria skeleton on first mount, but an empty bind mount (or a
# pre-created volume) starts blank; this makes either work.
# Only ever creates the new layout. An image that predates the rename left its
# database at $HOME/.zen-orchestrator/orchestrator.db, and lib/storage.mjs
# keeps using it wherever it exists; pre-creating an empty $HOME/.calandria
# can't strand it, since that fallback tests for the database file, not the
# directory.
mkdir -p \
  "$HOME/.calandria" \
  "${CALANDRIA_WORKTREES_DIR:-${ORCH_WORKTREES_DIR:-$HOME/worktrees}}" \
  "$HOME/projects" \
  "$HOME/.claude"

# Subscription login by default. The `claude`/`codex` CLIs, the Agent SDK
# child processes, and every pty shell all inherit this environment, and if an
# agent key/token env var is present they prefer it over the volume's stored
# login and switch to per-token API billing. Strip them so a stray `-e` on
# `docker run` can't do that. CALANDRIA_ALLOW_API_KEY_ENV=1 opts back in to
# env-provided keys explicitly. Both node entrypoints repeat this strip
# in-process (lib/env-keys.mjs) so bare-node deploys get the same guard; this
# is the container backstop. See docs/DEPLOY.md, "Per-user claude login".
# CALANDRIA_* wins and the deprecated ORCH_* spelling still answers. lib/env.mjs
# applies the same precedence in-process; it is hand-rolled here since this
# runs before node does.
_allow_key_env="${CALANDRIA_ALLOW_API_KEY_ENV:-${ORCH_ALLOW_API_KEY_ENV:-}}"
if [[ "$_allow_key_env" != "1" && "$_allow_key_env" != "true" ]]; then
  for _v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY; do
    if [[ -n "${!_v:-}" ]]; then
      echo "WARN: $_v was set in the container environment — unsetting it." \
           "Instances authenticate via the connected agent login (or a key saved in Settings);" \
           "set CALANDRIA_ALLOW_API_KEY_ENV=1 to bill an environment-provided key on purpose." >&2
      unset "$_v"
    fi
  done
fi

# SERVICE_TOKEN is optional everywhere except Cloudflare Access mode, where it
# is the only credential the non-browser callers inside this container can
# present: the HEALTHCHECK, the boot restore of managed services, and the
# stdio MCP bridge the non-Claude agents use all hit routes that otherwise
# fall through to JWT verification, which nothing in here can satisfy. Left
# unset, that leaves a container that never reports healthy, so mint one.
#
# It goes to /tmp (a tmpfs under docker-compose.yml's read-only rootfs), not
# the home volume: this is a runtime credential, not user state, and a fresh
# one per container start is better than one persisted next to the database.
# The HEALTHCHECK reads the same path because it runs as a separate exec with
# the image's environment and never sees what is exported here; keep the two
# in step. An operator-supplied SERVICE_TOKEN always wins.
CALANDRIA_SERVICE_TOKEN_FILE=/tmp/calandria-service-token
if [[ -z "${SERVICE_TOKEN:-}" && -n "${CF_ACCESS_TEAM_DOMAIN:-}" && -n "${CF_ACCESS_AUD:-}" ]]; then
  SERVICE_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
  export SERVICE_TOKEN
  ( umask 077 && printf '%s' "$SERVICE_TOKEN" > "$CALANDRIA_SERVICE_TOKEN_FILE" )
  echo "Cloudflare Access is on and no SERVICE_TOKEN was supplied — generated a per-boot one" \
       "for the health probe, service restore, and the agent-tool bridge." >&2
fi

# Optional git identity for task worktree commits, settable per instance
# without entering the container. Never overrides one already on the volume.
if [[ -n "${GIT_USER_NAME:-}" ]] && ! git config --global user.name >/dev/null 2>&1; then
  git config --global user.name "$GIT_USER_NAME"
fi
if [[ -n "${GIT_USER_EMAIL:-}" ]] && ! git config --global user.email >/dev/null 2>&1; then
  git config --global user.email "$GIT_USER_EMAIL"
fi

cd /app

term() {
  kill "${PTY_PID:-}" "${APP_PID:-}" 2>/dev/null || true
}
trap term TERM INT

node pty-server.js &
PTY_PID=$!
node server.js &
APP_PID=$!

# The first exit or signal wins; take the other process down with it.
code=0
wait -n || code=$?
term
wait || true
exit "$code"
