---
title: "Self-hosting"
---

# Self-hosting

Running your own instance: Docker, tunnels, auth, and configuration. The
[README](../README.md) covers the two-command quick start; this is the rest.
Already broken? See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for
first-incident runbooks (DB corruption, disk fill, headless re-auth, boot
failures).

## Docker

The [`Dockerfile`](../Dockerfile) builds a single-user image: a production Next.js
build (a stopped container starts in seconds) with Node 22, git, and the `claude`
CLI. [`docker/entrypoint.sh`](../docker/entrypoint.sh) runs both processes (app
server and pty sidecar) under tini. All state lives under `/home/calandria`: one
named volume holds the SQLite database, worktrees, project repos, and the claude
login.

You don't have to build it yourself. The published image builds nightly
from `main`, from `v*` release tags, and on manual dispatch (ordinary pushes
to `main` no longer trigger a build; `test.yml` still runs on every push).

### The published image

```bash
docker pull ghcr.io/calandria-dev/calandria:latest
```

The package is public: no `docker login`, no token needed.
[`.github/workflows/publish-image.yml`](../.github/workflows/publish-image.yml)
publishes it, gated on the test suite (types, unit, e2e), so a red run never
reaches the registry.

**Architectures:** one manifest covers `linux/amd64` and `linux/arm64`, so
`docker pull` picks the right one for you.

| Tag | Points at |
|-|-|
| `latest` | The newest tagged release |
| `edge` | The newest nightly build of `main` |
| `sha-<short>` | One immutable tag per commit (`sha-337ea62`, the 7-char SHA) |
| `<version>` | A pushed `v*` git tag with the `v` stripped (`v1.4.2` → `1.4.2`) |
| `<major>.<minor>` | The newest patch on that line (e.g. `1.4`) |

