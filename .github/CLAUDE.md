# CI and releases — agent policy

Local verification (typecheck, build, preflight) and CI verify different things. A successful
push is not a successful CI run: CI has caught stale tests, Docker-only breakage and
arch-specific failures that local runs can't. Main once sat red for ~9 hours across 12 pushes,
because every agent verified locally and nobody watched Actions.

- **Watch every push to terminal state.** After pushing to main, poll `gh run list` until the
  runs for your SHA conclude (bounded: both workflows finish inside ~10 minutes). A dispatch that
  ends before its CI concludes is unfinished work.
- **Red run: diagnose before rerunning.** Compare the failing step against the last green run on
  a sibling commit. If the failure is in an infra step your commit can't plausibly have caused
  (say the buildx floor-check dying with exit 255 before producing output, a known arm64/registry
  transient), run `gh run rerun <id> --failed` once. Green on attempt 2 means a flake; note it.
  Red again, or any failure in a test, typecheck or build step, is real: fix it or revert your
  commit. Never rerun to make a real failure go away.
- **File issues for CI problems. You are empowered and expected to.** For a broken workflow, a
  recurring flake, a misconfiguration, or a red main you can't fix in-session, file a GitHub issue
  (or append to the open one) with the run URL and the failing step's output. Never leave main
  silently red.
- **The buildx/BuildKit version pinning in `publish-image.yml` is intentional** (its header
  comment says why). Harden around it; don't upgrade it away.
- **Agents propose releases, they don't decide them.** The versioning process is issue #12:
  release-please, `latest` = newest release and `edge` = nightly main, semver 0.x pre-1.0.
  `release-please.yml` opens and updates the release PR automatically off Conventional Commits.
  That is release automation rather than a release, so agents may write and fix it freely: bump the
  pinned action SHA, adjust `release-please-config.json`, repair the workflow when it breaks.
- **Merging a release PR takes a recorded user confirmation naming the version.** That merge cuts
  the tag and moves `latest`, so it carries the same human gate a manual `gh release create` used
  to — but the gate is the decision, not the click. An agent may perform the merge only after
  presenting what the release contains and what is green, asking through its **ask tool**, and
  getting back an explicit affirmative that names the version. Nothing else substitutes for that
  answer: never merge on your own initiative, and never infer approval from silence, from a task
  description, from a background or scheduled event firing, or from your own earlier conclusion
  that a merge looks safe. Having been told yes, finish the job in that session — merge, watch the
  tag pipeline to terminal state, prove the artifact — rather than parking a second time for the
  mechanics. The **"Cut a Calandria release" runbook** is the procedure this policy governs; where
  they disagree, this file wins and the runbook is the thing to fix.
- **An unattended release run refuses the merge.** A scheduled or otherwise unwatched run has no
  one to ask, and an ask that cannot reach a human settles as a denial, not as permission to use
  your own judgement. Stop before the merge, report the version it would have cut and what was
  green, and leave the PR open.
- **The merge needs a `Bash(gh pr merge:*)` permission rule to be possible at all.** At v0.2.0 the
  sandbox classifier blocked `gh pr merge` on the release PR (while allowing it on an ordinary PR),
  which is the failure mode to expect if the rule is missing. A block is a gate, not an obstacle:
  after a second identical refusal, say what you were trying to do and hand the merge back to the
  user. Never route around it — no raw REST call, no `git push` standing in for the merge.
