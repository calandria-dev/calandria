# syntax=docker/dockerfile:1
# Example end-user overlay on top of the published Calandria image: adds a
# couple of site-specific CLIs and a baked-in config file. This is a starting
# point, not something to deploy as-is — see README.md in this directory.
#
# THE ONE CONSTRAINT THAT SHAPES THIS FILE
# The base image declares `VOLUME ["/home/orch"]` and runs as the non-root
# `orch` user (uid 1000). Docker discards anything a later build step writes
# under a declared volume path, and a freshly created volume is seeded from
# whatever's at that path in the image at build time — so installs belong
# under a rootfs path (/usr/local, /opt), never $HOME, and any root-owned
# leftovers left under /home/orch become permanently unwritable for uid 1000
# once a real volume mounts. Install as root, reassert ownership, then drop
# back to the base image's user as the last step.

# :latest is the newest tagged release (issue #12) — correct for an example
# meant to stay current with no upkeep. A real overlay that cares about
# reproducible builds should pin a specific version instead (`:0.2.0` — note
# the registry tag carries no leading `v`, unlike the git tag) and re-pin
# deliberately on upgrade; see docs/SELF_HOSTING.md, "Pinning a version".
FROM ghcr.io/calandria-dev/calandria:latest

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Example CLIs a real overlay might add for its own projects. Both ship in
# Debian's repos, so no arch-specific download logic is needed here — a real
# overlay pulling pinned single-binary releases (kubectl, a cloud CLI, etc.)
# would instead pin an ARG version per tool and curl+install each into
# /usr/local/bin, one RUN per tool so a failure names the culprit.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ripgrep \
       httpie \
  && rm -rf /var/lib/apt/lists/*

# Example baked-in site config: generic git defaults every project in this
# overlay should start with. Real overlays put real config here (registry
# mirrors, internal CA certs, tool config) — never secrets; inject those as
# env vars at `docker compose up` time instead.
COPY gitconfig.example /etc/gitconfig

# Everything above ran as root. /home/orch is the volume skeleton: reassert
# ownership before dropping back, or a fresh volume inherits unwritable
# root-owned files.
RUN chown -R orch:orch /home/orch

USER orch
