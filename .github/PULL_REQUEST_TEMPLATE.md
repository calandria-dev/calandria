<!--
TITLE THIS PR AS A CONVENTIONAL COMMIT: <type>[(scope)][!]: <description>

  feat: ...    a user-visible capability   (bumps the minor version)
  fix: ...     a bug fix                   (bumps the patch version)
  perf revert docs style chore refactor test build ci    no bump

main is squash-merge-only, so this title becomes the subject of the single
commit that lands, and release-please reads it to write CHANGELOG.md and pick
the next version. A title it can't parse is skipped silently — the change ships
with no mention in the release notes. CI fails the PR instead; retitling
re-runs the check. CONTRIBUTING.md has the full table.
-->

## Human-written context

<!-- Required: write this section yourself, without AI generating or rewriting it. -->

### Problem

<!-- In your own words, describe the bug, limitation, or user need. -->

### Proposed fix

<!-- In your own words, explain the fix at a high level and why you chose this approach. -->

## Implementation details

<!-- Add any useful technical detail. Prefix AI-generated prose with "AI-generated details:". AI-written code is welcome and does not need line-by-line labeling. -->

## Verification

<!-- List the checks you ran and any important cases you tested. -->

## Related issue or discussion

<!-- Link the issue this closes or the discussion that established scope. -->

## Checklist

- [ ] The PR title is a Conventional Commit (`feat:`, `fix:`, `docs:`, …) — it becomes the squashed commit's subject and drives the changelog.
- [ ] The change is focused and its commit message explains why.
- [ ] I wrote the Human-written context myself and labeled any AI-generated PR prose.
- [ ] Tests cover changed behavior, or I explained why tests are not applicable.
- [ ] User-facing documentation is updated where needed.
- [ ] My commits include a `Signed-off-by` line (`git commit -s`).
