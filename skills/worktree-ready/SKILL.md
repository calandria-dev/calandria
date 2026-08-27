---
name: worktree-ready
description: Audit a repository for parallel git-worktree development and fix what breaks — untracked files a fresh checkout will never have (.env, local config, certs), per-worktree dependency installs, hardcoded ports, one shared dev database, Docker Compose project-name collisions, and tooling that assumes .git is a directory. Use whenever a project runs under Calandria or any tool that gives each agent task its own worktree, when a task fails on a fresh checkout with EADDRINUSE, a missing .env, or missing node_modules, when two parallel tasks interfere with each other, or when asked to make a repo worktree-safe, parallel-agent-ready, or cheaper to check out many times.
license: Apache-2.0
compatibility: Works in any agent that reads the Agent Skills format (Claude Code, Codex). Needs a shell with git.
---

# Making a repo safe for parallel worktrees

A worktree isolates **files**. Nothing else. Ports, databases, caches, container
names, `~/.cache` entries and anything else outside the tracked tree are still
shared with every other worktree and with the main checkout. Most "worktree
problems" are really this: a repo that quietly assumed there would only ever be
one copy of itself on the machine.

Your job is to find those assumptions and remove them from *the repo*, not to
paper over them in one worktree.

## What a fresh worktree actually is

These are invariants under Calandria; check the numbers but not the shape.

- It contains **tracked files at one commit, and nothing else**. No `.env`, no
  `node_modules`, no `.venv`, no build output, no local certs, no gitignored
  fixtures. Calandria copies nothing in — verify the equivalent for whatever
  tool cut the worktree before assuming it's different.
- **No bootstrap runs.** Calandria has no per-worktree setup hook: the worktree
  is cut and the agent's first turn starts in it. Whatever the repo needs done
  first, a human or the agent has to do, so it had better be one command and
  it had better be named somewhere the agent reads.
- It lives **outside the repo** (`~/.calandria/worktrees/<task-id>`), on a
  branch `calandria/<task-id>` cut from a pinned base SHA. Outside is the good
  case: a worktree nested inside a package-manager workspace root corrupts the
  parent's `node_modules`.
- **`.git` is a file**, not a directory — it holds `gitdir: <main
  repo>/.git/worktrees/<id>`, which points *outside* the worktree.
- Git refs, hooks and most config are **shared with the main repo**. A plain
  `git config` run inside a worktree writes to the main repo's config.
- Many worktrees can exist at once, and they persist after a task is merged.
  Per-worktree disk cost is paid N times, indefinitely.

## Start with the probe

```bash
bash <this skill's directory>/scripts/worktree-probe.sh
```

Read-only; run it from anywhere inside the target repo. It reports the facts
the checks below are about — ignored config files, lockfiles and install sizes,
hardcoded ports in tracked files, compose settings, `.git`-as-directory
assumptions, submodules/LFS, and whether a bootstrap command already exists.

Use it because the interesting findings are the ones nobody remembers: a
`.env.local` that has been on disk for two years, a port literal in a test
helper. Don't stop at its output — it can only see patterns, so confirm each
finding in the file before proposing a change, and read the repo's own setup
docs for anything it structurally cannot detect (a service that must be
running, an account that must exist).

## The checks, worst blast radius first

### 1. Untracked files the worktree will never have

**Look for** anything git ignores that the app or test suite reads: `.env`,
`.env.local`, `config/local.*`, `*.pem`/`*.key`, `secrets.*`, gitignored
fixture or seed data, a gitignored `CLAUDE.md`/`AGENTS.md`.

**Why it breaks** first turn, loudest, and often as a confusing error rather
than "file not found" — an empty `DATABASE_URL` reads as a connection bug.

**Fix, in order of preference:**

1. Make the file unnecessary — real defaults in code for everything that isn't
   a secret, so a bare checkout runs.
2. Commit a complete `.env.example` and have bootstrap copy it when `.env` is
   absent. Complete matters: an example missing three of the twelve vars is how
   this bug survives the fix.
3. For genuine secrets, read them from the environment or a secret manager,
   and fail with a message that names the missing variable and how to get it.

Copying `.env` from the main checkout into each worktree is what most worktree
tooling does and it's the option to reach for last: it re-shares exactly the
state (one database, one port, one API key) that this whole exercise is about
un-sharing.

### 2. Dependencies must install per worktree

**Look for** the manifest/lockfile pair and how big the installed tree is.
`N worktrees × 900MB` is the actual cost, and it doesn't shrink when a task
merges.

