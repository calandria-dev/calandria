# syntax=docker/dockerfile:1
# Calandria — one container per user (see docs/DEPLOY.md).
#
# The image bundles Node, git, and the `claude` CLI, and runs BOTH processes
# (Next.js custom server + node-pty terminal sidecar) via docker/entrypoint.sh.
# It is a PRODUCTION build (next build; NODE_ENV=production) so a stopped
# container wakes in seconds, not a dev-mode cold compile.
#
# All per-user state lives under /home/calandria — mount one named volume there:
#   .calandria/         SQLite db        worktrees/  per-task git worktrees
#   projects/           cloned repos     .claude/    claude CLI login (Max)
#   .config/gh/         gh CLI login     .gitconfig  git credential helper
#
# Build:  docker build -t calandria .
# Run:    see docker-compose.yml or the reference `docker run` in docs/DEPLOY.md.

# ---- build stage: install all deps (incl. dev), compile Next ----------------
# Pinned by digest, not by the `22-bookworm-slim` tag, which moves on every
# Node patch and Debian security rebuild — a tag reference means two builds of
# the same commit are not the same image. The digest is the multi-arch INDEX
# digest (linux/amd64 + linux/arm64/v8), so both matrix legs still resolve
# their own manifest from it. .github/dependabot.yml bumps it weekly; keep the
# two FROM lines identical or the runtime stage silently diverges from build.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build
WORKDIR /app

# Toolchain only as a fallback — better-sqlite3 and node-pty ship Linux x64
# prebuilds; node-gyp kicks in (and needs these) only when no prebuild matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# scripts/ first: postinstall runs scripts/fix-pty.js.
# .npmrc carries legacy-peer-deps=true (@xterm/addon-web-links@0.11 only
# declares a peer on @xterm/xterm@^5 but works with the v6 we pin).
COPY package.json package-lock.json .npmrc ./
COPY scripts ./scripts
RUN npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Drop dev deps from node_modules, then restore node-pty's spawn-helper exec
# bit (prune can re-extract prebuilds without it — same reason as postinstall).
RUN npm prune --omit=dev && node scripts/fix-pty.js

# ---- runtime stage -----------------------------------------------------------
# Same digest as the build stage above — see the note there.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

