# Windows compatibility assessment

Research spike, 2026-08-24. Findings only — nothing here is implemented. The
follow-up tasks are listed at the end and filed in the project's Suggested tray.

**Recommendation: WSL2 first.** Document WSL2 as the supported way to run
Calandria on a Windows machine now (it already works — it *is* Linux), and treat
native Windows as a phased track that only starts if demand shows up. Native is
not far off in raw line count (~10 files), but it adds a second process model
(`taskkill` trees instead of POSIX process groups), a second shell (`cmd.exe`
semantics for managed-service commands), a second filesystem model (case-folded
identity, `MAX_PATH`, handle-locked deletes), and a Windows CI lane to keep all
of it honest. That is a standing maintenance cost, not a one-off port.

## Summary by effort

| # | Finding | Area | Effort | Native blocker? |
|-|-|-|-|-|
| 1 | `npm run build` / `npm start` use `NODE_ENV=production …` inline env (POSIX-only); `*:docker` scripts invoke a bash file directly | Entrypoints | S | Yes — nothing boots |
| 2 | `pty-server.js:119` falls back to `/bin/zsh`; `$SHELL` is unset on Windows | node-pty | S | Yes — terminal dead |
| 3 | `CLAUDE_CLI_PATH` default has no `.exe`; bare `"codex"` spawned without a shell can't resolve npm's `.cmd` shim | Agent CLIs | S | Yes — no turns |
| 4 | Six negative-PID process-group kills + a `ps`-based orphan guard in `lib/services.ts`; `detached: true` means "new console" on Windows | Process mgmt | M | Yes — services can't be stopped or reaped — **fixed** (`lib/processTree.ts`) |
| 5 | Path identity compared case-sensitively after `realpathSync` (`lib/git.ts:536`, `lib/repoLock.ts:73`) — NTFS is case-insensitive | Paths | S | Yes — can wrongly `rmSync` a linked worktree |
| 6 | No `core.longpaths`; worktrees under `%USERPROFILE%\.calandria\worktrees\<id>\…` + `node_modules` exceed `MAX_PATH` | Paths | S | Likely — depends on repo depth |
| 7 | `fs.rmSync` / `git worktree remove` have no EBUSY/EPERM retry — Windows refuses to delete files another process (shell, editor, AV) has open | Paths | M | Yes — worktree prune/discard/delete fails while a Task terminal is open |
| 8 | SIGTERM drain (`server.js:318`) only fires for console Ctrl+C on Windows; service-manager stops and `taskkill /F` skip it; `concurrently -k` on Windows kills via `taskkill /F` (unverified) | Process mgmt | S–M | Degradation, not a crash |
| 9 | `chmod 0o600` on persisted API-key files is a no-op on NTFS (`lib/anthropic-key.ts:41`, `lib/openai-key.ts:41`) — **fixed**, §3 | Files | S | Security downgrade |
| 10 | `worktreeDiskUsage()` shells out to `du` (`lib/git.ts:642`) — silently reports 0 | Paths | S | Cosmetic |
| 11 | `gh` probe dirs are all POSIX (`lib/github.ts:17`); `GIT_SSH_COMMAND` assumes `ssh` on PATH | Agent CLIs | S | Degradation |
| 12 | Unit suite: `tests/setup.ts:77` pins `GIT_CONFIG_SYSTEM=/dev/null` (e2e already branches to `NUL`); pty tests force `SHELL=/bin/sh` and group-kill; services tests use `sleep 30` through `cmd.exe`; `ghBin`/`diff` tests assert exec-bit semantics | Tests | M | For CI, yes |
| 13 | No Windows CI lane; better-sqlite3's win32 prebuild is fetched at install (network), node-pty's is vendored | Tests/CI | M | For declaring support, yes |
| 14 | `lib/db-lock.mjs` — SQLite `BEGIN IMMEDIATE` uses `LockFileEx` byte-range locks on Windows; released on process death; semantics hold on local NTFS | File locking | — | **No change needed** |
| 15 | `scripts/calandria-mcp.mjs` bridge: launched as `process.execPath <abs path>` — already portable; `postinstall` `fix-pty.js` no-ops correctly (win32 prebuilds ship no `spawn-helper`) | Entrypoints | — | **No change needed** |

