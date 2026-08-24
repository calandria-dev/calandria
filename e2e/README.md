# End-to-end suite

Playwright tests that boot the **real production server** (`npm start` — `server.js`
+ the pty sidecar, exactly what a self-hoster runs) against a **throwaway
instance** and drive the app the way a user does: through the browser and the
public REST routes. One command before pushing:

```bash
npm run preflight     # vitest unit suite + build + full e2e run
```

or just the e2e half:

```bash
npm run test:e2e        # next build + playwright test
npm run test:e2e:only   # skip the rebuild — ONLY safe if app code didn't change
npx playwright test e2e/03-views.spec.ts   # one spec (post-01 specs self-onboard)
```

## Running the suites in a container

The project rule is to run tests in a **separate docker container**, and this is
the committed recipe for it — `docker/test/Dockerfile` plus
`scripts/docker-test.sh`, wired to four npm scripts:

```bash
npm run test:docker        # vitest
npm run typecheck:docker   # next typegen && tsc --noEmit
npm run test:e2e:docker    # next build && playwright test
npm run preflight:docker   # unit + e2e, the pre-push gate
npm run test:docker -- tests/merge.test.ts   # args pass through
```

Nothing is baked into the image: the checkout is bind-mounted at `/work` and
`node_modules` is a **named volume** (`orch-test-node-modules`), so the install
is a one-time cost the next run — and every other worktree — inherits. The
container's entrypoint reinstalls only when `package-lock.json` changes; wipe
the volume (`docker volume rm orch-test-node-modules`) to force a clean tree.

Three things this exists to stop you rediscovering:

- **A worktree has no `node_modules`, and you cannot borrow the main
  checkout's.** That tree was installed on macOS — it carries
  `@rollup/rollup-darwin-arm64` and no Linux binary — so vitest will not start
  against it from a Linux container. The volume is the fix.
- **Don't build on `mcr.microsoft.com/playwright:v*-noble`.** It ships Node 24,
  which has no `better-sqlite3` prebuild and no compiler, so `npm ci` dies on
  `gyp ERR! not found: make`; hand it a toolchain and the app still fails to
  boot with `ERR_DLOPEN_FAILED` / "Module did not self-register", which reads
  like a product bug and reds every spec including 01-onboarding. The image
  here puts the browsers on a **`node:22`** base instead, so both native
  modules stay on their prebuilds.
- **Pin the browsers to the installed Playwright.** `scripts/docker-test.sh`
  reads the resolved `@playwright/test` version out of `package-lock.json` and
  puts it in both the build arg and the image tag, so a version bump rebuilds
  the image instead of silently re-downloading chromium on every run.

Caveat, harmless but alarming: a task worktree's `.git` is a *file* pointing at
`<parent repo>/.git/worktrees/<id>`, which is outside the mount, so any git
command run at `/work` prints `fatal: not a git repository`. Neither suite cares
— both build their own fixture repos under a temp root with a pinned gitconfig
— but don't read it as a broken checkout. Run git on the host.

Knobs (all optional): `ORCH_TEST_VOLUME` to use a different node_modules volume,
`ORCH_TEST_USER=$(id -u):$(id -g)` on a Linux daemon that does *not* remap bind
mounts (otherwise `.next/` and `test-results/` come back root-owned; OrbStack
and Docker Desktop remap, so the default root user is fine there), and
`ORCH_TEST_REBUILD=1` after editing anything under `docker/test/` — the wrapper
skips the build when the tag already exists.

## How it stays hermetic and deterministic

- **Fresh instance per run** — `e2e/env.ts` creates a temp root (DB, worktrees,
  projects, fixture repos, pinned gitconfig) and points every `ORCH_*` dir at it.
  Nothing touches `~/.zen-orchestrator` or your real projects; the app listens on
  port 4711 (`ORCH_E2E_PORT` to move it).
