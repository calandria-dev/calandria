# Installation and development

## Requirements

- Node.js 20.9 or newer
- macOS, Linux, or Windows via [WSL2](#windows-wsl2) (native Windows is not supported yet)
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

## Windows (WSL2)

WSL2 is the supported way to run Calandria on a Windows machine. It runs the ordinary
Linux build with no Windows-specific configuration. Native Windows is not supported yet;
[`WINDOWS.md`](WINDOWS.md) records what that would take.

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

Three caveats:

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
