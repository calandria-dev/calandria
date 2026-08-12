<div align="center">

# Operator

### Run Claude Code and Codex in parallel—across every project—from one control room.

Every task gets a persistent agent session in an isolated git worktree. See which agents
need you, review their diffs, and merge when the work is ready. Operator uses your existing
Max, Pro, or ChatGPT subscription—no API key or per-token billing required.

[**Try Operator hosted**](https://getoperator.dev) · [**Self-host**](docs/SELF_HOSTING.md) · [**Request a feature**](https://github.com/iishyfishyy/operator-oss/discussions/categories/ideas)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node ≥20.9](https://img.shields.io/badge/node-%E2%89%A520.9-brightgreen.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-8A2BE2.svg)](CONTRIBUTING.md)

![Operator workspace showing projects and parallel agent tasks](docs/images/workspace.png)

</div>

## Why Operator

- **Run many tasks without juggling terminals.** Every task has its own worktree, branch,
  transcript, and agent session.
- **Know where you are needed.** A cross-project inbox surfaces sessions waiting for input
  while the rest keep working.
- **Stay in control of every change.** Review the diff beside the conversation, then merge,
  resolve conflicts, or open a pull request.

## How it works

**Create a task → Operator creates an isolated worktree → your agent works → Operator
alerts you when needed → you review and merge.**

Project context is written once and carried into each task. Server-owned turns and persisted
transcripts survive browser reloads and laptop sleep, and `/clear` starts a fresh context
window while preserving the task's lineage.

## What makes it different

- **Parallel, isolated tasks** — work across multiple repositories without agents mixing
  files or branches.
- **One “Needs you” inbox** — jump directly to any session waiting for an answer.
- **Persistent context** — reuse project knowledge and continue long-running work across
  fresh context windows.
- **Review-to-merge workflow** — inspect diffs, sync branches, resolve conflicts, merge, or
  create a GitHub PR from the same screen.
- **Task orchestration** — use list or kanban views, chain dependencies, and automatically
  start tasks when their blockers finish.
- **A complete workspace** — chat, terminal, managed services, live logs, and transparent
  token and usage insights stay together.

![Operator diff review beside an agent session](docs/images/changes.png)

[Explore all features](docs/FEATURES.md)

## Supported agents

Operator supports **Claude Code** and **OpenAI Codex** end to end. Choose an agent per task,
or connect only the one you use. Both work with subscription login; API keys remain an
optional explicit choice.

[Agent support, permissions, and usage details](docs/AGENTS.md)

## Quick start

You need Node 20.9+, macOS or Linux, and at least one supported agent CLI.

```bash
npm install
npm run build
npm start
```

Open <http://localhost:3000>. The first-run wizard connects Claude Code or Codex and takes
you through a short hands-on tutorial.

Use `npm run dev` only when developing Operator itself. For Docker, authentication,
networking, and configuration, see the [self-hosting guide](docs/SELF_HOSTING.md).

## Hosted

[**getoperator.dev**](https://getoperator.dev) gives you an always-on Operator instance
with no server setup. It uses this open-source app with a hosted control plane.

## Community

- [Request a feature or share an idea](https://github.com/iishyfishyy/operator-oss/discussions/categories/ideas)
- [Ask a question](https://github.com/iishyfishyy/operator-oss/discussions/categories/q-a)
- [Report a bug](https://github.com/iishyfishyy/operator-oss/issues/new?template=bug_report.yml)
- [Contribute](CONTRIBUTING.md)

See [COMMUNITY.md](docs/COMMUNITY.md) for where each kind of conversation belongs.

## Documentation

- [Installation and local development](docs/INSTALLATION.md)
- [Features](docs/FEATURES.md)
- [Agents](docs/AGENTS.md)
- [Insights and usage](docs/INSIGHTS.md)
- [Managed services](docs/SERVICES.md)
- [Self-hosting](docs/SELF_HOSTING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security](SECURITY.md)

## License

[Apache-2.0](LICENSE)
