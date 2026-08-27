# Self-hosting

Everything about running your own instance: Docker, tunnels, auth, and configuration.
The [README](../README.md) has the two-command version; this is the rest. Something already
broken? See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for first-incident runbooks (DB
corruption, disk fill, headless re-auth, boot failures).

## Docker

The [`Dockerfile`](../Dockerfile) builds a single-user image: a **production** Next.js
build (a stopped container starts in seconds) bundling Node 22, git, and the `claude`
CLI, with [`docker/entrypoint.sh`](../docker/entrypoint.sh) running both processes (app
server + pty sidecar) under tini. All state lives under `/home/calandria` — one named volume
captures the SQLite db, worktrees, project repos, and claude login.

You don't have to build it yourself: the same image is published on every push to `main`.

### The published image

```bash
docker pull ghcr.io/calandria-dev/calandria:latest
```

The package is public — no `docker login`, no token.
[`.github/workflows/publish-image.yml`](../.github/workflows/publish-image.yml) publishes
it, gated on the unit suite, so a red test run never reaches the registry.

**Architectures:** one manifest covering `linux/amd64` and `linux/arm64`, so `docker pull`
picks yours. Each arch is built on a native runner (no QEMU), and the workflow then boots
the *published* image on both and waits for its HEALTHCHECK before the run goes green.

| Tag | Points at |
|-|-|
| `latest` | The newest tagged release |
| `edge` | The newest nightly build of `main` |
| `sha-<short>` | One immutable tag per commit — `sha-337ea62`, the 7-char SHA |
| `<version>` | A pushed `v*` git tag with the `v` stripped — `v1.4.2` → `1.4.2` |
| `<major>.<minor>` | The newest patch on that line — `1.4` |

