# Managed services

Calandria can supervise a project's development, setup, and test processes. Services belong
to the server—not an agent turn or browser tab—so they continue running after a turn ends
and their state and logs are available when you reconnect.

## Configure a project

Open the project's context editor and set its `dev`, `setup`, or `test` commands. The
Services drawer can then start, stop, and restart them and display live logs.

Each project receives a stable port derived from `ORCH_SERVICE_PORT_BASE`. Calandria injects
that value as `PORT` into managed services and the project's terminal. A service that was
running is restarted when Calandria boots.

If Calandria previously stopped unexpectedly, startup checks for and reaps the orphaned
process group before relaunching the service. Port conflicts with unmanaged processes are
shown as readable errors rather than crash loops. Log retention is bounded by
`ORCH_SERVICE_LOG_LINES` (1,500 lines by default).

Managed services are enabled by default. Set `ORCH_FEATURE_SERVICES=0` to remove the
feature.

## Framework host checks

When public service hostnames are enabled, frameworks that validate hostnames must allow
the value Calandria supplies in `ORCH_PUBLIC_HOST`:

- Vite: `server.allowedHosts: [process.env.ORCH_PUBLIC_HOST]`
- Next.js development server: `allowedDevOrigins: [process.env.ORCH_PUBLIC_HOST]`
- Create React App / webpack-dev-server is configured through the injected environment.

## Public URLs are opt-in

Running a managed service does not expose it publicly. Public service hostnames require all
of the following:

1. `ORCH_SERVICE_HOSTS=1`;
2. a configured `PUBLIC_BASE_URL`; and
3. wildcard DNS and TLS for `*--<operator-host>`.

Each exposed service can then be **private** (your session), **shared** (tokenized link), or
**public**. The hostname is stable: `<project-slug>--<operator-host>`.

One thing switches routing back off with all three in place: `ORCH_CONTROL_PLANE=1` vetoes it,
because a box running as a fleet's control plane must not serve user services off its own
hostname. It is unset on a normal instance — but if your services keep their
`http://localhost:<port>` URLs and the three requirements above look right, check it.

Calandria provides a terminal and unattended coding agents. Put authentication in front of
any internet-facing instance and read the [self-hosting security guidance](SELF_HOSTING.md).

## Idle instances

Running services are reported by the idle endpoint but do not prevent an instance from
sleeping. Their desired state is persisted, so they resume on boot at the same URL. An
external supervisor can choose a stricter keep-warm policy if desired.

All service-related environment variables and defaults are documented in
[`.env.example`](../.env.example).
