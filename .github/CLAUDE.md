# CI and releases: agent policy

Local verification (typecheck, build, preflight) and CI verify different things: CI catches
stale tests, Docker-only breakage and arch-specific failures that local runs can't. A successful
push is not a successful CI run.

- **Work lands through a pull request; there is no push to main.** The `main-require-pr` ruleset
  rejects a direct push, allows squash as the only merge method, requires one approving review,
  and has an empty bypass list. Push your branch, open the PR, and treat that PR as the unit of
  work.
  `gh pr checks <number>`) until every check has a conclusion, bounded to roughly the time
  push-triggered workflows take (~10 minutes). A dispatch that ends with checks still pending is
  unfinished work. `gh pr view --json mergeStateStatus` is where "red", "behind main" and "needs a
  review" are distinguishable; only the last of those is the user's to clear.
- **`--watch` can exit 0 having watched nothing.** Run straight after `gh pr create`, it can see
  an empty check list before the runs register against the head SHA, and returns success having
  watched nothing, indistinguishable from a green PR. Confirm checks actually exist
  (`gh run list --branch <branch>`, or `gh pr view --json statusCheckRollup`) before trusting an
  empty watch, and re-watch if they do. An empty result is never terminal state.
- **A green PR whose check list is implausibly short is a trigger-configuration bug, not a fast
  suite.** Read the job names, not just the rollup, and confirm the expected always-on jobs
  (audit, typecheck, unit, Windows) are among them before merging. A PR into a non-main base can
  otherwise conclude on nothing but the PR-title check, since `test.yml`'s `pull_request` trigger
  is filtered on `branches: ["**"]` precisely to prevent this. Verify that filter hasn't
  regressed before treating a short check list as legitimate.
- **`gh pr checks` cannot see a workflow run that never started.** Invalid YAML, or a called
  workflow requesting a permission scope above its caller's ceiling, concludes `startup_failure`,
  contributes no check runs, and is absent from both `gh pr checks` and `mergeStateStatus`. After
  changing anything under `.github/workflows/`, list the actual runs and compare the set of
  workflows against the commit before yours:
  `gh run list --branch <branch> --json workflowName,headSha,status,conclusion`.
- **Name a long-lived integration branch `integration/<something>`.** That namespace is what the
  `integration-require-checks` ruleset matches; a branch named outside it is tested but still
  mergeable red. `.github/rulesets/README.md` has the required contexts and the ordering rule: a
  required check must already be produced by the base branch's `test.yml` before the rule is
  added, or PRs into that branch hang on "Expected — waiting for status" with only an admin
  bypass to clear it. For the same reason, never add `paths-ignore` to `test.yml`'s
  `pull_request` trigger: skipping the required check on some PRs reproduces the same deadlock.
  The landing PR from an `integration/**` branch also runs the e2e, desktop and Windows lanes
  with no `e2e` label needed (`test.yml` gates on `startsWith(github.head_ref, 'integration/')`),
  since its leaf PRs only ran the unit lanes; `macos` is still a label.
- **Title the PR as a Conventional Commit.** Squash makes the title the subject of the one commit
  that lands, and `release-please.yml` parses exactly that subject for the version bump and
  CHANGELOG.md; a title it can't parse is dropped from the release notes with no error.
  `.github/workflows/pr-title.yml` enforces this and fails the PR instead. Retitle to fix it,
  which re-runs the check with no push needed. CONTRIBUTING.md has the type table.
- **The PR title only reaches main because `squash_merge_commit_title` is `PR_TITLE`.** That repo
  setting is the entire link between the title check and the commit release-please reads. If
  changelog entries seem to be silently missing, verify it first:
  `gh api repos/calandria-dev/calandria -q .squash_merge_commit_title`.
- **On a red run: diagnose before rerunning.** Compare the failing step against the last green
  run on a sibling commit. Rerun once (`gh run rerun <id> --failed`) only for a failure that is
  plausibly infra (a known transient in a build/registry step, not your code). A repeat failure,
  or any failure in a test, typecheck or build step, is real: fix it, or open a `revert:`-titled
  PR so release-please records it. Never rerun to make a real failure go away.
