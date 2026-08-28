# Windows

Calandria runs on Windows two ways, both supported:

- **Natively** — Windows 10 1809+ / Server 2019+, Git for Windows on `PATH`, Node 20.9+.
- **Under WSL2** — the ordinary Linux build, unchanged.

Setup for both is in [Installation → Windows](INSTALLATION.md#windows). Failure modes
are in [Troubleshooting → Native Windows](TROUBLESHOOTING.md#native-windows) and
[→ WSL2 on Windows](TROUBLESHOOTING.md#wsl2-on-windows). This page is the status of the
port itself: what each platform difference resolved to in the code, what CI proves, and
what is still owed a real machine.

Which to pick: native if Windows is where your repos, editor and agent logins already
live. WSL2 if they live in Linux, or if you want the platform every other Calandria
instance runs on. Neither is a fallback for the other.

## What CI proves

`.github/workflows/test.yml` has a `windows-latest` job running `npm run typecheck` and
`npm test` on every push and pull request, alongside the Ubuntu lanes. It also asserts
that `better-sqlite3` installed from its **prebuilt** win32 binary rather than compiling
with the runner's MSVC — a node-gyp fallback would pass green here while failing for
every user who doesn't have Visual Studio build tools, so it fails the job instead.

A second `windows-latest` job runs the **end-to-end suite** — the same Playwright specs the
Ubuntu lane runs, gated by the same expression rather than a schedule of its own, so it
fires on main, on manual dispatch, and on a pull request carrying the `e2e` label. Its own
job rather than three more steps in the first one: a full `next build` plus a browser
download would serialize the two fast checks behind it on every push. This is the only job
that *boots* Calandria on Windows — `npm start` there is `scripts/start.mjs`, which ties
`server.js` and the pty sidecar together where there is no process group to kill — so the
shipped launcher is now executed in CI rather than only read.

The unit lane earned its place on its first run. Everything below had been written,
reviewed and merged as portable, with the Ubuntu suite green throughout; 83 of 135 test
files failed the first time it actually ran on Windows. Two were product bugs in the
document-collaboration file route — `worktreeRelative()` read a drive-letter path as *relative*, so a file plainly
inside the worktree 404'd and the containment check never ran, and the route's own
malformed-path test (`rel.startsWith("/")`) reported an absolute Windows path as an
ordinary missing file rather than a bad request. One was the refusal message that names the
worktree blocking a rebase, quoting git's `C:/Users/...` while every other path the app
shows is `C:\Users\...`. The rest were the suite's own: a teardown that deleted the temp
root with the SQLite handle still open (EBUSY, 79 files), a runner `%TEMP%` in 8.3 short
form that `fs.realpathSync` doesn't expand, and three assertions that pinned a POSIX
spelling rather than a behaviour. None of it was visible from Linux.

A third `windows-latest` job runs the **desktop shell's** suite — the Electron
wrapper in `desktop/`, under the same gate again. It is hosted rather than run on a
homelab VM for a reason worth stating: a hosted Windows runner has a real window
station, so Electron opens a genuine window on it and the job needs no display server
installed at all, which is the one thing the Ubuntu desktop lane cannot say (it runs
under `xvfb`). The lane exists because this is where the shell's behaviour actually
diverges — `child.kill()` is a `TerminateProcess`, so a quit has no signal to carry a
graceful shutdown, and the node sidecars are in no job object, so a `taskkill` without
`/T` orphans them. `supervisor.stop()` answers the first by POSTing
`/api/instance/drain` over loopback before it kills anything, which works identically on
every platform; `desktop/e2e/05-windows-quit.spec.ts` pins the `taskkill` half. What none
of it covers is a real shutdown or logout: Electron emits neither `before-quit` nor
`will-quit` for `WM_QUERYENDSESSION`, and no test here claims otherwise.

The e2e lane found nothing on its first run: 92 specs, green on the first attempt, in 2.7
minutes. That is worth recording because it is the exact opposite of what the unit lane
did, and for a traceable reason — the portability work the unit lane forced had already
reached every file the e2e suite leans on. `e2e/env.ts` resolves its temp root through
`fs.realpathSync.native` and strips the `\\?\` prefix; the fixture helpers and the mock
driver shell out through `execFileSync` with an argv array rather than a shell string;
`worktreeRelative()` was fixed for the drive-letter case `15-collab-doc.spec.ts` asserts
on. The suite was portable before anything ran it.

## Where each platform difference lives

Every row is code that behaves differently on `win32`. Nothing here is a Windows-only
module: each takes the platform as an input so the POSIX suite pins both branches.

| Difference | Where it resolved |
|-|-|
| `NODE_ENV=…` prefixes and bare `.sh` invocations in npm scripts | `cross-env`, and `bash scripts/docker-test.sh` for the `*:docker` scripts (which additionally need Git Bash on `PATH` and Docker Desktop in Linux-container mode) |
| `$SHELL` is a POSIX convention; the old `/bin/zsh` fallback exists nowhere on Windows | `CALANDRIA_PTY_SHELL`, then `$SHELL`, then a probed default: `pwsh.exe`/`powershell.exe` on `PATH`, else `%COMSPEC%` (`pty-server.js`) |
| `CreateProcess` finds `.exe` but never npm's `.cmd` shim | `lib/binPath.ts` — `PATHEXT`-aware lookup plus `cmd.exe` wrapping for shims, used by `codex` (`lib/agents/codex/bin.ts`) and `gh`. `claude` is the exception: `CLAUDE_CLI_PATH` defaults to a real `claude.exe` under `%USERPROFILE%\.local\bin` because the Agent SDK and node-pty spawn it directly and can't route a batch shim |
| No process groups; `detached` means "new console"; no `ps` | `lib/processTree.ts` — `taskkill /pid <pid> /T /F` for the tree, `tasklist` for liveness, a `Win32_Process` CommandLine lookup for the recycled-pid guard, and `detached` requested only where groups exist. A `dev_command` is a `cmd.exe` command line ([SERVICES.md](SERVICES.md#windows-command-syntax)) |
| NTFS is case-insensitive, so `realpathSync` output can't be compared with `===` | `lib/paths.ts` — one `samePath()`/`canonicalPath()` pair, case-folded on win32. This was the correctness bug of the set: a false "not linked" is what authorized an `rmSync` of a live worktree |
| `MAX_PATH`, and files that can't be deleted while a handle is open | `-c core.longpaths=true` on the app's own git calls; retrying teardown for `EBUSY`/`EPERM`/`ENOTEMPTY`. The global `core.longpaths` setting and the "close the terminal holding it" case are the user's to know — both are in Troubleshooting |
| `chmod 0o600` is a no-op on NTFS | `lib/secretFile.ts` — `icacls /inheritance:r /grant:r`, pinned to `%SystemRoot%\System32\icacls.exe`. Fatal for the API keys (a credential at permissions we couldn't set is worse than none), a warning for the VAPID key (the app mints it with no user in the loop) |
| `du` doesn't exist | an `fs` walk on win32 (`lib/git.ts`) |
| There is no deliverable `SIGTERM`, and `concurrently` kills its children with `taskkill /T /F` | `scripts/start.mjs` — a dependency-free launcher for `npm start` that ties the two entrypoints' lifetimes together without force-killing, so a console Ctrl+C reaches the shutdown drain |
| POSIX spellings and semantics in the suite | `tests/platform.ts` — `IS_WIN`, `onPosix`, `NULL_DEVICE`, `TEST_SHELL`, `DETACHED`, `killChildTree`, on one rule: a POSIX construct a test merely *uses* gets a portable spelling; a test *about* POSIX semantics is skipped on win32 rather than translated into something that pins nothing |
| SQLite's single-process mutex | **no change needed** — `BEGIN IMMEDIATE`'s RESERVED lock is a `LockFileEx` byte-range lock on Windows, released by the OS on process death, including `TerminateProcess` (`lib/db-lock.mjs`) |

## Known limits

- **`npm run dev` still force-kills on Ctrl+C.** It runs under `concurrently`, whose win32
  kill path is an unconditional `taskkill /T /F` with the requested signal discarded — so
  the drain loses that race and in-flight turns are terminated rather than settled. A
  deliberate trade: `concurrently`'s per-process prefixes are worth more in development,
  where a lost turn is cheap. `npm start` is the one that drains.
- **Only Ctrl+C in the console reaches the drain.** `taskkill /F`, Task Manager and
  closing the console window are all `TerminateProcess`. Running under a service wrapper
  (NSSM, WinSW, `sc`) is only as graceful as the wrapper's configured shutdown method, and
  is not supported without pinning that method yourself. See
  [Troubleshooting](TROUBLESHOOTING.md#native-windows).
- **Codex's native Windows sandbox** (restricted tokens, dedicated sandbox users) has a
  heavier first-run setup than Landlock or Seatbelt and may want elevation Calandria never
  prompts for. `sandboxMode` maps through the SDK either way.
- **The desktop shell wraps the native server only, never one inside WSL2.** Both server
  configurations stay supported; the Electron wrapper in `desktop/` is not a way to run
  the WSL2 one. A WSL2 user runs `npm start` in the distro and opens
  `http://127.0.0.1:3000` in a Windows browser, which WSL2's localhost forwarding makes
  work unchanged — verified, including the `/pty` WebSocket upgrade, on arbitrary ports.
  Reasons the shell does not cross the boundary are in
  [DESKTOP_APP.md](DESKTOP_APP.md#5-per-platform-gaps) §5. Note the rule that outlives
  the shell question: `CALANDRIA_DB_DIR` and `CALANDRIA_WORKTREES_DIR` must live on the
  distro's ext4, never under `/mnt/c` — that is 9p, and SQLite WAL over it corrupts.
- **The desktop shell does not drain on a Windows shutdown or logout.** Quit and window
  close both do (`supervisor.stop()` POSTs `/api/instance/drain` and waits before it
  kills — verified on real hardware, teardown in 384ms with no orphaned sidecars), but
  Electron emits neither `before-quit` nor `will-quit` for `WM_QUERYENDSESSION`, so a
  session ending underneath the app drains nothing. No `session-end` listener exists yet.
- **Service hostnames** (`<slug>--<host>`) need the same wildcard DNS story as on any
  platform; `localhost` subdomains don't resolve without a `hosts` entry.

## Still owed a real machine

CI covers typecheck, the unit suite, the e2e suite and the desktop shell's suite — on a
real Windows runner, green. The **desktop shell** half has since been run on an actual
Windows 11 box as well (§5 of [DESKTOP_APP.md](DESKTOP_APP.md#5-per-platform-gaps) records
what it did, including the quit drain, the terminal panel and the WSL2 decision), so what
is left here is the CONSOLE shutdown path, and all four lanes structurally miss it. `child.kill()` is a `TerminateProcess` on Windows, so no stub can observe *which*
signal a process was sent, and `tests/startLauncher.test.ts` skips its SIGINT case there for
exactly that reason; the e2e lane really does boot `scripts/start.mjs`, but Playwright tears
its `webServer` down with a process-tree kill, so that lane proves the launcher **starts**
both processes and nothing about whether either drains. (The desktop lane covers the
shell's own quit paths — `app.quit()` and `taskkill` — but that is a different process
tree with a different killer; it says nothing about a console Ctrl+C, and neither covers
a real shutdown or logout.) Five minutes on a Windows box would settle both:

1. Under `npm start`, begin a long turn, press Ctrl+C, and confirm the transcript carries
   the interrupted-state notice rather than the next boot's crash recovery clearing a raw
   running flag.
2. Confirm `cmd.exe`'s `Terminate batch job (Y/N)?` prompt on npm's `.cmd` shim doesn't
   truncate that wait. It appears *after* the console event has been broadcast, so the
   drain should already be running — but that is the one interaction between the shim and
   this design that reading source cannot settle.

## History

This file began as a compatibility assessment (research spike, 2026-08-24) enumerating
fifteen findings, sized and ordered into three phases, with WSL2 recommended as the
interim answer. All of it shipped; the findings and their reasoning now live in the code
they became, in the commits that made each change, and in the earlier revisions of this
file.
