# Per-ecosystem cost and what is safe to share

Contents: [The general shape](#the-general-shape) · [Node](#node) ·
[Python](#python) · [Go](#go) · [Rust](#rust) · [JVM](#jvm) · [Ruby](#ruby) ·
[PHP](#php) · [.NET](#net) · [Docker](#docker) · [Build caches](#build-caches)

## The general shape

Two different things get called "the cache" and they behave oppositely:

- A **package cache** (downloaded artifacts, content-addressed by version+hash)
  is global, already shared across every checkout on the machine, and safe. You
  almost never need to do anything here.
- An **installed dependency tree or build output** (`node_modules`, `.venv`,
  `target/`, `bin/obj/`) is per-checkout, path-sensitive, and expensive. This
  is what a worktree pays for again.

So the question for each ecosystem is: how big is the second one, and does the
ecosystem offer a supported way to make it cheap? Only two ecosystems really
do, and one hand-rolled technique exists for a third.

## Node

| Manager | Per-worktree cost | Safe sharing |
|-|-|-|
| npm / yarn | Full `node_modules` install, commonly 300MB–1GB | None supported |
| pnpm | Near-zero with a global virtual store | Yes, supported and documented |
| bun | Full install, fast | None specific |

pnpm's global virtual store is the one first-class answer in this whole
document. In `pnpm-workspace.yaml`:

```yaml
virtualStoreType: global
```

(`enableGlobalVirtualStore: true` on pnpm before 11.23.) Each worktree still
gets its own real `node_modules` directory, so different branches can hold
different dependency versions; the contents are just links into one
content-addressable store. Migrating npm to pnpm for this reason alone is a
legitimate recommendation for a repo that expects many worktrees, but it's a
real migration and it's the user's call.

**Do not share one `node_modules` between worktrees by symlinking it.** It
appears to work while every branch has identical dependencies and fails
silently when a branch changes one, and concurrent installs in two worktrees
corrupt the directory. Making `node_modules` itself a symlink also breaks pnpm
outright.

**Never let a worktree land inside a workspace root.** If the worktrees
directory is inside a repo with `pnpm-workspace.yaml` or a `workspaces` field,
an install run inside the worktree walks up, finds the parent workspace, and
re-points symlinks in the *parent's* `node_modules` into the worktree's store.
Delete the worktree later and the main checkout's build breaks with resolver
errors that have nothing to do with what you changed; the only fix is a full
`rm -rf node_modules && install`. Keep worktrees outside the repo, as
Calandria already does.

## Python

| Manager | Per-worktree cost | Safe sharing |
|-|-|-|
| uv | Seconds; content-addressed cache, hardlinks into `.venv` | Automatic |
| pip + venv | Full download+build per worktree | None |
| poetry | Venv per project path under `~/.cache/pypoetry` | Per-path, so no reuse but no conflict either |
| pipenv | Similar to poetry | Same |

uv is the fast path and needs no configuration to be worktree-friendly. On pip,
`PIP_CACHE_DIR` is already global and helps with download time but not build
time.

## Go

Nothing to do. `GOMODCACHE` (module downloads) and `GOCACHE` (build cache) are
both content-addressed, global by default, and safe across worktrees.

One caveat: tools layered *on* the build cache can leak absolute paths from
whichever checkout populated an entry. golangci-lint has an open issue where
cached findings come back pointing at a stale worktree path. If lint results
look impossible, clear that tool's own cache before believing them.

## Rust

The expensive one. `target/` is per-worktree and a cold build is minutes and
gigabytes.

Two obvious fixes both fail:

- A shared `CARGO_TARGET_DIR` runs into Cargo's build lock: only one build at a
  time across every worktree sharing it, so a background agent's build blocks
  a human's.
- `sccache` includes the working directory in its cache key, so worktrees miss
  each other by construction. `--remap-path-prefix` doesn't rescue it, since
  sccache doesn't interpret the flag and a differing flag is itself a new key.

What has been made to work is hardlinking the *immutable dependency* artifacts
(not workspace-crate output) plus their `.fingerprint` entries between
worktrees, using a hand-rolled script rather than a Cargo feature. Mention it
as an option; don't present it as standard practice.

## JVM

`~/.m2/repository` (Maven) and `GRADLE_USER_HOME` (Gradle, default `~/.gradle`)
are already global, safe, worktree-agnostic dependency caches. Build output
(`build/`, `target/`) is per-worktree and that's correct. Gradle daemons are
per-JVM-config, not per-checkout, so several worktrees share them fine.

Nothing to change in most repos.

## Ruby

Default RubyGems home is global and versioned, so it's safe to share. If the
repo sets `bundle config path vendor/bundle`, every worktree pays a full
install. Check whether that setting is still earning its keep.

## PHP

`vendor/` is per-worktree with no sharing mechanism. Composer additionally
**cannot detect the root package version from a linked worktree**: `.git` is a
file, so version detection falls back to `1.0.0`, which quietly changes
constraint resolution. Setting `COMPOSER_ROOT_VERSION`, or a `version` field in
`composer.json`, is the standard escape hatch for that class of failure; verify
it on the repo rather than assuming.

## .NET

`~/.nuget/packages` is global and safe. `bin/` and `obj/` are per-worktree and
path-sensitive; that's inherent to MSBuild. SDK and toolchain installs are the
genuinely unsolved part: on large projects they're shared but unversioned, so
two worktrees needing different toolchain versions clobber each other, and a
`make clean` in one can delete what another is using. There's no shipped fix;
name it as a risk rather than proposing a workaround.

## Docker

Every worktree's compose stack collides by default: project name, container
names, published ports, and named volumes. One variable fixes most of it:

```bash
export COMPOSE_PROJECT_NAME="$(basename "$PWD")"
```

That namespaces containers, networks and volumes per worktree without touching
the compose file. Then remove literal `container_name:` values, which override
the namespacing, and make published host ports variables
(`"${APP_PORT:-3000}:3000"`).

Bind-mounting the checkout into a container has a separate problem: a
worktree's `.git` is a file pointing *outside* the mount, so git inside the
container fails with `fatal: not a git repository`. If the container genuinely
needs git metadata, pass what it needs in (a commit SHA as a build arg) rather
than expecting the mount to carry it.

## Build caches

Tool-specific, and the one area with no general rule:

- **Turborepo** now detects worktrees and shares the main worktree's cache
  automatically. If a cached artifact embeds an absolute path, that's wrong
  across worktrees; setting an explicit `cacheDir` in `turbo.json` opts out
  and isolates them. Older versions had the opposite behavior (cache misses
  purely from the differing path), so check the installed version rather than
  assuming either.
- **`.next`, `dist`, `__pycache__`, `.gradle/build`** are per-worktree and
  should stay that way. They're cheap to regenerate and expensive to get wrong.
- Anything keying a cache on **project identity** should key on
  `git rev-parse --git-common-dir`, which is identical across every worktree of
  one repo. Keying on `--git-dir`, or on the checkout path, fragments state per
  worktree; this is a real bug that shipped in at least one coding agent.
