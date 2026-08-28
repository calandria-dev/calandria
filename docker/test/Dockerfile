# syntax=docker/dockerfile:1
# The container test harness. CLAUDE.md's rule is "run tests in a separate
# docker container"; this is the container. Drive it through
# scripts/docker-test.sh (`npm run test:docker`, `npm run test:e2e:docker`) —
# see e2e/README.md for the full recipe and its one caveat about git.
#
# Nothing of the repo is baked in: the checkout is bind-mounted at /work and
# node_modules is a named volume, so the image is just "a Linux Node 22 with
# the right browsers" and the install is a one-time cost shared across runs.
#
# Two targets:
#   base — Node 22 (matches .nvmrc) + git. Unit tests and typecheck.
#   e2e  — base + the chromium build matching @playwright/test in the lockfile.
#
# WHY NOT mcr.microsoft.com/playwright:v<x>-noble, the obvious choice:
# that image ships Node 24 and no compiler. better-sqlite3 published no Node 24
# prebuild, so `npm ci` fell through to node-gyp and died on
# "gyp ERR! not found: make"; add the toolchain and the app still failed to boot
# with ERR_DLOPEN_FAILED / "Module did not self-register", which reads like a
# product bug and fails every e2e spec including 01-onboarding. Putting the
# browsers on a Node 22 base instead keeps us on the prebuild path for both
# native modules (better-sqlite3, node-pty) and needs no compiler at all.
#
# Half of that reason has since expired and the conclusion has not: better-sqlite3
# 13 is N-API and bundles its Linux binaries, so it no longer cares which Node
# this image ships. node-pty still fetches a per-ABI prebuild and compiles when
# that misses, and Node 22 is what .nvmrc pins and every other lane runs — so a
# base matching it is still the right one, now for the boring reason rather than
# the ABI one. Re-test before assuming the Playwright image would work today.
#
# The base tag is deliberately NOT digest-pinned the way the shipping Dockerfile
# is. This image is dev tooling that never leaves the machine, reproducibility
# of what's tested comes from package-lock.json, and an unowned digest pin here
# would just rot (.github/dependabot.yml's docker ecosystem only scans "/").
# If you ever pin it, add /docker/test to that file in the same commit.
ARG NODE_IMAGE=node:22

FROM ${NODE_IMAGE} AS base

# The volume is mounted over this path, and Docker seeds a fresh named volume
# from the image directory it covers — including its mode. 0777 so the install
# works whether the container runs as root (default) or as CALANDRIA_TEST_USER.
RUN mkdir -p /work/node_modules && chmod 0777 /work/node_modules
WORKDIR /work

# CI=1: vitest stays non-interactive, playwright honors forbidOnly.
ENV CI=1 \
    NEXT_TELEMETRY_DISABLED=1

# Syncs node_modules with the mounted lockfile, then execs the real command.
COPY --chmod=755 entrypoint.sh /usr/local/bin/docker-test-entrypoint
ENTRYPOINT ["/usr/local/bin/docker-test-entrypoint"]
CMD ["npm", "test"]

FROM base AS e2e

# Passed by scripts/docker-test.sh, read out of package-lock.json — the browser
# build and the installed @playwright/test must be the same version or every
# run re-downloads chromium into the container it then throws away.
ARG PLAYWRIGHT_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium
