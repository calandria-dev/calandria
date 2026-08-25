# Self-hosting

Everything about running your own instance: Docker, tunnels, auth, and configuration.
The [README](../README.md) has the two-command version; this is the rest. Something already
broken? See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for first-incident runbooks (DB
corruption, disk fill, headless re-auth, boot failures).

## Docker

The [`Dockerfile`](../Dockerfile) builds a single-user image: a **production** Next.js
build (a stopped container starts in seconds) bundling Node 22, git, and the `claude`
CLI, with [`docker/entrypoint.sh`](../docker/entrypoint.sh) running both processes (app
server + pty sidecar) under tini. All state lives under `/home/orch` — one named volume
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

The first release, `v0.2.0`, was cut on 2026-08-25, so `latest`,
`<version>` and `<major>.<minor>` all exist and point at it — as `0.2.0` and
`0.2`, with no `v`.

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

| You want | Set `ORCH_IMAGE` to |
|-|-|
| A specific release, never changes | `ghcr.io/calandria-dev/calandria:X.Y.Z` |
| The newest patch on a minor line, moves forward within it | `ghcr.io/calandria-dev/calandria:X.Y` |
| Whatever the newest release is, moves on every release | `ghcr.io/calandria-dev/calandria:latest` |
| Nightly builds of `main`, ahead of any release, least stable | `ghcr.io/calandria-dev/calandria:edge` |

`X.Y.Z` is the only one of these that never changes under you — `X.Y` and `latest` are
both moving targets by design (see the tag table above). Pin `X.Y.Z` for anything you
don't want to babysit; use `latest` only if you're fine re-reading the changelog after
every unattended upgrade.

**Rollback** is re-pinning: set `ORCH_IMAGE` back to the previous `X.Y.Z` and
`docker compose pull && up -d --no-build` again. There's no separate rollback mechanism —
every past release tag stays pullable indefinitely, so "roll back" and "pin an older
version" are the same operation.

### Running it

[`docker-compose.yml`](../docker-compose.yml) is the parameterized runner. It builds from
this checkout by default; set `ORCH_IMAGE` to run the published image instead.

```bash
export ORCH_USER=alice ORCH_PORT=10001 ORCH_RUNTIME=runc

# A) build from this checkout (the default)
docker build -t calandria .
docker compose -p orch-alice up -d

# B) or run the published image, nothing to build. :latest is the newest
# release; pin :0.2.0 (no leading v) to hold one; :edge is nightly main.
# See "Pinning a version" above.
export ORCH_IMAGE=ghcr.io/calandria-dev/calandria:latest
docker compose -p orch-alice pull
docker compose -p orch-alice up -d --no-build

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
`ORCH_ALLOWED_ORIGINS`. This remains a single-user mode, not authentication — never expose
it raw to the internet.

The one Access-mode exception is `SERVICE_TOKEN`: a shared secret letting health probes
read the documented service-token routes without an Access JWT
(`x-service-token` header).

It is optional in the sense that nothing *requires* you to choose a value, but in Access
mode something has to present one — it is also how the three callers that live inside the
box authenticate, none of which has an Access JWT: the image's `HEALTHCHECK`, the boot
restore of managed services, and the stdio MCP bridge the non-Claude agents' tool calls go
through. So [`docker/entrypoint.sh`](../docker/entrypoint.sh) mints a per-boot token into
`/tmp/orch-service-token` when `CF_ACCESS_*` is set and you supplied none; the
`HEALTHCHECK` reads env-or-file (a healthcheck runs as a separate exec with the *image's*
environment, so the file is the only way a generated token reaches it). Supply your own
when a monitor outside the container needs to poll. Running bare Node behind Access with
no token, `server.js` warns loudly at startup instead.

`ORCH_FLEET_TOKEN` is a second, optional secret for the same two read-only routes,
shared fleet-wide so one dashboard can poll many boxes without learning each one's private
`SERVICE_TOKEN`. It is deliberately **not** accepted on the mutating internal agent-tool
endpoints. Unset — the default — it grants nothing.

## Configuration

Every per-instance value is an env var with a documented default — one env set fully
relocates an instance (fresh container, different user, different ports) with **zero
code edits**. [`.env.example`](../.env.example) is the same list in copyable form.
Export the variables in the environment that launches `npm run dev` / `npm start` —
`server.js` and `pty-server.js` are plain Node and read them before Next boots, so a
`.env` file alone doesn't cover `PORT`/`ORCH_HOSTNAME`/`PTY_*`.

| Variable | Default | What it does |
|-|-|-|
| `PORT` | `3000` | Port of the single public origin (Next.js + `/pty` proxy) |
| `ORCH_HOSTNAME` | `127.0.0.1` | Bind address of the app server. Loopback by default: a local instance is unauthenticated and hands out a shell, and the origin gate is a header check that a LAN client can forge past, so only the bind closes that. Widen it only behind `CF_ACCESS_*`. Bare `HOSTNAME` is deliberately **not** read — shells and container runtimes inject it. The image sets `ORCH_HOSTNAME=0.0.0.0`, correct inside a container whose port is published on the host's loopback |
| `PTY_PORT` | `3001` | Port of the node-pty terminal sidecar |
| `PTY_HOST` | `127.0.0.1` | Bind address of the sidecar **and** the proxy's upstream. Keep it on loopback — the browser never connects directly; `server.js` proxies `/pty` to it |
| `PUBLIC_BASE_URL` | *(empty)* | The origin users reach the app on (e.g. `https://orch.example.com` behind a tunnel). The client builds its `ws(s)://` terminal URL from it; empty = the browser's own origin, correct for any single-hostname deployment, Access mode included. Set it if your proxy rewrites the `Host` header, which would make the origin gate's `Origin`-vs-`Host` comparison disagree |
| `ORCH_ALLOWED_ORIGINS` | *(empty)* | Exact comma-separated `http(s)` origins additionally allowed in no-login local mode, for intentional LAN/reverse-proxy access. Loopback origins and `PUBLIC_BASE_URL` are already accepted. This is not a substitute for authentication |
| `VAPID_SUBJECT` | *(derived)* | Contact for the browsers' push services (Web Push VAPID subject): a `mailto:` or `https:` URL. Defaults to `PUBLIC_BASE_URL` when that is https, else `mailto:admin@localhost`. **iOS push needs a real one** — Apple rejects `localhost` with `403 BadJwtToken`; set your https origin or a real `mailto:` |
| `VAPID_PRIVATE_KEY` | *(minted)* | Base64url raw P-256 scalar signing every push. Empty = minted on first use and kept at `<ORCH_DB_DIR>/vapid.json`; subscriptions are bound to it, so back it up with the database |
| `ORCH_PTY_ALLOW_REMOTE` | *(off)* | Set `1` to let the pty sidecar accept off-machine peers. It otherwise requires a loopback peer, since `server.js` proxies to it from the same host — an address check the caller cannot forge, unlike a header. Only for a deliberately split deployment; anything reaching the sidecar gets a shell |
| `CF_ACCESS_TEAM_DOMAIN` | *(empty)* | Cloudflare Zero Trust team domain (e.g. `your-team.cloudflareaccess.com`); see above |
| `CF_ACCESS_AUD` | *(empty)* | The Access application's `aud` tag the JWT must carry (comma-separable) |
| `SERVICE_TOKEN` | *(empty)* | Shared secret for the health/version/usage routes **and** for the in-container callers (health probe, service restore, agent-tool bridge); see above. The image mints a per-boot one under Access if you leave it empty |
| `ORCH_FLEET_TOKEN` | *(empty)* | Optional fleet-wide **read** token, accepted on the same two read-only routes so one dashboard can poll many instances with one secret. Never accepted on the mutating internal endpoints. Unset = no such bypass |
| `ORCH_DB_DIR` | `~/.zen-orchestrator` | Directory holding `orchestrator.db` (SQLite app data). Absolute path; created on first run |
| `ORCH_DB_LOCK` | `on` | The single-instance boot lock. `off` lets a second process start against a database another one already owns — unsupported, and the exact corruption the lock exists to prevent; see **One process per database** below |
| `ORCH_DB_LOCK_WAIT_MS` | `10000` | How long boot retries the lock before giving up. Covers a predecessor that is still shutting down; a crashed one releases instantly |
| `ORCH_WORKTREES_DIR` | `~/.agent-orchestrator/worktrees` | Where per-task git worktrees are created. Must live outside any project repo |
| `ORCH_PROJECTS_DIR` | `~/projects` | Where **Clone from GitHub** puts cloned repos |
| `ORCH_SERVICE_PORT_BASE` | `4300` | Base of the deterministic per-project port block. Each project is assigned `base + slot` at creation, injected as `PORT` into its supervised services and PTY |
| `ORCH_SERVICE_LOG_LINES` | `1500` | Per-service in-memory log ring buffer (lines) kept for the Services drawer |
| `ORCH_SERVICE_HOSTS` | *(off)* | Set `1` to serve each service on a public hostname `<slug>--<appHost>` with per-service visibility (private / shared link / public). Separate opt-in from the services feature itself; also needs `PUBLIC_BASE_URL` + wildcard DNS/TLS |
| `ORCH_FEATURE_SERVICES` | `1` (on) | The managed-services feature (Services drawer, supervisor, persisted registry with boot auto-restart + orphan reaping). Set `0` to disable |
| `CLAUDE_CLI_PATH` | `~/.local/bin/claude` | Path to the logged-in `claude` CLI (pinned because Next's server may run with a trimmed `PATH`) |
| `ORCH_GH_BIN` | *(auto-resolve)* | Path to the GitHub CLI (`gh`). Empty = bare `gh` if the server's `PATH` resolves it, else a probe of the usual install dirs (linuxbrew/Homebrew, `/usr/local/bin`, snap, `~/.local/bin`). The server never reads a shell profile, so a gh that works in your terminal can be invisible here — set this if the probe misses yours |

Example — relocate an instance entirely via env:

```bash
PORT=8080 PTY_PORT=8081 \
PUBLIC_BASE_URL=https://orch.example.com \
ORCH_DB_DIR=/data/orchestrator \
ORCH_WORKTREES_DIR=/data/worktrees \
CLAUDE_CLI_PATH=/usr/local/bin/claude \
npm start
```

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
  itself (`ORCH_PERMISSION_UNATTENDED_MS` when no tab is open,
  `ORCH_PERMISSION_PROMPT_TIMEOUT_MS` when one is), so an auto-started task can't
  wedge a turn overnight. Calandria is a control layer, not a sandbox — the
  isolated worktree is still the real boundary.
- **One process per database:** Calandria is single-process by design — turns run detached
  and owned by the server, and boot opens by clearing what a crash left behind (running
  flags, queued follow-ups, unanswered permission cards, in-flight schedule runs). Point a
  second process at the same `orchestrator.db` and that recovery pass runs against a *live*
  instance. So the app takes a lock on the database at boot and **refuses to start** if
  another process holds it, naming the holder's pid and host; crash recovery only ever runs
  for the process that owns the database. The lock is a kernel file lock on a separate
  `orchestrator.lock.db`, so a killed instance releases it immediately and the next boot
  takes over with no waiting — and a read-only `sqlite3 orchestrator.db` inspection is
  unaffected, since the real database is never exclusively locked. Two instances need two
  `ORCH_DB_DIR`s. `ORCH_DB_LOCK=off` disables the check; it is unsupported.
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
- **Delete is hard delete:** a removed project's chat history is gone (your code on disk
  is untouched).