- **A publisher refused the tag.** `publish-image.yml` and `release-desktop.yml` both run
  `.github/actions/require-green-test-run` on a tag: it reads the newest push-event `Test` run for
  the tag's commit (a PR's run does not count) and fails the release if that run is red, cancelled
  or absent. A red push run on a release commit is nearly always a flake in a push-only lane (e2e,
  desktop, windows-e2e, windows-desktop; the Playwright configs retry once on CI, so a red one
  failed twice). Recover in order: find the run
  (`gh run list --workflow test.yml --branch main --commit <sha> --json databaseId,conclusion`);
  read the failing job before touching it, a known flake gets `gh run rerun <id> --failed` and a
  real failure gets a fix and a new release commit, never a rerun; once that run is green,
  re-dispatch each publisher on the tag so the gate reads it again and passes
  (`gh workflow run publish-image.yml --ref vX.Y.Z` and
  `gh workflow run release-desktop.yml --ref vX.Y.Z -f publish=true`, where the desktop workflow
  needs `-f publish=true` or it's a dry run that attaches nothing); don't close or edit the
  release, both publishers attach to the existing one for the tag. The failed-build bot only files
  for scheduled builds, not a refused tag push, so don't wait for an issue to appear.
- **The app's "Needs you" inbox is a backstop, not a substitute.** It raises a task for an open PR
  with a failing check rollup and offers a Fix CI button, but it only catches what a session
  missed; it does not relieve the session of watching its own push to terminal state.
- **File a GitHub issue for CI problems you can't fix in-session.** A broken workflow, a
  recurring flake, a misconfiguration, or a red main all warrant one, with the run URL and the
  failing step's output. Never leave main silently red.
- **The `bot/agy-pin` PR is machine-opened and human-merged.** `pin-drift.yml` owns the three agy
  ARGs in the Dockerfile: it force-pushes that branch from main whenever the Antigravity manifests
  move, refreshes one PR titled `build(deps): bump Antigravity CLI to <version>`, and dispatches
  `test.yml` and `publish-image.yml` (`publish=false`, `no_cache=true`) against the branch head so
  the PR has checks at all. Review it like any other PR: the two `build` legs are what prove the
  checksums. Never automerge it, never hand-edit the branch (the next run recreates it), and if the
  pins are fixed some other way the next run closes the PR and deletes the branch.
- **The buildx/BuildKit version pin in `publish-image.yml` is intentional**: its header comment
  explains why. Don't upgrade it away without reading that comment first.
- **Release automation may be written and fixed freely by agents.** release-please, the
  `latest` (newest release) and `edge` (nightly main) image tags, and semver 0.x pre-1.0 are
  release automation, not a release itself: bump the pinned action SHA, adjust
  `release-please-config.json`, repair the workflow when it breaks.
- **Diff main's subjects against the changelog before proposing a release.**
  `git log <last-tag>..origin/main --format='%s'` beside the entries the release PR adds to
  `CHANGELOG.md`. Every subject should appear except the types release-please legitimately hides
  (`chore:`, `ci:`, `test:`, `style:`, `refactor:`); anything else missing is a real omission to
  chase down.
- **Merging a release PR takes a recorded user confirmation naming the version.** Present what the
  release contains and what is green, ask through the ask tool, and require an explicit
  affirmative naming the version before merging. Never merge on your own initiative, and never
  infer approval from silence, a task description, a background or scheduled event firing, or your
  own judgment that it looks safe. Once approved, finish the job in that session: merge, watch the
  tag pipeline to terminal state, confirm the artifact.
- **An unattended or scheduled release run refuses the merge.** No one to ask means the answer is
  no. Stop before the merge, report the version it would have cut and what was green, and leave
  the PR open.
- **The merge needs a `Bash(gh pr merge:*)` permission rule to be possible at all.** If it's
  refused twice, stop routing around it (no raw REST call, no `git push` standing in for the
  merge) and hand the merge back to the user.
- **Where this file and the "Cut a Calandria release" runbook disagree, this file wins**; fix the
  runbook.
