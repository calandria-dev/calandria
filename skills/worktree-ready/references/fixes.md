# Fix recipes

Contents: [Bootstrap script](#bootstrap-script) · [Telling the agent about
it](#telling-the-agent-about-it) · [Env-driven ports](#env-driven-ports) ·
[Ephemeral test ports](#ephemeral-test-ports) · [Compose
namespacing](#compose-namespacing) · [Per-worktree data](#per-worktree-data) ·
[Resolving git paths](#resolving-git-paths) · [Keeping .env.example
honest](#keeping-envexample-honest)

Adapt these; don't paste them unchanged. A recipe that doesn't match the repo's
existing idiom is a change the maintainer will revert.

## Bootstrap script

The requirement is **idempotent** and **one command**. Running it twice in a
row must be fast and must not undo anything.

```bash
#!/usr/bin/env bash
# scripts/bootstrap.sh: make a bare checkout runnable. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .gitmodules ]; then
  git submodule update --init --recursive
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example, fill in the secrets it marks"
fi

# Cheap when already satisfied: npm ci is not, `npm ls` first is.
npm ci --no-audit --no-fund

echo "ready. next: npm run dev"
```

Wire it up so there's one name for it:

```json
{ "scripts": { "bootstrap": "bash scripts/bootstrap.sh" } }
```

Prefer extending whatever entry point the repo already has (`make setup`, `just
setup`, an existing `npm run setup`) over introducing a second one. Two
bootstrap commands is worse than none, because now the agent has to choose.

## Telling the agent about it

The bootstrap only helps if the session knows to run it. Put it near the top of
the instruction file, stated as a precondition rather than a suggestion:

```markdown
## First run in a fresh checkout

This repo is developed in parallel git worktrees, so a checkout starts with
tracked files only: no `node_modules`, no `.env`. Run `npm run bootstrap`
before anything else; it is idempotent, so run it if you are unsure.
```

Claude Code reads `CLAUDE.md`; Codex reads `AGENTS.md`. Neither reads the
other's. If the repo has one and might see the other agent, add a stub:

```markdown
<!-- AGENTS.md -->
See [CLAUDE.md](./CLAUDE.md) for the instructions; they apply to any agent.
```

Keep the real content in one file and point the other at it. Two copies of the
same instructions drift, and the drift is invisible until an agent acts on the
stale one.

## Env-driven ports

Every listener gets an env var with a documented default:

```js
const port = Number(process.env.PORT ?? 3000);
```

```python
port = int(os.environ.get("PORT", 8000))
```

Then record it in `.env.example` (`PORT=3000`) so the default is discoverable
without reading source. If the repo runs several listeners, give each its own
variable (`API_PORT`, `WEB_PORT`) rather than deriving offsets from one. An
offset scheme collides again as soon as two worktrees pick nearby bases.

Under Calandria an agent that starts a server itself gets no injected `PORT`,
so it needs to choose one and can only do that if the repo lets it.

## Ephemeral test ports

A fixed port in a test suite is a guaranteed failure the moment two tasks run
tests at once, and it fails as a timeout or a wrong-response assertion rather
than as `EADDRINUSE`, which makes it expensive to diagnose.

Bind port 0 and read back what the OS assigned:

```js
const server = app.listen(0);
const { port } = server.address();     // use this, don't assume
```

```python
sock = socket.socket(); sock.bind(("127.0.0.1", 0))
port = sock.getsockname()[1]
```

Same for any fixture that needs a database, a temp directory, or a socket path:
derive it per run, and clean it up in teardown.

## Compose namespacing

```bash
# .envrc, Makefile, or the bootstrap script
export COMPOSE_PROJECT_NAME="$(basename "$PWD")"
```

Under Calandria the worktree basename is the task id, so this is unique per
task for free. Then in the compose file:

```yaml
services:
  web:
    # container_name: app-web        ← delete; it overrides the namespacing
    ports:
      - "${WEB_PORT:-3000}:3000"     # host side variable, container side fixed
```

Named volumes need no change once the project name differs. Compose prefixes
them with it.

If the repo's stack includes something heavy and genuinely shareable (a
database server every worktree can have its own *database* inside), splitting
that tier out of the per-worktree stack is usually better than running N
copies. Say so as a finding; don't restructure someone's compose file uninvited.

## Per-worktree data

Anything the app writes should land inside the worktree, or in a directory
derived from it:

```js
const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), ".data");
```

For a shared database server, derive the database *name* instead:

```
DATABASE_URL=postgres://localhost:5432/app_${WORKTREE:-dev}
```

The failure mode you're preventing is silent: two tasks running migrations
against one database don't error, they corrupt each other's fixtures and
surface later as flaky tests in a third task that changed nothing.

## Resolving git paths

Any script, hook or tool config that touches git internals:

```bash
git rev-parse --git-dir          # this worktree's private git dir
git rev-parse --git-common-dir   # the shared one: refs, objects, config
git rev-parse --git-path hooks   # let git resolve a specific path
```

Decide which one you need: `--git-common-dir` for anything that should be one
value for the whole repo (a project identity, a cache key, shared hooks),
`--git-dir` for anything private to this checkout. Literal `.git/...` is wrong
in a worktree either way, and inside a container it can't resolve at all.

Also: a plain `git config x.y z` run from a worktree writes to the *shared*
config, affecting the main checkout. Use `git config --worktree` (after
`git config extensions.worktreeConfig true`) for anything that should vary per
worktree. Note that `core.hooksPath` is not among the keys git scopes
automatically, which is how worktree tooling has silently disabled a user's
global hooks in their main repo.

## Keeping .env.example honest

The failure is an example that was complete once. Make it checkable:

```bash
# scripts/check-env-example.sh: fails if code reads a var the example omits
missing=$(git grep -hoE 'process\.env\.[A-Z0-9_]+' -- 'src/**' \
  | sed 's/process\.env\.//' | sort -u \
  | while read -r v; do grep -qE "^#? *$v=" .env.example || echo "$v"; done)
[ -z "$missing" ] || { echo "missing from .env.example:"; echo "$missing"; exit 1; }
```

Wire it into CI and it stays true. Without something like this the example
drifts, and the drift only shows up on someone's first day, or on a fresh
worktree's first turn, which now happens several times a day.
