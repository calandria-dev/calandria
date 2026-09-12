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
# Pinned by digest rather than the `22-bookworm-slim` tag, which moves on every
# Node patch and Debian security rebuild, so a tag reference would not give two
# builds of the same commit the same image. The digest is the multi-arch index
# digest (linux/amd64 + linux/arm64/v8), so both matrix legs resolve their own
# manifest from it. .github/dependabot.yml bumps it weekly; keep the two FROM
# lines identical or the runtime stage diverges from the build stage.
FROM node:26-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS build
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
FROM node:26-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae

# git: project repos and per-task worktrees. openssh-client: git over ssh.
# tini: PID 1, reaps the pty shells' orphans. procps: ps for debugging shells.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git openssh-client ca-certificates curl bash tini procps \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI: powers the in-app "Connect GitHub" device-flow login and the
# repo picker/clone in project creation. Its token (~/.config/gh/hosts.yml)
# and the git credential helper it configures (~/.gitconfig) live on the home
# volume, so a login survives container stop/start.
#
# Pinned to an exact apt version. Docker's layer cache keys on the RUN
# command's text, not its result, so an unpinned `apt-get install gh` would
# let a cached layer keep an old gh version even after apt has a newer,
# CVE-fixed package. Bump this version string to update gh: check
# `apt-cache madison gh` (or the cli.github.com Packages index) for the
# current version, then rebuild uncached to confirm the new layer pulls it.
# cli.github.com carries only its newest release, so a gh release leaves this
# pin missing from the index rather than merely old. `Pin drift`
# (.github/workflows/pin-drift.yml) reads the repo's Packages index daily and
# files an issue when this line falls behind; publish-image.yml's Sunday cron
# builds uncached so a rotted pin cannot hide behind a cached layer. Keep the
# `gh=` spelling on one line: the pin-drift check's regex reads it from here.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh=2.100.0 \
  && rm -rf /var/lib/apt/lists/* \
  && gh --version

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
# revisit policy.
RUN npm install -g npm@12.0.2 && npm --version

# The agent CLIs, pinned. A floating `@latest` install would make a
# supply-chain decision per build and leave no two images alike; bump these
# deliberately instead. All three are ARGs so a one-off build can test a
# candidate without editing this file:
#   docker build --build-arg CODEX_VERSION=0.147.0 .
#
# A stale pin here still builds and fails later instead: 0.146.0 could not run
# GPT-6 Astra at all ("model requires a newer version of codex"), because a new
# model can require a CLI bump and not just a catalog entry. `Pin drift`
# (.github/workflows/pin-drift.yml) watches both npm pins and files an issue at
# three weeks old or three newer minors, carrying the bump checklist,
# including the one step no job can take: exercising the agent against a real
# login.
ARG CLAUDE_CODE_VERSION=2.1.260
ARG CODEX_VERSION=0.153.0
ARG AGY_VERSION=1.2.2

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
# checks a SHA-512 and drops the single binary in place. Those steps are done
# here against a pinned version instead of piping the script, so the build is
# reproducible and the checksum is reviewed in this file rather than fetched.
#
# These three ARGs are owned by `Pin drift` (.github/workflows/pin-drift.yml).
# It reads both manifests daily and, when they have moved, force-pushes the
# rewritten ARGs to the `bot/agy-pin` branch and opens or refreshes one pull
# request titled `build(deps): bump Antigravity CLI to <version>`. That PR is
# reviewed and merged by a human and is never automerged. Editing the three by
# hand still works and costs nothing: the next run sees the pins are current,
# closes the bot PR and deletes its branch.
#
# The values come from
#   curl -fsSL https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json
# (and .../linux_arm64.json). The `version` field is what AGY_VERSION must
# match, the `sha512` field is the digest for that arch, and all three move
# together: the guard below compares the manifest URL against AGY_VERSION, so
# a version written without its digests fails `sha512sum -c` on both arches.
# The bot refuses to write anything when the two manifests disagree on the
# version, and files the usual issue for the other pins in this file.
#
# The binary self-updates in the background by default, which would replace
# this pin mid-turn. AGY_CLI_DISABLE_AUTO_UPDATE below turns that off
# image-wide, and the driver sets it on every spawn as a second guard.
ARG AGY_SHA512_AMD64=74342cf2a78b344392e573b638a648a6ad1f8e877f494b96e20f9c2b79158d5c423c40b2dcf788703362bb0a9150f09c707fde599d7557ce01c12208802a63cb
ARG AGY_SHA512_ARM64=a1645a30f36b767c7534c2f6a53e99a9bfade993267efcca715f7a45d797d47d6561df787e9d4a51a3bdfc9be855d49d23fa3f4b91b2c661fd17314050836048
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) manifest=linux_amd64; sha="${AGY_SHA512_AMD64}" ;; \
      arm64) manifest=linux_arm64; sha="${AGY_SHA512_ARM64}" ;; \
      *) echo "unsupported architecture for the agy CLI: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    # Fetched and checked on its OWN, because a network failure here must not be
    # reported as a stale pin. Written as `url="$(curl … | sed …)"` the status is
    # the PIPELINE's, which is sed's, and sed exits 0 on empty input — so `set -e`
    # never saw a dead curl, the empty url fell through to the version guard
    # below, and the build failed with "manifest no longer serves AGY_VERSION"
    # and `(got )`, sending the next reader to bump a pin that was fine. Observed
    # 2026-09-05: curl (35), connection reset, on the amd64 builder while arm64
    # built the same commit against the same manifest. Retried for the same
    # reason — it is the one network read in an otherwise hermetic step.
    manifest_json="$(curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 --max-time 60 \
                       "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${manifest}.json")" \
      || { echo "could not fetch the agy ${manifest} manifest: NETWORK failure, not a stale AGY_VERSION" >&2; exit 1; }; \
    # The download URL carries an opaque build id after the version, so it is
    # read from the manifest rather than templated from AGY_VERSION alone.
    url="$(printf '%s' "$manifest_json" \
            | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"; \
    # The manifest always serves the latest build, so a stale pin fails the
    # build here instead of installing a version whose checksum was never reviewed.
    case "$url" in *"/${AGY_VERSION}-"*) : ;; \
      *) echo "manifest no longer serves AGY_VERSION=${AGY_VERSION} (got ${url}); bump the ARG and both SHA-512s" >&2; exit 1 ;; \
    esac; \
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
# - lib/log.mjs: the shared line emitter (CALANDRIA_LOG_FORMAT), imported by
#   both entrypoints for their own output and by lib/config.ts for the bundled
#   half.
# - lib/schema-version.mjs (-> lib/storage.mjs): the schema stamp and boot
#   gate. server.js runs it right after claiming the lock so a rolled-back
#   image tag refuses to start instead of writing to a database a newer build
#   already migrated.
COPY --from=build --chown=root:root /app/lib/cf-access.mjs /app/lib/service-router.mjs /app/lib/service-host.mjs /app/lib/env-keys.mjs /app/lib/db-lock.mjs /app/lib/resolveHostname.js /app/lib/env.mjs /app/lib/storage.mjs /app/lib/log.mjs /app/lib/schema-version.mjs ./lib/
COPY --from=build --chown=root:root /app/lib/auth ./lib/auth
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