Effort key: S = under a day, M = one to three days, L = a week or more. Nothing
here is L on its own; the L is the sum plus the standing CI lane.

## Area findings

### 1. node-pty sidecar (`pty-server.js`)

- **Prebuilds are fine.** node-pty 1.1.0 vendors `prebuilds/win32-x64/` and
  `win32-arm64/` (`conpty.node`, `pty.node`, `winpty-agent.exe`, ConPTY DLL), so
  no Visual Studio toolchain is needed. ConPTY is selected automatically on
  Windows 10 1809+ (build ≥ 18309 for the stable path); older builds fall back
  to winpty.
- **Shell selection is the break.** `const shell = process.env.SHELL || "/bin/zsh"`
  (`pty-server.js:119`). `SHELL` is a POSIX convention and is unset in a native
  Windows environment, so every terminal session tries to spawn `/bin/zsh` and
  ENOENTs. Fix: a `CALANDRIA_PTY_SHELL` env knob (useful on every platform — the
  server never reads a shell profile, so `$SHELL` is already a guess) with a
  win32 default of `process.env.COMSPEC || "powershell.exe"`. `pwsh.exe` if
  present is the nicer default; `cmd.exe` is the guaranteed one.
- **Signals.** `term.kill()` on close is a `TerminateProcess` on Windows — fine,
  that's the desired semantics for a closed tab. `onExit` exit codes come from
  ConPTY and are reliable.
- **Loopback-peer check** (`isLoopbackPeer`) compares `socket.remoteAddress`
  against `127.0.0.1` / `::1` / `::ffff:127.0.0.1` — the same strings Node
  reports on Windows. No change.
- **`postinstall`** (`scripts/fix-pty.js`) looks for `spawn-helper` per prebuild
  dir; the win32 dirs don't have one, so it skips them before `chmod` is
  reached. Already correct.

### 2. Process management

All six process-group sites live in `lib/services.ts` and hang off one spawn:

```
spawn(cfg.command, { cwd: project.repo_path, shell: true, detached: true, env })   // :463-470
```

| Line | Code | Problem on Windows |
|-|-|-|
| 411 | `process.kill(-m.proc.pid, "SIGKILL")` (exit hook) | No process groups; negative pid is meaningless |
| 517 | `process.kill(-pid, "SIGTERM")` (`killProcGroup`) | Same. With `shell: true` the tree is `cmd.exe → npm.cmd → node.exe`; killing `proc.pid` alone orphans the real server |
| 518 | `process.kill(-pid, "SIGKILL")` (4 s escalation) | Same; no graceful/forced distinction exists — `taskkill /T /F` is the only tree kill |
| 644 | `process.kill(-pid, 0)` (liveness) | Not a group probe on Windows |
| 647 | `execFileSync("ps", ["-A", "-o", "pgid=,command="])` | No `ps` → guard returns false → **orphan reaping is a silent no-op**; a restart then loses `EADDRINUSE` to its own predecessor |
| 665, 668 | `process.kill(-row.pid, …)` (`reapOrphan`) | Same |

Two further semantics:

- `detached: true` on Windows means "allocate a new console", not "new process
  group". It buys nothing for kill scoping and may pop a console window.
- `shell: true` runs the command through `cmd.exe /d /s /c`. A `dev_command`
  written for `sh` (`FOO=bar npm run dev`, `&&` chains are fine, `$VAR`, single
  quotes, `~`) parses differently or fails. This is a product decision, not
  just a port: either document that Windows service commands are `cmd.exe`
  syntax, or run them through `pwsh`/Git Bash explicitly.

