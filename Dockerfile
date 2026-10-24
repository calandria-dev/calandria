# syntax=docker/dockerfile:1
# Calandria runs as one container per user (see docs/DEPLOY.md).
#
# The image bundles Node, git, and the `claude` CLI, and runs both processes
# (Next.js custom server + node-pty terminal sidecar) via docker/entrypoint.sh.
# It is a production build (next build; NODE_ENV=production), so a stopped
# container starts without a dev-mode compile.
#
# All per-user state lives under /home/calandria. Mount one named volume there:
#   .calandria/         SQLite db        worktrees/  per-task git worktrees
#   projects/           cloned repos     .claude/    claude CLI login (Max)
#   .config/gh/         gh CLI login     .gitconfig  git credential helper
#
# Build:  docker build -t calandria .
# Run:    see docker-compose.yml or the reference `docker run` in docs/DEPLOY.md.

# ---- build stage: install all deps (incl. dev), compile Next ----------------
# Pinned by digest rather than the `26-bookworm-slim` tag, which moves on every
# Node patch and Debian security rebuild, so a tag reference would not give two
# builds of the same commit the same image. The digest is the multi-arch index
# digest (linux/amd64 + linux/arm64/v8), so both matrix legs resolve their own
# manifest from it. .github/dependabot.yml bumps it weekly; keep the two FROM
# lines identical or the runtime stage diverges from the build stage.
#
# A current digest is not a current Debian package set. The tag is rebuilt on
# Node's cadence, so between rebuilds this layer holds packages Debian has
# already fixed. The runtime stage runs `apt-get upgrade` for that reason; the
# note at that line carries the reasoning.
FROM node:26-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913 AS build
WORKDIR /app

# The toolchain is a fallback for node-pty, which fetches a per-ABI Linux
# prebuild at install time and compiles when that finds nothing. better-sqlite3
# 13 is N-API and carries linux-x64/arm64 (glibc and musl) binaries inside its
# own package, with `gypfile: false` and no install script, so it never takes
# the node-gyp path on any platform this image builds for.
#
# That holds for `npm ci` below only because package-lock.json repeats
# `"gypfile": false` on better-sqlite3's entry by hand: npm does not copy that
# manifest field into a lockfile, and without it arborist synthesizes
# `node-gyp rebuild` from the tarball's `binding.gyp`. npm strips the field on
# any lockfile regeneration; tests/lockfileGypfile.test.ts guards it, and
# docs/WINDOWS.md has the failure this caused there.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# scripts/ is copied first because postinstall runs scripts/fix-pty.js.
# .npmrc carries legacy-peer-deps=true: @xterm/addon-web-links@0.11 only
# declares a peer on @xterm/xterm@^5 but works with the v6 pinned here.
COPY package.json package-lock.json .npmrc ./
COPY scripts ./scripts
RUN npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Drop dev deps from node_modules, then restore node-pty's spawn-helper exec
# bit: prune can re-extract prebuilds without it, the same issue postinstall
# works around.
RUN npm prune --omit=dev && node scripts/fix-pty.js

# ---- runtime stage -----------------------------------------------------------
# Same digest as the build stage above.
FROM node:26-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913

