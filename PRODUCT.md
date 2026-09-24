# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The design language is the web app's. Two wrappers ship it without changing that: an Electron
desktop app (`desktop/`) and an installable Progressive Web App (`public/sw.js`, documented in
`docs/FEATURES.md` under "Install as an app"). Below 760px the shell becomes a single pane with a
bottom tab bar ("On a phone" in the same doc).

## Users

The primary user is a solo developer self-hosting Calandria for their own repositories. They run
several agent sessions in parallel across several projects and check in from a laptop, a tablet
or a phone while the agents keep working. They usually arrive at a state they did not watch
unfold: sessions have finished, parked on a question, gone red in CI, or filed new tasks since
they last looked.

A small team sharing one instance is not a confirmed audience. Cloudflare Access mode exists as an
auth boundary, not as a multi-user product target.

## Product Purpose

Once a developer can launch any number of coding agents in parallel, the problem becomes keeping
track of them all. Calandria puts structure around those sessions and lets agents help the user
manage work as tasks, units of work with a status, a branch and a landing path, instead of as
sessions and terminals.

Success means the user always knows where they are needed, nothing an agent did is lost or
orphaned, and finished work lands (merged, PR opened, checks green, worktree reclaimed) without
leaving the app.

The README's current lead copy is out of date on this point. Its feature bullets are accurate;
the headline should be the control-room framing above.

## Positioning

Calandria is a self-hosted control room for many coding agents across many projects, usable from
any browser. What a neighboring tool cannot truthfully copy is the combination of:

- **The task as the unit of work.** Every task owns a git worktree, a branch, a session lineage
  that survives `/clear`, a status, dependencies (`blocked_by`), a base branch and a landing
  lifecycle (diff, merge or PR, CI state, reclaim). The transcript is how the task gets done, not
  the thing being managed.
- **Structure over the whole fleet.** Projects carry reusable context; tags group tasks into
  ordered pipelines that auto-start dependents; runbooks and schedules mint tasks; one
  cross-project inbox ("Needs you") lists every session waiting on a person.
- **Agents as participants in management.** A session can file tasks into any project, order
  them, edit and move them, withdraw suggestions, create runbooks and draft bug reports. The user
  keeps consent over anything outward-facing (publishing an issue, merging, permissions).

Supporting facts that are true but not the headline: it runs on the user's existing Claude or
ChatGPT login with no API key, and it drives Claude Code, OpenAI Codex and Antigravity through one
driver interface.

## Operating Context

- Git repositories on the user's machine or server; one worktree per task, always outside the
  repo; GitHub pull requests, checks and auto-merge where the repo allows it.
- Agent CLIs installed and logged in locally: Claude Code, Codex, Antigravity. Local models and a
  LiteLLM gateway are documented options (`docs/AGENTS.md`).
- Self-hosted on a laptop or a server, optionally behind a Cloudflare tunnel with Access. Turns run
  detached on the server, so a page reload, a sleeping laptop or a dropped tunnel interrupts
  nothing.
- Surfaces the user works in: the three-column workspace (projects, tasks, live session with
  Diff / Preview / Context rail), the task board, the inbox, an embedded terminal, managed
  services with preview URLs, the Insights usage dashboard, collaborative documents, Settings.
- Rituals: planning turns that file a batch of tasks; morning check-ins on the inbox; scheduled and
  runbook-driven recurring work; review-and-merge passes over diffs; Fix CI turns seeded from a
  failing job's log.
- Keyboard use on desktop is a first-class path: `⌘K`/`Ctrl+K` opens the command palette,
  `⌘⇧B`/`Ctrl+Shift+B` toggles list and board, `Escape` closes panels, and arrow keys move through
  pickers. The identity handoff also specifies single-key task navigation (`j`/`k` move, `enter`
  open, `t` terminal, `d` diff, `n` new); those keys are not implemented yet.

## Capabilities and Constraints

Terminology (defined in `README.md` and `docs/FEATURES.md`):

- **Project**: a working directory plus reusable context sent into every task.
- **Task**: one unit of work; owns a worktree, branch and agent session lineage.
- **Session / generation**: the agent conversation behind a task; `/clear` ends a generation and
  seeds the next with a summary.
- **Turn**: one agent response cycle, from a sent message to the agent finishing.
- **Needs you**: the cross-project inbox of sessions parked on a question, permission or red build.
- **Tag**: groups tasks, can order them as a pipeline and set a shared base branch.
- **Runbook**: a saved prompt plus agent and permission settings; Run mints a task.
- **Schedule**: a runbook or prompt fired on a wall-clock cadence; each firing mints a task.
- **Suggestion**: a task an agent filed, awaiting Start, Add or Dismiss.
- **Reclaim**: after work lands, fast-forward base, remove the worktree, delete the branch, mark
  done.
- **Services**: project-defined long-running processes with logs and optional public URLs.
- **Insights**: usage and outcome dashboard (spend, tokens, tasks shipped, lines merged).

