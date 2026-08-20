---
name: running-tests
description: Use when running, scoping, rerunning, or debugging this repo's tests — vitest unit tests, typecheck, Playwright e2e, or the preflight gate — including when a run behaves oddly under Docker or a test fails only inside the container.
---

# Running tests

Tests run **in a container, through the committed harness**. Don't hand-roll a
`docker run`: `scripts/docker-test.sh` already encodes the mount layout, the
shared `node_modules` volume, `--init`, and the Playwright version pin — each
added because its absence produced a confusing failure.

## Pick the command

| Intent | Command |
|-|-|
| Unit (vitest) | `npm run test:docker` |
| One test file | `npm run test:docker -- tests/merge.test.ts` |
| Typecheck | `npm run typecheck:docker` |
| End-to-end | `npm run test:e2e:docker` |
| Pre-push gate (unit + e2e) | `npm run preflight:docker` |

Sources of truth for those: `package.json`, `scripts/docker-test.sh`,
`docker/test/Dockerfile`.

**A file path passes straight through; a FLAG needs a second `--`.** The args
land in a plain `npm test` inside the container, and npm consumes leading flags
itself — `-t` becomes npm's own `--tag`, silently, and vitest runs the file
unfiltered:

```bash
npm run test:docker -- tests/merge.test.ts                    # ✅ one file
npm run test:docker -- tests/merge.test.ts -t "conflicts"     # ❌ -t swallowed; all 24 run
npm run test:docker -- -- tests/merge.test.ts -t "conflicts"  # ✅ reaches vitest
```

## node_modules is a shared named volume

The checkout is bind-mounted at `/work`; `node_modules` is the named volume
`orch-test-node-modules`, reinstalled only when `package-lock.json` changes. That
install is a one-time cost every later run — and every other worktree — inherits.

A worktree having no `node_modules` of its own is **normal**, not something to
fix. `docker volume rm orch-test-node-modules` only to force a clean install (a
wedged tree, or proving a dependency change from scratch); it costs a full
`npm ci` on the next run of every worktree. `ORCH_TEST_REBUILD=1` after editing
anything under `docker/test/` — the wrapper skips the build when the image tag
already exists.

## Reading a result

- **A red `services.test.ts` is a REAL failure.** Its "reaps the orphaned process
  group" case fails in a container only when `docker run` lacks `--init` (the test
  process becomes PID 1, and PID 1 doesn't reap orphans). This wrapper passes
  `--init`. Don't wave it through as a container artifact, and don't report the
  run as green-except-one.
- **e2e executes the BUILT bundle.** `test:e2e:docker` builds first;
  `test:e2e:only` doesn't. After editing anything under `lib/` or `app/`, use the
  building form — otherwise you assert against a stale `.next` while reading the
  new source. (That built server is also the only place the Turbopack
  async-module class of bug appears at all — see CLAUDE.md on `DYNAMIC_ONLY`.)
- `fatal: not a git repository` from git at `/work` is expected noise: a task
  worktree's `.git` is a *file* pointing outside the mount. Neither suite needs it
  — both build fixture repos under a temp root. Run git on the host.
- Otherwise report the exact command and the failing test. Don't substitute an
  environmental explanation you haven't reproduced.

## Only when diagnosing wrapper startup

These explain a harness that won't mount or launch. **They are never reasons to
discount a test failure once the wrapper has started.**

- **A hand-rolled bind mount can be silently EMPTY.** Where the Docker daemon
  doesn't share the shell's filesystem namespace, `-v <path>:/work` mounts an
  empty directory instead of failing, and surfaces much later as something
  unrelated — classically `npm ci` insisting there is no `package-lock.json`
  while the lockfile is plainly there. The wrapper mounts `$PWD`. If you must
  mount by hand, verify before trusting it:
  `docker run --rm -v <dir>:/w node:22 ls /w | wc -l`.
- **An executable on a `noexec` mount is skipped, not refused.** `/tmp` is
  commonly mounted `noexec`; a `chmod +x` shim placed there passes `ls` but fails
  `access(X_OK)`, so PATH lookup steps over it and the real binary runs with no
  error anywhere. Put anything meant to be executed under `$HOME`. (The wrapper
  needs no shim — this only bites when you build one.)

## The recipe itself

`e2e/README.md` is the source of truth for the container recipe and its reasoning
— why a `node:22` base rather than the Playwright image, the browser version pin,
`ORCH_TEST_USER` on a daemon that doesn't remap bind mounts — plus the mock
agent's turn directives and the spec inventory. Read it before changing the
harness or adding e2e coverage.