# git: project repos and per-task worktrees. openssh-client: git over ssh.
# tini: PID 1, reaps the pty shells' orphans. procps: ps for debugging shells.
#
# `apt-get upgrade` covers the packages the base image already carries and
# this line does not name. The FROM above is pinned by digest and Dependabot
# rewrites it weekly, but Debian publishes a security update against bookworm
# as soon as it is built, while the `node:26-bookworm-slim` tag is rebuilt on
# Node's cadence. Between those two the pinned layer accumulates CVEs that
# Debian has already fixed, which is what `Image scan (trivy)` reports: every
# finding is `ignore-unfixed: true`, so every finding has a fixed version in
# the archive. Installing only the seven packages named here left
# libpcre2-8-0 at 10.42-1 with 10.42-1+deb12u1 sitting in the archive
# (CVE-2026-86145, CVE-2026-89161, issue #363).
#
# This depends on the layer actually being rebuilt. Docker keys a layer on the
# RUN command's text, so a cached build reuses whatever apt resolved the last
# time the cache was cold. The agy layer below has the same property.
# publish-image.yml's Sunday cron (09:23 UTC) builds with `no-cache` and
# pushes `:edge`; security-scan.yml reads `:edge` on Monday at 06:00 UTC. The
# cold build is the one the scan sees, so this repeats every week on its own
# instead of needing a digest bump by hand.
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
       git openssh-client ca-certificates curl bash tini procps \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI: powers the in-app "Connect GitHub" device-flow login and the
# repo picker/clone in project creation. Its token (~/.config/gh/hosts.yml)
# and the git credential helper it configures (~/.gitconfig) live on the home
# volume, so a login survives container stop/start.
#
# Installed from the GitHub release tarball for GH_VERSION. Release assets on
# github.com are permanent, so an old pin keeps building after gh ships a new
# release. The tarball is checked against the release's own checksums file.
# `Pin drift` (.github/workflows/pin-drift.yml) reads the latest gh release and
# files an issue when this ARG falls behind; bump it by hand. Keep the ARG on
# one line: the pin-drift check reads it with a line-anchored regex.
ARG GH_VERSION=2.103.2
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64|arm64) : ;; \
      *) echo "unsupported architecture for the gh CLI: $arch" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/cli/cli/releases/download/v${GH_VERSION}"; \
    tarball="gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    workdir="$(mktemp -d)"; \
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o "${workdir}/${tarball}" "${base}/${tarball}"; \
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o "${workdir}/checksums.txt" "${base}/gh_${GH_VERSION}_checksums.txt"; \
    (cd "${workdir}" && grep " ${tarball}\$" checksums.txt | sha256sum -c -); \
    tar -xzf "${workdir}/${tarball}" -C "${workdir}"; \
    install -m 0755 "${workdir}/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf "${workdir}"; \
    gh --version

# The base image's bundled npm (10.9.8) vendors its own tar (7.5.11) and
# brace-expansion (2.0.2), both flagged by the image scan with HIGH CVEs
# (CVE-2026-59873, CVE-2026-59874, CVE-2026-13149) in npm's own dependency
# tree, unrelated to package-lock.json. Reinstalling npm replaces those
# vendored copies. Pinned rather than @latest, for the same reason
# CLAUDE_CODE_VERSION/CODEX_VERSION below are pinned.
#
# npm 12.0.2 in turn vendors its own newer but still-vulnerable copies of tar,
# brace-expansion, and ip-address, unfixable here since it is npm's newest
# release. Tracked in .trivyignore; see that file for the current CVE list and
# revisit policy. Bumping this pin is how those four clear.
RUN npm install -g npm@12.0.2 && npm --version

# The npm agent CLIs, pinned. A floating `@latest` install would make a
# supply-chain decision per build and leave no two images alike. Both are ARGs
# so a one-off build can test a candidate without editing this file:
#   docker build --build-arg CODEX_VERSION=0.147.0 .
#
# `Pin drift` (.github/workflows/pin-drift.yml) runs hourly and keeps these
# two ARGs, @openai/codex-sdk and @anthropic-ai/claude-agent-sdk on the newest
# release. It opens one bot PR as soon as any of them moves, dispatches the
# required test, desktop skip and uncached image workflows against the exact
# branch head, and enables squash auto-merge after verifying that head. GitHub
# merges only after every required check passes.
ARG CLAUDE_CODE_VERSION=2.1.310
ARG CODEX_VERSION=0.164.0