**Shipped** as `lib/processTree.ts`: `killTree(pid, signal)` signals the process
group on POSIX and runs `taskkill /pid <pid> /T /F` on win32 (both signals
collapse to that one forced kill — there is no graceful tree signal), with
`treeAlive` (`tasklist /fi "PID eq <pid>" /nh /fo csv`) and `treeMatchesCommand`
(a `Get-CimInstance Win32_Process` CommandLine lookup, since the persisted pid
IS the `cmd.exe /d /s /c "<command>"` wrapper) standing in for the `ps`
membership guard. `detached` is now set only where process groups exist, the
SIGTERM→SIGKILL escalation is skipped on win32, and when the guard can't find
out — no `ps`, no PowerShell — the answer stays "don't kill". The win32 branches
take their platform and command runner as arguments, so `tests/processTree.test.ts`
pins them from the POSIX suite. The `cmd.exe` command semantics above are
documented in [SERVICES.md](SERVICES.md#windows-command-syntax) rather than
worked around: `dev_command` is a `cmd.exe` command line on Windows.

**The runner's own children are fine.** The claude/codex CLI processes the
Agent SDKs spawn are plain, non-detached children; Stop and the drain are
`AbortController` aborts that the SDKs turn into a direct `child.kill()`, which
libuv maps to `TerminateProcess`. No group semantics involved.

**SIGTERM drain** (`server.js:283-322`, `drainActiveTurns()` in `lib/runner.ts`):
the drain itself is signal-free (loopback POST, JS aborts, bounded wait) and
would work on Windows. What doesn't port is *reaching* it: Node on Windows
delivers `SIGINT` for console Ctrl+C, but there is no deliverable `SIGTERM` —
`taskkill /F`, a service manager's stop, and Task Manager all `TerminateProcess`
and skip every handler, leaving the next boot's `recoverFromCrash()` to clean
up. For the realistic native use case (a user running `npm start` in a
terminal) Ctrl+C is the path, and it needs verifying, because `concurrently -k`
on Windows terminates its children with `taskkill /T /F`, which would bypass
the drain in `server.js` even on Ctrl+C. If that's confirmed, the fix is to
either stop using `concurrently` for `npm start` on win32 or have `server.js`
own the pty sidecar as a child.

### 3. Path handling

- **Defaults are portable.** `DB_DIR`, `WORKTREES_DIR`, `PROJECTS_DIR`
  (`lib/config.ts:15-22`) and `resolveDbLockDir` (`lib/db-lock.mjs:81`) all use
  `path.join(os.homedir(), …)`, never a literal `~`. `.env.example` already
  says `~` is not expanded in overrides. No change.
- **Worktree paths are safe.** `path.join(WORKTREES_DIR, taskId)`
  (`lib/git.ts:552`) with a nanoid task id (`A-Za-z0-9_-`) — no NTFS-illegal
  characters, no reserved device names possible. The merge scratch path
  (`lib/git.ts:1147`) is already scrubbed to `[A-Za-z0-9._-]`. Branch `calandria/<id>`
  is a git ref, which git for Windows nests as folders — fine.
- **Git is invoked correctly.** Every call is `execFile("git", [argv])`
  (`lib/git.ts:22-27`); Windows `CreateProcess` resolves `git.exe` on PATH. All
  output parsing is NUL-delimited or prefix-based and treats paths as opaque
  strings; `git worktree list --porcelain` emits `C:/…` forward-slash absolute
  paths on Windows, which `realpathSync` normalizes. No `sh`/`xargs`/`sed`
  dependencies — except `du` in `worktreeDiskUsage()` (`lib/git.ts:642`), which
  ENOENTs into its `catch` and reports 0 bytes. Replace with an `fs` walk on
  win32.
- **Case-insensitive identity is the correctness bug.** `isLinkedWorktree()`
  (`lib/git.ts:518-537`) and `pathIdentity()` (`lib/repoLock.ts:72-78`) compare
  `fs.realpathSync` output with `===`. On NTFS `realpathSync` is case-*preserving*
  but does not canonicalize case, so `C:\Users\Foo` and `c:\users\foo` differ
  as strings. In `isLinkedWorktree` a false "not linked" is what authorizes
  `fs.rmSync(wtPath, { recursive: true, force: true })` at `lib/git.ts:579`;
  in `repoLock` it means two spellings of one repo take two locks. Fix:
  case-fold both sides on win32 (`toLowerCase()` after `path.normalize`), ideally
  in one shared `samePath()` helper.
- **`MAX_PATH`.** The app never sets `core.longpaths`. Git for Windows enforces
  260 characters unless it's on, and a task worktree lives four levels under
  the profile dir before the repo's own tree starts. Set
  `core.longpaths=true` on the worktree (`git config` per repo, or
  `-c core.longpaths=true` on `worktree add`/`checkout`) on win32, and document
  the global setting.
- **Handle-locked deletes.** POSIX lets an unlinked-but-open file disappear;
  Windows returns `EBUSY`/`EPERM`/`ENOTEMPTY` while anything holds a handle. The
  Task-scoped `TerminalDrawer` shell is rooted *in the worktree being removed*,
  editors index it, and Defender scans fresh checkouts. Every teardown path
  (`lib/git.ts:579,621,1058`, `git worktree remove`, `lib/taskMove.ts` discard)
  would surface a hard failure. Fix: on win32, `rmSync` with `maxRetries`/
  `retryDelay` (Node supports both) and a `git worktree remove --force` retry,
  with a message that names the likely holder.
- **File modes are not permissions.** The persisted API keys were written with
  `mode: 0o600` plus a `chmodSync` and comments promising owner-only
  (`lib/anthropic-key.ts`, `lib/openai-key.ts`). On NTFS Node's `chmod` maps
  onto the read-only attribute and nothing else, so the DACL stayed whatever the
  profile directory handed down and every other local account could read the
  key. **Fixed**: both go through `writeSecretFile()` (`lib/secretFile.ts`),
  which keeps the POSIX path byte-for-byte and on win32 runs
  `icacls <file> /inheritance:r /grant:r <owner>:(R,W)` through `execFile` — no
  shell, and pinned to `%SystemRoot%\System32\icacls.exe` rather than PATH
  order, since a PATH-resolved helper is one writable directory away from being
  someone else's program that exits 0. `/grant:r` replaces the DACL, so
  re-saving repairs a file an older build left open. **A failure is fatal**: the
  file is deleted and the error reaches the API-key route, because a credential
  at permissions we could not set is worse than no credential — the wizard would
  otherwise report a connected agent over a world-readable key. The escape hatch
  is the existing one (`ANTHROPIC_API_KEY` in the env plus
  `CALANDRIA_ALLOW_API_KEY_ENV=1`, which writes nothing to disk), and the same
  applies to a key directory on FAT32 or a mapped drive, where there is no DACL
  to set. The owner is `os.userInfo().username`, qualified with `%USERDOMAIN%`
  when it names something other than this machine — icacls resolves a bare name
  through `LookupAccountName`, which checks the local machine before the domain,
  so a domain account can be shadowed by a local one of the same name. Stated in
  `docs/SELF_HOSTING.md`; `lib/push/vapid.ts:86` writes the VAPID private key the
  same 0600 way and is **not** covered.
- **Service router** (`lib/service-router.mjs`, `lib/service-host.mjs`) is pure
  Host-header string logic + loopback proxying. Nothing filesystem-bound; the
  `<slug>--<host>` wildcard-DNS requirement is the same on every OS.
- **Temp dirs.** Production code never touches `/tmp` or `os.tmpdir()`. Tests
  use `mkdtemp` and pass results only as `execFile` argv, so a space in
  `C:\Users\John Doe\AppData\Local\Temp` is safe — but untested.

### 4. File locking (`lib/db-lock.mjs`)

No change needed. SQLite's Windows VFS implements `BEGIN IMMEDIATE`'s RESERVED
lock as a `LockFileEx` byte-range lock on the file handle; the OS releases it
when the process dies (including `TerminateProcess`), and a second process on
the same machine gets `SQLITE_BUSY` immediately — the same contract the module
documents for `flock`-style POSIX behaviour. `journal_mode = DELETE` on the lock
file avoids the WAL `-shm` mapping, which is also correct on Windows.

The caveat is **WSL2's cross-boundary filesystems**, and it applies to today's
Linux build, not just a native port: `/mnt/c` (drvfs/9p) and `\\wsl$` do not
implement file locking, and SQLite's WAL mode over them can return stale data or
corrupt. `CALANDRIA_DB_DIR` **and** `CALANDRIA_WORKTREES_DIR` must live on the WSL2 ext4
root. That belongs in the WSL2 docs (task 1).

### 5. Entrypoints and scripts

| Script | Status |
|-|-|
| `build`, `start` | `NODE_ENV=production …` prefix — `cmd.exe`/PowerShell try to run a program called `NODE_ENV=production`. Add `cross-env` (not currently a dep) or drop the prefix: `next build` forces production itself, and `server.js` reads `NODE_ENV` for `dev` — check that before dropping it from `start` |
| `test:docker`, `typecheck:docker`, `test:e2e:docker`, `preflight:docker` | Bare `scripts/docker-test.sh` — no shebang interpreter under `cmd.exe`. `bash scripts/docker-test.sh` works with Git Bash on PATH; the Docker Desktop side additionally needs Linux-container mode |
| `dev`, `dev:next`, `pty`, `typecheck`, `test`, `test:e2e*`, `preflight`, `postinstall` | Portable as written; `concurrently`'s nested quotes survive npm's `cmd.exe /d /s /c` wrapper |
| `next.config.mjs`, `server.js`, `pty-server.js` | Plain Node, no POSIX assumptions beyond the shell default in §1 |
| `docker/entrypoint.sh`, `Dockerfile`, `docker-compose.yml` | Run inside the Linux container; unaffected. Docker Desktop users already have the `CALANDRIA_RUNTIME=runc` override documented (no gVisor) |

Playwright's `webServer.command` is `npm start`, so the e2e suite inherits the
`start` breakage — fixing the scripts is the prerequisite for everything else.

### 6. Agent CLIs

- **Claude Code** is natively supported on Windows (self-contained
  `claude.exe`, Windows 10 1809+ / Server 2019+) but **requires Git for Windows**
  — it runs its Bash tool through Git Bash even when launched from PowerShell.
  So "Git for Windows on PATH" is a hard prerequisite of Calandria-on-Windows
  either way, which also covers our `execFile("git")` calls.
- **`CLAUDE_CLI_PATH`** defaulted to `~/.local/bin/claude` with no extension,
  passed straight to the SDK's `pathToClaudeCodeExecutable` on every turn,
  one-shot and `/`-command probe (`lib/agents/claude/driver.ts`,
  `commands.ts`) and to node-pty for `claude auth login` (`lib/claude-auth.ts`).
  Node's shell-less spawn resolves `.exe` via `CreateProcess` but never npm's
  `.cmd` shim. **Fixed**: on win32 the default is the native installer's
  `claude.exe` under `%USERPROFILE%\.local\bin`, then a `PATHEXT`-aware PATH
  lookup, then that path literally so a failure names something plausible
  (`lib/config.ts`). `.exe` is ordered ahead of `.cmd` because the SDK spawns
  this value directly, as does node-pty for the login — neither offers a
  cmd.exe wrapper, so a real `claude.exe` is a requirement on Windows, not a
  preference. The codex helpers differ only because they shell out through
  `child_process`, where the wrapper works.
- **`claude auth login` sets `BROWSER=true`** to no-op the browser open by
  exec'ing `/bin/true`, and there is no `true` on Windows. **Checked against
  the shipped CLI (2.1.240) and left as-is**: `$BROWSER` is exec'd as a command
  with the URL as its only argument, a missing opener is classified
  `opener_missing` and *returned* rather than thrown, the CLI sets
  `BROWSER: "true"` itself in the environment it builds for its own background
  sessions — in the same object literal carrying its `platform === "windows"`
  case — and a separate check reads `BROWSER === "true"` as "not a real
  browser". So the value is a sentinel the CLI expects, and the Windows worst
  case is the benign no-browser path the flag is asking for.
- **Codex CLI**: OpenAI shipped a native Windows sandbox in March 2026
  (restricted tokens + dedicated sandbox users + `codex-command-runner.exe`),
  so `sandboxMode: "workspace-write" | "read-only"` in
  `lib/agents/codex/driver.ts` maps through the SDK; first-run sandbox setup is
  heavier than Landlock/Seatbelt and may need elevation Calandria doesn't
  prompt for. The bare `"codex"` spawns in `lib/agents/codex/auth.ts:22,212` and
  `codex/mcp.ts:38` had the same `.cmd` problem as Claude — and `mcp.ts` fails
  silently (leaves inherited MCP servers mounted, the exact context-waste it
  exists to prevent), so a Windows instance would have paid that cost on every
  turn with nothing logged. **Fixed**: both go through `resolveCodexBin()` /
  `codexSpawn()` (`lib/agents/codex/bin.ts`), which applies `PATHEXT` and wraps
  a `.cmd` shim in `cmd.exe` — Node refuses to spawn one shell-less since
  CVE-2024-27980. `codexPathOverride` via `CODEX_CLI_PATH` still works as the
  escape hatch, and the driver's own SDK-bundled binary is unaffected.
- **`scripts/calandria-mcp.mjs`** is launched as `{ command: process.execPath,
  args: [CALANDRIA_MCP_SCRIPT] }` (`lib/agents/codex/driver.ts:58`) with an absolute
  `path.join(process.cwd(), …)` script path and talks to the app over loopback
  HTTP. Already portable; the shebang is inert.
- **`gh`** probe dirs were all POSIX; bare `gh` on PATH is tried first so
  winget/scoop installs usually worked by accident. **Fixed**: win32 probes
  `%LOCALAPPDATA%\Microsoft\WinGet\Links`, `%ProgramFiles%\GitHub CLI` and
  `~\scoop\shims`, and the lookup applies `PATHEXT` so the `gh.exe` in them is
  actually seen (every extension-less candidate missed before). A PATH hit still
  answers bare `"gh"` — `CreateProcess` repeats the PATH+PATHEXT search itself.
  `resolveGhBin`'s `X_OK` check is meaningless on Windows — it passes for any
  existing file — so `isExecutableFile()` skips it there and asks only "is this
  a file", which the extension candidates already answer. Accepted, and noted in
  `lib/binPath.ts`.

### 7. Tests and CI

- **Unit suite.** Git fixtures are all `execFile("git", argv)` via
  `tests/helpers.ts:12` — portable. What isn't: `tests/setup.ts:77`
  (`GIT_CONFIG_SYSTEM = "/dev/null"`, where `e2e/env.ts` already branches to
  `NUL`); `tests/ptyOrigin.test.ts:48,125` and `tests/ptyProtocol.test.ts:65`
  force `SHELL=/bin/sh` and clean up with `process.kill(-pid)`;
  `tests/services.test.ts:160,187,211` run `dev_command: "sleep 30"` through
  `cmd.exe`, which has no `sleep`; `tests/ghBin.test.ts:21` writes a `#!/bin/sh`
  fake with mode `0o644` vs `0o755` to test exec-bit detection;
  `tests/diff.test.ts:139` asserts `new file mode 100755`. The last two encode
  POSIX semantics and should be `describe.skipIf(win32)`, not ported.
- **e2e.** `e2e/env.ts` is the one file in the repo that already anticipates
  win32. The prod server boot is Playwright's own `webServer` (portable
  teardown); the only blocker is `npm start` itself (§5).