Binding constraints (confirmed by the product owner):

- **Mobile and tablet are first-class.** Every surface must work on a phone as a full
  interaction, not a read-only fallback.
- **Dark and light themes are both required** and equal in quality. Four themes ship, each with a
  dark and a light variant; the OS setting is followed unless pinned.

Technical and scope constraints:

- Self-hosted only, no control plane. No hosted, fleet, billing or first-party identity features.
  Auth is local no-login mode or Cloudflare Access.
- Every per-instance knob is an environment variable with a documented default.
- Long work is a detached background job; nothing multi-minute holds an HTTP request.
- `app/globals.css` is one flat class namespace; new component classes get a prefix.
- English only. Internationalization is not planned and not refused; undecided.

Explicitly undecided product facts:

- Whether the three-column desktop shell is settled structure. The owner declined to mark it
  binding, so it is open to proposals; the phone layout is its own committed structure.
- A formal accessibility standard (none chosen; see below).
- Whether a shared multi-user instance is ever a target audience.

## Brand Commitments

- **Name**: Calandria. Wordmark in title case, never all-caps in the lockup.
- **Identity**: the rebrand recorded in `docs/design/handoff/README.md` is settled and final
  with the product owner and is implemented in `app/globals.css`. It fixes the logomark (a 3×3
  isometric lattice of control rods, `currentColor`), the wordmark (Spectral 500), the type
  system (Spectral for display, Source Sans 3 for body, JetBrains Mono for code), the four named
  themes (Cherenkov, the default, plus heavywater, denoche and basic) and their tokens, and the
  focus and reduced-motion rules. Future visual work extends this identity; it does not replace it
  without a new owner decision.
- **Tagline**: "One vessel, many channels: your agent fleet, from any browser."
- **Assets**: `docs/design/handoff/assets/` holds `logo.svg`, `favicon.svg` and `favicon-small.svg`;
  `docs/design/og.png` (1200×630 social image), `public/icons/` (PWA icons).
- **Voice**: plain technical prose in UI copy and docs. Active voice, one idea per sentence, no
  em dashes, no "not X but Y" constructions, no design-justification asides. The rules live in
  the repo's `CLAUDE.md` and are CI-checked for docs and comments.
- **User-selectable fonts** are part of the product, not a theme detail: code/terminal font and
  prompt-input font are each chosen in Settings → Appearance; labels say "font", never "face".

## Evidence on Hand

Real screenshots referenced by the README and docs, in `docs/images/`:

| File | Shows |
|-|-|
| `workspace.png` | Workspace with projects and parallel agent tasks |
| `board.png` | Task board with a tagged three-step pipeline and auto-start chips |
| `changes.png` | Diff review beside the agent session |
| `inbox.png` | "Needs you" inbox listing sessions waiting on answers |
| `insights.png` | Spend, tokens, tasks shipped, lines merged over 30 days |
| `project.png` | A tag with brief, two runbooks and a weekday schedule |
| `mobile.png` | A session waiting on an answer, on a phone |
| `mobile-tasks.png` | Task list on a phone |

Feature documentation in `docs/` (FEATURES, AGENTS, SERVICES, INSIGHTS, DOCUMENT_COLLABORATION,
SELF_HOSTING) is current product truth. The public site and docs at calandria.dev live in a
separate `website` repo.

Absent, and not to be fabricated: customer names, testimonials, case studies, benchmarks, pricing
or plan tiers, user counts, press.

License: Apache-2.0, copyright "The Calandria authors".

## Product Principles

1. **The task is the unit of work.** Status, dependencies, branch and landing state live on the
   task. A session is how a task gets done and is never what the user has to manage.
2. **Show where the user is needed first.** Parked questions, permissions and red builds surface
   before anything else; everything not waiting on a person keeps running unattended.
3. **Agents help manage, the user consents.** Agents may file, order, edit and move tasks and
   draft reports. Anything outward-facing or irreversible waits for the user's explicit action.
4. **One workspace on every device.** A phone check-in can answer, start, review and merge, with
   the same information as the desktop, reflowed, never reduced.
5. **Work lands inside the app.** Diff, merge or PR, CI state, conflict resolution and reclaim
   complete without opening a terminal or GitHub.

## Accessibility & Inclusion

No formal standard has been chosen; the owner left WCAG 2.2 AA unselected. Committed practice
in the identity handoff and CSS: `prefers-reduced-motion` disables pulse dots and caret blink,
mobile hit targets are at least 44px, and Atkinson Hyperlegible fonts are offered as code and
prompt-input choices. The handoff also requires a 2px accent focus outline on every interactive
element and never `outline: none`. `app/globals.css` still sets `outline: none` on several
fields and inputs, some of which substitute a border or ring on focus, so that rule is not yet
met everywhere. Future work keeps these; whether to hold surfaces to a named standard is an open
decision.