`latest` moves only on a `v*` tag push and **only ever moves forward**: releases are cut
from `main`, so a patch back-published onto an older line would otherwise silently roll
`latest` *backwards* for everyone pulling it. `main` itself no longer moves `latest` —
ordinary nightly builds publish under `edge` instead, so pulling `latest` never hands you
untagged, unreleased code. Pin `sha-<short>` (or a specific `X.Y.Z`) when you want a tag
that can never change under you. See [Pinning a version](#pinning-a-version) below.

Every release since the first (`v0.2.0`, 2026-08-25) publishes all three:
`latest`, `<version>` and `<major>.<minor>` — as `0.3.0` and `0.3` for a
`v0.3.0` tag, with no `v`. The [releases page](https://github.com/calandria-dev/calandria/releases)
is the list of what `latest` has pointed at.

### Verify the image's provenance

The `attest` job signs the merged multi-arch index with SLSA build provenance (Sigstore,
keyless) — the "this digest was built by this workflow, from this commit" claim. Check it
before you run it:

```bash
gh attestation verify oci://ghcr.io/calandria-dev/calandria:latest --owner calandria-dev
```

Success is the **exit status** — `gh` prints nothing when its output isn't a terminal.
Add `--format json` for the parsed statement and signing certificate. Useful variations:

| Flag | Why |
|-|-|
| `--repo calandria-dev/calandria` | Instead of `--owner`; scopes the claim to this one repo rather than anything the account publishes |
| `--signer-workflow calandria-dev/calandria/.github/workflows/publish-image.yml` | Pins *which* workflow was allowed to sign, the check actually worth making |
| `--bundle-from-oci` | Reads the signature from the registry (the `attest` job pushes it there) instead of the GitHub API |

The subject is the **multi-arch index** digest, not a per-arch one: the index is the thing
you pull, and the per-arch legs are built with `provenance: false` so their digests are
plain manifests the merge step can stitch together. Only digests published by a run that
included the `attest` job carry a signature — anything older reports
`no attestations found`.

### Pinning a version

Note the image tag carries **no leading `v`**, even though the git tag does:
`v0.2.0` in git is `:0.2.0` in the registry (`docker/metadata-action`'s
`{{version}}` strips it). `:vX.Y.Z` does not exist and will fail to pull.

Pick one of:

| You want | Set `CALANDRIA_IMAGE` to |
|-|-|
| A specific release, never changes | `ghcr.io/calandria-dev/calandria:X.Y.Z` |
| The newest patch on a minor line, moves forward within it | `ghcr.io/calandria-dev/calandria:X.Y` |
| Whatever the newest release is, moves on every release | `ghcr.io/calandria-dev/calandria:latest` |
| Nightly builds of `main`, ahead of any release, least stable | `ghcr.io/calandria-dev/calandria:edge` |

`X.Y.Z` is the only one of these that never changes under you — `X.Y` and `latest` are
both moving targets by design (see the tag table above). Pin `X.Y.Z` for anything you
don't want to babysit; use `latest` only if you're fine re-reading the changelog after
every unattended upgrade.

Every past release tag stays pullable indefinitely, so moving between versions is only
ever a matter of re-pinning `CALANDRIA_IMAGE`. Going *backwards* has one more step than
going forwards, because the newer build already migrated your database — see
[Rolling back an upgrade](#rolling-back-an-upgrade).

### Running it

[`docker-compose.yml`](../docker-compose.yml) is the parameterized runner. It builds from
this checkout by default; set `CALANDRIA_IMAGE` to run the published image instead.

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

The explicit `pull` + `--no-build` is belt and braces: the service keeps its `build: .`
stanza so a checkout still works with no env at all, and Compose versions differ on
whether a missing image with a build context gets pulled or built.

The container publishes its port on the **host's loopback only**. To reach it from
elsewhere, put an authenticated tunnel or reverse proxy in front — this app hands out a
full shell and a `bypassPermissions` agent, so **never expose the port raw**.

An HTTPS front has a second payoff beyond safety: browsers only offer **PWA install**
(Add to Home Screen / standalone window) and the **Notification permission** in a secure
context — HTTPS or `localhost`. A plain-HTTP LAN IP gets neither, so if the phone is one
of your surfaces, reach the instance through the tunnel hostname rather than `http://192.168.x.x`.

The `claude` CLI works headless: it prints the OAuth URL and accepts a pasted code, and
the setup wizard drives that flow from the browser.

Need site-specific CLIs or config layered on top of the published image? See
[`examples/overlay/`](../examples/overlay/) for a sanitized starting point — real overlays
belong in a private repo, not committed here.

### Upgrading

**Take a backup first.** It is one command, it needs no downtime, and it is the only
thing that makes the upgrade reversible — the new build migrates your database on its
first boot, and there is no down-migration.

```bash
# 1. Snapshot the database while the old version is still the one running.
docker exec -u calandria calandria-alice npm run backup -- --out /home/calandria/backups
#    (running locally instead: npm run backup -- --out /mnt/backups)

# 2. Note the version you are on — it's what you'd roll back to.
curl -s localhost:10001/api/version

# 3. Upgrade.
export CALANDRIA_IMAGE=ghcr.io/calandria-dev/calandria:0.3.0   # or :latest
docker compose -p calandria-alice pull
docker compose -p calandria-alice up -d --no-build
```

The container comes up, runs its schema migrations, and serves. Migrations are additive
and idempotent — new columns get defaults, nothing is dropped — so a database from any
older version upgrades in place, and re-running the same version changes nothing. What
they are *not* is reversible, which is what step 1 is for.

At the end of migrating, the build stamps the database with the schema version it
understands (`PRAGMA user_version`, [`lib/schema-version.mjs`](../lib/schema-version.mjs)).
Nothing surfaces that number in normal operation; it exists so that an *older* build
pointed at that database refuses to start instead of quietly writing to a schema it has
never seen. That refusal is the subject of the next section.

### Rolling back an upgrade

A rollback is **two** moves, and doing only the first one is the mistake this section
exists to prevent: re-pin the image *and* put back the database the old version knew.

If you re-pin the image alone, the old build finds a database stamped by the newer one
and refuses to boot, with the versions and both ways out in the message:

```
Refusing to start: /home/calandria/.calandria/calandria.db was written by a NEWER version of Calandria.

  database schema version: 2
  this build understands:  1
  ...
```

That is a deliberate, clean failure rather than a corrupted instance. The container will
exit and (with `restart: unless-stopped`) keep retrying, so `docker compose logs` is where
you'll read it. Pick one of the two exits:

**A. Forward — go back to the version you just came from.** Nothing to restore; the
database is already the shape that build wants. This is the right answer whenever the
upgrade merely surprised you and no data is at stake.

```bash
export CALANDRIA_IMAGE=ghcr.io/calandria-dev/calandria:0.3.0   # the NEWER tag
docker compose -p calandria-alice pull
docker compose -p calandria-alice up -d --no-build
```

**B. Backward — pin the old tag and restore the pre-upgrade backup.** This is a real
rollback: you also give up everything that happened after the backup was taken.

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

Read [Restore](#restore) before running step 3 in anger — it covers the `db-dir/`
half (uploads, VAPID key, a persisted API key), agent logins, and the three things a
restored instance does that look like faults and aren't. The backup's `manifest.json`
records the snapshot's `userVersion` and the app version that wrote it, so you can check
you're restoring a database the tag you just pinned will actually accept.

Three notes on what a rollback costs, none of them avoidable by a different procedure:

- **Everything since the backup is gone**, including turns that ran on the new version.
  Task branches are not: they live in your project repos, so committed work survives the
  database going back — the *task rows* describing it don't.
- **Worktrees are not rolled back** (they aren't in the default backup). A task whose row
  came back but whose checkout moved on gets a fresh one cut from its branch on the next
  turn.
- **No backup, and you want the old version anyway?** There is no supported way to
  down-migrate, and pointing the old build at the new database is exactly what the boot
  gate refuses. Your options are to stay on the newer version (A above) or start from a
  fresh database — take a backup of the current one first either way.

## Origin-side auth (Cloudflare Access)

If you front an instance with Cloudflare Access, set `CF_ACCESS_TEAM_DOMAIN` +
`CF_ACCESS_AUD` and the origin re-verifies the Access JWT (`Cf-Access-Jwt-Assertion`
header / `CF_Authorization` cookie, checked against the team's public signing keys and
the app's `aud` tag) on **every HTTP route** (Next.js middleware) **and on every
WebSocket upgrade** (`server.js`, in front of the `/pty` terminal proxy). No valid
assertion → 403. [`lib/cf-access.mjs`](../lib/cf-access.mjs) is the single shared
verifier; the titlebar shows the authenticated email.

Requests get a **second** check on top of the JWT: if the browser sends an `Origin`, it
must match the `Host` the request was aimed at. Access proves *who* is calling, not that
they meant to call — the `CF_Authorization` cookie is `SameSite=None` by default, so a
hostile page can make a logged-in user's browser issue a request and the edge will attach
a perfectly valid assertion to it. Without this check that page could open
`wss://your-host/pty` and be handed a shell, or POST to any mutating API route
(cross-site CSRF: browsers skip the CORS preflight for form and `text/plain` bodies, and
several routes act on the URL path alone). WebSocket upgrades **require** an `Origin`;
HTTP requests only require that one, if sent, matches — so an ordinary cross-site link to
your instance from an email or a wiki still opens normally.

`PUBLIC_BASE_URL` is **not** required for this; the check compares the request's own two
headers. Set it only if your proxy rewrites `Host` (Cloudflare Tunnel's `httpHostHeader`),
which would otherwise make the two disagree. The pty sidecar independently repeats the
upgrade checks, so reaching `PTY_PORT` directly grants nothing either.

Unset (the local default), the app has no login, but it still enforces a browser-origin
boundary: loopback hosts are accepted, cross-site requests are rejected, and `/pty`
WebSocket upgrades require a matching browser `Origin`. This prevents an unrelated
website from driving the local shell and blocks DNS-rebinding hostnames. `PUBLIC_BASE_URL`
is accepted automatically; intentional LAN access must list its exact origin in
`CALANDRIA_ALLOWED_ORIGINS`. This remains a single-user mode, not authentication — never expose
it raw to the internet.

The one Access-mode exception is `SERVICE_TOKEN`: a shared secret letting health probes
read the documented service-token routes without an Access JWT
(`x-service-token` header).

It is optional in the sense that nothing *requires* you to choose a value, but in Access
mode something has to present one — it is also how the three callers that live inside the
box authenticate, none of which has an Access JWT: the image's `HEALTHCHECK`, the boot
restore of managed services, and the stdio MCP bridge the non-Claude agents' tool calls go
through. So [`docker/entrypoint.sh`](../docker/entrypoint.sh) mints a per-boot token into
`/tmp/calandria-service-token` when `CF_ACCESS_*` is set and you supplied none; the
`HEALTHCHECK` reads env-or-file (a healthcheck runs as a separate exec with the *image's*
environment, so the file is the only way a generated token reaches it). Supply your own
when a monitor outside the container needs to poll. Running bare Node behind Access with
no token, `server.js` warns loudly at startup instead.

`CALANDRIA_FLEET_TOKEN` is a second, optional secret for the same read-only routes,
shared fleet-wide so one dashboard can poll many boxes without learning each one's private
`SERVICE_TOKEN`. It is deliberately **not** accepted on the mutating internal agent-tool
endpoints. Unset — the default — it grants nothing.

## Configuration

Every per-instance value is an env var with a documented default — one env set fully
relocates an instance (fresh container, different user, different ports) with **zero
code edits**. [`.env.example`](../.env.example) is the same list in copyable form.
Export the variables in the environment that launches `npm run dev` / `npm start` —
`server.js` and `pty-server.js` are plain Node and read them before Next boots, so a
`.env` file alone doesn't cover `PORT`/`CALANDRIA_HOSTNAME`/`PTY_*`.

Variables below were renamed from an earlier `ORCH_*` naming; every old name still works
as a fallback (a `CALANDRIA_*` value wins if both are set), and the server prints one
boot-time warning naming whichever old names are still in use — that warning is your
upgrade signal to move a self-hosted `.env`/systemd unit/compose file over on your own
schedule.

### Upgrading from `ORCH_*` names

Three groups, and only one of them can break you.

**App variables — nothing to do.** Everything in the table below reads `CALANDRIA_X` first
and falls back to `ORCH_X`, so an existing `.env`, systemd unit or `docker run -e` keeps
working untouched. An empty value counts as unset on both sides, so a blank
`CALANDRIA_X` never shadows a real `ORCH_X`. The boot line naming the old names still in
use is a nudge, not a deadline.

**Compose variables — a hard rename.** `ORCH_USER`, `ORCH_PORT`, `ORCH_CPUS`, `ORCH_MEM`,
`ORCH_IMAGE` and `ORCH_RUNTIME` are interpolated by `docker compose` itself, which has no
aliasing mechanism, so there is nowhere to put a fallback. Rename them in your shell or
`.env`:

```bash
sed -i 's/^ORCH_\(USER\|PORT\|CPUS\|MEM\|IMAGE\|RUNTIME\)=/CALANDRIA_\1=/' .env
```

The two required ones fail loudly if you miss them (`set CALANDRIA_USER (e.g. alice)`)
rather than starting a second, empty instance. The `-p` project name is your own label,
not something the app reads — an existing stack can stay on `-p orch-alice` (its
`container_name` is pinned either way); the docs just show `-p calandria-alice` for new
ones.

**Docker resource names — unchanged on purpose.** The home volume is still
`orch-u-<user>-home` and the network still `orch-u-<user>-net`. Those are storage ids, not
branding: renaming the volume would strand every existing instance's database, cloned
repos and agent logins behind a name nothing mounts any more. Only the mount *path* moved,
`/home/orch` -> `/home/calandria`, and a named volume follows its mount.

That path move is invisible to a fresh instance and handled for an existing one: absolute
`/home/orch/...` strings are baked into rows the app cannot re-derive (`projects.repo_path`,
`tasks.worktree_path`) and into each repo's git worktree metadata, so the image keeps
`/home/orch` as a symlink to the new home. Old paths keep resolving; new ones are written
under `/home/calandria`.

If you would rather have the volume named for the product, do it deliberately while the
container is down — Docker has no rename, so it is a copy:

```bash
docker compose -p calandria-alice down
docker volume create calandria-u-alice-home
docker run --rm -v orch-u-alice-home:/from -v calandria-u-alice-home:/to alpine \
  sh -c 'cd /from && cp -a . /to'
# then point the compose `volumes:` stanza at the new name and bring it back up
```

Verify the copy (the database and `projects/` are there) before `docker volume rm` on the
old one. There is no undo.

| Variable | Default | What it does |
|-|-|-|
| `PORT` | `3000` | Port of the single public origin (Next.js + `/pty` proxy) |
| `CALANDRIA_HOSTNAME` | `127.0.0.1` | Bind address of the app server. Loopback by default: a local instance is unauthenticated and hands out a shell, and the origin gate is a header check that a LAN client can forge past, so only the bind closes that. Widen it only behind `CF_ACCESS_*`. Bare `HOSTNAME` is deliberately **not** read — shells and container runtimes inject it. The image sets `CALANDRIA_HOSTNAME=0.0.0.0`, correct inside a container whose port is published on the host's loopback |
| `CALANDRIA_LOG_FORMAT` | `text` | How log lines are rendered. `text` is the human-readable `[component] message key=value` form this app has always printed; `json` emits one JSON object per line (`ts`, `level`, `component`, `msg`, plus that line's own fields) for shipping at a collector. Read independently by `server.js`, `pty-server.js` and the app, so set it in the environment that launches all three. See [Reading the logs](TROUBLESHOOTING.md#reading-the-logs) |
| `PTY_PORT` | `3001` | Port of the node-pty terminal sidecar |
| `PTY_HOST` | `127.0.0.1` | Bind address of the sidecar **and** the proxy's upstream. Keep it on loopback — the browser never connects directly; `server.js` proxies `/pty` to it |
| `CALANDRIA_PTY_SHELL` | *(empty)* | The shell every terminal tab spawns. Empty falls back to `$SHELL`, then to a platform default: the first of `/bin/zsh`, `/bin/bash`, `/bin/sh` that exists on POSIX; `pwsh.exe`/`powershell.exe` if either is on PATH, else `%COMSPEC%`, on Windows. `$SHELL` is a POSIX convention — unset on native Windows and under systemd/trimmed environments — so set this if the terminal drawer can't spawn a shell, or to get a different one than your login shell |
| `PUBLIC_BASE_URL` | *(empty)* | The origin users reach the app on (e.g. `https://calandria.example.com` behind a tunnel). The client builds its `ws(s)://` terminal URL from it; empty = the browser's own origin, correct for any single-hostname deployment, Access mode included. Set it if your proxy rewrites the `Host` header, which would make the origin gate's `Origin`-vs-`Host` comparison disagree |
| `CALANDRIA_ALLOWED_ORIGINS` | *(empty)* | Exact comma-separated `http(s)` origins additionally allowed in no-login local mode, for intentional LAN/reverse-proxy access. Loopback origins and `PUBLIC_BASE_URL` are already accepted. This is not a substitute for authentication |
| `VAPID_SUBJECT` | *(derived)* | Contact for the browsers' push services (Web Push VAPID subject): a `mailto:` or `https:` URL. Defaults to `PUBLIC_BASE_URL` when that is https, else `mailto:admin@localhost`. **iOS push needs a real one** — Apple rejects `localhost` with `403 BadJwtToken`; set your https origin or a real `mailto:` |
| `VAPID_PRIVATE_KEY` | *(minted)* | Base64url raw P-256 scalar signing every push. Empty = minted on first use and kept at `<CALANDRIA_DB_DIR>/vapid.json`; subscriptions are bound to it, so back it up with the database |
| `CALANDRIA_PTY_ALLOW_REMOTE` | *(off)* | Set `1` to let the pty sidecar accept off-machine peers. It otherwise requires a loopback peer, since `server.js` proxies to it from the same host — an address check the caller cannot forge, unlike a header. Only for a deliberately split deployment; anything reaching the sidecar gets a shell |
| `CF_ACCESS_TEAM_DOMAIN` | *(empty)* | Cloudflare Zero Trust team domain (e.g. `your-team.cloudflareaccess.com`); see above |
| `CF_ACCESS_AUD` | *(empty)* | The Access application's `aud` tag the JWT must carry (comma-separable) |
| `SERVICE_TOKEN` | *(empty)* | Shared secret for the health/version/usage/metrics routes **and** for the in-container callers (health probe, service restore, agent-tool bridge); see above. The image mints a per-boot one under Access if you leave it empty |
| `CALANDRIA_FLEET_TOKEN` | *(empty)* | Optional fleet-wide **read** token, accepted on the same read-only routes (`/api/version`, `/api/instance/usage`, `/api/instance/metrics`, `GET /api/instance/scheduler`) so one dashboard can scrape many instances with one secret. Never accepted on the mutating internal endpoints. Unset = no such bypass |
| `CALANDRIA_DB_DIR` | `~/.calandria` | Directory holding `calandria.db` (SQLite app data). Absolute path; created on first run |
| `CALANDRIA_DB_LOCK` | `on` | The single-instance boot lock. `off` lets a second process start against a database another one already owns — unsupported, and the exact corruption the lock exists to prevent; see **One process per database** below |
| `CALANDRIA_DB_LOCK_WAIT_MS` | `10000` | How long boot retries the lock before giving up. Covers a predecessor that is still shutting down; a crashed one releases instantly |
| `CALANDRIA_WORKTREES_DIR` | `~/.calandria/worktrees` | Where per-task git worktrees are created. Must live outside any project repo |
| `CALANDRIA_PROJECTS_DIR` | `~/projects` | Where **Clone from GitHub** puts cloned repos |
| `CALANDRIA_BACKUP_DIR` | `<CALANDRIA_DB_DIR>/backups` | Where `npm run backup` writes its archives. Read by [`scripts/backup.mjs`](../scripts/backup.mjs), not by the app; point it at a different volume than the one being backed up. See **Backup & restore** below |
| `CALANDRIA_SERVICE_PORT_BASE` | `4300` | Base of the deterministic per-project port block. Each project is assigned `base + slot` at creation, injected as `PORT` into its supervised services and PTY |
| `CALANDRIA_SERVICE_LOG_LINES` | `1500` | Per-service in-memory log ring buffer (lines) kept for the Services drawer |
| `CALANDRIA_SERVICE_HOSTS` | *(off)* | Set `1` to serve each service on a public hostname `<slug>--<appHost>` with per-service visibility (private / shared link / public). Separate opt-in from the services feature itself; also needs `PUBLIC_BASE_URL` + wildcard DNS/TLS |
| `CALANDRIA_FEATURE_SERVICES` | `1` (on) | The managed-services feature (Services drawer, supervisor, persisted registry with boot auto-restart + orphan reaping). Set `0` to disable |
| `CLAUDE_CLI_PATH` | `~/.local/bin/claude` | Path to the logged-in `claude` CLI (pinned because Next's server may run with a trimmed `PATH`). On Windows: `%USERPROFILE%\.local\bin\claude.exe`, then `PATH` — point it at a real `.exe`, not an npm `.cmd` shim |
| `CALANDRIA_GH_BIN` | *(auto-resolve)* | Path to the GitHub CLI (`gh`). Empty = bare `gh` if the server's `PATH` resolves it, else a probe of the usual install dirs (linuxbrew/Homebrew, `/usr/local/bin`, snap, `~/.local/bin`; on Windows winget Links, `%ProgramFiles%\GitHub CLI`, scoop shims). The server never reads a shell profile, so a gh that works in your terminal can be invisible here — set this if the probe misses yours |

Example — relocate an instance entirely via env:

```bash
PORT=8080 PTY_PORT=8081 \
PUBLIC_BASE_URL=https://calandria.example.com \
CALANDRIA_DB_DIR=/data/calandria \
CALANDRIA_WORKTREES_DIR=/data/worktrees \
CLAUDE_CLI_PATH=/usr/local/bin/claude \
npm start
```

### Upgrading from the pre-rename default paths

`CALANDRIA_DB_DIR` and `CALANDRIA_WORKTREES_DIR` used to default to `~/.zen-orchestrator`
and `~/.agent-orchestrator/worktrees`. Nothing is ever moved automatically — relocating a
live instance's database behind its back is indistinguishable, from your side, from losing
every project and task, and a worktree is registered by *absolute path* in its parent repo's
`.git/worktrees/<id>/gitdir`, so relocating the directory needs a `git worktree repair` run
inside every affected project repo, not a file move. So the resolver falls back instead:
with `CALANDRIA_DB_DIR` unset, if `~/.calandria` holds no database but
`~/.zen-orchestrator/orchestrator.db` exists, the old path keeps being used, and boot prints
one hint line naming it and where to move it. Inside an explicit `CALANDRIA_DB_DIR`,
`calandria.db` is preferred and an existing `orchestrator.db` there is the fallback —
resolution never leaves a directory you named. The check is against the database *file*,
not the directory, so a container entrypoint pre-creating an empty `~/.calandria` can never
strand existing data. Worktrees follow their own, simpler rule: a populated legacy
`~/.agent-orchestrator/worktrees` is kept as-is, and only an empty one is abandoned in
favor of the new default.

To migrate on your own schedule:

```bash
# Move a pre-rename install to the new default location. Stop the app first —
# copying a live SQLite database mid-write gives you a corrupt one.
mkdir -p ~/.calandria
mv ~/.zen-orchestrator/orchestrator.db     ~/.calandria/calandria.db
mv ~/.zen-orchestrator/orchestrator.db-wal ~/.calandria/calandria.db-wal 2>/dev/null || true
mv ~/.zen-orchestrator/orchestrator.db-shm ~/.calandria/calandria.db-shm 2>/dev/null || true
# The boot lock is a pure mutex holding no data — delete it rather than move it.
rm -f ~/.zen-orchestrator/orchestrator.lock.*
# Anything else the app keeps beside the database (API keys, VAPID keys, uploads):
mv ~/.zen-orchestrator/* ~/.calandria/ 2>/dev/null || true
# Then start the app. The boot hint line stops printing once nothing legacy is left.
```

The `-wal`/`-shm` files must move *together* with the database, or be checkpointed away
first — a stale `-wal` left behind next to a moved `.db` loses the most recent writes. Note
what this recipe deliberately leaves out: the per-task **worktrees** aren't part of it —
either leave `CALANDRIA_WORKTREES_DIR` pointing at the old directory, or relocate it
yourself and run `git worktree repair <new-path>/<task-id>` inside each affected project
repo.

## Backup & restore

`npm run backup` ([`scripts/backup.mjs`](../scripts/backup.mjs)) takes a **hot** backup —
run it with the app up, no downtime, no drain. The DB half is not a file copy, and that is
the whole point of the script.

### Never `cp` a live database

`calandria.db` is in WAL mode, so recent transactions live in `calandria.db-wal` until a
checkpoint folds them back. Copying the `.db` on its own gives you a file that opens fine,
has a schema, has *most* of your data, and is silently missing exactly the newest work;
copying the pair while the app is mid-write can tear it outright. The script instead runs
`VACUUM INTO`, which reads the live database inside one read transaction and writes a
self-contained, already-checkpointed copy — so a turn committing mid-backup lands wholly
inside the snapshot or wholly after it, and the result has no `-wal`/`-shm` sidecars to
forget to move. It then re-opens the snapshot and runs `PRAGMA integrity_check` before
calling the backup a backup. (`tests/backup.test.ts` pins this against a naive copy of the
same moment.)

The connection is **read-only and takes no application lock**: the single-instance boot
mutex is a separate `*.lock.db` file precisely so an out-of-band reader can work while the
app owns the database. A backup can never stop the app from booting.

### What state lives where

| What | Where | In the backup |
|-|-|-|
| Projects, tasks, transcripts, summaries, usage, schedules, runbooks, permission rules | `<CALANDRIA_DB_DIR>/calandria.db` (+ `-wal`/`-shm`) | `db/` — one snapshot, no sidecars |
| Chat attachments | `<CALANDRIA_DB_DIR>/uploads/<taskId>` | `db-dir/` |
| Web Push signing key | `<CALANDRIA_DB_DIR>/vapid.json` | `db-dir/` |
| A persisted API key (only if you used the wizard's key path) | `<CALANDRIA_DB_DIR>/anthropic-api-key`, `openai-api-key` | `db-dir/` |
| Boot mutex | `<CALANDRIA_DB_DIR>/*.lock.db`, `*.lock.json` | **excluded** — a pure lock holding no data; restoring one restores a stale claim |
| Agent CLI logins | `~/.claude.json`, `~/.claude/.credentials.json`, `~/.claude/settings.json`, `~/.codex/auth.json`, `~/.codex/config.toml` | `agent-login/home/…` (`--no-logins` to skip) |
| Per-task git worktrees | `CALANDRIA_WORKTREES_DIR` (default `~/.calandria/worktrees`) | **opt-in** (`--worktrees`) |
| Cloned project repos | `CALANDRIA_PROJECTS_DIR` (default `~/projects`) | **opt-in** (`--projects`) |
| Your own repos | wherever you told the project they are | never — they're yours |

`db-dir/` is captured by *exclusion* (everything in the DB dir that isn't a SQLite file, the
lock pair, the backup directory itself, or a nested worktrees dir), so something added
beside the database in a later version is picked up without anyone editing a list.

The last two rows are opt-in because they are reconstructible and they are the two that turn
a nightly backup into a disk problem: a worktree is a checkout of a branch that already lives
in the project repo, and a clone is a clone. What you actually lose by skipping them is a
task's **uncommitted** working-tree edits; committed work is on the task branch in the repo.

**Docker vs local.** In the container everything above is one named volume mounted at
`/home/calandria` — database, worktrees, project clones and both CLI logins together, which
is what makes the cold-copy option below a real option. Running locally, the same state is
spread across your `$HOME` (`~/.calandria`, `~/projects`, `~/.claude`, `~/.codex`) and only
the env vars say where; the manifest records the resolved paths for that reason.

Note the database **file name is resolved, not assumed**: a fresh install writes
`calandria.db`, an install that predates the rename keeps `orchestrator.db` where it is and
is never migrated ([above](#upgrading-from-the-pre-rename-default-paths)). The script asks
`lib/storage.mjs` the same question the app asks at boot, so it backs up the database your
instance is actually using, under its real name.

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

The archive is a single `.tar.gz` holding `manifest.json`, `db/`, `db-dir/` and (unless
skipped) `agent-login/`. The manifest records the format version, the app version, the
resolved source paths, the snapshot's SHA-256 and `user_version`, and row counts — enough
to tell two backups apart and to reconcile absolute paths on restore. On a 37 MB database
with the app running, the whole run took **1.2 s** and produced an 8.5 MB archive.

**It contains credentials.** The file is written `0600` on POSIX. On Windows a POSIX mode is
a no-op, so it inherits the ACL of the directory it lands in — put it somewhere private.

Nightly, with your own retention (there is no built-in pruning of old archives):

```cron
17 4 * * *  cd /opt/calandria && /usr/bin/npm run backup -- --quiet --out /mnt/backups >/dev/null
27 4 * * *  find /mnt/backups -name 'calandria-backup-*.tar.gz' -mtime +14 -delete
```

### Cold backup (the alternative)

If you'd rather not reason about any of the above: stop the container and copy the volume.
The app is down, nothing is mid-write, and a plain copy is correct — including the WAL,
because it comes along with everything else.

```bash
docker compose -p calandria-alice stop
docker run --rm -v orch-u-alice-home:/from -v /mnt/backups:/to alpine \
  tar -czf /to/calandria-volume-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /from .
docker compose -p calandria-alice start
```

That captures worktrees and project clones too, so it is much larger. It costs downtime,
which is why it isn't the default recipe — but it is the one to reach for when you want a
byte-for-byte image of the whole instance rather than its state.

### Restore

This procedure was run end to end — hot backup of a live instance (five projects, 156 tasks,
13k messages), restored into a scratch data directory, verification boot, contents checked
through the API — before it was written down.

1. **Stop the app.** A restore that races a running instance is the one thing the boot lock
   can't save you from, because you'd be replacing the file underneath it.

   ```bash
   docker compose -p calandria-alice stop     # or: systemctl stop calandria
   ```

2. **Unpack somewhere scratch**, and read the manifest before you overwrite anything —
   `contents.db` names the file, `source.*` says where it came from.

   ```bash
   mkdir -p /tmp/restore && tar -xzf calandria-backup-20260827T221316Z.tar.gz -C /tmp/restore
   cd /tmp/restore/calandria-backup-20260827T221316Z && cat manifest.json
   ```

3. **Put the database back.** Copy the snapshot to `<CALANDRIA_DB_DIR>` and make sure no
   stale sidecars survive beside it — the snapshot is self-contained, and an old `-wal` next
   to a new `.db` is the one way to lose data during a *successful* restore.

   ```bash
   DBDIR=~/.calandria                       # whatever CALANDRIA_DB_DIR resolves to
   rm -f "$DBDIR"/calandria.db-wal "$DBDIR"/calandria.db-shm
   cp db/calandria.db "$DBDIR"/calandria.db
   cp -a db-dir/.     "$DBDIR"/             # uploads, vapid.json, any API key
   ```

   Restoring a backup whose `contents.db` is `db/orchestrator.db` is the moment to leave the
   old name behind: copy it to `calandria.db` instead. Nothing but `lib/storage.mjs` cares
   about the name, and there is no other reference to fix up.

4. **Put the agent logins back** (skip if the target is already logged in):

   ```bash
   cp -a agent-login/home/. ~/
   ```

5. **Start the app and verify.** For a verification boot against a *copy*, point
   `CALANDRIA_DB_DIR` at the scratch directory and set `CALANDRIA_SCHEDULER=off` and
   `CALANDRIA_FEATURE_SERVICES=0` first — otherwise the restored instance cheerfully fires
   every schedule it thinks it missed and restarts every managed service it remembers.

   ```bash
   CALANDRIA_DB_DIR=/tmp/restore/data CALANDRIA_WORKTREES_DIR=/tmp/restore/worktrees \
   CALANDRIA_SCHEDULER=off CALANDRIA_FEATURE_SERVICES=0 PORT=4318 PTY_PORT=4319 npm start
   curl -s localhost:4318/api/projects | jq 'length'
   ```

Three things to expect from a restored instance, none of them a fault:

- **In-flight turns come back interrupted, not resumed.** The snapshot captures whatever was
  running at that instant (in the tested run: three tasks with `running=1`), and the first
  boot's crash recovery clears exactly that — running flags, queued follow-ups, unanswered
  permission cards, in-flight schedule runs. Ask those tasks to continue; the transcript and
  the session lineage are intact.
- **Absolute paths come back verbatim.** `projects.repo_path` and `tasks.worktree_path` are
  absolute. Restoring onto the same layout (the container case, where everything is under
  `/home/calandria`) needs nothing. Restoring onto a *different* layout means editing
  `projects.repo_path` to point at the repos' new home; task worktrees self-heal, since every
  launch path re-cuts a missing one.
- **Worktrees you didn't archive are gone, and that's recoverable.** A task whose checkout is
  missing gets a fresh one cut from its branch on the next turn. Uncommitted edits that were
  sitting in the old worktree are not in the backup — which is the argument for `--worktrees`
  if you run tasks that idle for days with work in progress.

## Metrics

`GET /api/instance/metrics` serves [Prometheus text exposition][promfmt] — a handful of
series, hand-rolled rather than pulled from a client library, covering the two questions a
running instance can't otherwise answer from outside: *is it doing work, and is it eating
the disk?* It is always on.

[promfmt]: https://prometheus.io/docs/instrumenting/exposition_formats/

Auth is the same read-only service-token exemption `/api/version` and `/api/instance/usage`
take. In no-login local mode a loopback scrape needs nothing; under Cloudflare Access a
scraper has no JWT, so it presents `SERVICE_TOKEN` — or `CALANDRIA_FLEET_TOKEN`, which is
the point of that token, one secret for a dashboard polling every box.

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
| `calandria_process_start_time_seconds` | gauge | When this process booted. The counters below reset here — graph it alongside them |
| `calandria_turns_started_total` | counter | Agent turns started |
| `calandria_turns_finished_total{outcome}` | counter | Turns that ended, by outcome: `ok`, `failed`, `stopped` (a human pressed Stop), `interrupted` (the agent session never opened, so the turn produced nothing) |
| `calandria_turns_active` | gauge | Turns running right now, read from the in-process registry rather than from `tasks.running` — the only source that is right after a crash |
| `calandria_db_size_bytes{file}` | gauge | `calandria.db` and its `wal` / `shm` sidecars, separately |
| `calandria_worktrees_size_bytes` | gauge | Everything under `CALANDRIA_WORKTREES_DIR` |
| `calandria_schedule_runs{status}` | gauge | Rows in the schedule run ledger by status (`succeeded`, `failed`, `missed`, `skipped_overlap`, `claimed`, `running`, `stopped`, `interrupted`) |

Two of those have a sharp edge worth knowing before you write an alert on them.

**The turn counters are per-process.** They live in memory and reset when the app restarts,
which is what a Prometheus counter means and what `rate()` handles — but a raw
`calandria_turns_started_total` panel will sawtooth on every deploy. Graph rates, not
totals, and keep `calandria_process_start_time_seconds` on the same board.

**`calandria_schedule_runs` is a gauge, not a counter.** The ledger is capped per schedule,
so these numbers *fall* as old runs age out. It answers "is anything stuck or failing right
now", not "how many runs have ever failed". Read as a counter, a prune looks like a
negative rate.

Every label a metric can take is emitted on every scrape, including the ones sitting at
zero, so an alert on `{outcome="failed"}` has data to be false about before the first
failure. The one series that can be *absent* is `calandria_worktrees_size_bytes`, and only
until the first successful measurement — a disk gauge that read `0` after every restart
would resolve a firing alert without a byte having been reclaimed.

### Scraping it

```yaml
# prometheus.yml — a collector running on the same host, local mode.
# Nothing to authenticate: loopback is already an allowed origin.
scrape_configs:
  - job_name: calandria
    metrics_path: /api/instance/metrics
    static_configs:
      - targets: ["127.0.0.1:3000"]
```

That is the deployment to reach for first. Scraping a box behind Access means getting
`x-service-token` onto the request, which Prometheus 2.49+ can do directly:

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

On an older Prometheus, put a proxy in front that injects the header — the token is a
plain shared secret, so any of the usual mechanisms work.

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

Everything on the endpoint is free to compute except the worktrees measurement, which is a
`du` over every task checkout on the box. It is cached for
`CALANDRIA_METRICS_SIZE_TTL_MS` (default **60000**, one minute) so a 15s scrape interval
doesn't walk every `node_modules` on the instance four times a minute; raise it if you
carry many large worktrees. A scrape never *waits* on that walk beyond the first one after
a restart — later scrapes serve the last measurement while a new one runs.


## Notes & caveats

- **Permissions:** tasks default to Claude Code's **auto** mode, where a
  model classifier approves the calls it judges safe and escalates the rest. Switch a
  task — or the app default in Settings → Run defaults — to **bypassPermissions**
  for work that must never block on a prompt, or down to
  **acceptEdits**, **default** or **plan** (the pickers use each agent's own mode
  names — a Codex task offers its **workspace-write** / **read-only** sandboxes
  instead). Anything the
  agent isn't pre-approved for parks on a permission card in the transcript, with
  Allow once / Always allow / Decline. Read-only tools pass silently; "Always
  allow" remembers a command for that one project and is revocable in
  Settings → Run defaults → Remembered approvals — which also takes a rule typed
  in ahead of time, through the same Bash-only, prefix-checked policy, so an
  unattended task doesn't have to trip a card you'll never see. A prompt nobody answers denies
  itself (`CALANDRIA_PERMISSION_UNATTENDED_MS` when no tab is open,
  `CALANDRIA_PERMISSION_PROMPT_TIMEOUT_MS` when one is), so an auto-started task can't
  wedge a turn overnight. Calandria is a control layer, not a sandbox — the
  isolated worktree is still the real boundary.
- **One process per database:** Calandria is single-process by design — turns run detached
  and owned by the server, and boot opens by clearing what a crash left behind (running
  flags, queued follow-ups, unanswered permission cards, in-flight schedule runs). Point a
  second process at the same `calandria.db` and that recovery pass runs against a *live*
  instance. So the app takes a lock on the database at boot and **refuses to start** if
  another process holds it, naming the holder's pid and host; crash recovery only ever runs
  for the process that owns the database. The lock is a kernel file lock on a separate
  `calandria.lock.db`, so a killed instance releases it immediately and the next boot
  takes over with no waiting — and a read-only `sqlite3 calandria.db` inspection is
  unaffected, since the real database is never exclusively locked. The lock file is named
  after the database it guards, so a pre-rename `orchestrator.db` is still guarded by
  `orchestrator.lock.db` — that pairing is what keeps mutual exclusion working across an
  upgrade from an older build. Two instances need two `CALANDRIA_DB_DIR`s.
  `CALANDRIA_DB_LOCK=off` disables the check; it is unsupported.
  One limit worth stating: the lock coordinates processes that share a kernel. Two
  *containers* mounting one volume may not see each other's locks (a sandboxed runtime like
  gVisor need not share a lock table), but that configuration is already unsafe — SQLite's
  WAL mode itself requires shared memory between its users. One instance, one volume.
- **Parallel quota:** every concurrent task spends your rate limit — N tasks ≈ N× the
  token rate against one subscription.
- **Terminal:** the `node-pty` sidecar stays bound to `127.0.0.1` only — the browser
  reaches it through the app origin at `/pty`, so remote access goes through your one
  tunneled hostname. `postinstall` restores the exec bit npm can strip off node-pty's
  prebuilt helper.
- **Keep `ANTHROPIC_API_KEY` unset** unless you deliberately chose the wizard's API-key
  path — set, it takes precedence and bills per-use instead of using your subscription.
- **A stored API key is locked to the account that runs the app.** The wizard's
  "I have an API key instead" path writes the key to `anthropic-api-key` /
  `openai-api-key` beside the database, never to the settings table (which the browser
  reads wholesale). On Linux and macOS that file is mode `0600`. **On Windows a POSIX
  mode is a no-op** — Node's `chmod` only toggles the read-only attribute on NTFS — so
  the file is restricted with an ACL instead: `icacls <file> /inheritance:r /grant:r
  <you>:(R,W)`, which drops the permissions inherited from your profile directory and
  replaces the whole list, leaving your account alone with the key. If that call fails
  (no `icacls`, an unresolvable account name, a filesystem with no ACLs such as FAT32 or
  a mapped network drive) **the key is deleted and the save returns an error** rather
  than leaving a credential at permissions nobody checked. The fallback in that case is
  the environment: start the app with `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` set and
  `CALANDRIA_ALLOW_API_KEY_ENV=1`, and nothing is written to disk. The **VAPID private
  key** (`vapid.json`, which signs your Web Push notifications) is written the same way
  but **fails open**: you never pasted it in — the app mints it on first use with nobody
  in the loop — so a failed ACL logs a warning and keeps the key rather than taking push
  notifications out of the instance entirely. Set `VAPID_PRIVATE_KEY` to keep it off
  disk. Note the limit on every platform — a local administrator (or root) can take
  ownership regardless; this protects the key from *other* users of the machine, not
  from its owner.
- **Retention:** the database is not append-only forever. A sweep rides the schedule
  ticker (same process — Calandria never starts a second daemon) and ages out the record
  of tasks that are **finished**: terminal (`done`/`cancelled`), idle, not snoozed, with
  no queued follow-up and no in-flight scheduled run behind them. A live task is never
  touched, however old. Two windows, both in days:
  `CALANDRIA_RETENTION_DAYS` (default **180**) covers a finished task's own record —
  transcript, diff/document review comments, the sessions a `/clear` retired, and its
  uploaded attachments — and `CALANDRIA_USAGE_RETENTION_DAYS` (default **400**) covers
  the spend rows (`task_usage`, `task_merges`, `internal_usage`). The second is longer on
  purpose: those feed the Insights dashboard, which reads 180 days back and asks for the
  same width again to compute prior-period deltas, so a shorter window would carve a hole
  in a chart you are looking at. Two things a sweep changes that are worth knowing before
  you shorten either: an aged-out task shows an **empty transcript** (it stays resumable —
  the session it would resume into is the one row deliberately kept — but the record of
  what it did is gone, bar its `/clear` summaries, which are never pruned), and its
  all-time cost reads **$0.00** rather than a smaller wrong number. Set
  `CALANDRIA_RETENTION=off` to keep everything forever; set either window to `0` to keep
  just that half. Cadence is `CALANDRIA_RETENTION_SWEEP_MS` (default 6h), and the first
  sweep runs on the tick after boot, so an instance that is only up for part of the day
  still gets one. Anything deleted is named in one server log line.
- **Reclaiming the disk:** a sweep that deleted anything follows with
  `PRAGMA wal_checkpoint(TRUNCATE)`. That matters more than it sounds: in WAL mode the
  deletes themselves land in `calandria.db-wal`, which *grows* to hold them, so without a
  checkpoint a big prune makes the on-disk footprint go up before it comes down. What a
  checkpoint cannot do is shrink `calandria.db` itself — freed pages go on the freelist
  and get reused by later writes rather than returned to the filesystem, so the file
  plateaus instead of falling. Only `VACUUM` shrinks it, by rewriting the whole database
  under a write lock, which is seconds on a small database and a visible stall on a large
  one. So it is opt-in: `CALANDRIA_RETENTION_VACUUM=1` runs one after any sweep that
  deleted rows, or run `VACUUM;` yourself against a stopped instance.
- **Worktrees are the bigger disk story**, and they have their own switch. Every task
  runs in its own git worktree — a full checkout of the project repo *each*, under
  `CALANDRIA_WORKTREES_DIR` — so this is the one number measured in gigabytes rather
  than rows. Two things happen here, and the second is on by default while the first
  is not.
  **The sweep** (`CALANDRIA_WORKTREE_RETENTION=on`, off by default) rides the same
  ticker and reclaims the checkouts of tasks that are finished and cold, on a shorter
  window: `CALANDRIA_WORKTREE_RETENTION_DAYS`, default **14** (`0` keeps them forever).
  It reuses the retention predicate above verbatim — terminal, idle, not snoozed,
  nothing queued behind it — and adds the check the manual cleanup uses: a worktree
  with **uncommitted edits or commits the base branch has not absorbed is skipped**,
  however old, and named in the log rather than quietly passed over. It never deletes
  a branch, so a reclaimed task keeps its diff and re-cuts its checkout on the next
  turn. It is opt-in because the table windows above (180/400 days) are longer than
  most instances have existed, whereas a window in weeks would start removing
  checkouts on the first tick after an upgrade nobody asked for. The manual path
  (Settings → Storage, which can also *discard* unmerged work after you acknowledge
  it) is unaffected either way.
  **The disk warning** runs whether or not the sweep does: when the worktrees
  directory crosses `CALANDRIA_WORKTREES_DISK_WARN_GB` (default **20**, `0` disables)
  a line goes to the server log each pass while it is over, the reading is served on
  `GET /api/instance/scheduler` under `worktrees`, and Settings → Storage shows it
  above the reclaim list. (The same directory is also a `/metrics` gauge —
  `calandria_worktrees_size_bytes` — if you would rather alert on it than read a log;
  see [Metrics](#metrics).) That total counts the checkouts of tasks still in flight,
  which nothing here will touch — so on a busy instance the honest reading is "you
  have 40 GB of worktrees, 6 GB of it reclaimable", and the remaining 34 GB is
  answered by finishing or deleting tasks, not by a sweep.
- **Delete is hard delete:** a removed project's chat history is gone (your code on disk
  is untouched).