# git: project repos + per-task worktrees.  openssh-client: git over ssh.
# tini: PID 1 (reaps the pty shells' orphans).  procps: ps for debugging shells.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git openssh-client ca-certificates curl bash tini procps \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI: powers the in-app "Connect GitHub" device-flow login and the
# repo picker/clone in project creation. Its token (~/.config/gh/hosts.yml)
# and the git credential helper it configures (~/.gitconfig) live on the home
# volume, so a login survives container stop/start.
# Pinned to an exact apt version (issue #21): an unpinned `apt-get install gh`
# resolves whatever the cli.github.com repo serves at build time, but Docker's
# layer cache keys on the RUN command's *text*, not its result — a rebuild
# that hits a cached layer here silently keeps whatever gh version the cache
# was made with, even after apt has a newer, CVE-fixed package. Bumping this
# version string is now how gh updates happen; check
# `apt-cache madison gh` (or the cli.github.com Packages index) for the
# current version before bumping, then rebuild uncached to confirm the new
# layer actually pulls it.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh=2.98.0 \
  && rm -rf /var/lib/apt/lists/* \
  && gh --version

# The base image's bundled npm (10.9.8) vendors its own tar (7.5.11) and
# brace-expansion (2.0.2), both with HIGH CVEs the image scan flags
# (CVE-2026-59873, CVE-2026-59874, CVE-2026-13149) — unrelated to anything in
# package-lock.json, since this is npm's own dependency tree, not the app's.
# Reinstalling npm replaces its vendored copies. Pinned, not @latest, for the
# same reason CLAUDE_CODE_VERSION/CODEX_VERSION below are pinned.
#
# npm 12.0.2 in turn vendors its own newer (but still-vulnerable) copies of
# tar, brace-expansion, and ip-address — npm's newest release as of
# 2026-08-23, so unfixable here. Tracked in .trivyignore, not re-documented
# per bump; see that file for the current CVE list and revisit policy.
RUN npm install -g npm@12.0.2 && npm --version

# The agent CLIs, pinned. Floating `@latest` installs would make two supply-chain
# decisions per build and leave no two images alike; bump these deliberately
# (`npm view <pkg> version`, then rebuild and exercise the agent) rather than
# inheriting whatever published most recently. Both are ARGs so a one-off build
# can test a candidate version without editing this file:
#   docker build --build-arg CODEX_VERSION=0.147.0 .
ARG CLAUDE_CODE_VERSION=2.1.228
ARG CODEX_VERSION=0.146.0

# The `claude` CLI (Agent SDK spawns it; login state lives in ~/.claude on the
# volume). Pinned location via CLAUDE_CLI_PATH; updates ship as image rebuilds,
# so the in-place autoupdater is disabled. npm 12 (above) blocks postinstall
# scripts by default; claude-code's postinstall fetches its native binary, so
# it needs an explicit allow-scripts grant or the install succeeds but the
# binary is missing.
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && claude --version

# The `codex` CLI (the Codex agent driver drives it via @openai/codex-sdk; login
# state lives in ~/.codex on the volume). Installed globally so CODEX_CLI_PATH /
# PATH lookup and the auth helpers resolve it next to `claude`. Keep this pin in
# step with the @openai/codex-sdk version in package-lock.json — the SDK speaks
# JSONL to this exact binary, so a minor skew between them is a real risk.
RUN npm install -g @openai/codex@${CODEX_VERSION} && codex --version

# Replace the base image's `node` user so uid 1000 owns /home/calandria — named
# volumes initialize from this skeleton with correct ownership on first mount.
#
# /home/orch is kept as a symlink to the new home, and is NOT vestigial: an
# instance that predates the rename has ABSOLUTE /home/orch paths baked into
# rows it cannot re-derive — projects.repo_path, tasks.worktree_path — and into
# the git worktree metadata under each project's .git/worktrees/<id>/gitdir.
# Mounting the same named volume at /home/calandria moves the bytes but not
# those strings, so without the symlink every existing project and task on a
# Docker-hosted instance would point at a path that no longer exists. It costs
# one inode; drop it only once old paths are known to be gone.
RUN userdel -r node \
  && useradd --create-home --uid 1000 --home-dir /home/calandria --shell /bin/bash calandria \
  && mkdir -p /home/calandria/.calandria /home/calandria/worktrees /home/calandria/projects /home/calandria/.claude /home/calandria/.codex \
  && chown -R calandria:calandria /home/calandria \
  && ln -s /home/calandria /home/orch

WORKDIR /app
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/.next ./.next
COPY --from=build --chown=root:root /app/public ./public
COPY --from=build --chown=root:root /app/server.js /app/pty-server.js /app/next.config.mjs /app/package.json ./
# server.js dynamically imports the origin auth verifiers, the service
# hostname router, and the inherited-key guard at runtime (un-bundled, unlike
# the middleware copy compiled into .next). Import graphs:
# lib/auth/origin.mjs -> lib/cf-access.mjs;
# lib/service-router.mjs -> lib/service-host.mjs; lib/env-keys.mjs (also
# imported by pty-server.js) stands alone. lib/auth/{origin,local-origin}.mjs
# are imported by server.js AND pty-server.js — the sidecar runs the same
# mode-aware gate as the app — and arrive with the lib/auth copy below.
# lib/resolveHostname.js is CommonJS and require()'d synchronously (the bind
# address is needed before listen), but it is COPY'd for the same reason.
# lib/db-lock.mjs (the single-instance boot lock) is in the same set: server.js
# imports it un-bundled to claim the database before serving, and lib/db.ts
# imports the bundled copy to decide whether crash recovery may run. Missing
# here, the container would fail to boot. lib/env.mjs is the CALANDRIA_*/ORCH_*
# alias reader db-lock.mjs, the auth .mjs files and server.js itself all import,
# and lib/storage.mjs (which resolves the database/worktree locations, including
# the pre-rename fallback) is imported by server.js and db-lock.mjs alike.
COPY --from=build --chown=root:root /app/lib/cf-access.mjs /app/lib/service-router.mjs /app/lib/service-host.mjs /app/lib/env-keys.mjs /app/lib/db-lock.mjs /app/lib/resolveHostname.js /app/lib/env.mjs /app/lib/storage.mjs ./lib/
COPY --from=build --chown=root:root /app/lib/auth ./lib/auth
# The stdio MCP bridge the non-Claude drivers spawn per turn (node scripts/calandria-mcp.mjs)
# and its shared tool defs — plain-Node .mjs the build output doesn't bundle, so
# they must be COPY'd explicitly (same gotcha as the auth/router .mjs above).
COPY --from=build --chown=root:root /app/scripts/calandria-mcp.mjs ./scripts/calandria-mcp.mjs
COPY --from=build --chown=root:root /app/lib/agentToolDefs.mjs ./lib/agentToolDefs.mjs
# The container boots through docker/entrypoint.sh, not `npm start` — but
# package.json IS in this image, so a script it names has to exist or `npm start`
# in a docker exec fails on a missing file rather than doing the obvious thing.
COPY --from=build --chown=root:root /app/scripts/start.mjs ./scripts/start.mjs
# The hot-backup script (`docker exec ... npm run backup`). It needs better-sqlite3
# from node_modules and lib/env.mjs + lib/storage.mjs, all already above; without
# this line the one recovery tool the image ships would be missing from the image.
COPY --from=build --chown=root:root /app/scripts/backup.mjs ./scripts/backup.mjs
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/calandria-entrypoint

