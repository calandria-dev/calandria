# Branch rulesets

GitHub rulesets are repository *settings*, not files — nothing here is read by GitHub. These
payloads exist so a settings change is reviewable in a diff and repeatable from one command,
instead of being a thing someone did once in a web form and nobody can audit.

Read the live state before changing it; the API is the source of truth:

```sh
gh api repos/calandria-dev/calandria/rulesets
gh api repos/calandria-dev/calandria/rulesets/<id>
```

## What exists

State as of 2026-09-07. The API above is authoritative; re-read it rather than trusting this
table.

| Ruleset | Targets | Rules | Live |
|-|-|-|-|
| `main-require-pr` | `~DEFAULT_BRANCH` | `deletion`, `pull_request` (squash only, 0 approvals, empty bypass list), `required_status_checks` | id `21757704`, carrying the first two rules; `required_status_checks` waits on the PUT below |
| `integration-require-checks` | `refs/heads/integration/**` | `required_status_checks` | not created yet, waits on the POST below |

## The five required checks

`required-checks.json` holds the rule both rulesets use. The contexts are the job **display
names** in `.github/workflows/test.yml`, not the job keys, and they must match byte-for-byte:

- `Changed paths`
- `Audit (npm)`
- `Types (tsc)`
- `Unit (vitest)`
- `Windows (types + unit)`

Four things about that list are load-bearing.

**`Changed paths` is required for a reason that is easy to miss.** A `needs:` whose dependency
FAILS reports its dependents as `skipped`, and GitHub treats a skipped required check as
*satisfied*. So without this entry a red `changes` job would wave a PR through having run
nothing — the exact bug this was all set up to stop. Requiring it makes that unrepresentable.

**`Audit (npm)` is unambiguous only because `security-scan.yml`'s identical weekly job was
renamed to `Audit (npm, weekly)`.** Don't rename either back.

**The four slow lanes are deliberately absent.** `End-to-end (Playwright)`, both desktop lanes and
the Windows e2e pair are label-gated (`e2e`, `macos`), so they report `skipped` on most PRs.
Requiring a check that is usually skipped buys nothing — skipped satisfies the gate — while
making every labelled PR wait half an hour.

**`strict_required_status_checks_policy` is `false`.** True means "branch must be up to date with
the base before merging", which in a stacked tag tree forces a rebase of every open PR each time
one of its siblings lands.

## Ordering: a required check must already exist on the base branch

**Adding one of these rules to a branch whose `test.yml` does not yet produce the check blocks
every PR into it, permanently.** The check never reports, and the PR sits on "Expected — waiting
for status" with no way forward but an admin bypass.

So the order is always: land the workflow change on the branch first, *then* add the rule.

`integration-require-checks` targets `refs/heads/integration/**` rather than naming individual
branches because the namespace was empty when this payload was written, so the rule could strand
nothing. **It is no longer empty.** Before creating or widening this ruleset, check that every
branch it matches already produces all five contexts, and that no open PR into one is sitting on a
head that predates the workflow change:

```sh
gh pr list --repo calandria-dev/calandria --state all --limit 60 \
  --json number,state,baseRefName \
  --jq '.[] | select(.baseRefName | startswith("integration/")) | "\(.number) \(.state) -> \(.baseRefName)"'
gh pr checks <N> --repo calandria-dev/calandria
```

Checked 2026-09-07: `integration/docs-cleanup` (PR #271) and `integration/model-providers`
(PR #256) both report all five as `pass`, and both carry `pull_request: branches: ["**"]` in
`test.yml`. `main` produces them too, on the one open PR into it (#241).

The same check is what unblocks the `main-require-pr` half. It was held back while PR #142 was
unmerged, because the required `Changed paths` context did not exist on `main` and the then-open
release PR #108 would have hung on it forever. #142 landed 2026-09-02 and #108 merged the same
day, so neither is a constraint now.

Same reason `test.yml`'s `pull_request` trigger has no `paths-ignore`. A workflow-level path
filter and a required check are incompatible: filtering the workflow out is indistinguishable, to
the merge gate, from a check that never ran. The website-only saving lives in the `changes` job
instead, which reports `skipped` where a filter reported nothing at all.

## Applying

**This is a human step.** A `gh api` write to `repos/.../rulesets` is refused by Claude Code's
auto-mode classifier, so an agent session can prepare and verify these payloads but cannot apply
them. Reads of the same endpoint go through fine.

Create the integration ruleset:

```sh
gh api -X POST repos/calandria-dev/calandria/rulesets \
  --input .github/rulesets/integration-require-checks.json
```

Add the same rule to `main-require-pr`. A ruleset PATCH replaces the whole `rules` array, so read
the current one and append rather than sending the rule alone:

```sh
id=$(gh api repos/calandria-dev/calandria/rulesets --jq '.[] | select(.name=="main-require-pr") | .id')
gh api "repos/calandria-dev/calandria/rulesets/$id" \
  --jq '{name, target, enforcement, bypass_actors, conditions, rules}' \
  > /tmp/main.json
node -e '
  const fs = require("fs");
  const rs = JSON.parse(fs.readFileSync("/tmp/main.json"));
  const rule = JSON.parse(fs.readFileSync(".github/rulesets/required-checks.json"));
  rs.rules = rs.rules.filter(r => r.type !== "required_status_checks").concat([rule]);
  fs.writeFileSync("/tmp/main.json", JSON.stringify(rs, null, 2));
'
gh api -X PUT "repos/calandria-dev/calandria/rulesets/$id" --input /tmp/main.json
```

Verify, and keep the table above honest:

```sh
gh api repos/calandria-dev/calandria/rulesets/<id> --jq '.rules[].type'
```

## Known friction

`required_status_checks` applies to **direct pushes** to a matched branch, not only to merges. A
fast-forward of an integration branch to a `main` commit is fine — that SHA already carries
`main`'s green run — but a *merge commit* produced by syncing one is a new SHA with no checks, and
the push is refused. Sync an `integration/**` branch by fast-forward, or open a PR for it.

A branch that is both ahead of and behind `main` cannot fast-forward at all, so for it the PR is
the only route. That is the normal state of a working integration branch: on 2026-09-07
`integration/docs-cleanup` was 23 ahead and 11 behind. Check before reaching for a sync:

```sh
git rev-list --left-right --count origin/main...origin/integration/<name>
```

The left column is commits on `main` only (behind), the right is commits on the branch only
(ahead). Getting them backwards is easy and turns "fully merged, safe to delete" into its
opposite.

`do_not_enforce_on_create: true` is set so creating a new `integration/**` branch is not itself
refused for having no checks.
