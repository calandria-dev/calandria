---
title: "Windows"
---

# Windows

Calandria runs on Windows two ways, both supported:

- **Natively**: Windows 10 1809+ / Server 2019+, Git for Windows on `PATH`, Node 22+.
- **Under WSL2**: the ordinary Linux build, unchanged.

Setup for both is in [Installation → Windows](INSTALLATION.md#windows). Failure modes are in
[Troubleshooting → Native Windows](TROUBLESHOOTING.md#native-windows) and
[→ WSL2 on Windows](TROUBLESHOOTING.md#wsl2-on-windows). This page covers the port's status:
where each platform difference resolved to in the code, what CI proves, and what's still
owed a real machine.

Pick native if your repos, editor and agent logins already live on Windows. Pick WSL2 if
they live in Linux, or if you want the platform every other Calandria instance runs on.

## What CI proves

`.github/workflows/test.yml` has a `windows-latest` job running `npm run typecheck` and
`npm test` on every push and pull request, alongside the Ubuntu lanes. It also asserts that
`better-sqlite3` loaded the **prebuilt** win32 binary shipped in its npm package rather than
compiling one with the runner's MSVC. A node-gyp path fails for every user without Visual
Studio build tools, so the job fails on it rather than treating it as a neutral substitute.

That assertion used to be bounded by the Node it ran on: every lane takes its Node from
`.nvmrc` (22), so the old check could only prove a prebuild existed for the Node this repo
pins, not for whatever a user installed. A real desktop found the gap: on Node 26 from
nodejs.org there was no `better-sqlite3` binary for that ABI, npm fell silently through to
node-gyp, and the build died in MSVC (see
[the troubleshooting entry](TROUBLESHOOTING.md#native-windows)). Widening the CI matrix to
every live Node line isn't the fix; each line means another full Windows install and suite
run.

`better-sqlite3` 13 is N-API: one binary per platform triple, bundled in the npm package,
resolved at require time with no ABI to match and no download, `gypfile: false`, no
`install` script. Nothing is left to fail silently. What CI proves now generalizes past its
own Node: the package still bundles a win32-x64 binary and it loads. The residual risk is
whether `better-sqlite3` drops that platform triple, which one Node version tests as well as
five. `engine-strict=true` in `.npmrc` handles the Node floor: a Node below the declared range
is refused with one `EBADENGINE` line instead of a compiler wall.

That paragraph describes `npm install`, and it did not hold for `npm ci`, which is what CI,
the Docker builder and anyone cloning the repo actually run. The gap turned both Windows lanes
red. It is worth recording, because the fix lives in a file nobody reads and npm undoes it on
its own.

A lockfile entry carries only a subset of a package's manifest fields, and `gypfile` is not one
of them. `npm ci` builds its tree from the lockfile rather than from the real manifests, so it
read `gypfile` as unset rather than `false`, found the `binding.gyp` still in the published
tarball, and ran the default `node-gyp rebuild` on a package that ships prebuilt binaries and
asks for no such thing (`#addToBuildSet` in `@npmcli/arborist/lib/arborist/rebuild.js`, which
tests `gypfile !== false && !install && !preinstall && isNodeGypPackage(path)`). `npm install`
has the real manifest and skips it. Measured on every npm from 10.9.3 through 12.0.2, the
current release, so there was no version to upgrade to. A Windows user is told to run
`npm install` throughout ([installation](INSTALLATION.md#native-windows)), which is why this
never reached them.

The cost differed by platform, and the quiet half is why it survived so long. On Windows
`node-gyp rebuild` died at `gyp ERR! find VS` and `npm ci` exited non-zero; the runner's own
MSVC did not rescue it, because node-gyp 11.5.0 does not recognise the Visual Studio 18 the
current `windows-latest` image ships. On Linux and macOS it was silent: better-sqlite3's
`binding.gyp` compiles nothing without `force_build`, so the run left a half-finished `build/`
(a `config.gypi`, an empty `obj.target`, no linked `.node`) and exited 0, because require-time
resolution falls back to the bundled prebuild regardless. Nothing was broken there. It was an
undeclared toolchain requirement waiting for the first machine without a compiler.

The fix is one hand-written `"gypfile": false` on the `node_modules/better-sqlite3` entry in
`package-lock.json`, which repairs every `npm ci` at once rather than the eleven places one is
invoked across the workflows, the Dockerfile and the container test harness. Its cost is that
npm deletes the field again every time it rewrites the lockfile: an `npm install`, a dependency
bump, a Dependabot PR. So `tests/lockfileGypfile.test.ts` asserts it is still there, and sweeps
`node_modules` for any other installed package with the same shape (a `binding.gyp`,
`gypfile: false` in its own manifest, no install script) whose lock entry does not repeat it.
If that test goes red, re-add the field by hand and commit it with the lockfile change that
dropped it.

A second `windows-latest` job runs the **end-to-end suite**, the same Playwright specs the
Ubuntu lane runs, gated by the same expression: it fires on main, on manual dispatch, and on
a pull request carrying the `e2e` label. It's a separate job because a full `next build` plus
a browser download would otherwise serialize behind the two fast checks on every push. This
is the only job that boots Calandria on Windows: `npm start` runs `scripts/start.mjs`, which
ties `server.js` and the pty sidecar together (there's no process group to kill), so the
shipped launcher runs in CI rather than only being read.

A separate workflow, `.github/workflows/node-current.yml`, installs on the latest Node
**Current** rather than `.nvmrc`'s 22, on `ubuntu-24.04` and `windows-latest`, and does
nothing else: `npm ci`, then load `better-sqlite3` and open a database, then open a real pty
with `node-pty`, then assert that nothing in the tree compiled a native addon that shouldn't
have. It watches for the install itself failing, so there is no suite to run. Ubuntu is the
leg that matters most, which inverts the framing of the rest of this page: Windows is where
`better-sqlite3` blew up, but it is also where both native dependencies ship bundled
binaries and neither compiles. `node-pty` bundles no Linux prebuild at all, so on Linux it
builds from source against the running Node's headers on every install, and that compile
succeeding on a Node released last week is what nothing else here would notice breaking. The
workflow runs weekly and on manual dispatch, never on push, because `current` moves with no
commit in this repo and a Node release must not turn unrelated pull requests red. For the
same reason it is not a required check.

The unit lane earned its place on its first run: 83 of 135 test files failed, despite
everything having been written, reviewed and merged as portable with the Ubuntu suite green
throughout. Two were product bugs in the document-collaboration file route:
`worktreeRelative()` read a drive-letter path as *relative*, so a file inside the worktree
404'd and the containment check never ran, and the malformed-path test
(`rel.startsWith("/")`) reported an absolute Windows path as a missing file rather than a bad
request. One was a refusal message naming the worktree blocking a rebase, quoting git's
`C:/Users/...` while every other path the app shows is `C:\Users\...`. The rest were suite
bugs: a teardown that deleted the temp root with the SQLite handle still open (EBUSY, 79
files), a runner `%TEMP%` in 8.3 short form that `fs.realpathSync` doesn't expand, and three
assertions that pinned a POSIX spelling rather than a behavior. None of it was visible from
Linux.

The lane's second find, months later, was the same shape and worth naming as a class:
**a native Windows binary writes its stdout in text mode, so every line it prints ends CRLF**
(issue #53). `tests/backup.test.ts` split `tar -tzf` output on `"\n"`, which left a `\r` on
each archive member, so no `toContain()` could match and the head of the list read as a
phantom `'\r'` entry — the archive's own root directory, reduced to a lone carriage return
that `filter(Boolean)` then kept because it is truthy. The lane was red for five pushes, and
because `publish-image.yml`'s release gate reads a run's overall conclusion rather than
filtering per job, no release could be cut while it was. Splitting on `/\r?\n/` is the fix,
and it lives in `tests/platform.ts` as `outputLines` so the next test to shell out inherits
it. The sweep that followed found the exposure is narrow: **only native binaries do this.**
Git for Windows is an MSYS build that keeps its pipes in binary mode, so the suite's many
`git log` / `git worktree list --porcelain` callers emit LF on every platform and were never
affected — they route through `outputLines` now for one convention rather than to fix a bug.
Everything else that splits on a newline in the suite reads an in-process string (Prometheus
exposition text, SSE frames, a tag-context block), a NUL-delimited `git ls-files -z`, or a
JSONL fixture whose `JSON.parse` treats a trailing `\r` as whitespace.

That last clause raised the sibling question, and it has a different answer. A `\r` can also
arrive from **disk** rather than from a pipe, and the repo had no `.gitattributes` at all, so
what landed in a Windows working tree was decided by that machine's `core.autocrlf` — a
per-machine setting the repo can't see and CI doesn't share. Nothing was broken: the JSONL
fixtures tolerate the CR for the reason above, and `tests/naming.test.ts` walks every tracked
file but carries no `$`-anchored pattern. The exposure was the *next* test — a snapshot, an
anchored regex, a fixture compared byte-for-byte — which would pass for whoever wrote it and
fail only on Windows, and only for the subset of Windows developers with conversion on. So the
repo now pins `* text=auto eol=lf`. It cost nothing to land: `git ls-files --eol` reported
`i/lf` for all 596 text files beforehand, so `git add --renormalize .` staged zero changes and
no in-flight branch inherited a whole-tree conflict. `text=auto` rather than a bare `text` is
the load-bearing half — it leaves git's content detection in place, so the 27 tracked PNGs,
WEBPs and WOFF2s stay `-text` and are never converted. `tests/gitattributes.test.ts` pins all
three facts, the last of them (nothing committed CRLF) independently of the mechanism that
produces it.

The e2e lane found nothing on its first run: 92 specs, green, in 2.7 minutes. The portability
work the unit lane forced had already reached every file the e2e suite leans on: `e2e/env.ts`
resolves its temp root through `fs.realpathSync.native` and strips the `\\?\` prefix, the
fixture helpers and mock driver shell out through `execFileSync` with an argv array rather
than a shell string, and `worktreeRelative()` was already fixed for the drive-letter case
`15-collab-doc.spec.ts` asserts on.

## Where each platform difference lives

Every row is code that behaves differently on `win32`. Each takes the platform as an input
rather than living in a Windows-only module, so the POSIX suite pins both branches.

| Difference | Where it resolved |
|-|-|
| `NODE_ENV=…` prefixes and bare `.sh` invocations in npm scripts | `cross-env`, and `bash scripts/docker-test.sh` for the `*:docker` scripts (which also need Git Bash on `PATH` and Docker Desktop in Linux-container mode) |
| `$SHELL` is a POSIX convention; the old `/bin/zsh` fallback doesn't exist on Windows | `CALANDRIA_PTY_SHELL`, then `$SHELL`, then a probed default: `pwsh.exe`/`powershell.exe` on `PATH`, else `%COMSPEC%` (`pty-server.js`) |
| `CreateProcess` finds `.exe` but never npm's `.cmd` shim | `lib/binPath.ts`, a `PATHEXT`-aware lookup plus `cmd.exe` wrapping for shims, used by `codex` (`lib/agents/codex/bin.ts`) and `gh`. `claude` is the exception: `CLAUDE_CLI_PATH` defaults to a real `claude.exe` under `%USERPROFILE%\.local\bin`, because the Agent SDK and node-pty spawn it directly and can't route a batch shim |
| No process groups; `detached` means "new console"; no `ps` | `lib/processTree.ts`: `taskkill /pid <pid> /T /F` for the tree, `tasklist` for liveness, a `Win32_Process` CommandLine lookup for the recycled-pid guard, and `detached` requested only where groups exist. A `dev_command` is a `cmd.exe` command line ([SERVICES.md](SERVICES.md#windows-command-syntax)) |
| NTFS is case-insensitive, so `realpathSync` output can't be compared with `===` | `lib/paths.ts`, one `samePath()`/`canonicalPath()` pair, case-folded on win32. This was the correctness bug of the set: a false "not linked" authorized an `rmSync` of a live worktree |
| `MAX_PATH`, and files that can't be deleted while a handle is open | `-c core.longpaths=true` on the app's own git calls; teardown retries `EBUSY`/`EPERM`/`ENOTEMPTY`. The global `core.longpaths` setting and closing a terminal holding a file open are covered in Troubleshooting |
| `chmod 0o600` is a no-op on NTFS | `lib/secretFile.ts`: `icacls /inheritance:r /grant:r`, pinned to `%SystemRoot%\System32\icacls.exe`. Fatal for API keys (a credential at permissions we couldn't set is worse than none), a warning for the VAPID key (the app mints it with no user in the loop) |
| `du` doesn't exist | an `fs` walk on win32 (`lib/git.ts`) |
| No deliverable `SIGTERM`, and `concurrently` kills its children with `taskkill /T /F` | `scripts/start.mjs`, a dependency-free launcher for `npm start` that ties the two entrypoints' lifetimes together without force-killing, so a console Ctrl+C reaches the shutdown drain |
| POSIX spellings and semantics in the suite | `tests/platform.ts`: `IS_WIN`, `onPosix`, `NULL_DEVICE`, `TEST_SHELL`, `DETACHED`, `killChildTree`. A test that merely *uses* a POSIX construct gets a portable spelling; a test *about* POSIX semantics is skipped on win32 |
| A native binary's stdout is CRLF-terminated | `outputLines` in the same file, splitting on `/\r?\n/`. Every test that reads a subprocess's output line by line goes through it, so the next one doesn't re-derive the split and get it wrong (issue #53) |
| What a Windows checkout writes to disk depends on that machine's `core.autocrlf` | `.gitattributes`: one blanket `* text=auto eol=lf`, so the working tree is LF everywhere and git's own content detection still keeps the images and fonts out of it. `tests/gitattributes.test.ts` pins the attribute, the binary exclusion, and that nothing is committed CRLF |
| SQLite's single-process mutex | No change needed. `BEGIN IMMEDIATE`'s RESERVED lock is a `LockFileEx` byte-range lock on Windows, released by the OS on process death, including `TerminateProcess` (`lib/db-lock.mjs`) |

## Known limits

- **`npm run dev` still force-kills on Ctrl+C.** It runs under `concurrently`, whose win32
  kill path is an unconditional `taskkill /T /F` with the requested signal discarded, so
  in-flight turns are terminated rather than settled. Use `npm start` when you need the drain.
- **Only Ctrl+C in the console reaches the drain.** `taskkill /F`, Task Manager and closing
  the console window are all `TerminateProcess`. Running under a service wrapper (NSSM,
  WinSW, `sc`) is only as graceful as the wrapper's configured shutdown method, which you must
  pin yourself. See [Troubleshooting](TROUBLESHOOTING.md#native-windows).
- **Codex's native Windows sandbox** (restricted tokens, dedicated sandbox users) has a
  heavier first-run setup than Landlock or Seatbelt and may need elevation Calandria never
  prompts for; `sandboxMode` maps through the SDK either way.
- **Service hostnames** (`<slug>--<host>`) need the same wildcard DNS story as on any
  platform; `localhost` subdomains don't resolve without a `hosts` entry.

## Still owed a real machine

CI covers typecheck, the unit suite and the e2e suite: 1462 tests and 92 specs, green on a
real Windows runner. What's left is the shutdown path, which all three lanes miss
structurally. `child.kill()` is a `TerminateProcess` on Windows, so no stub can observe which
signal a process was sent; `tests/startLauncher.test.ts` skips its SIGINT case there for that
reason. The e2e lane does boot `scripts/start.mjs`, but Playwright tears its `webServer` down
with a process-tree kill, so it only proves the launcher starts both processes, not whether
either drains. Five minutes on a Windows box would settle both:

1. Under `npm start`, begin a long turn, press Ctrl+C, and confirm the transcript carries the
   interrupted-state notice rather than the next boot's crash recovery clearing a raw running
   flag.
2. Confirm `cmd.exe`'s `Terminate batch job (Y/N)?` prompt on npm's `.cmd` shim doesn't
   truncate that wait. It appears after the console event has been broadcast, so the drain
   should already be running, but only a real box can confirm it.

## History

This file began as a compatibility assessment (research spike, 2026-08-24) enumerating
fifteen findings, sized and ordered into three phases, with WSL2 recommended as the interim
answer. All of it shipped; the findings now live in the code they became and in the commits
that made each change.