`latest` moves only on a `v*` tag push and only moves forward, so `latest`
never points at untagged, unreleased code; nightly builds of `main` publish
under `edge` instead. Pin `sha-<short>` (or a specific `X.Y.Z`) for a tag that
never changes under you. See [Pinning a version](#pinning-a-version) below.

Every release publishes all three tags: `latest`, `<version>`, and
`<major>.<minor>`, e.g. `0.3.0` and `0.3` for a `v0.3.0` tag (no `v`). The
[releases page](https://github.com/calandria-dev/calandria/releases) lists
what `latest` has pointed at over time.

### Verify the image's provenance

The `attest` job signs the merged multi-arch index with SLSA build provenance
(Sigstore, keyless): a signed claim that this digest was built by this
workflow, from this commit. Check it before you run the image:

```bash
gh attestation verify oci://ghcr.io/calandria-dev/calandria:latest --owner calandria-dev
```

Success is the exit status; `gh` prints nothing when its output isn't a
terminal. Add `--format json` for the parsed statement and signing certificate.

| Flag | Why |
|-|-|
| `--repo calandria-dev/calandria` | Scopes the claim to this repo instead of anything the account publishes |
| `--signer-workflow calandria-dev/calandria/.github/workflows/publish-image.yml` | Pins which workflow was allowed to sign |
| `--bundle-from-oci` | Reads the signature from the registry instead of the GitHub API |

The subject is the multi-arch index digest, since that's what you pull.
Only digests published by a run that included the `attest` job carry a
signature; anything older reports `no attestations found`.

### Pinning a version

The image tag carries no leading `v`, even though the git tag does: `v0.2.0` in
git is `:0.2.0` in the registry (`docker/metadata-action`'s `{{version}}` strips
it). `:vX.Y.Z` does not exist and fails to pull.

Pick one of:

| You want | Set `CALANDRIA_IMAGE` to |
|-|-|
| A specific release, never changes | `ghcr.io/calandria-dev/calandria:X.Y.Z` |
| The newest patch on a minor line | `ghcr.io/calandria-dev/calandria:X.Y` |
| Whatever the newest release is | `ghcr.io/calandria-dev/calandria:latest` |
| Nightly builds of `main`, least stable | `ghcr.io/calandria-dev/calandria:edge` |

`X.Y.Z` is the only one of these that never changes under you; `X.Y` and
`latest` are both moving targets. Pin `X.Y.Z` for anything you don't want to
babysit. Use `latest` only if you're fine re-reading the changelog after
every unattended upgrade.

Every past release tag stays pullable indefinitely, so moving between
versions just means re-pinning `CALANDRIA_IMAGE`. Going backwards takes one
more step than going forwards, because the newer build already migrated your
database; see [Rolling back an upgrade](#rolling-back-an-upgrade).

### Running it

[`docker-compose.yml`](../docker-compose.yml) is the parameterized runner. It
builds from this checkout by default; set `CALANDRIA_IMAGE` to run the published
image instead.

```bash
export CALANDRIA_USER=alice CALANDRIA_PORT=10001 CALANDRIA_RUNTIME=runc

# A) build from this checkout (the default)
docker build -t calandria .
docker compose -p calandria-alice up -d

# B) or run the published image, nothing to build. :latest is the newest
# release; pin :0.3.0 (no leading v) to hold one; :edge is nightly main.
# See "Pinning a version" above.
export CALANDRIA_IMAGE=ghcr.io/calandria-dev/calandria:latest
docker compose -p calandria-alice pull
docker compose -p calandria-alice up -d --no-build

# open http://127.0.0.1:10001
```

The explicit `pull` plus `--no-build` works around a Compose quirk: Compose
versions differ on whether a missing image with a build context gets pulled
or built, and the service keeps its `build: .` stanza so a bare checkout still
works with no env set.

The container publishes its port on the host's loopback only. To reach it from
elsewhere, put an authenticated tunnel or reverse proxy in front. The app
hands out a full shell and a `bypassPermissions` agent, so never expose the
port raw.

An HTTPS front also gets you PWA install and the Notification permission,
which browsers only offer in a secure context (HTTPS or `localhost`). A
plain-HTTP LAN IP gets neither, so if your phone is one of your surfaces,
reach the instance through the tunnel hostname, not `http://192.168.x.x`.

The `claude` CLI works headless: it prints the OAuth URL and accepts a pasted
code, and the setup wizard drives that flow from the browser.

For site-specific CLIs or config layered on the published image, see
[`examples/overlay/`](../examples/overlay/); keep real overlays in a private
repo, not committed here.

### Upgrading

**Take a backup first.** It's one command, needs no downtime, and is the only
thing that makes the upgrade reversible. The new build migrates your database
on first boot, and there's no down-migration.

```bash
# 1. Snapshot the database while the old version is still the one running.
docker exec -u calandria calandria-alice npm run backup -- --out /home/calandria/backups
#    (running locally instead: npm run backup -- --out /mnt/backups)

# 2. Note the version you are on (it's what you'd roll back to).
curl -s localhost:10001/api/version

# 3. Upgrade.
export CALANDRIA_IMAGE=ghcr.io/calandria-dev/calandria:0.3.0   # or :latest
docker compose -p calandria-alice pull
docker compose -p calandria-alice up -d --no-build
```

The container comes up, runs its schema migrations, and starts serving.
Migrations are additive and idempotent: new columns get defaults, nothing is
dropped, so a database from any older version upgrades in place, and
re-running the same version changes nothing. They're not reversible, which is
why step 1 matters.

After migrating, the build stamps the database with the schema version it
understands (`PRAGMA user_version`,
[`lib/schema-version.mjs`](../lib/schema-version.mjs)). This makes an older
build pointed at that database refuse to start instead of writing to a schema
it has never seen. The next section covers that refusal.

### Rolling back an upgrade

A rollback is two moves: re-pin the image and restore the database the old
version knew. Doing only the first is the common mistake.

If you re-pin the image alone, the old build finds a database stamped by the
newer one and refuses to boot. The error message includes both version numbers
and both ways out:

```
Refusing to start: /home/calandria/.calandria/calandria.db was written by a NEWER version of Calandria.

  database schema version: 2
  this build understands:  1
  ...
```

This is a clean failure, not a corrupted instance. The container exits and,
with `restart: unless-stopped`, keeps retrying, so check `docker compose logs`
to see it. Pick one of two exits:

**A. Forward: go back to the version you just came from.** Nothing to restore;
the database is already the shape that build expects. Use this when the
upgrade just surprised you and no data is at stake.

```bash
export CALANDRIA_IMAGE=ghcr.io/calandria-dev/calandria:0.3.0   # the NEWER tag
docker compose -p calandria-alice pull
docker compose -p calandria-alice up -d --no-build
```

**B. Backward: pin the old tag and restore the pre-upgrade backup.** This is a
real rollback: you give up everything that happened after the backup was
taken.

```bash
# 1. Stop the app. Never swap the database file under a running instance.
docker compose -p calandria-alice stop

# 2. Pin the version you are going back to (no leading v).
export CALANDRIA_IMAGE=ghcr.io/calandria-dev/calandria:0.2.0

# 3. Restore the database from the backup you took before the upgrade.
#    Full procedure, including the sidecars and the manifest: "Restore" below.
mkdir -p /tmp/rollback
tar -xzf calandria-backup-20260827T221316Z.tar.gz -C /tmp/rollback
cd /tmp/rollback/calandria-backup-20260827T221316Z
DBDIR=~/.calandria
rm -f "$DBDIR"/calandria.db-wal "$DBDIR"/calandria.db-shm
cp db/calandria.db "$DBDIR"/calandria.db

# 4. Bring the old version up.
docker compose -p calandria-alice pull
docker compose -p calandria-alice up -d --no-build
curl -s localhost:10001/api/version
```

Read [Restore](#restore) before running step 3. It covers the `db-dir/` half
(uploads, VAPID key, a persisted API key), agent logins, and three things a
restored instance does that look like faults but aren't. The backup's
`manifest.json` records the snapshot's `userVersion` and the app version that
wrote it, so you can check the tag you just pinned will accept it.

A rollback costs three things, none avoidable by a different procedure:

- **Everything since the backup is gone**, including turns that ran on the
  new version. Task branches survive in your project repos, so committed
  work outlives the rollback; the task rows describing it don't.
- **Worktrees are not rolled back** (they aren't in the default backup). A
  task whose row came back but whose checkout moved on gets a fresh one cut
  from its branch on the next turn.
- **No backup, and you want the old version anyway?** There's no supported
  way to down-migrate. Stay on the newer version (A above), or start from a
  fresh database, backing up the current one first either way.

## Origin-side auth (Cloudflare Access)

If you front an instance with Cloudflare Access, set `CF_ACCESS_TEAM_DOMAIN`
and `CF_ACCESS_AUD`. The origin then re-verifies the Access JWT
(`Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie, checked
against the team's public signing keys and the app's `aud` tag) on every HTTP
route and every WebSocket upgrade (`server.js`, in front of the `/pty`
terminal proxy). No valid assertion gets a 403.
[`lib/cf-access.mjs`](../lib/cf-access.mjs) is the shared verifier; the
titlebar shows the authenticated email.

Requests get a second check on top of the JWT: if the browser sends an
`Origin` header, it must match the `Host` the request was aimed at. The JWT
proves who is calling, not that they meant to call: the `CF_Authorization`
cookie is `SameSite=None` by default, so a hostile page can make a logged-in
user's browser issue a request that the edge will happily attach a valid
assertion to (opening `wss://your-host/pty` for a shell, or POSTing to a
mutating API route via a CORS-exempt form or `text/plain` body). WebSocket
upgrades require an `Origin`; HTTP requests only require that one match if
it's sent, so an ordinary cross-site link to your instance from an email or
wiki still opens normally.

`PUBLIC_BASE_URL` isn't required for this check; it compares the request's own
two headers. Set it only if your proxy rewrites `Host` (Cloudflare Tunnel's
`httpHostHeader`), which would otherwise make the two disagree. The pty
sidecar repeats the same checks independently, so reaching `PTY_PORT` directly
grants nothing either.

Unset (the local default), the app has no login, but it still enforces a
browser-origin boundary (accepting loopback hosts, rejecting cross-site
requests, and requiring `/pty` WebSocket upgrades to carry a matching browser
`Origin`), which stops an unrelated website from driving the local shell and
blocks DNS-rebinding hostnames. `PUBLIC_BASE_URL` is accepted automatically;
list any other LAN origin explicitly in `CALANDRIA_ALLOWED_ORIGINS`. It's
still single-user mode, not authentication; never expose it raw to the
internet.

The one Access-mode exception is `SERVICE_TOKEN`: a shared secret letting
health probes read the documented service-token routes without an Access JWT
(`x-service-token` header).

Nothing requires you to set a value, but in Access mode something has to
present one, since three in-container callers have no Access JWT: the image's
`HEALTHCHECK`, the boot restore of managed services, and the stdio MCP bridge
non-Claude agents' tool calls go through. If `CF_ACCESS_*` is set and you
leave `SERVICE_TOKEN` empty,
[`docker/entrypoint.sh`](../docker/entrypoint.sh) mints a per-boot token into
`/tmp/calandria-service-token`, which the `HEALTHCHECK` reads (a healthcheck
runs as a separate exec with the image's environment, so the file is the only
way a generated token reaches it). Supply your own token when a monitor
outside the container needs to poll. Running bare Node behind Access with no
token, `server.js` warns loudly at startup instead.

`CALANDRIA_FLEET_TOKEN` is a second, optional secret for the same read-only
routes, shared fleet-wide so one dashboard can poll many boxes without
learning each one's private `SERVICE_TOKEN`. It is not accepted on the
mutating internal agent-tool endpoints. Unset (the default), it grants
nothing.

## Configuration

Every per-instance value is an env var with a documented default. One env set
relocates an instance (fresh container, different user, different ports) with
zero code edits. [`.env.example`](../.env.example) has the same list in
copyable form. Export variables in the environment that launches `npm run dev`
/ `npm start`: `server.js` and `pty-server.js` are plain Node and read them
before Next boots, so a `.env` file alone doesn't cover `PORT`,
`CALANDRIA_HOSTNAME`, or `PTY_*`.

Variables below were renamed from an earlier `ORCH_*` naming. Every old name
still works as a fallback (a `CALANDRIA_*` value wins if both are set), and
the server prints one boot-time warning naming whichever old names are still
in use. Move a self-hosted `.env`, systemd unit, or compose file over on your
own schedule.

### Upgrading from `ORCH_*` names

Three groups, and only one can break you.

**App variables: nothing to do.** Everything in the table below reads
`CALANDRIA_X` first and falls back to `ORCH_X`, so an existing `.env`,
systemd unit, or `docker run -e` keeps working untouched. An empty value
counts as unset on both sides, so a blank `CALANDRIA_X` never shadows a real
`ORCH_X`.

**Compose variables: a hard rename.** `ORCH_USER`, `ORCH_PORT`, `ORCH_CPUS`,
`ORCH_MEM`, `ORCH_IMAGE`, and `ORCH_RUNTIME` are interpolated by
`docker compose` itself, which has no aliasing mechanism, so there's nowhere
to put a fallback. Rename them in your shell or `.env`:

```bash
sed -i 's/^ORCH_\(USER\|PORT\|CPUS\|MEM\|IMAGE\|RUNTIME\)=/CALANDRIA_\1=/' .env
```

The two required variables fail loudly if you miss them
(`set CALANDRIA_USER (e.g. alice)`) instead of starting a second, empty
instance. The `-p` project name is your own label, not something the app
reads; an existing stack can stay on `-p orch-alice`. These docs use
`-p calandria-alice` for new ones.

**Docker resource names: unchanged.** The home volume is still
`orch-u-<user>-home` and the network still `orch-u-<user>-net`, since
renaming them would strand every existing instance's database, cloned repos,
and agent logins behind a name nothing mounts anymore. Only the mount path
moved, from `/home/orch` to `/home/calandria`, and a named volume follows its
mount. Absolute `/home/orch/...` strings are baked into rows the app can't
re-derive (`projects.repo_path`, `tasks.worktree_path`) and into each repo's
git worktree metadata, so the image keeps `/home/orch` as a symlink to the
new home; old paths keep resolving and new ones write under
`/home/calandria`.

To rename the volume to match the product anyway, do it while the container
is down. Docker has no rename, so this is a copy:

```bash
docker compose -p calandria-alice down
docker volume create calandria-u-alice-home
docker run --rm -v orch-u-alice-home:/from -v calandria-u-alice-home:/to alpine \
  sh -c 'cd /from && cp -a . /to'
# then point the compose `volumes:` stanza at the new name and bring it back up
```

Verify the copy (the database and `projects/` are there) before
`docker volume rm` on the old one. There is no undo.

| Variable | Default | What it does |
|-|-|-|
| `PORT` | `3000` | Port of the single public origin (Next.js + `/pty` proxy) |
| `CALANDRIA_HOSTNAME` | `127.0.0.1` | Bind address of the app server. Loopback by default, since a local instance is unauthenticated and the origin gate is a header check a LAN client can forge; widen it only behind `CF_ACCESS_*`. Bare `HOSTNAME` is not read (shells and container runtimes inject it). The image sets `CALANDRIA_HOSTNAME=0.0.0.0`, correct for a container published on the host's loopback |
| `CALANDRIA_LOG_FORMAT` | `text` | `text` is the human-readable `[component] message key=value` form; `json` emits one object per line (`ts`, `level`, `component`, `msg`, plus that line's fields) for a collector. `server.js`, `pty-server.js`, and the app each read it independently, so set it for all three. See [Reading the logs](TROUBLESHOOTING.md#reading-the-logs) |
| `PTY_PORT` | `3001` | Port of the node-pty terminal sidecar |
| `PTY_HOST` | `127.0.0.1` | Bind address of the sidecar and the proxy's upstream. Keep it on loopback; the browser never connects directly, since `server.js` proxies `/pty` to it |
| `CALANDRIA_PTY_SHELL` | *(empty)* | The shell every terminal tab spawns. Empty falls back to `$SHELL`, then a platform default (POSIX: first of `/bin/zsh`, `/bin/bash`, `/bin/sh` that exists; Windows: `pwsh.exe`/`powershell.exe` on PATH, else `%COMSPEC%`). Set this if the terminal drawer can't spawn a shell, or to get a different one than your login shell |
| `PUBLIC_BASE_URL` | *(empty)* | The origin you reach the app on (e.g. `https://calandria.example.com` behind a tunnel); the client builds its `ws(s)://` terminal URL from it. Empty means the browser's own origin, which works for any single-hostname deployment. Set it if your proxy rewrites `Host`, which would otherwise make the origin gate's `Origin` vs `Host` check disagree |
| `CALANDRIA_ALLOWED_ORIGINS` | *(empty)* | Exact comma-separated `http(s)` origins allowed in no-login local mode, for intentional LAN or reverse-proxy access. Loopback origins and `PUBLIC_BASE_URL` are already accepted. Not a substitute for authentication |
| `VAPID_SUBJECT` | *(derived)* | Contact for the browsers' push services (Web Push VAPID subject): a `mailto:` or `https:` URL. Defaults to `PUBLIC_BASE_URL` when that's https, else `mailto:admin@localhost`. iOS rejects `localhost` with `403 BadJwtToken`, so set a real https origin or `mailto:` for iOS push |
| `VAPID_PRIVATE_KEY` | *(minted)* | Base64url raw P-256 scalar signing every push. Empty = minted on first use and kept at `<CALANDRIA_DB_DIR>/vapid.json`; subscriptions are bound to it, so back it up with the database |
| `CALANDRIA_PTY_ALLOW_REMOTE` | *(off)* | Set `1` to let the pty sidecar accept off-machine peers. Otherwise it requires a loopback peer, since `server.js` proxies to it from the same host. Only for a split deployment; anything that reaches the sidecar gets a shell |
| `CF_ACCESS_TEAM_DOMAIN` | *(empty)* | Cloudflare Zero Trust team domain (e.g. `your-team.cloudflareaccess.com`); see above |
| `CF_ACCESS_AUD` | *(empty)* | The Access application's `aud` tag the JWT must carry (comma-separable) |
| `SERVICE_TOKEN` | *(empty)* | Shared secret for the health/version/usage/metrics routes and the in-container callers (health probe, service restore, agent-tool bridge); see above. The image mints a per-boot one under Access if empty |
| `CALANDRIA_FLEET_TOKEN` | *(empty)* | Optional fleet-wide read token for the same read-only routes (`/api/version`, `/api/instance/usage`, `/api/instance/metrics`, `GET /api/instance/scheduler`), so one dashboard can scrape many instances with one secret. Never accepted on mutating endpoints |
| `CALANDRIA_DB_DIR` | `~/.calandria` | Directory holding `calandria.db` (SQLite app data). Absolute path; created on first run |
| `CALANDRIA_DB_LOCK` | `on` | The single-instance boot lock. `off` lets a second process start against a database another one already owns (unsupported: it's the exact corruption the lock exists to prevent). See **One process per database** below |
| `CALANDRIA_DB_LOCK_WAIT_MS` | `10000` | How long boot retries the lock before giving up. Covers a predecessor that is still shutting down; a crashed one releases instantly |
| `CALANDRIA_WORKTREES_DIR` | `~/.calandria/worktrees` | Where per-task git worktrees are created. Must live outside any project repo |
| `CALANDRIA_PROJECTS_DIR` | `~/projects` | Where **Clone from GitHub** puts cloned repos |
| `CALANDRIA_MAX_UPLOAD_MB` | `25` | Largest single chat attachment. Any file type may be attached; it is staged under `<CALANDRIA_DB_DIR>/uploads/<taskId>` and only its path goes into the message, so the cap bounds disk and the server's heap rather than the model's context |
| `CALANDRIA_BACKUP_DIR` | `<CALANDRIA_DB_DIR>/backups` | Where `npm run backup` writes its archives. Read by [`scripts/backup.mjs`](../scripts/backup.mjs), not by the app; point it at a different volume than the one being backed up. See **Backup & restore** below |
| `CALANDRIA_SERVICE_PORT_BASE` | `4300` | Base of the deterministic per-project port block. Each project is assigned `base + slot` at creation, injected as `PORT` into its supervised services and PTY |
| `CALANDRIA_SERVICE_LOG_LINES` | `1500` | Per-service in-memory log ring buffer (lines) kept for the Services drawer |
| `CALANDRIA_SERVICE_HOSTS` | *(off)* | Set `1` to serve each service on a public hostname `<slug>--<appHost>` with per-service visibility (private / shared link / public). Also needs `PUBLIC_BASE_URL` + wildcard DNS/TLS |
| `CALANDRIA_FEATURE_SERVICES` | `1` (on) | The managed-services feature (Services drawer, supervisor, persisted registry with boot auto-restart + orphan reaping). Set `0` to disable |
| `CLAUDE_CLI_PATH` | `~/.local/bin/claude` | Path to the logged-in `claude` CLI (pinned since Next's server may run with a trimmed `PATH`). On Windows: `%USERPROFILE%\.local\bin\claude.exe`, then `PATH` (point at a real `.exe`, not an npm `.cmd` shim) |
| `CALANDRIA_GH_BIN` | *(auto-resolve)* | Path to the GitHub CLI (`gh`). Empty means bare `gh` if the server's `PATH` resolves it, else a probe of the usual install dirs (linuxbrew/Homebrew, `/usr/local/bin`, snap, `~/.local/bin`; Windows: winget Links, `%ProgramFiles%\GitHub CLI`, scoop shims). The server never reads a shell profile, so set this if the probe misses your `gh` |
| `CALANDRIA_PR_STALE_MS` | `60000` | How long a task's PR state counts as fresh. Opening a task, the chip's Refresh button and the create-PR trigger all skip `gh pr view` inside this window |
| `CALANDRIA_PR_POLL_MS` | `300000` | How often the background sweep re-reads tasks whose PR is still open. `0` disables the sweep, leaving the on-open and explicit-Refresh triggers. The sweep stops itself when no PR is open and skips a pass when no browser tab is watching |
| `CALANDRIA_PR_POLL_BATCH` | `5` | Most PRs refreshed per sweep (one `gh pr view` each, oldest-synced first) |
| `CALANDRIA_CI_LOG_TAIL_LINES` | `200` | Lines of a failed job's log the **Fix CI** button seeds its turn with, per failing check. `gh run view --log-failed` already drops the green steps, but only the end of a failing suite says what broke |

Example: relocate an instance entirely via env.

```bash
PORT=8080 PTY_PORT=8081 \
PUBLIC_BASE_URL=https://calandria.example.com \
CALANDRIA_DB_DIR=/data/calandria \
CALANDRIA_WORKTREES_DIR=/data/worktrees \
CLAUDE_CLI_PATH=/usr/local/bin/claude \
npm start
```

### Upgrading from the pre-rename default paths

`CALANDRIA_DB_DIR` and `CALANDRIA_WORKTREES_DIR` used to default to
`~/.zen-orchestrator` and `~/.agent-orchestrator/worktrees`. Nothing moves
automatically: a worktree is registered by absolute path in its parent
repo's `.git/worktrees/<id>/gitdir`, so relocating one needs a
`git worktree repair` run inside every affected project repo, not a file
move.

Instead the resolver falls back. With `CALANDRIA_DB_DIR` unset, if
`~/.calandria` holds no database but `~/.zen-orchestrator/orchestrator.db`
exists, the app keeps using the old path and boot prints a hint line naming
it and where to move it. Inside an explicit `CALANDRIA_DB_DIR`,
`calandria.db` is preferred, with an existing `orchestrator.db` there as the
fallback (checked as a file, not a directory, so a container entrypoint
pre-creating an empty `~/.calandria` never strands existing data). Worktrees
follow a simpler rule: a populated legacy `~/.agent-orchestrator/worktrees`
is kept as-is, and only an empty one is abandoned for the new default.

To migrate on your own schedule:

```bash
# Move a pre-rename install to the new default location.
# Stop the app first: copying a live SQLite database mid-write corrupts it.
mkdir -p ~/.calandria
mv ~/.zen-orchestrator/orchestrator.db     ~/.calandria/calandria.db
mv ~/.zen-orchestrator/orchestrator.db-wal ~/.calandria/calandria.db-wal 2>/dev/null || true
mv ~/.zen-orchestrator/orchestrator.db-shm ~/.calandria/calandria.db-shm 2>/dev/null || true
# The boot lock is a pure mutex holding no data: delete it rather than move it.
rm -f ~/.zen-orchestrator/orchestrator.lock.*
# Anything else the app keeps beside the database (API keys, VAPID keys, uploads):
mv ~/.zen-orchestrator/* ~/.calandria/ 2>/dev/null || true
# Then start the app. The boot hint line stops printing once nothing legacy is left.
```

Move the `-wal`/`-shm` files together with the database, or checkpoint them
away first; a stale `-wal` left behind next to a moved `.db` loses the most
recent writes. This recipe doesn't cover per-task worktrees: either leave
`CALANDRIA_WORKTREES_DIR` pointing at the old directory, or relocate it
yourself and run `git worktree repair <new-path>/<task-id>` inside each
affected project repo.

## Backup & restore

`npm run backup` ([`scripts/backup.mjs`](../scripts/backup.mjs)) takes a hot
backup: run it with the app up, no downtime. The database half isn't a plain
file copy; that's the point of the script.

### Never `cp` a live database

`calandria.db` runs in WAL mode, so recent transactions live in
`calandria.db-wal` until a checkpoint folds them back. Copying the `.db`
alone gives you a file that's silently missing the newest work; copying the
pair mid-write can tear it outright.

The script runs `VACUUM INTO` instead: one read transaction that writes a
self-contained, already-checkpointed copy with no `-wal`/`-shm` sidecars to
move. It then runs `PRAGMA integrity_check` on the snapshot before calling
the backup done (`tests/backup.test.ts` pins this against a naive copy of the
same moment).

The backup connection is read-only and takes no application lock: the
single-instance boot mutex is a separate `*.lock.db` file, so an out-of-band
reader can work while the app owns the database. A backup never stops the
app from booting.

### What state lives where

| What | Where | In the backup |
|-|-|-|
| Projects, tasks, transcripts, summaries, usage, schedules, runbooks, permission rules | `<CALANDRIA_DB_DIR>/calandria.db` (+ `-wal`/`-shm`) | `db/` (one snapshot, no sidecars) |
| Chat attachments (any file type) | `<CALANDRIA_DB_DIR>/uploads/<taskId>` | `db-dir/` |
| Web Push signing key | `<CALANDRIA_DB_DIR>/vapid.json` | `db-dir/` |
| A persisted API key (only if you used the wizard's key path) | `<CALANDRIA_DB_DIR>/anthropic-api-key`, `openai-api-key` | `db-dir/` |
| Boot mutex | `<CALANDRIA_DB_DIR>/*.lock.db`, `*.lock.json` | **excluded**: a pure lock holding no data; restoring one restores a stale claim |
| Agent CLI logins | `~/.claude.json`, `~/.claude/.credentials.json`, `~/.claude/settings.json`, `~/.codex/auth.json`, `~/.codex/config.toml` | `agent-login/home/…` (`--no-logins` to skip) |
| Per-task git worktrees | `CALANDRIA_WORKTREES_DIR` (default `~/.calandria/worktrees`) | **opt-in** (`--worktrees`) |
| Cloned project repos | `CALANDRIA_PROJECTS_DIR` (default `~/projects`) | **opt-in** (`--projects`) |
| Your own repos | wherever you told the project they are | never (they're yours) |

`db-dir/` is captured by exclusion (everything in the DB dir that isn't a
SQLite file, the lock pair, the backup directory, or a nested worktrees dir),
so anything added beside the database later is picked up automatically.

The last two rows are opt-in since they're reconstructible and are what turn
a nightly backup into a disk problem: a worktree is a checkout of a branch
already in the project repo, and a clone is a clone. Skipping them only
costs a task's uncommitted working-tree edits.

**Docker vs local.** In the container, everything above lives in one named
volume mounted at `/home/calandria`. Running locally, the same state is
spread across your
`$HOME` (`~/.calandria`, `~/projects`, `~/.claude`, `~/.codex`), and only the
env vars say where; the manifest records the resolved paths.

The database file name is resolved, not assumed: a fresh install writes
`calandria.db`, while an install that predates the rename keeps
`orchestrator.db` and is never migrated
([above](#upgrading-from-the-pre-rename-default-paths)). The script asks
`lib/storage.mjs` the same question the app asks at boot, so it backs up
whichever database your instance is actually using, under its real name.

### Hot backup

```bash
npm run backup                        # -> <CALANDRIA_DB_DIR>/backups/calandria-backup-<UTC>.tar.gz
npm run backup -- --out /mnt/backups  # somewhere that isn't the disk you're backing up
docker exec -u calandria calandria-alice npm run backup -- --out /home/calandria/backups
```

| Flag | Effect |
|-|-|
| `--out DIR` | Where to write. Default `CALANDRIA_BACKUP_DIR`, else `<CALANDRIA_DB_DIR>/backups` |
| `--worktrees` | Also archive per-task worktrees (large, slow) |
| `--projects` | Also archive cloned project repos (large, slow) |
| `--no-logins` | Omit the agent CLI credentials |
| `--no-archive` | Leave the staging directory instead of tarring it |
| `--quiet` | Print only the resulting path on stdout |

The archive is a single `.tar.gz` holding `manifest.json`, `db/`, `db-dir/`,
and (unless skipped) `agent-login/`. The manifest records the format and app
version, resolved source paths, the snapshot's SHA-256 and `user_version`,
and row counts, enough to tell two backups apart and reconcile absolute
paths on restore. On a 37 MB database with the app running, the run took
1.2 s and produced an 8.5 MB archive.

**It contains credentials.** The file is written `0600` on POSIX. On Windows a
POSIX mode is a no-op, so the file inherits the ACL of the directory it lands
in. Put it somewhere private.

Nightly, with your own retention (there is no built-in pruning of old
archives):

```cron
17 4 * * *  cd /opt/calandria && /usr/bin/npm run backup -- --quiet --out /mnt/backups >/dev/null
27 4 * * *  find /mnt/backups -name 'calandria-backup-*.tar.gz' -mtime +14 -delete
```

### Cold backup (the alternative)

To skip all of the above, stop the container and copy the volume: the app
is down, nothing is mid-write, and a plain copy (WAL included) is correct.

```bash
docker compose -p calandria-alice stop
docker run --rm -v orch-u-alice-home:/from -v /mnt/backups:/to alpine \
  tar -czf /to/calandria-volume-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /from .
docker compose -p calandria-alice start
```

This captures worktrees and project clones too, so it's much larger and
costs downtime. Reach for it when you want a byte-for-byte image of the whole
instance, not just its state.

### Restore

This procedure was tested end to end: hot backup, restore into a scratch
directory, verification boot, contents checked through the API.

1. **Stop the app.** A restore that races a running instance replaces the
   database file out from under it; the boot lock can't save you from that.

   ```bash
   docker compose -p calandria-alice stop     # or: systemctl stop calandria
   ```

2. **Unpack somewhere scratch**, and read the manifest before overwriting
   anything. `contents.db` names the file; `source.*` says where it came
   from.

   ```bash
   mkdir -p /tmp/restore && tar -xzf calandria-backup-20260827T221316Z.tar.gz -C /tmp/restore
   cd /tmp/restore/calandria-backup-20260827T221316Z && cat manifest.json
   ```

3. **Put the database back.** Copy the snapshot to `<CALANDRIA_DB_DIR>` and
   remove any stale sidecars beside it: the snapshot is self-contained, and
   an old `-wal` next to a new `.db` is the one way to lose data on an
   otherwise successful restore.

   ```bash
   DBDIR=~/.calandria                       # whatever CALANDRIA_DB_DIR resolves to
   rm -f "$DBDIR"/calandria.db-wal "$DBDIR"/calandria.db-shm
   cp db/calandria.db "$DBDIR"/calandria.db
   cp -a db-dir/.     "$DBDIR"/             # uploads, vapid.json, any API key
   ```

   If the backup's `contents.db` is `db/orchestrator.db`, this is the moment
   to leave the old name behind: copy it to `calandria.db` instead. Nothing
   but `lib/storage.mjs` cares about the name, so there's no other reference
   to fix up.

4. **Put the agent logins back** (skip if the target is already logged in):

   ```bash
   cp -a agent-login/home/. ~/
   ```

5. **Start the app and verify.** For a verification boot against a copy,
   point `CALANDRIA_DB_DIR` at the scratch directory and set
   `CALANDRIA_SCHEDULER=off` and `CALANDRIA_FEATURE_SERVICES=0` first.
   Otherwise the restored instance fires every schedule that looks missed
   and restarts every managed service in its registry.

   ```bash
   CALANDRIA_DB_DIR=/tmp/restore/data CALANDRIA_WORKTREES_DIR=/tmp/restore/worktrees \
   CALANDRIA_SCHEDULER=off CALANDRIA_FEATURE_SERVICES=0 PORT=4318 PTY_PORT=4319 npm start
   curl -s localhost:4318/api/projects | jq 'length'
   ```

Expect three things from a restored instance; none are faults:

- **In-flight turns come back interrupted.** The snapshot captures whatever
  was running at that instant. The first boot's crash recovery clears
  running flags, queued follow-ups, unanswered permission cards, and
  in-flight schedule runs. Ask those tasks to continue; the transcript and
  session lineage are intact.
- **Absolute paths come back verbatim.** `projects.repo_path` and
  `tasks.worktree_path` are absolute. Restoring onto the same layout (the
  container case, everything under `/home/calandria`) needs nothing.
  Restoring onto a different layout means editing `projects.repo_path` to
  point at the repos' new home; worktrees self-heal, since every launch path
  re-cuts a missing one.
- **Worktrees you didn't archive are gone, but that's recoverable.** A task
  whose checkout is missing gets a fresh one cut from its branch on the next
  turn. Uncommitted edits sitting in the old worktree aren't in the backup,
  the argument for `--worktrees` if you run tasks that idle for days with
  work in progress.

## Metrics

`GET /api/instance/metrics` serves
[Prometheus text exposition][promfmt]: a handful of hand-rolled series
covering two questions a running instance can't otherwise answer from
outside: is it doing work, and is it eating the disk? It's always on.

[promfmt]: https://prometheus.io/docs/instrumenting/exposition_formats/

Auth uses the same read-only service-token exemption as `/api/version` and
`/api/instance/usage`. In no-login local mode, a loopback scrape needs
nothing. Under Cloudflare Access, a scraper has no JWT, so it presents
`SERVICE_TOKEN` or `CALANDRIA_FLEET_TOKEN` (one secret for a dashboard polling
every box).

```bash
# local mode, from the host
curl -s localhost:3000/api/instance/metrics

# behind Access
curl -s -H "x-service-token: $CALANDRIA_FLEET_TOKEN" \
  https://calandria.example.com/api/instance/metrics
```

| Series | Type | What it is |
|-|-|-|
| `calandria_build_info{version,sha}` | gauge | Always `1`; read the labels. The same provenance `/api/version` reports, so a change in behaviour can be lined up against a deploy |
| `calandria_process_start_time_seconds` | gauge | When this process booted. The counters below reset here; graph it alongside them |
| `calandria_turns_started_total` | counter | Agent turns started |
| `calandria_turns_finished_total{outcome}` | counter | Turns that ended, by outcome: `ok`, `failed`, `stopped` (a human pressed Stop), `interrupted` (the agent session never opened, so the turn produced nothing) |
| `calandria_turns_active` | gauge | Turns running right now, read from the in-process registry rather than `tasks.running`, the only source that's correct right after a crash |
| `calandria_db_size_bytes{file}` | gauge | `calandria.db` and its `wal` / `shm` sidecars, separately |
| `calandria_worktrees_size_bytes` | gauge | Everything under `CALANDRIA_WORKTREES_DIR` |
| `calandria_schedule_runs{status}` | gauge | Rows in the schedule run ledger by status (`succeeded`, `failed`, `missed`, `skipped_overlap`, `claimed`, `running`, `stopped`, `interrupted`) |

Two sharp edges worth knowing before you alert on these:

**The turn counters are per-process.** They live in memory and reset on
restart, so a raw `calandria_turns_started_total` panel sawtooths on every
deploy. Graph rates, not totals, and keep
`calandria_process_start_time_seconds` on the same board.

**`calandria_schedule_runs` is a gauge, not a counter.** The ledger is capped
per schedule, so these numbers fall as old runs age out. It answers "is
anything stuck or failing right now", not "how many runs have ever failed."
Read as a counter, a prune looks like a negative rate.

Every label a metric can take is emitted on every scrape, including zeros, so
an alert on `{outcome="failed"}` has data before the first failure. The one
series that can be absent is `calandria_worktrees_size_bytes`, until its
first successful measurement; reading `0` there instead would resolve a
firing alert without a byte reclaimed.

### Scraping it

```yaml
# prometheus.yml: a collector running on the same host, local mode.
# Nothing to authenticate: loopback is already an allowed origin.
scrape_configs:
  - job_name: calandria
    metrics_path: /api/instance/metrics
    static_configs:
      - targets: ["127.0.0.1:3000"]
```

Scraping a box behind Access means getting `x-service-token` onto the
request, which Prometheus 2.49+ can do directly:

```yaml
scrape_configs:
  - job_name: calandria-fleet
    scheme: https
    metrics_path: /api/instance/metrics
    http_headers:
      x-service-token:
        files: [/etc/prometheus/calandria-fleet-token]
    static_configs:
      - targets: ["calandria.example.com"]
```

On an older Prometheus, put a proxy in front that injects the header; the
token is a plain shared secret.

A first Grafana row, and the two alerts worth having on day one:

```promql
# panel: turn throughput and failure rate
sum(rate(calandria_turns_started_total[5m]))
sum by (outcome) (rate(calandria_turns_finished_total[5m]))

# panel: disk footprint
calandria_db_size_bytes{file="db"} + calandria_worktrees_size_bytes

# alert: turns are failing, not just running
sum(rate(calandria_turns_finished_total{outcome="failed"}[15m]))
  / sum(rate(calandria_turns_finished_total[15m])) > 0.5

# alert: a scheduled run is wedged (claimed/running is a transient state)
sum(calandria_schedule_runs{status=~"claimed|running"}) > 0    # for: 1h

# alert: the WAL isn't being checkpointed
calandria_db_size_bytes{file="wal"} > 512e6                    # for: 30m
```

Everything on the endpoint is cheap to compute except the worktrees
measurement, which runs `du` over every task checkout on the box. It's
cached for `CALANDRIA_METRICS_SIZE_TTL_MS` (default 60000, one minute) so a
15s scrape interval doesn't walk every `node_modules` on the instance four
times a minute; raise it if you carry many large worktrees. A scrape only
waits on that walk once, right after a restart.

## Notes & caveats

- **Permissions:** tasks default to Claude Code's auto mode, where a model
  classifier approves calls it judges safe and escalates the rest. Switch a
  task, or the app default in Settings → Run defaults, to bypassPermissions
  for work that must never block on a prompt, or down to acceptEdits,
  default, or plan (a Codex task offers its own workspace-write / read-only
  sandboxes instead). Anything the agent isn't pre-approved for parks on a
  permission card in the transcript, with Allow once / Always allow /
  Decline. Read-only tools pass silently; "Always allow" remembers a command
  for that project and is revocable in Settings → Run defaults → Remembered
  approvals, which also takes a rule typed in ahead of time through the same
  Bash-only, prefix-checked policy. A prompt nobody answers denies itself
  (`CALANDRIA_PERMISSION_UNATTENDED_MS` when no tab is open,
  `CALANDRIA_PERMISSION_PROMPT_TIMEOUT_MS` when one is), so an auto-started
  task can't wedge a turn overnight. Calandria is a control layer, not a
  sandbox; the isolated worktree is the real security boundary.
- **One process per database:** Calandria runs single-process; boot clears
  what a crash left behind (running flags, queued follow-ups, unanswered
  permission cards, in-flight schedule runs). A second process on the same
  `calandria.db` would run that recovery pass against a live instance, so
  the app takes a lock at boot and refuses to start if another process holds
  it, naming the holder's pid and host. Crash recovery only runs in the
  process that owns the database. The lock is a kernel file lock on a
  separate `calandria.lock.db`, named after the database it guards (a
  pre-rename `orchestrator.db` is guarded by `orchestrator.lock.db`), so a
  killed instance releases it immediately and a read-only
  `sqlite3 calandria.db` inspection is unaffected. Two instances need two
  `CALANDRIA_DB_DIR`s; `CALANDRIA_DB_LOCK=off` disables the check and is
  unsupported. Limit: the lock only coordinates processes sharing a kernel,
  so two containers mounting one volume may not see each other's locks, but
  that's already unsafe, since SQLite's WAL mode needs shared memory between
  its users. Use one instance per volume.
- **Parallel quota:** every concurrent task spends your rate limit: N tasks
  use roughly N times the token rate against one subscription.
- **Terminal:** the `node-pty` sidecar stays bound to `127.0.0.1` only. The
  browser reaches it through the app origin at `/pty`, so remote access goes
  through your one tunneled hostname. `postinstall` restores the exec bit npm
  can strip off node-pty's prebuilt helper.
- **Keep `ANTHROPIC_API_KEY` unset** unless you chose the wizard's API-key
  path. If set, it takes precedence and bills per-use instead of using your
  subscription.
- **A stored API key is locked to the account that runs the app.** The
  wizard's "I have an API key instead" path writes the key to
  `anthropic-api-key` / `openai-api-key` beside the database, never to the
  settings table. On Linux and macOS that file is mode `0600`. On Windows,
  where a POSIX mode is a no-op, it's restricted with an ACL instead
  (`icacls <file> /inheritance:r /grant:r <you>:(R,W)`), leaving only your
  account with access. If that ACL call fails (no `icacls`, an unresolvable
  account, a filesystem with no ACLs such as FAT32 or a mapped network
  drive), the key is deleted and the save returns an error rather than
  leaving a credential at permissions nobody checked; in that case, start the
  app with `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` set and
  `CALANDRIA_ALLOW_API_KEY_ENV=1` instead, so nothing is written to disk. The
  VAPID private key (`vapid.json`) is written the same way but fails open: a
  failed ACL logs a warning and keeps the key rather than disabling push
  notifications, since you never pasted it in. Set `VAPID_PRIVATE_KEY` to
  keep it off disk. On every platform, a local administrator or root can
  take ownership regardless; this protects against other users, not the
  machine's owner.
- **Retention:** the database isn't append-only forever. A sweep rides the
  schedule ticker and ages out the record of finished tasks (terminal, idle,
  not snoozed, no queued follow-up, no in-flight scheduled run). A live task
  is never touched, however old. Two windows, both in days:
  `CALANDRIA_RETENTION_DAYS` (default 180) covers a finished task's own
  record (transcript, review comments, `/clear`-retired sessions, uploaded
  attachments); `CALANDRIA_USAGE_RETENTION_DAYS` (default 400) covers the
  spend rows (`task_usage`, `task_merges`, `internal_usage`); it's longer
  because Insights reads 180 days back and needs the same width again for
  prior-period deltas. A sweep leaves an aged-out task with an empty
  transcript (its `/clear` summaries survive, so it stays resumable) and an
  all-time cost of $0.00. Set `CALANDRIA_RETENTION=off` to keep everything
  forever, or either window to `0` to keep just that half. Cadence is
  `CALANDRIA_RETENTION_SWEEP_MS` (default 6h); the first sweep runs on the
  tick after boot. Anything deleted is named in one server log line.
- **Reclaiming the disk:** a sweep that deletes anything follows with
  `PRAGMA wal_checkpoint(TRUNCATE)`, since in WAL mode the deletes themselves
  land in `calandria.db-wal` and grow it, so without a checkpoint a big prune
  raises the on-disk footprint before it falls. A checkpoint can't shrink
  `calandria.db` itself: freed pages go on the freelist for reuse rather than
  being returned to the filesystem, so the file plateaus instead of
  shrinking. Only `VACUUM` shrinks it (a write-locked rewrite of the whole
  database, seconds on a small database, a visible stall on a large one), so
  it's opt-in: set `CALANDRIA_RETENTION_VACUUM=1` to run one after any sweep
  that deletes rows, or run `VACUUM;` yourself against a stopped instance.
- **Worktrees are the bigger disk story**, measured in gigabytes rather than
  rows, and have their own switch. Every task runs in its own git worktree
  (a full checkout of the project repo) under `CALANDRIA_WORKTREES_DIR`.
  **The sweep** (`CALANDRIA_WORKTREE_RETENTION=on`, off by default) rides the
  same ticker and reclaims checkouts of finished, cold tasks on a shorter
  window: `CALANDRIA_WORKTREE_RETENTION_DAYS`, default 14 (`0` keeps them
  forever). It reuses the retention predicate above and skips, names in the
  log, and never touches a worktree with uncommitted edits or commits the
  base branch hasn't absorbed, however old. It never deletes a branch, so a
  reclaimed task re-cuts its checkout on the next turn and keeps its diff.
  It's opt-in because the retention windows above (180/400 days) are longer
  than most instances have existed, and a window in weeks would start
  removing checkouts on the first tick after an upgrade nobody asked for.
  The manual path (Settings → Storage, which can also discard unmerged work
  after you acknowledge it) works either way.
  **Landing is the other trigger, and it isn't on this clock at all.** When a
  task's PR reports merged, or its branch is merged locally, the session
  header's **Reclaim** button (or the project's `auto_reclaim` setting, off by
  default) catches the local base branch up with origin, removes the checkout,
  deletes the *local* branch and marks the task done. Unlike the sweep it does
  delete a branch — the diff it carried is in the base branch by then — and
  like the sweep it never discards uncommitted edits, or commits the remote
  never received, without an explicit acknowledgement nobody can give
  unattended. See [Features](FEATURES.md).
  **The disk warning** runs whether or not the sweep does: when the
  worktrees directory crosses `CALANDRIA_WORKTREES_DISK_WARN_GB` (default 20,
  `0` disables), a line goes to the server log each pass while it's over, the
  reading is served on `GET /api/instance/scheduler` under `worktrees`, and
  Settings → Storage shows it above the reclaim list. The same directory is
  also the `calandria_worktrees_size_bytes` metrics gauge; see
  [Metrics](#metrics). The total includes in-flight checkouts, which nothing
  here touches, so on a busy instance the honest reading might be "40 GB of
  worktrees, 6 GB reclaimable"; the rest is answered by finishing or deleting
  tasks, not by a sweep.
- **Delete is hard delete:** a removed project's chat history is gone (your
  code on disk is untouched).
