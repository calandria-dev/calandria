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

# Toolchain only as a fallback, and only node-pty can still reach for it: it
# fetches a per-ABI Linux prebuild at install time and compiles when that finds
# nothing. better-sqlite3 13 cannot — it is N-API and carries linux-x64/arm64
# (glibc and musl) binaries inside its own package, with `gypfile: false` and no
# install script, so there is no node-gyp path left for it on any platform we
# build for.
#
# That last sentence holds for `npm ci` (below) only because package-lock.json
# repeats `"gypfile": false` on better-sqlite3's entry by hand — npm does not
# copy that manifest field into a lockfile, and without it arborist synthesizes
# `node-gyp rebuild` here from the tarball's `binding.gyp`. On this image that
# was silent (the compile half-finishes, the bundled prebuild loads anyway, the
# build stays green) while the same defect failed outright on Windows. npm
# strips the field on any lockfile regeneration; tests/lockfileGypfile.test.ts
# is the guard, docs/WINDOWS.md the account.
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
# You should not have to notice this yourself: cli.github.com carries ONLY its
# newest release, so a gh release does not leave this pin old, it leaves it
# gone. `Pin drift` (.github/workflows/pin-drift.yml) reads the repo's Packages
# index daily and files an issue when this line falls behind, and
# publish-image.yml's Sunday cron builds uncached so a rotted pin cannot hide
# behind a cached layer. Keep the `gh=` spelling on one line; the check's regex
# reads it from here.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh=2.100.0 \
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

# The agent CLIs, pinned. Floating `@latest` installs would make a supply-chain
# decision per build and leave no two images alike; bump these deliberately
# rather than inheriting whatever published most recently. All three are ARGs so
# a one-off build can test a candidate without editing this file:
#   docker build --build-arg CODEX_VERSION=0.147.0 .
#
# Deliberately is not the same as never. npm keeps old versions, so a stale pin
# here still BUILDS and fails later instead: 0.146.0 could not run GPT-6 Astra
# at all ("model requires a newer version of codex"), because a new model can
# require a CLI bump and not just a catalog entry. `Pin drift`
# (.github/workflows/pin-drift.yml) watches both npm pins and files an issue at
# three weeks old or three newer minors, carrying the bump checklist — including
# the one step no job can take, exercising the agent against a real login.
ARG CLAUDE_CODE_VERSION=2.1.260
ARG CODEX_VERSION=0.153.0
ARG AGY_VERSION=1.1.26

# The `claude` CLI (Agent SDK spawns it; login state lives in ~/.claude on the
# volume). Pinned location via CLAUDE_CLI_PATH; updates ship as image rebuilds,
# so the in-place autoupdater is disabled. npm 12 (above) blocks postinstall
# scripts by default; claude-code's postinstall fetches its native binary, so
# it needs an explicit allow-scripts grant or the install succeeds but the
# binary is missing.
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && claude --version

# The `codex` CLI (the Codex agent driver drives it via @openai/codex-sdk; login
# state lives in ~/.codex on the volume). Installed globally so CODEX_CLI_PATH /
# PATH lookup and the auth helpers resolve it next to `claude`. This pin must
# EQUAL the @openai/codex version that @openai/codex-sdk exact-depends on: the
# SDK speaks JSONL to one binary, and which one depends on where Calandria runs
# — ENV CODEX_CLI_PATH below points at this global install, while outside the
# image that variable is empty and the SDK drives its own vendored copy. Let the
# two diverge and dev and prod run different CLIs. `tests/cliPins.test.ts`
# compares this ARG against package.json and the lockfile, which is also why
# @openai/codex-sdk is pinned exactly there: a caret let `npm install` float the
# SDK a patch and desynchronize it from this line with nothing to notice.
#
# One consequence for the model catalog, since the floor above is easy to miss
# from a dev machine: verify a new entry in lib/agents/codex/capabilities.ts
# against THIS pin, not against whatever codex a developer happens to have
# installed locally. Astra was confirmed working on 0.153.0 and listed while
# this ARG still read 0.146.0 — the same skew, arriving through the catalog.
RUN npm install -g @openai/codex@${CODEX_VERSION} && codex --version