- **No real agent needed** — the suite sets `ORCH_E2E_MOCK_AGENT=1`, which
  registers the deterministic mock driver (`lib/agents/mock/driver.ts`) in the
  agent registry. It implements the full `AgentDriver` contract — instant login,
  verify, streamed turns (session/model/tool/assistant/usage/done), commits its
  work like a real agent — so onboarding, turns, diffs, and merges all run
  end-to-end with zero credentials and identical output every time.
- **Scripted turns** — mock behavior is driven by directives embedded in the
  prompt (title/description for the initial turn, message text after):

  | Directive | Effect |
  |-|-|
  | `e2e:write=<relpath>:<content>` | write that file in the task worktree |
  | `e2e:sleep=<ms>` | hold the turn open (Stop / queueing tests) |
  | `e2e:fail=<message>` | end the turn with an error event |
  | `e2e:suggest=<title>` | create a suggested task + emit the event |
  | `e2e:suggest-into=<project>\|<title>` | file the suggestion into ANOTHER project (id or name), through the real strict resolver — an unknown ref yields an error event |
  | `e2e:permission=<command>` | park the turn on a tool-permission card for that Bash command (runs the real `lib/permissions.ts` gate) |
  | `e2e:blocked=<command>` | that Bash call refused by the CLI itself — an already-decided card with no buttons, nothing parked on the user |
  | *(none)* | append the prompt to `AGENT_NOTES.md` (so every turn has a diff) |

## Specs

| File | Covers |
|-|-|
| `01-onboarding.spec.ts` | first-run wizard: connect agent → verify → tutorial seeded (must run first — needs the untouched fresh DB) |
| `02-core-flow.spec.ts` | the core loop through the UI: new project → new task → session runs → transcript streams → diff → merge to main → file really lands on the base branch |
| `03-views.spec.ts` | list ⇄ board (kanban) toggle, status columns, card placement |
| `04-turn-behaviors.spec.ts` | mid-turn queueing, Stop, failed-turn notices, suggestions tray, session resume |
| `05-api-smoke.spec.ts` | REST contracts: diff/sync shapes, `/clear` generation lineage, agent registry, hard deletes |
| `06-move-task.spec.ts` | re-filing an unstarted task to another project from the Edit modal |
| `07-move-tasks-bulk.spec.ts` | multi-select + Move to project… : one request for a whole selection, refusals reported |
| `08-move-started-task.spec.ts` | re-filing a task that has RUN: the worktree it must discard is named, confirmed twice, reclaimed — and its next turn lands in the destination repo |
| `09-permissions.spec.ts` | the tool-permission gate: a turn parks on a card, Allow once resumes it, Decline feeds the reason back, "Always allow" stores a project rule that skips the next prompt and is revocable in Settings |
| `13-notifications.spec.ts` | browser notifications: a parked task notifies a tab looking elsewhere, stays silent when you're watching that very task, and a failed turn notifies |
| `15-collab-doc.spec.ts` | document collaboration mode: a markdown file in the diff opens as a document, a selected passage takes a comment, the source is edited, and Send lands ONE message in the transcript — the edit as a patch (agent applies it) or written straight into the worktree (the default; the diff rides along as context), the comment with its located line; plus the worktree file route's path guard and the write route's two refusals (live turn, file changed since load) |

The suite runs serially (one shared app instance + SQLite DB). Every spec after
01 calls `ensureOnboarded()` in `beforeAll` and creates its own uniquely-named
project, so they're independently runnable.

## Adding coverage

- New UI flow → prefer role/title/placeholder selectors (the app has no
  `data-testid`s); scope title text to a container class when it renders in
  several places (list row, board card, session header).
- New agent-visible behavior → add a directive to the mock driver rather than
  special-casing a spec.
- Changed `lib/` or `app/` code → re-run `npm run test:e2e` (not `:only`): the
  server executes the **built** bundle, so a stale `.next` will test old code.