- **CI.** All jobs run on Ubuntu. A `windows-latest` lane needs: Git for
  Windows (preinstalled), node-pty (vendored prebuild — fine), better-sqlite3
  (`prebuild-install` downloads a win32/Node-22 binary at install; falls back to
  `node-gyp` with the runner's MSVC — works but is the network-dependent step
  to watch), and the `*:docker` scripts excluded. Start with
  `typecheck` + `unit` on Windows; e2e once the process-management work lands.

## Native vs WSL2

**WSL2 today**: the Linux build, unchanged. A Windows user installs Ubuntu in
WSL2, Node 20.9+, Git, the agent CLIs *inside* WSL2, clones or keeps project
repos on the ext4 root, and runs `npm start`. WSL2 forwards `localhost:3000` to
the Windows browser automatically; xterm gets a real Linux shell; every
process-group, signal, path, lock and CLI finding above is moot. Three things
to document because they bite: (1) `CALANDRIA_DB_DIR`/`CALANDRIA_WORKTREES_DIR`/repos must
not be on `/mnt/c` (no file locking — §4 — and 10–50× slower git), (2) the
Windows-side Claude/Codex logins are not visible inside WSL2, the CLIs log in
separately there, and (3) `<slug>--<host>` service hostnames need the same DNS
story as Linux; `localhost` subdomains don't resolve from the Windows browser
without a hosts-file entry.