# The `claude` CLI: the Agent SDK spawns it, and login state lives in
# ~/.claude on the volume. Pinned location via CLAUDE_CLI_PATH; updates ship as
# image rebuilds, so the in-place autoupdater is disabled. npm 12 (above)
# blocks postinstall scripts by default; claude-code's postinstall fetches its
# native binary, so it needs an explicit allow-scripts grant or the install
# succeeds with the binary missing.
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && claude --version

# The `codex` CLI: the Codex agent driver drives it via @openai/codex-sdk, and
# login state lives in ~/.codex on the volume. Installed globally so
# CODEX_CLI_PATH / PATH lookup and the auth helpers resolve it next to
# `claude`. This pin must equal the @openai/codex version that
# @openai/codex-sdk exact-depends on: the SDK speaks JSONL to one binary, and
# ENV CODEX_CLI_PATH below points the in-image SDK at this global install,
# while outside the image that variable is empty and the SDK drives its own
# vendored copy. If the two diverge, dev and prod run different CLIs.
# `tests/cliPins.test.ts` compares this ARG against package.json and the
# lockfile, which is also why @openai/codex-sdk is pinned exactly there: a
# caret would let `npm install` float the SDK a patch and desynchronize it
# from this line with nothing to notice.
#
# Verify a new entry in lib/agents/codex/capabilities.ts against this pin, not
# against whatever codex a developer has installed locally: a model can work
# on a newer CLI than this ARG names and not yet on this one.
RUN npm install -g @openai/codex@${CODEX_VERSION} && codex --version

# The `agy` CLI (Antigravity): the Gemini agent driver spawns it directly,
# with no SDK in between. Not on npm: the vendor ships a per-platform tarball
# named by a manifest, and their install.sh reads that manifest, downloads,
# checks a SHA-512 and drops the single binary in place. This step does the
# same against
#   https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_{amd64,arm64}.json
# The manifest serves only the newest build, so the image installs that build:
# `url`, `sha512` and `version` all come from the manifest, and the tarball is
# verified against its `sha512`. Docker caches this layer on the RUN text, so a
# cached build keeps the agy it last fetched; publish-image.yml's Sunday cron
# builds uncached and picks up the newest.
#
# AGY_VERSION is empty by default. Set it to make a one-off build assert a
# version: the build fails when the manifest serves a different one.
#   docker build --build-arg AGY_VERSION=1.4.7 .
#
# The binary self-updates in the background by default, which would replace
# the installed build mid-turn. AGY_CLI_DISABLE_AUTO_UPDATE below turns that
# off image-wide, and the driver sets it on every spawn as a second guard.
ARG AGY_VERSION=
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) manifest=linux_amd64 ;; \
      arm64) manifest=linux_arm64 ;; \
      *) echo "unsupported architecture for the agy CLI: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    # Fetched and checked on its own, so a network failure is reported as one.
    # In `x="$(curl ... | sed ...)"` the status is sed's, which is 0 on empty
    # input, so a dead curl would fall through to the empty-field checks below
    # with a misleading message. Retried because it is the one network read the
    # rest of this step depends on.
    manifest_json="$(curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 --max-time 60 \
                       "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${manifest}.json")" \
      || { echo "could not fetch the agy ${manifest} manifest: NETWORK failure" >&2; exit 1; }; \
    field() { printf '%s' "$manifest_json" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }; \
    url="$(field url)"; sha="$(field sha512)"; version="$(field version)"; \
    [ -n "$url" ] || { echo "the agy ${manifest} manifest has no url: ${manifest_json}" >&2; exit 1; }; \
    [ -n "$sha" ] || { echo "the agy ${manifest} manifest has no sha512: ${manifest_json}" >&2; exit 1; }; \
    if [ -n "${AGY_VERSION}" ] && [ "$version" != "${AGY_VERSION}" ]; then \
      echo "the agy ${manifest} manifest serves ${version:-no version}, not AGY_VERSION=${AGY_VERSION}" >&2; exit 1; \
    fi; \
    echo "installing agy ${version:-(unversioned)} from ${url}"; \
    workdir="$(mktemp -d)"; \
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o "${workdir}/agy.tar.gz" "$url"; \
    echo "${sha}  ${workdir}/agy.tar.gz" | sha512sum -c -; \
    tar -xzf "${workdir}/agy.tar.gz" -C "${workdir}"; \
    install -m 0755 "$(find "${workdir}" -type f -name antigravity | head -1)" /usr/local/bin/agy; \
    rm -rf "${workdir}"; \
    AGY_CLI_DISABLE_AUTO_UPDATE=true agy --version

