# Managed services

Calandria can supervise a project's development, setup, and test processes. Services belong
to the server—not an agent turn or browser tab—so they continue running after a turn ends
and their state and logs are available when you reconnect.

## Configure a project

Open the project's context editor and set its `dev`, `setup`, or `test` commands. The
Services drawer can then start, stop, and restart them and display live logs.

Each project receives a stable port derived from `CALANDRIA_SERVICE_PORT_BASE`. Calandria injects
that value as `PORT` into managed services and the project's terminal. A service that was
running is restarted when Calandria boots.

If Calandria previously stopped unexpectedly, startup checks for and reaps the orphaned
process tree before relaunching the service — on Linux and macOS by signalling the
process group, on Windows with `taskkill /T /F`. In both cases the reaper first confirms
the recorded process still carries that service's command line, so a recycled PID is never
killed. Port conflicts with unmanaged processes are shown as readable errors rather than
crash loops. Log retention is bounded by `CALANDRIA_SERVICE_LOG_LINES` (1,500 lines by
default).

Managed services are enabled by default. Set `CALANDRIA_FEATURE_SERVICES=0` to remove the
feature.

## Windows command syntax

Service commands run through the platform's own shell: `sh -c` on Linux and macOS,
`cmd.exe /d /s /c` on Windows. **On Windows a `dev`, `setup`, or `test` command is a
`cmd.exe` command line**, not a POSIX one. `&&` chains, `npm run dev`, and plain paths work
the same; these do not:

- environment prefixes — `FOO=bar npm run dev` is a `cmd.exe` syntax error. Use
  `set FOO=bar && npm run dev`.
- `$VAR` — expansion is `%VAR%`.
- single quotes — `cmd.exe` only understands double quotes; `'…'` is passed through
  literally.
- `~` — use `%USERPROFILE%`.

To keep one command portable across platforms, put it in a script the project already has
(`npm run dev`) or invoke the shell you want explicitly, for example
`pwsh -NoProfile -Command "…"` or `bash -lc "…"` with Git Bash installed. Calandria does not
rewrite the command or substitute a shell for you: it runs exactly what the project
configured, so what you test in a terminal on that machine is what the service runs.

## Framework host checks

When public service hostnames are enabled, frameworks that validate hostnames must allow
the value Calandria supplies in `CALANDRIA_PUBLIC_HOST`:

- Vite: `server.allowedHosts: [process.env.CALANDRIA_PUBLIC_HOST]`
- Next.js development server: `allowedDevOrigins: [process.env.CALANDRIA_PUBLIC_HOST]`
- Create React App / webpack-dev-server is configured through the injected environment.

`ORCH_PUBLIC_HOST` is also still injected into every managed service indefinitely, so an
existing config referencing the old name keeps working unchanged.

## Public URLs are opt-in

Running a managed service does not expose it publicly. Public service hostnames require all
of the following:

1. `CALANDRIA_SERVICE_HOSTS=1`;
2. a configured `PUBLIC_BASE_URL`; and
3. wildcard DNS and TLS for `*--<calandria-host>`.

Each exposed service can then be **private** (your session), **shared** (tokenized link), or
**public**. The hostname is stable: `<project-slug>--<calandria-host>`.

Calandria provides a terminal and unattended coding agents. Put authentication in front of
any internet-facing instance and read the [self-hosting security guidance](SELF_HOSTING.md).

All service-related environment variables and defaults are documented in
[`.env.example`](../.env.example).