# The `agy` CLI (Antigravity — the Gemini agent driver spawns it directly; there
# is no SDK). Not on npm: the vendor ships a per-platform tarball named by a
# manifest, and their install.sh just reads that manifest, downloads, checks a
# SHA-512 and drops the single binary in place. We do those steps ourselves
# against a PINNED version rather than piping the script, so a build is
# reproducible and the checksum is reviewed in this file rather than fetched.
#
# Refresh both digests together when bumping AGY_VERSION; they come from
#   curl -fsSL https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json
# (and .../linux_arm64.json), whose `version` field is what the ARG must match.
# `Pin drift` (.github/workflows/pin-drift.yml) reads those same two manifests
# daily and files an issue when this ARG or either digest falls behind, so the
# bump is scheduled work rather than a build failure (issue #182).
#
# The binary self-updates in the background by default, which would silently
# replace this pin mid-turn — AGY_CLI_DISABLE_AUTO_UPDATE below turns that off
# image-wide, and the driver sets it on every spawn as a second belt.
ARG AGY_SHA512_AMD64=80f2e7bf1fe0833487975b320b07176b82dd2cc2043b8acb4201b37b86d604af50718400b58af0f41adc68b389640f6ff95362da87a9ef1682b34258e83110b2
ARG AGY_SHA512_ARM64=332dddb06ab4d901a44cfd4b9b358848230e64a64515a8e79b03822348adac9ce92d54cb4fc5119ef075edfba922820c926dfddf82d3a49f4ecdb6e6704dfc75
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) manifest=linux_amd64; sha="${AGY_SHA512_AMD64}" ;; \
      arm64) manifest=linux_arm64; sha="${AGY_SHA512_ARM64}" ;; \
      *) echo "unsupported architecture for the agy CLI: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    # The download URL carries an opaque build id after the version, so it is
    # read from the manifest rather than templated from AGY_VERSION alone.
    url="$(curl -fsSL "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${manifest}.json" \
            | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"; \
    # The manifest always serves the LATEST build, so a stale pin has to fail the
    # build loudly rather than install a version whose checksum we never reviewed.
    case "$url" in *"/${AGY_VERSION}-"*) : ;; \
      *) echo "manifest no longer serves AGY_VERSION=${AGY_VERSION} (got ${url}); bump the ARG and both SHA-512s" >&2; exit 1 ;; \
    esac; \
    workdir="$(mktemp -d)"; \
    curl -fsSL -o "${workdir}/agy.tar.gz" "$url"; \
    echo "${sha}  ${workdir}/agy.tar.gz" | sha512sum -c -; \
    tar -xzf "${workdir}/agy.tar.gz" -C "${workdir}"; \
    install -m 0755 "$(find "${workdir}" -type f -name antigravity | head -1)" /usr/local/bin/agy; \
    rm -rf "${workdir}"; \
    AGY_CLI_DISABLE_AUTO_UPDATE=true agy --version

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
  && mkdir -p /home/calandria/.calandria /home/calandria/worktrees /home/calandria/projects /home/calandria/.claude /home/calandria/.codex /home/calandria/.gemini \
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
# lib/log.mjs is the shared line emitter (CALANDRIA_LOG_FORMAT) both entrypoints
# import for their own output and lib/config.ts imports for the bundled half —
# missing here, every boot line and every turn-lifecycle line dies on an
# unresolved import. lib/schema-version.mjs is the schema stamp + boot gate
# (-> lib/storage.mjs): server.js runs it right after claiming the lock so a
# rolled-back image tag refuses to start instead of writing to a database a
# newer build already migrated.
COPY --from=build --chown=root:root /app/lib/cf-access.mjs /app/lib/service-router.mjs /app/lib/service-host.mjs /app/lib/env-keys.mjs /app/lib/db-lock.mjs /app/lib/resolveHostname.js /app/lib/env.mjs /app/lib/storage.mjs /app/lib/log.mjs /app/lib/schema-version.mjs ./lib/
COPY --from=build --chown=root:root /app/lib/auth ./lib/auth
# The stdio MCP bridge the non-Claude drivers spawn per turn (node scripts/calandria-mcp.mjs)
# and its shared tool defs — plain-Node .mjs the build output doesn't bundle, so
# they must be COPY'd explicitly (same gotcha as the auth/router .mjs above).
COPY --from=build --chown=root:root /app/scripts/calandria-mcp.mjs ./scripts/calandria-mcp.mjs
COPY --from=build --chown=root:root /app/lib/agentToolDefs.mjs ./lib/agentToolDefs.mjs
COPY --from=build --chown=root:root /app/lib/agentToolGuard.mjs ./lib/agentToolGuard.mjs
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
    AGY_CLI_PATH=/usr/local/bin/agy \
    AGY_CLI_DISABLE_AUTO_UPDATE=true \
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
