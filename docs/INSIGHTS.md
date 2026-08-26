# Insights and usage

Calandria shows what your agents process and what they ship without sending repository data
elsewhere. Open **Insights** from the top bar for daily usage, tasks shipped, and lines
merged to base, filterable by project and agent across 7-, 30-, and 90-day ranges.

## Reading the task chip

A task may show a chip such as `250k tok · 3.5M cached · ~$4.20`.

| Part | Meaning |
|-|-|
| `250k tok` | Prompt, completion, and context written into the prompt cache—the tokens processed for the first time |
| `3.5M cached` | Prompt-cache reads, usually the conversation so far being reused on later turns |
| `~$4.20` | Estimated API-price equivalent; the tilde indicates an estimate rather than a reported charge |

Cache reads can dominate the raw count in a long task but are not millions of tokens of new
work. Hover the chip for exact counts and the full breakdown.

## Cost versus price equivalent

On a Max, Pro, or ChatGPT subscription login, turns consume plan quota. The displayed dollar
figure answers “what would these tokens cost at published API prices?”; it is not a bill and
the marginal API charge is zero.

With an API key, the amount represents billed API usage. Claude can report its SDK dollar
figure directly. Codex currently reports tokens only, so its amount is estimated from token
counts and published prices and carries a `~`.

## Plan usage meter

On a Claude Pro/Max subscription login, the titlebar shows a compact meter with the current
session (5-hour) and week (7-day) plan utilization — plus the time left before the session
window resets, since that's the number you pace dispatches against — running many parallel sessions burns a
plan faster than one terminal, so the remaining headroom is worth a glance before dispatching
more work. Click it for the full breakdown: every window Anthropic reports (including
per-model weeks), reset times, and data freshness. The pill tints amber at 80% and red at
95% or when a limit is reached.

Two data sources feed it. Percentages come from the same usage endpoint the Claude CLI's own
`/usage` panel reads, fetched conservatively — only while a tab is open, at most once per
five minutes (`CALANDRIA_PLAN_USAGE_MIN_FETCH_MS`), backing off when Anthropic rate-limits it.
Between fetches it coasts on the cache plus the rate-limit telemetry every turn already
carries for free, so an approaching or reached limit shows up immediately rather than on the
next poll. Set `CALANDRIA_PLAN_USAGE=off` to hide the meter and guarantee the app never calls the
usage endpoint. The meter doesn't render for API-key auth (there is no plan to meter).

## Calandria overhead

Insights separates task activity from Calandria's own convenience jobs, including:

- `/clear` handoff summaries;
- project recaps;
- project-context drafts; and
- agent connection verification.

This makes it possible to understand the quota spent on automation independently of the
work requested in task sessions. Settings shows the last 30 days of utility-job activity
and allows unattended background work to be disabled.

## Data handling

The dashboard is computed from the local SQLite database. Filtering happens in the browser;
task transcripts and repository contents are not uploaded for Insights.