# Replace the base image's `node` user so uid 1000 owns /home/calandria: named
# volumes initialize from this skeleton with correct ownership on first mount.
#
# /home/orch is kept as a symlink to the new home. An instance that predates
# the rename has absolute /home/orch paths baked into rows it cannot re-derive
# (projects.repo_path, tasks.worktree_path) and into the git worktree metadata
# under each project's .git/worktrees/<id>/gitdir. Mounting the same named
# volume at /home/calandria moves the bytes but not those strings, so without
# the symlink every existing project and task on a Docker-hosted instance would
# point at a path that no longer exists. It costs one inode; drop it only once
# old paths are known to be gone.
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
# server.js and pty-server.js are plain CommonJS and dynamically import their
# `lib/` dependencies at runtime, un-bundled, unlike the middleware copy Next
# compiles into .next. Each `.mjs` here is COPY'd because a missing one breaks
# boot on an unresolved import:
# - lib/auth/origin.mjs (-> lib/cf-access.mjs) and lib/auth/local-origin.mjs:
#   the origin-auth verifiers, imported by both server.js and pty-server.js so
#   the sidecar runs the same mode-aware gate as the app; arrive via the
#   lib/auth copy below.
# - lib/service-router.mjs (-> lib/service-host.mjs): the public service
#   hostname router.
# - lib/env-keys.mjs: the inherited-API-key guard, imported by both entrypoints.
# - lib/resolveHostname.js: CommonJS, require()'d synchronously because the
#   bind address is needed before listen.
# - lib/db-lock.mjs: the single-instance boot lock. server.js imports the
#   un-bundled copy to claim the database before serving; lib/db.ts imports the
#   bundled copy to decide whether crash recovery may run.
# - lib/env.mjs: the CALANDRIA_*/ORCH_* alias reader, imported by db-lock.mjs,
#   the auth .mjs files, and server.js itself.
# - lib/storage.mjs: resolves the database/worktree locations, including the
#   pre-rename fallback; imported by server.js and db-lock.mjs.
# - lib/homeDir.mjs (<- lib/storage.mjs): the home directory, read through a
#   module boundary the build's file tracer cannot see past.
# - lib/log.mjs: the shared line emitter (CALANDRIA_LOG_FORMAT), imported by
#   both entrypoints for their own output and by lib/config.ts for the bundled
#   half.
# - lib/pty-frame-writer.mjs: bounded frame serialization and PTY backpressure,
#   imported by pty-server.js before it accepts terminal connections.
# - lib/schema-version.mjs (-> lib/storage.mjs): the schema stamp and boot
#   gate. server.js runs it right after claiming the lock so a rolled-back
#   image tag refuses to start instead of writing to a database a newer build
#   already migrated.
COPY --from=build --chown=root:root /app/lib/cf-access.mjs /app/lib/service-router.mjs /app/lib/service-host.mjs /app/lib/env-keys.mjs /app/lib/db-lock.mjs /app/lib/resolveHostname.js /app/lib/env.mjs /app/lib/storage.mjs /app/lib/homeDir.mjs /app/lib/log.mjs /app/lib/pty-frame-writer.mjs /app/lib/schema-version.mjs ./lib/
COPY --from=build --chown=root:root /app/lib/auth ./lib/auth
# The advanced-settings bootstrap (lib/advanced-env/bootstrap.mjs) and the two
# plain-Node modules it loads. Both entrypoints await it before any other
# import, so a missing file here leaves the server unable to apply saved app
# settings at all: catalog.mjs supplies the reserved-name rule the boot path
# re-checks, and disk.mjs is the reader for the settings file beside the
# database. The .ts half of that directory is bundled by the Next build.
COPY --from=build --chown=root:root /app/lib/advanced-env/bootstrap.mjs /app/lib/advanced-env/catalog.mjs /app/lib/advanced-env/disk.mjs ./lib/advanced-env/
# The stdio MCP bridge the non-Claude drivers spawn per turn
# (node scripts/calandria-mcp.mjs) and its shared tool defs: plain-Node .mjs
# the build output doesn't bundle, so they need explicit COPYs, the same
# gotcha as the auth/router .mjs above.
COPY --from=build --chown=root:root /app/scripts/calandria-mcp.mjs ./scripts/calandria-mcp.mjs
COPY --from=build --chown=root:root /app/lib/agentToolDefs.mjs ./lib/agentToolDefs.mjs
COPY --from=build --chown=root:root /app/lib/agentToolGuard.mjs ./lib/agentToolGuard.mjs
# The container boots through docker/entrypoint.sh, not `npm start`, but
# package.json is in this image, so a script it names has to exist or
# `npm start` in a docker exec fails on a missing file.
COPY --from=build --chown=root:root /app/scripts/start.mjs ./scripts/start.mjs
# The hot-backup script (`docker exec ... npm run backup`). It needs
# better-sqlite3 from node_modules and lib/env.mjs plus lib/storage.mjs,
# already copied above.
COPY --from=build --chown=root:root /app/scripts/backup.mjs ./scripts/backup.mjs
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/calandria-entrypoint

