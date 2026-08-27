# Installation and development

## Requirements

- Node.js 20.9 or newer
- macOS, Linux, or [Windows](#windows) — natively, or under WSL2
- Claude Code, OpenAI Codex, or both

Install the CLI for the agent you plan to use:

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
```

The first-run wizard handles subscription login in the browser. Connecting either agent is
enough to complete setup.

## Run Calandria locally

```bash
npm install
npm run build
npm start
```

Open <http://localhost:3000>. This production build is the recommended way to use Calandria
day to day.

Local mode has no login and binds to loopback by default. It rejects cross-site HTTP and
WebSocket access to the app and terminal. If you intentionally use it over a LAN, configure
the exact origin with `CALANDRIA_ALLOWED_ORIGINS`. Use real origin authentication for anything
internet-facing; see [Self-hosting](SELF_HOSTING.md).

Every setting is an environment variable with a documented default in
[`.env.example`](../.env.example).

## Windows

Both ways are supported. **Native** is the ordinary install above with three prerequisites
and a few Windows-specific defaults worth knowing; **WSL2** is the Linux build unchanged,
and is the better answer if your repos, toolchains or agent logins already live there.
The typecheck, unit and end-to-end suites all run on `windows-latest` in CI — the last of
those boots the real server there — so the native path is a tested claim rather than a hope. [`WINDOWS.md`](WINDOWS.md) records what native support
consists of and the one thing still unverified on real hardware.

### Native Windows

Prerequisites:

- **Windows 10 1809+ or Windows Server 2019+.** The terminal drawer is node-pty over
  ConPTY, which arrived in 1809; older builds fall back to winpty and are untested.
- **Git for Windows, on `PATH`.** Calandria shells out to `git` for every worktree, diff
  and merge. Claude Code needs it too — `claude.exe` runs its Bash tool through Git Bash
  even when you launch it from PowerShell.
- **Node.js 20.9 or newer.**

Set git's long-path support once for the machine before you start:

```powershell
git config --global core.longpaths true
```

Calandria passes `-c core.longpaths=true` on its own git calls, but a task's checkout lives
under `%USERPROFILE%\.calandria\worktrees\<task id>\`, and the agent's own `git` and `npm`
read the ordinary config. Without this, a deep repository fails part-way through checkout
with "Filename too long". See
[Native Windows](TROUBLESHOOTING.md#native-windows) for that and for worktree removals that
fail while a terminal or editor holds the folder open.

Then, from PowerShell in the cloned repo:

```powershell
npm install
npm run build
npm start
```

**Install the agent CLI natively too.** Claude Code must be the self-contained `claude.exe`
from its native installer, which lands in `%USERPROFILE%\.local\bin` — Calandria looks
there first, then on `PATH`. npm's `claude.cmd` shim will **not** work: the path goes
straight to the Agent SDK and to node-pty for `claude auth login`, and neither can run a
batch shim. Set `CLAUDE_CLI_PATH` to pin a different location. Codex has no such
restriction; `npm install -g @openai/codex` and its `.cmd` shim are fine.

**The terminal picks a shell for you.** With `CALANDRIA_PTY_SHELL` unset, terminal tabs get
`pwsh.exe` or `powershell.exe` if either is on `PATH`, otherwise `%COMSPEC%` (`cmd.exe`).
Set the variable to choose something else — Git Bash, for instance:

```
CALANDRIA_PTY_SHELL=C:\Program Files\Git\bin\bash.exe
```

**Managed-service commands are `cmd.exe` command lines**, not `sh` ones: a `dev_command`
written as `FOO=bar npm run dev` does not parse. See
[Windows command syntax](SERVICES.md#windows-command-syntax).

**Stop the server with Ctrl+C in the terminal running `npm start`.** That is the only stop
path that reaches the drain and settles in-flight turns; `taskkill /F`, Task Manager and
closing the console window are hard kills. Nothing is lost — the next boot clears what a
hard stop left behind — but the interrupted turns look like they simply stopped.

### WSL2

WSL2 runs the ordinary Linux build with no Windows-specific configuration.

Install a distribution, then do everything else **inside** it:

```powershell
wsl --install -d Ubuntu
```

From the Ubuntu shell, install Node.js 20.9+, git, and the agent CLI you use — the
Windows-side copies are not usable from WSL2:

```bash
sudo apt update && sudo apt install -y git
# Node 20.9+ — nvm, or your distribution's preferred method
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
```

Then clone Calandria on the WSL2 filesystem and run it as on any Linux host:

```bash
npm install
npm run build
npm start
```

WSL2 forwards `localhost:3000` to Windows, so <http://localhost:3000> opens in your
Windows browser with nothing further to configure.

Three caveats, all of them about the boundary between the two systems:

**Keep everything on the ext4 root.** `CALANDRIA_DB_DIR`, `CALANDRIA_WORKTREES_DIR`, and your
project repos must live under the Linux home (`/home/you/...`), never on `/mnt/c` or
`\\wsl$`. Those cross-boundary filesystems do not implement file locking, which breaks
the SQLite mutex in `lib/db-lock.mjs` — two processes can then open the same database and
corrupt its WAL. Git is also 10–50× slower there, which a per-task worktree feels
immediately.

**Log the agents in again inside WSL2.** A Claude or Codex login done on the Windows side
is not visible to the CLIs in WSL2. Run the first-run wizard (or `claude` / `codex`
directly) from the Ubuntu shell and complete the browser login there; the credentials land
under the WSL2 `$HOME`.

**Managed-service hostnames need the same DNS story as Linux.** Public service URLs
(`<slug>--<host>`, see [Managed services](SERVICES.md)) require `CALANDRIA_SERVICE_HOSTS=1`,
`PUBLIC_BASE_URL`, and wildcard DNS. WSL2 changes none of that — and subdomains of
`localhost` do not resolve from the Windows browser, so testing locally needs a
`C:\Windows\System32\drivers\etc\hosts` entry per service hostname.

## Develop Calandria

```bash
npm install
npm run dev
```

Development mode runs the Next.js development server and terminal sidecar with hot reload.
It compiles routes on first use and is intentionally slower than the production build.

Run the checks before opening a pull request:

```bash
npm test
npm run test:e2e
npm run preflight
```

The end-to-end suite builds the production app, boots it against a disposable instance,
and exercises onboarding, projects, tasks, agent turns, diffs, merges, and workspace views
with a deterministic mock agent. It does not require a real agent login. See the
[end-to-end testing guide](../e2e/README.md) for details.

Read [CONTRIBUTING.md](../CONTRIBUTING.md) and the codebase map in
[`CLAUDE.md`](../CLAUDE.md) before making a nontrivial change.
