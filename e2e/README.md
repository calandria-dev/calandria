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

## How it stays hermetic and deterministic

- **Fresh instance per run** — `e2e/env.ts` creates a temp root (DB, worktrees,
  projects, fixture repos, pinned gitconfig) and points every `ORCH_*` dir at it.
  Nothing touches `~/.zen-orchestrator` or your real projects; the app listens on
  port 4711 (`ORCH_E2E_PORT` to move it). Analytics are disabled.
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