# CALANDRIA_HOSTNAME, not HOSTNAME: server.js no longer reads the generic variable
# (Docker injects the container id into it, and Fedora's /etc/profile exports
# the machine name) — see lib/resolveHostname.js. 0.0.0.0 is correct INSIDE the
# container, where the default loopback bind would make the published port
# unreachable; isolation comes from publishing on the host's loopback only
# (-p 127.0.0.1:<port>:3000) with Cloudflare Tunnel in front.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOME=/home/calandria \
    SHELL=/bin/bash \
    PORT=3000 \
    CALANDRIA_HOSTNAME=0.0.0.0 \
    PTY_HOST=127.0.0.1 \
    PTY_PORT=3001 \
    CALANDRIA_WORKTREES_DIR=/home/calandria/worktrees \
    CLAUDE_CLI_PATH=/usr/local/bin/claude \
    CODEX_CLI_PATH=/usr/local/bin/codex \
    DISABLE_AUTOUPDATER=1

USER calandria
EXPOSE 3000
VOLUME ["/home/calandria"]

# Build provenance. The deploy script passes --build-arg GIT_SHA/BUILT_AT, captured
# from the deploy host's git tree BEFORE rsync (the image has no .git). Exposed
# read-only at GET /api/version so a deploy can be confirmed without ssh. Kept
# late so the per-build SHA churn doesn't bust any earlier layer's cache.
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ENV CALANDRIA_GIT_SHA=$GIT_SHA \
    CALANDRIA_BUILT_AT=$BUILT_AT

# /api/version doubles as the health probe (it exercises Next + SQLite-backed
# routing). It presents SERVICE_TOKEN — the one path middleware.ts exempts from
# the Cloudflare Access check, since no Access JWT exists inside the container.
#
# The token is read from the environment OR from the file the entrypoint writes
# when Access is on and the operator supplied none (see docker/entrypoint.sh —
# keep the path in step with CALANDRIA_SERVICE_TOKEN_FILE there). A healthcheck runs
# as a fresh exec with the IMAGE's environment, not the entrypoint's, so the
# file is the only way a generated token reaches it. Without this, Access mode
# plus an unset SERVICE_TOKEN meant every probe 403'd and the container was
# permanently unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "let t=(process.env.SERVICE_TOKEN||'').trim();if(!t){try{t=require('node:fs').readFileSync('/tmp/calandria-service-token','utf8').trim()}catch{}}fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/version',{headers:t?{'x-service-token':t}:{}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "/usr/local/bin/calandria-entrypoint"]
