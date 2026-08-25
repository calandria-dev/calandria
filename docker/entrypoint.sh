#!/usr/bin/env bash
# Container entrypoint: run BOTH Calandria processes (Next.js custom server
# + node-pty sidecar) and die if either dies — the container's restart policy
# brings the pair back as a unit. tini is PID 1 above us and reaps orphans.
set -euo pipefail

# Recreate the per-user state layout. Named volumes copy the image's /home/calandria
# skeleton on first mount, but an empty bind mount (or a pre-created volume)
# starts blank — this makes either work.
# Only ever the NEW layout: an image that predates the rename left its database
# at $HOME/.zen-orchestrator/orchestrator.db, and lib/storage.mjs keeps using it
# wherever it exists. Pre-creating an empty $HOME/.calandria can't strand it —
# that fallback tests for the database FILE, not the directory.
mkdir -p \
  "$HOME/.calandria" \
  "${CALANDRIA_WORKTREES_DIR:-${ORCH_WORKTREES_DIR:-$HOME/worktrees}}" \
  "$HOME/projects" \
  "$HOME/.claude"

# Subscription login by default. If an agent key/token env var is present, the
# `claude`/`codex` CLIs (and the Agent SDK child processes, and every pty shell
# — all inherit this environment) prefer it over the volume's stored login and
# silently switch to per-token API billing. Strip them so a stray `-e` on
# `docker run` can never do that — unless CALANDRIA_ALLOW_API_KEY_ENV=1 explicitly
# opts in to env-provided keys. Both node entrypoints repeat this strip
# in-process (lib/env-keys.mjs) so bare-node deploys get the same guard; this
# is the container backstop. See docs/DEPLOY.md → "Per-user claude login".
# CALANDRIA_* wins, the deprecated ORCH_* spelling still answers — the same
# precedence lib/env.mjs applies in-process, hand-rolled because this runs
# before node does.
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
# is the ONLY credential the non-browser callers inside this container can
# present: the HEALTHCHECK, the boot restore of managed services, and the stdio
# MCP bridge the non-Claude agents use all hit routes that otherwise fall
# through to JWT verification, which nothing in here can satisfy. Unset, that
# means a container that never reports healthy. So mint one.
#
# It goes to /tmp (a tmpfs under docker-compose.yml's read-only rootfs), not the
# home volume: this is a runtime credential, not user state, and a fresh one per
# container start is strictly better than one persisted next to the database.
# The HEALTHCHECK reads the same path because it runs as a separate exec with
# the image's environment and never sees what we export here — keep the two in
# step. An operator-supplied SERVICE_TOKEN always wins.
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

# First exit (or a signal) wins; take the other process down with it.
code=0
wait -n || code=$?
term
wait || true
exit "$code"
