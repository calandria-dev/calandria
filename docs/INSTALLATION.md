---
title: "Installation and development"
---

# Installation and development

## Requirements

- Node.js 22 or newer
- macOS, Linux, or [Windows](#windows)
- Claude Code, OpenAI Codex, or both

Calandria drives these CLIs from your own subscription login; it doesn't bundle them.
Install at least one:

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

Native Windows is the standard install: the ordinary steps above, plus three prerequisites
and a few Windows-specific defaults, below. The typecheck, unit and end-to-end suites all
run on `windows-latest` in CI, and the end-to-end suite boots the real server there. See
[`WINDOWS.md`](WINDOWS.md) for what that coverage proves and the one thing still unverified
on real hardware.

If your repos, toolchains, or agent logins already live in a WSL2 distro, run Calandria
there instead; see [WSL2](#wsl2) below.

### Native Windows

Prerequisites:

- **Windows 10 1809+ or Windows Server 2019+.** The terminal drawer is node-pty over
  ConPTY, which arrived in 1809; older builds fall back to winpty and are untested.
- **Git for Windows, on `PATH`.** Calandria shells out to `git` for every worktree, diff
  and merge. Claude Code needs it too: `claude.exe` runs its Bash tool through Git Bash
  even when you launch it from PowerShell.
- **Node.js 22 or newer.** `.nvmrc` pins 22, the version CI runs; newer lines, including
  *Current*, work too. Both native modules are N-API and carry their win32 binaries inside
  the npm package, so nothing compiles at install time and Visual Studio build tools aren't
  required. `.npmrc` sets `engine-strict`, so `npm install` fails immediately with one clear
  line on a Node below the floor.

Set git's long-path support once for the machine before you start:

```powershell
git config --global core.longpaths true
```

Calandria passes `-c core.longpaths=true` on its own git calls, but a task's checkout lives
under `%USERPROFILE%\.calandria\worktrees\<task id>\`, and the agent's own `git` and `npm`
read the ordinary config. Without this setting, a deep repository fails part-way through
checkout with "Filename too long". See [Native Windows](TROUBLESHOOTING.md#native-windows)
for that case and for worktree removals that fail while a terminal or editor holds the
folder open.

Then, from PowerShell in the cloned repo:

```powershell
npm install
npm run build
npm start
```

**Install the agent CLI natively too.** Claude Code must be the self-contained `claude.exe`
from its native installer, which lands in `%USERPROFILE%\.local\bin`; Calandria looks there
first, then on `PATH`. npm's `claude.cmd` shim will **not** work: the path goes straight to
the Agent SDK and to node-pty for `claude auth login`, and neither can run a batch shim. Set
`CLAUDE_CLI_PATH` to pin a different location. Codex has no such restriction;
`npm install -g @openai/codex` and its `.cmd` shim work fine.

**The terminal picks a shell for you.** With `CALANDRIA_PTY_SHELL` unset, terminal tabs get
`pwsh.exe` or `powershell.exe` if either is on `PATH`, otherwise `%COMSPEC%` (`cmd.exe`).
Set the variable to choose something else, Git Bash for instance:

```
CALANDRIA_PTY_SHELL=C:\Program Files\Git\bin\bash.exe
```

**Managed-service commands are `cmd.exe` command lines.** A `dev`, `setup`, or `test`
command written as `FOO=bar npm run dev` does not parse. See
[Windows command syntax](SERVICES.md#windows-command-syntax).

**Stop the server with Ctrl+C in the terminal running `npm start`.** That is the only stop
path that reaches the drain and settles in-flight turns; `taskkill /F`, Task Manager and
closing the console window are hard kills. The next boot clears what a hard stop left
behind, but interrupted turns will look like they simply stopped.

### WSL2

WSL2 runs the ordinary Linux build with no Windows-specific configuration. Install a
distribution, then do everything else **inside** it, following the ordinary Requirements
and "Run Calandria locally" steps above (Node, git, an agent CLI, `npm install && npm run
build && npm start`): the Windows-side copies of those aren't visible from WSL2, so install
and log in again from the Ubuntu shell.

```powershell
wsl --install -d Ubuntu
```

WSL2 forwards `localhost:3000` to Windows, so <http://localhost:3000> opens in your Windows
browser with nothing further to configure. Three boundary caveats, including a database
corruption risk if `CALANDRIA_DB_DIR` ends up on the wrong filesystem, are in
[WSL2 on Windows](TROUBLESHOOTING.md#wsl2-on-windows).

## Develop Calandria

```bash
npm install
npm run dev
```

Development mode runs the Next.js development server and terminal sidecar with hot reload.
It compiles routes on first use and is slower than the production build.

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
