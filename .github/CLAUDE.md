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
- **Agents propose releases, they don't cut them.** The versioning process is issue #12:
  release-please, `latest` = newest release and `edge` = nightly main, semver 0.x pre-1.0.
  `release-please.yml` opens and updates the release PR automatically off Conventional Commits.
  That is release automation rather than a release, so agents may write and fix it freely: bump the
  pinned action SHA, adjust `release-please-config.json`, repair the workflow when it breaks.
  **Merging a release PR is user-only**, because that merge cuts the tag and moves `latest`, so it
  gets the same human gate a manual `gh release create` used to. Agents may draft and update the
  release PR's body, verify that the release gate in `publish-image.yml` is green, and comment on
  issue #12 or the PR with what changed and why a merge looks safe. They never click merge.
