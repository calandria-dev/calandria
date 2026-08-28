# Windows

Calandria runs on Windows two ways, both supported:

- **Natively** — Windows 10 1809+ / Server 2019+, Git for Windows on `PATH`, Node 22+.
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
that `better-sqlite3` loaded the **prebuilt** win32 binary shipped in its npm package
rather than compiling one with the runner's MSVC — a node-gyp path is a failure for every
user who doesn't have Visual Studio build tools, so it fails the job rather than being
treated as a neutral substitute.

That assertion used to be bounded by the Node it ran on, and it is not any more — which is
worth recording, because a real desktop found the limit first. Every lane takes its Node
from `.nvmrc` (22), so the old check could only prove a prebuild existed **for the Node this
repo pins**, never for whatever a user installed. On Node 26 from `nodejs.org` there was no
`better-sqlite3` binary for that ABI, npm fell silently through to node-gyp, and it died in
MSVC (see [the troubleshooting entry](TROUBLESHOOTING.md#native-windows)). Widening the CI
matrix to every live Node line would not have been cheap — each is another full Windows
install and suite run — and it is no longer the answer.

`better-sqlite3` 13 is N-API. It ships one binary per platform triple *inside the npm
package*, resolved at require time with no ABI to match, no download, and `gypfile: false`
plus no `install` script, so there is no fallback left to be silent about. What CI now
proves therefore generalizes past its own Node: that the package still bundles a win32-x64
binary and that it loads. The residual risk moved with it — not "does a prebuild exist for
this ABI" but "did better-sqlite3 drop this platform triple", which one Node version tests
as well as five. The floor is enforced from the other end: `engine-strict=true` in `.npmrc`
means a Node below the declared range is refused with one `EBADENGINE` line instead of a
compiler wall.

That paragraph describes `npm install`, and it did not hold for `npm ci` — which is what CI,
the Docker builder and anyone cloning the repo actually run. The gap turned both Windows lanes
red and is worth recording, because the fix lives in a file nobody reads and npm undoes it on
its own.

A lockfile entry carries only a subset of a package's manifest, and `gypfile` is not among the
fields npm copies into it. `npm ci` builds its tree from the lockfile rather than from the real
manifests, so it read `gypfile` as unset instead of `false`, found the `binding.gyp` that is
still in the published tarball, and synthesized the default `node-gyp rebuild` for a package
that ships prebuilt binaries and asks for no such thing (`#addToBuildSet` in
`@npmcli/arborist/lib/arborist/rebuild.js`, which tests `gypfile !== false && !install &&
!preinstall && isNodeGypPackage(path)`). `npm install` has the manifest and skips it. Measured
on every npm from 10.9.3 through 12.0.2 — the current release — so there is no version to
upgrade to; what a Windows *user* is told to run is `npm install` throughout
([installation](INSTALLATION.md#native-windows)), which is why this never reached them.

What it cost differed by platform, and the quiet half is the reason it survived so long.
On Windows `node-gyp rebuild` died at `gyp ERR! find VS` and `npm ci` exited non-zero; the
runner's own MSVC did not rescue it, because node-gyp 11.5.0 does not recognise the Visual
Studio 18 the current `windows-latest` image ships. On Linux and macOS it was silent:
better-sqlite3's `binding.gyp` compiles nothing without `force_build`, so the run left a
half-finished `build/` (a `config.gypi`, an empty `obj.target`, no linked `.node`) and exited
0, because require-time resolution falls back to the bundled prebuild regardless. Nothing was
broken there — it was an undeclared toolchain requirement waiting for the first machine
without a compiler.

The fix is one hand-written `"gypfile": false` on the `node_modules/better-sqlite3` entry in
`package-lock.json`, which repairs every `npm ci` at once rather than the eleven places one is
invoked across the workflows, the Dockerfile and the container test harness. Its cost is that
npm deletes the field again every time it rewrites the lockfile — an `npm install`, a
dependency bump, a Dependabot PR — so `tests/lockfileGypfile.test.ts` asserts it is still
there, and sweeps `node_modules` for any other installed package with the same shape (a
`binding.gyp`, `gypfile: false` in its own manifest, no install script) whose lock entry does
not repeat it. If that test goes red, re-add the field by hand and commit it with the lockfile
change that dropped it.

A second `windows-latest` job runs the **end-to-end suite** — the same Playwright specs the
Ubuntu lane runs, gated by the same expression rather than a schedule of its own, so it
fires on main, on manual dispatch, and on a pull request carrying the `e2e` label. Its own
job rather than three more steps in the first one: a full `next build` plus a browser
download would serialize the two fast checks behind it on every push. This is the only job
that *boots* Calandria on Windows — `npm start` there is `scripts/start.mjs`, which ties
`server.js` and the pty sidecar together where there is no process group to kill — so the
shipped launcher is now executed in CI rather than only read.

A separate workflow, `.github/workflows/node-current.yml`, installs on the latest Node **Current**
rather than `.nvmrc`'s 22, on `ubuntu-24.04` and `windows-latest`, and does nothing else:
`npm ci`, then load `better-sqlite3` and open a database, then open a real pty with `node-pty`,
then assert that nothing in the tree compiled a native addon that shouldn't have. The failure
mode it watches for is the install itself, so there is no suite to run. Ubuntu is the leg that
matters most, which inverts the framing the rest of this page has: Windows is where
`better-sqlite3` blew up, but it is also where both native dependencies ship bundled binaries
and neither compiles — `node-pty` bundles no linux prebuild at all, so on Linux it builds from
source against the running Node's headers on every install, and that compile succeeding on a
Node released last week is the thing nothing else here would notice breaking. It runs weekly
and on manual dispatch, never on push, because `current` moves with no commit in this repo and
a Node release must not turn unrelated pull requests red; for the same reason it is
deliberately not a required check.

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
- **Service hostnames** (`<slug>--<host>`) need the same wildcard DNS story as on any
  platform; `localhost` subdomains don't resolve without a `hosts` entry.

## Still owed a real machine

CI covers typecheck, the unit suite and the e2e suite — 1462 tests and 92 specs, on a real
Windows runner, green. What is left is the shutdown path, and all three lanes structurally
miss it. `child.kill()` is a `TerminateProcess` on Windows, so no stub can observe *which*
signal a process was sent, and `tests/startLauncher.test.ts` skips its SIGINT case there for
exactly that reason; the e2e lane really does boot `scripts/start.mjs`, but Playwright tears
its `webServer` down with a process-tree kill, so that lane proves the launcher **starts**
both processes and nothing about whether either drains. Five minutes on a Windows box would
settle both:

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