# CALANDRIA_HOSTNAME, not HOSTNAME: server.js doesn't read the generic
# variable, since Docker injects the container id into it and Fedora's
# /etc/profile exports the machine name (see lib/resolveHostname.js). 0.0.0.0
# is correct inside the container, where the default loopback bind would make
# the published port unreachable; isolation comes from publishing on the
# host's loopback only (-p 127.0.0.1:<port>:3000) with Cloudflare Tunnel in
# front.
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

# Build provenance. The deploy script passes --build-arg GIT_SHA/BUILT_AT,
# captured from the deploy host's git tree before rsync, since the image has
# no .git. Exposed read-only at GET /api/version so a deploy can be confirmed
# without ssh. Kept late so the per-build SHA churn doesn't bust any earlier
# layer's cache.
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
# CALANDRIA_CONTAINER tells the update check this is an image install, so the
# update popover offers the compose upgrade steps.
ENV CALANDRIA_GIT_SHA=$GIT_SHA \
    CALANDRIA_BUILT_AT=$BUILT_AT \
    CALANDRIA_CONTAINER=1

# /api/version doubles as the health probe: it exercises Next and
# SQLite-backed routing. It presents SERVICE_TOKEN, the one path middleware.ts
# exempts from the Cloudflare Access check, since no Access JWT exists inside
# the container.
#
# The token is read from the environment or from the file the entrypoint
# writes when Access is on and the operator supplied none (see
# docker/entrypoint.sh; keep the path in step with CALANDRIA_SERVICE_TOKEN_FILE
# there). A healthcheck runs as a fresh exec with the image's environment, not
# the entrypoint's, so the file is the only way a generated token reaches it.
# Without it, Access mode plus an unset SERVICE_TOKEN would 403 every probe and
# leave the container permanently unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "let t=(process.env.SERVICE_TOKEN||'').trim();if(!t){try{t=require('node:fs').readFileSync('/tmp/calandria-service-token','utf8').trim()}catch{}}fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/version',{headers:t?{'x-service-token':t}:{}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "/usr/local/bin/calandria-entrypoint"]
