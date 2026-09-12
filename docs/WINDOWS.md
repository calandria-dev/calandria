---
title: "Windows"
---

# Windows

Calandria runs on Windows two ways, and both are supported:

- **Natively**: Windows 10 1809+ or Server 2019+, with Git for Windows on `PATH` and Node 22.12+.
- **Under WSL2**: the ordinary Linux build, unchanged.

Setup for both is in [Installation → Windows](INSTALLATION.md#windows). Failure modes are in
[Troubleshooting → Native Windows](TROUBLESHOOTING.md#native-windows) and
[Troubleshooting → WSL2 on Windows](TROUBLESHOOTING.md#wsl2-on-windows). This page covers what CI
verifies, the concrete platform differences, and Windows-specific limits to plan around.

Pick native if your repos, editor, and agent logins already live on Windows. Pick WSL2 if they
live in Linux, or if you want the platform every other Calandria instance runs on.

## What CI proves

Every push and pull request runs a dedicated job on a `windows-latest` runner: `npm run typecheck`
and `npm test`, alongside the Linux checks. This is the job that catches a POSIX-only path
spelling, a `/bin/sh` assumption, or a process-group kill before it reaches a Windows user, since
every other always-on check runs on Ubuntu.

A native Windows install needs no C++ build tools. `better-sqlite3` and `node-pty` both ship
prebuilt Windows binaries. Push CI asserts the bundled `win32-x64` build of `better-sqlite3` loads
with no compile step. [Installation → Native Windows](INSTALLATION.md#native-windows) has you
install with `npm install`, not `npm ci`: `npm ci` builds its dependency tree from
`package-lock.json` alone, and the lockfile has to keep `better-sqlite3`'s `"gypfile": false`
entry intact or npm tries to compile it anyway, which fails without Visual Studio build tools. A
Node version below the required range (22+) fails immediately with one `EBADENGINE` line instead
of a confusing compile error later (`.npmrc` sets `engine-strict=true`). A separate weekly job,
manual-dispatch only and not a required check, installs on the newest available Node release to
confirm both `better-sqlite3` and `node-pty` still ship a matching prebuilt.

Two more Windows jobs run only on a push to `main`, a manual workflow run, or a pull request
labeled `e2e`. Neither runs on every PR, since both are slow:

- The end-to-end Playwright suite is the only Windows job that boots the shipped launcher
  (`npm start`, which runs `scripts/start.mjs`) instead of only type-checking or unit-testing
  around it.
- The desktop shell's suite builds the NSIS installer (`npm run dist:win`), installs it silently
  (`/S`) as a per-user install needing no UAC prompt, and checks it end to end: the install lands
  at `%LOCALAPPDATA%\Programs\Calandria`, the payload files are present, both the Start Menu and
  desktop shortcuts exist, and the uninstaller removes all of it again. Building the payload runs
  `npm ci` wrapped in `cmd.exe`, since a plain `npm.cmd` fails under Node's CVE-2024-27980 patch.

CI can't observe one thing about that installer: Windows SmartScreen only warns on a file a
browser actually downloaded, and a file CI builds and runs itself was never downloaded. See
[Known limits](#known-limits) below for what that means when you distribute a build.

## Platform behavior

Concrete differences between running Calandria on Windows and on Linux/macOS:

- **npm scripts.** `NODE_ENV=…` prefixes work through `cross-env`. The `*:docker` scripts run
  through `bash scripts/docker-test.sh`, so they need Git Bash on `PATH` and Docker Desktop set to
  Linux containers.
- **Terminal shell.** The terminal drawer resolves its shell from `CALANDRIA_PTY_SHELL`, then
  `$SHELL`, then a platform default. `$SHELL` is a POSIX convention and is usually unset on
  Windows, so the Windows default is `pwsh.exe` or `powershell.exe` if one is on `PATH`, else
  `%COMSPEC%` (normally `cmd.exe`).
- **CLI binaries with npm `.cmd` shims.** `codex` and `gh` are wrapped in `cmd.exe` to spawn, since
  Windows can't run a batch file directly. `claude` is the exception: the Agent SDK spawns it
  directly with no wrapper available, so it needs a real `.exe`. `CLAUDE_CLI_PATH` controls this
  and defaults to `%USERPROFILE%\.local\bin\claude.exe`.
- **Killing a process tree.** Windows has no process groups and no graceful signal a whole tree can
  receive, so Calandria kills a managed service with `taskkill /pid <pid> /T /F`. That is always a
  hard kill, with no SIGTERM-then-SIGKILL escalation like on POSIX. Liveness checks use `tasklist`,
  and a stored PID is checked against that process's own command line before it's treated as still
  running, so a PID Windows recycled for an unrelated process is never mistaken for the original
  one. A managed service's `dev`, `setup`, or `test` command is a Windows command line, run
  through `cmd.exe`; see
  [Services → Windows command syntax](SERVICES.md#windows-command-syntax) for the syntax
  differences.
- **Case-insensitive paths.** NTFS doesn't distinguish path case. Calandria accounts for this when
  comparing worktree paths, so a case difference alone never reads as "different directory."
  Treating one as a different directory would let a live worktree be wrongly deleted as unlinked.
- **Long paths.** Calandria's own git calls set `core.longpaths=true`. If your checkout still hits
  `MAX_PATH`, set that globally too. See
  [Troubleshooting → Native Windows](TROUBLESHOOTING.md#native-windows). Deleting a worktree
  retries `EBUSY`, `EPERM`, and `ENOTEMPTY` for about 1.5 seconds before giving up, since another
  process (antivirus, search indexing) can hold a file handle briefly after git releases it.
- **File permissions.** `chmod` is a no-op on NTFS, so Calandria locks down secret files (API keys,
  the VAPID key) with `icacls /inheritance:r /grant:r` instead, always invoked by its absolute path
  (`%SystemRoot%\System32\icacls.exe`) and never resolved through `PATH`, since an earlier
  writable directory on `PATH` could hijack an unqualified `icacls`. A failure to set permissions
  is fatal for an API key and a warning for the VAPID key.
- **Disk usage.** There's no `du` on Windows; Calandria walks the directory tree itself to report
  worktree disk usage.
- **Line endings.** A native Windows binary's stdout is CRLF-terminated. If you pipe or parse
  output from something Calandria spawns on Windows, expect `\r\n`. Git for Windows itself is
  unaffected. Its pipes stay LF on every platform. The repo's `.gitattributes` normalizes every
  tracked file to LF in the index and in every working tree; without it, what lands in a Windows
  checkout would depend on that machine's own `core.autocrlf` setting.
- **SQLite locking.** No special handling needed: Windows' own file-locking primitive plays the
  same role POSIX file locking does elsewhere, and is released by the OS even if the process is
  killed outright.

## Known limits

- **`npm run dev` still force-kills on Ctrl+C.** It runs under `concurrently`, and on Windows
  `concurrently`'s kill path is an unconditional `taskkill /T /F` that discards whatever signal
  was requested, so an in-flight turn gets terminated instead of drained. Use `npm start` when you
  need a graceful shutdown.
- **Only Ctrl+C in the console reaches the graceful drain.** `npm start` forwards a console
  Ctrl+C/Ctrl+Break to the graceful shutdown instead of force-killing. `taskkill /F`, Task
  Manager, and closing the console window all terminate the process outright and skip the drain.
  If you started `npm start` through npm's own `.cmd` wrapper and see cmd.exe's
  `Terminate batch job (Y/N)?` prompt after Ctrl+C, the drain has already begun; wait for it to
  finish, or answer `Y`. Running under a service wrapper (NSSM, WinSW, `sc`) is only as graceful
  as the wrapper's own configured shutdown method, which you have to set up yourself. See
  [Troubleshooting → Native Windows](TROUBLESHOOTING.md#native-windows).
- **Codex's native Windows sandbox** (restricted tokens, dedicated sandbox users) has a heavier
  first-run setup than the Linux/macOS sandboxes and may need elevation Calandria never prompts
  for.
- **The desktop shell wraps the native Windows server only, never a server running inside WSL2.**
  Both server setups stay supported; you just can't point the Electron app at a WSL2 instance. To
  use Calandria from WSL2, run `npm start` inside the distro and open `http://127.0.0.1:3000` in a
  Windows browser. WSL2's localhost forwarding makes this work unchanged, including the
  terminal's WebSocket connection, on any port. See
  [DESKTOP_APP.md → Known limitations](DESKTOP_APP.md#known-limitations) for why the shell
  itself doesn't cross the boundary. One rule holds regardless of the shell question:
  `CALANDRIA_DB_DIR` and `CALANDRIA_WORKTREES_DIR` must live on the WSL2 distro's own filesystem,
  never under `/mnt/c`. That path is 9p, and SQLite's WAL mode corrupts over it.
- **The desktop shell doesn't drain on a Windows shutdown or logout.** Quit and closing the window
  both drain gracefully first, then kill. A system shutdown or logout doesn't: Electron gets no
  `before-quit`/`will-quit` event for that case on Windows, so a session ending underneath the app
  drains nothing.
- **SmartScreen can still warn on a signed download.** Release builds after 2026-09-10 are
  signed, v0.11.0 and earlier are not, and a build you make yourself never is. Where the warning
  appears it reads *"Windows protected your PC"*, with **More info → Run anyway** as the way past
  it; the zip doesn't avoid it either, since Explorer copies the download mark onto whatever it
  extracts. The difference signing makes is that the warning now fades: SmartScreen accrues
  reputation per publisher identity and downloads of a signed build count toward it, where an
  unsigned one re-triggered the warning on every release forever. See
  [desktop/README.md → What signing costs](../desktop/README.md#what-signing-costs).
- **Service hostnames** (`<slug>--<host>`) need the same wildcard DNS as on any platform;
  `localhost` subdomains won't resolve without a `hosts` entry.
