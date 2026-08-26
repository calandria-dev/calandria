# Example overlay image

Shows the shape of a private end-user overlay: `FROM ghcr.io/calandria-dev/calandria:latest`,
adding site-specific CLIs and config on top of the published base. This directory is
deliberately generic — swap the example packages, the example config file, and the
compose env values for your own before using it for real.

## Why an overlay, not a post-deploy script

The base image runs read-only with no sudo (see [`docs/SELF_HOSTING.md`](../../docs/SELF_HOSTING.md)),
so nothing can be installed into a running container. Building a Dockerfile `FROM` the
published image instead does the installs at build time, as root, so they land in the
rootfs and survive a home-volume reset.

## The one constraint

The base image declares `VOLUME ["/home/calandria"]`. Docker discards anything a later build
step writes under a declared volume path, and a freshly created volume is seeded from
whatever's there at build time — so an installer that defaults to `$HOME` needs
redirecting to a rootfs path (`/usr/local`, `/opt`), and any root-owned leftovers under
`/home/calandria` at the end of the build become permanently unwritable for uid 1000. That's
why `Dockerfile` here ends with `chown -R calandria:calandria /home/calandria` before dropping back to
`USER calandria`.

## Build and run

```bash
cd examples/overlay
docker compose -p calandria-example up -d --build
# open http://127.0.0.1:10001
```

## Env vars that matter

Full reference: [`docs/SELF_HOSTING.md`](../../docs/SELF_HOSTING.md#configuration). The
ones `compose.yaml` sets here:

| Variable | What it does |
|-|-|
| `PUBLIC_BASE_URL` | The origin users reach the app on |
| `GIT_USER_NAME` / `GIT_USER_EMAIL` | Git identity for task worktree commits |
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` | Cloudflare Access enforcement, if you front the instance with it |

## Keep the real one private

An overlay built for actual use typically encodes internal hostnames, credential paths,
and a toolchain selection specific enough to fingerprint your infrastructure. Fork this
example into a private repo and build from there — don't publish it.