**Fix:** make the install cheap rather than clever. `references/ecosystems.md`
has the per-ecosystem table; the short version is that most package *caches*
(`~/.m2`, `~/.nuget`, `GOMODCACHE`, uv's cache) are already global and safe,
and the expensive outliers are Node and Rust.

**Don't** symlink one `node_modules` across worktrees. It only works while
every branch has identical dependencies, it fails silently when they don't, and
concurrent installs corrupt it. pnpm's global virtual store is the supported
way to get the same saving.

### 3. Ports

**Look for** literal ports in dev servers, test servers, debuggers, compose
port bindings, and anything a test binds. Two tasks running the app is the
normal case, not an edge case.

**Why it breaks** badly with agents specifically: `EADDRINUSE` reads like a bug
in the code, and an agent will cheerfully spend a turn editing application
logic over it.

**Fix:**

- Every port env-driven with a documented default: `PORT ?? 3000`, and the
  default documented in `.env.example`.
- **Tests bind port 0** (ephemeral) and read back the assigned port. A fixed
  test port is a guaranteed collision the moment two suites run at once, and
  running tests in parallel tasks is the whole point of this setup.
- Under Calandria specifically: managed services get a `PORT` injected, but an
  agent running `npm run dev` itself in its worktree gets nothing — so honoring
  `PORT` is what lets the agent pick a free one, and `expose_service` is how it
  publishes what it picked. See `references/calandria.md`.

### 4. Shared mutable state outside the repo

The quiet one. Ports fail loudly; a shared database corrupts two tasks' data
and shows up later as flaky tests.

**Look for** one fixed dev database (a `localhost:5432/appname` URL, a SQLite
file at a fixed path), fixed paths under `/tmp` or `$HOME`, cache directories
keyed by *project name* rather than path, a `docker-compose.yml` with literal
`container_name:` values or a default project name, and named volumes.

**Fix:**

- Derive the database name / data directory / socket path from the worktree, or
  make it env-driven with a default that includes the worktree basename.
- Compose: set `COMPOSE_PROJECT_NAME` from the worktree basename — it namespaces
  containers, networks and volumes in one move, with no compose-file edits.
  Then drop literal `container_name:` values, which override that namespacing.
- Publish compose ports through variables (`"${APP_PORT:-3000}:3000"`).
- Anything keyed on a project identity should key on
  `git rev-parse --git-common-dir`, which is the same string in every worktree
  of one repo. `--git-dir` is not.

### 5. Tooling that assumes `.git` is a directory

**Look for** tracked scripts, hooks, CI config, Dockerfiles and tool config
that reference `.git/` as a path, bind-mount the repo into a container and then
run git in it, or read `.git/HEAD` directly.

**Why it breaks:** in a worktree `.git` is a file pointing outside the
worktree, so the path doesn't resolve — inside a container it can't resolve
even in principle. Real instances: Composer defaults the root package version
to `1.0.0`; containerized CI runners fail `actions/checkout`; a tool that
cached its project id at `.git/<name>` computed a different id per worktree and
fragmented its own state.

**Fix:** `git rev-parse --git-dir` / `--git-common-dir` / `--git-path <file>`
instead of literal `.git/...`. Never assume which of the two you want without
deciding: `--git-common-dir` for anything shared by the whole repo (refs, the
object store, a project identity), `--git-dir` for anything private to this
worktree.

### 6. Submodules, LFS, hooks

- **Submodules** are not initialized in a new worktree, and git's own docs still
  call multi-checkout support for them incomplete. If the repo has any, the
  bootstrap command must run `git submodule update --init --recursive`, and the
  repo should say so.
- **LFS** materializes a full copy of every tracked blob per worktree. Nothing
  dedupes it. Worth naming in the repo's docs as a disk-cost warning.
- **Hooks** live in the shared git dir, so they already apply to every worktree.
  Two traps: a `prepare`-script installer (husky, lefthook) hasn't run in a
  fresh worktree until dependencies are installed; and a global
  `core.hooksPath` can be silently overwritten in the *main* repo's config by a
  worktree-creating tool that writes it unscoped. If the repo depends on hooks
  for correctness rather than convenience, that's worth stating.

### 7. One bootstrap command

Everything above converges here. Because no setup hook runs for you, the repo's
answer to "you have a bare checkout, now what" has to be a single idempotent
command — `make bootstrap`, `just setup`, `npm run setup`, `./scripts/setup.sh`
— that installs dependencies, seeds config from examples, initializes
submodules and does nothing when already done.

Then **name it where the agent will read it**: `AGENTS.md` and/or `CLAUDE.md`
at the repo root, in the first few lines, phrased as "run this first in a fresh
checkout". A bootstrap command nobody is told about is worth about as much as
none, and this file is the only per-worktree setup mechanism that exists today.

## What to hand back

Produce a findings report before changing anything:

| Finding | Cost when parallel | Fix | Effort |
|-|-|-|-|

Rank by what actually bites: files that don't exist and shared writable state
first, disk cost last. Then propose the patch. Apply it if the user asks, one
finding per commit so a fix that turns out wrong can be dropped on its own.

Say what you are *not* fixing, too. "This repo needs a running Postgres that
all worktrees share, and splitting that per-task is a bigger change than this"
is a legitimate finding; silently leaving it out is not.

Two things to resist:

- **Don't fix the worktree you're in.** Writing an `.env` into this checkout
  makes this task work and teaches the repo nothing. The change belongs in
  tracked files.
- **Don't add a tool.** A worktree manager, a port broker or a devcontainer may
  well be right for the user, but it's their call and it's out of scope for a
  repo audit. Note it as an option, with what it would buy.

## Prove it

The check that actually settles it, run from the repo (not from a worktree
you're already working in — you can't check out the same branch twice):

```bash
git worktree add /tmp/wt-probe HEAD --detach
cd /tmp/wt-probe && <bootstrap command> && <test command>
# and, if the repo serves anything, start it while the original is running
git worktree remove /tmp/wt-probe --force
```

A green run here is the claim. Everything before it is an argument. If the
sandbox forbids creating worktrees, say that the verification didn't run rather
than reporting the fixes as confirmed.

## References

- `references/ecosystems.md` — per-ecosystem install cost and what is safe to
  share (Node/pnpm, Python, Go, Rust, JVM, Ruby, PHP, .NET, Docker).
- `references/fixes.md` — copy-paste recipes: bootstrap script skeleton,
  compose namespacing, env-driven ports, ephemeral test ports, `.env.example`
  completeness check.
- `references/calandria.md` — what Calandria does and does not do to a
  worktree, and the project settings that interact with this.
