# Contributing

Thanks for your interest in Calandria!

Questions and feature ideas belong in
[GitHub Discussions](https://github.com/calandria-dev/calandria/discussions). Reproducible
bugs belong in [Issues](https://github.com/calandria-dev/calandria/issues). For the full
map, see the [community guide](docs/COMMUNITY.md).

## Getting started

```bash
npm install
npm run dev       # app on :3000, pty sidecar on 127.0.0.1:3001
npm run typecheck # next typegen + tsc --noEmit; seconds, and CI runs exactly this
npm test          # vitest, serial: tests spawn real git subprocesses
npm run test:e2e
npm run preflight # unit + end-to-end suite; the pre-push gate
```

One thing to know before you commit a `package-lock.json` change: the `better-sqlite3`
entry carries a hand-written `"gypfile": false` that npm strips every time it rewrites the
lockfile, and without it `npm ci` compiles the package from source and fails on Windows.
`tests/lockfileGypfile.test.ts` fails if it goes missing. Re-add it by hand rather than
regenerating the lockfile; [docs/WINDOWS.md](docs/WINDOWS.md#what-ci-proves) has the why.

`CLAUDE.md` is the codebase map (architecture, conventions, gotchas). Read it before a
nontrivial change. TypeScript is strict and there is no lint script, so `npm run typecheck`
is the only static check. (`next typegen` writes the gitignored `next-env.d.ts`
and `.next/types` that `tsconfig.json` includes, so a fresh clone checks the same files
`next build` does.)

Each of those commands has a `:docker` twin (`npm run test:docker`, `typecheck:docker`,
`test:e2e:docker`, `preflight:docker`) that runs it in a throwaway Linux container with
its own `node_modules` volume and matching Playwright browsers, for getting a green
run out of a checkout whose dependencies were installed on another platform. If you work
with an agent that reads Claude Code skills, `.claude/skills/running-tests/` encodes the
same workflow.

The end-to-end suite builds the production app and drives onboarding, project/task
creation, turns, diff, merge, and workspace views against a disposable instance. It uses
the deterministic mock agent, so no agent CLI or login is required. See
[`e2e/README.md`](e2e/README.md), which also documents the container harness.

## Continuous integration

`.github/workflows/test.yml` runs `npm run typecheck` and `npm test` on every pull request
and every push to `main`, as two independent jobs, and the image publish gates on both: a
red suite never reaches the registry.

The e2e suite is much slower, so it doesn't run on every push. It runs on `main`, and
on a pull request labelled `e2e`. Add that label when a change touches the core flow
(onboarding, turns, diff, merge) and you want the browser-level proof before merge.

`.github/workflows/pr-title.yml` is a separate, seconds-long job that checks your pull
request **title** parses as a Conventional Commit. It has its own workflow because it must
run on PRs that `test.yml` skips (website-only changes) and must re-run when you retitle.
See [Pull requests](#pull-requests) for why the title matters.

## Pull requests

**Every change lands through a pull request.** Direct pushes to `main` are rejected by a
repository ruleset — there is no bypass list, so this applies to maintainers and to agents
as much as to first-time contributors. A branch that is "just a docs fix" still opens a PR.

The ruleset also fixes two things about how a PR lands:

- **Squash merge only.** Merge commits and rebase merges are refused. Your branch becomes
  exactly one commit on `main`, however many commits you pushed to it.
- **One approving review** is required before the merge button works.

### Your PR title becomes the commit message

Because the merge is a squash, GitHub composes the single resulting commit's subject from
the pull request, and `.github/workflows/release-please.yml` then reads exactly those
subjects — every commit since the last tag — to decide the next version number and to write
`CHANGELOG.md`.

A subject release-please can't parse isn't an error. It's simply skipped: no version bump,
no changelog line, nothing in the logs. A PR titled `Fix the thing` ships a real bug fix
into a release whose notes don't mention it, and there is no later point at which anybody
finds out.

So the title has to be a [Conventional Commit](https://www.conventionalcommits.org/):

```
<type>[(scope)][!]: <description>
```

| Type | Effect |
|-|-|
| `feat` | Minor bump; listed under **Features** |
| `fix` | Patch bump; listed under **Bug Fixes** |
| `perf`, `revert` | Listed in the changelog, no bump |
| `docs`, `style`, `chore`, `refactor`, `test`, `build`, `ci` | Recorded, hidden from the changelog |

Those twelve are the whole list. A type outside it (`update:`, `chores:`) parses as a
commit and is then dropped by the changelog writer — the same silent loss as no type at
all — so the CI check refuses it rather than letting it through.

A `!` before the colon marks a breaking change. While Calandria is pre-1.0 that moves the
**minor** version, not the major (`bump-minor-pre-major` in `release-please-config.json`).

```
feat: surface a red PR in the "Needs you" inbox
fix(runner): keep a queued follow-up in its own worktree
docs: document the Conventional Commit PR title requirement
feat!: drop the control-plane interop routes
```

Reverting needs the `revert:` type; GitHub's default `Revert "..."` title doesn't parse.
If the check goes red, edit the title — it re-runs by itself, with no new push.

**Write your commit subjects the same way.** The repository's `squash_merge_commit_title`
is `PR_TITLE`, so the title the check just passed is the subject that lands, whether your
branch has one commit or twenty. Conventional subjects on the branch are still worth
writing: they are what the squash commit's body preserves, and they are the fallback if
that setting ever drifts back to `COMMIT_OR_PR_TITLE`, which takes a single-commit
branch's own subject instead — the way three fixes went missing from the 0.4.0 changelog
with every check green.

## Before starting

- Search existing issues and discussions first.
- For nontrivial features, open an Ideas discussion and agree on scope before investing in
  an implementation.
- Comment on an existing issue before claiming it. Issues labelled `good first issue` or
  `help wanted` are intended for community contributions.

## Ground rules

- **One change per PR**, with a commit message that explains why, not just what.
- **Tests:** bug fixes come with a regression test; behavior changes update the affected
  tests. `npm test` must be green.
- **Documentation stays current:** if you change user-visible behavior, update `README.md`
  or the relevant file under `docs/` in the same PR.
- **Env-driven config:** a new per-instance knob is an env var with a documented default,
  added to `lib/config.ts` (or `lib/features.ts` for flags) and `.env.example`.
- **Naming:** the app is Calandria. `tests/naming.test.ts` fails any new `orch`,
  `orchestrator`, `operator`, or `ORCH_` reference by file and line. Lowercase `operator`
  meaning whoever runs an instance is recognized as the ordinary noun and needs nothing
  from you (if such a line is still reported, something else on it is guarded too). If
  yours is genuinely attribution, the deprecated `ORCH_*` alias table, or a pre-rename
  on-disk/localStorage name, add the file to that test's `ALLOWED` map with the narrowest
  pattern covering the line, and a comment saying which of those.

## AI-assisted contributions

AI-written code is welcome. Contributors remain responsible for understanding the change,
testing it, and addressing review feedback.

Every pull request must include a short **Human-written context** section written in the
contributor's own words, without AI generating or rewriting it. It must explain:

- the bug, limitation, or user need being addressed; and
- the proposed fix at a high level, including why that approach was chosen.

Clearly label any AI-generated text elsewhere in the pull request description or review
discussion as **AI-generated details**. You don't need to label individual lines of
AI-written code. The goal is to give reviewers an authentic explanation from the person
submitting and standing behind the change, while keeping AI-assisted implementation fully
welcome.

## Developer Certificate of Origin

Contributions are accepted under the [Developer Certificate of
Origin](https://developercertificate.org/). By adding a `Signed-off-by` line to your commits
(`git commit -s`), you certify that you have the right to submit the work under this
repository's Apache-2.0 license.

## Conduct

Be respectful, constructive, and assume good intent. Critique ideas and code, not people.
Report security problems privately as described in [SECURITY.md](SECURITY.md).