**Native** is three phases if it happens:

1. *Boot* (S, all hygiene on every platform): cross-platform npm scripts,
   `CALANDRIA_PTY_SHELL` + win32 shell default, `.exe`/`.cmd` resolution for
   `claude`/`codex`/`gh`, `NUL` in `tests/setup.ts`, case-folded path identity.
   After this the app starts, turns run, the terminal opens.
2. *Correctness* (M): `killTree` for managed services + `tasklist` guard,
   `core.longpaths` + EBUSY-tolerant worktree teardown, `du` replacement, key
   file ACLs, drain-on-Ctrl+C verified under `concurrently`.
3. *Support* (M, ongoing): Windows CI lane, test-suite portability, README /
   INSTALLATION / TROUBLESHOOTING declaring native support with prerequisites
   (Git for Windows, Windows 10 1809+).

Phase 1 is worth doing regardless — every item is a portability fix that also
removes an assumption Linux users trip on (`$SHELL` unset under systemd, a
trimmed PATH). Phases 2–3 wait for a real Windows user.

## Follow-up tasks

Filed in the Suggested tray, in dependency order:

1. Docs: WSL2 as the supported Windows path (README, INSTALLATION, TROUBLESHOOTING; the `/mnt/c` locking and login caveats). No blockers. **Do first.**
2. Cross-platform npm scripts (`cross-env` or drop `NODE_ENV=` prefix; `bash scripts/docker-test.sh`). — **Done** (`1314a34`).
3. `CALANDRIA_PTY_SHELL` env knob + win32 shell default in `pty-server.js`.
4. Agent CLI resolution on win32 (`claude.exe` default, `.cmd`/`PATHEXT` for `codex`, win32 `gh` probe dirs, `BROWSER=true` check). — **Done** (`lib/binPath.ts` + callers).
5. Path identity + filesystem semantics on win32 (case-fold `samePath()`, `core.longpaths`, EBUSY-retrying teardown, `du` replacement).
6. Cross-platform process tree kill in `lib/services.ts` (`killTree`, `tasklist` guard, `detached` only on POSIX, document `cmd.exe` command semantics). — **Done** (`lib/processTree.ts` + `lib/services.ts`).
7. Persisted API-key file permissions on Windows (`icacls` or documented downgrade).
8. Verify Ctrl+C drain path under `concurrently -k` on Windows — blocked by 2.
9. Unit/e2e suite portability — blocked by 2, 3, 5, 6.
10. Windows CI lane + docs declaring native support — blocked by 2, 9.
