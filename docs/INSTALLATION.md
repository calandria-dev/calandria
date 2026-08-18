# Installation and development

## Requirements

- Node.js 20.9 or newer
- macOS or Linux
- Claude Code, OpenAI Codex, or both

Install the CLI for the agent you plan to use:

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
```

The first-run wizard handles subscription login in the browser. Connecting either agent is
enough to complete setup.

## Run Operator locally

```bash
npm install
npm run build
npm start
```

Open <http://localhost:3000>. This production build is the recommended way to use Operator
day to day.

Local mode has no login and binds to loopback by default. It rejects cross-site HTTP and
WebSocket access to the app and terminal. If you intentionally use it over a LAN, configure
the exact origin with `ORCH_ALLOWED_ORIGINS`. Use real origin authentication for anything
internet-facing; see [Self-hosting](SELF_HOSTING.md).

Every setting is an environment variable with a documented default in
[`.env.example`](../.env.example).

## Develop Operator

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
