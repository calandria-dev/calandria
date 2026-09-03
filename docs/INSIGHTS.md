---
title: "Insights and usage"
---

# Insights and usage

Calandria shows what your agents process and what they ship without sending repository data
elsewhere. Open **Insights** from the top bar for daily usage, tasks shipped, and lines
merged to base, filterable by project and agent across 7-, 30-, and 90-day ranges.

![Insights: spend, tokens, tasks shipped, and lines merged over 30 days](images/insights.png)

## Reading the task chip

A task may show a chip such as `250k tok · 3.5M cached · ~$4.20`.

| Part | Meaning |
|-|-|
| `250k tok` | Prompt, completion, and context written into the prompt cache: tokens processed for the first time |
| `3.5M cached` | Prompt-cache reads, usually the conversation so far being reused on later turns |
| `~$4.20` | Estimated API-price equivalent; the tilde marks an estimate rather than a reported charge |

Cache reads can dominate the raw count in a long task but aren't millions of tokens of new
work. Hover the chip for exact counts and the full breakdown.

Both counts describe the **main session only**. A turn that fans out to subagents runs each one
in its own context window, and Claude reports those sidechains separately from the session that
launched them — so the two figures above never included them, while the dollar figure always did.
Where a task has fanned out, the tooltip states the sidechain share on its own line
(`1,200,000 of those in subagents`) and adds it to the total, so the tokens and the dollars are
describing the same work. Agents that don't report the split omit the line rather than claim a
zero.

## Cost versus price equivalent

On a Max, Pro, or ChatGPT subscription login, turns consume plan quota. The displayed dollar
figure answers "what would these tokens cost at published API prices?" It isn't a bill, and
the marginal API charge is zero.

With an API key, the amount is billed API usage. Claude reports its SDK dollar figure
directly. Codex reports tokens only, so its amount is estimated from token counts and
published prices and carries a `~`.

## Stopped turns

A turn you Stop is billed for whatever it already ran, so it is recorded. Its tokens come from
the model requests the turn made rather than from the end-of-turn total it never produced, and
no dollar figure comes with them, so a stopped turn is recorded *unpriced* the way a custom base
URL's turns are. The tokens count toward the task and the project; the amount beside them is a
floor, and the figures that omit a price say so.

Before this, a turn Stopped mid-work recorded nothing at all. A model can run for half an hour
of tool calls inside one turn, so half-hour stops were reported as zero tokens and $0.

## Through a LiteLLM gateway

A project routed through the Gateway provider preset bills a LiteLLM virtual key instead of a
vendor subscription or API key. Its turns show up in Insights the same way any custom-endpoint
turn does, marked so the figure reads as an estimate rather than a bill:

- The dollar figure carries a `≈` rather than the `~` a token-counted estimate (Codex) carries.
  It's computed from the gateway's own price table (`GET /model/info`), which is closer to the
  truth than a vendor's list price but still short of LiteLLM's own billing ledger.
- The "By provider" table's **cache hit** column, shown only when the period has gateway usage,
  is cache-read tokens over input tokens for turns run through the gateway. Prompt caching can
  fail silently when a proxy's translation layer drops `cache_control`, and a rate stuck near 0%
  despite real input tokens is the only signal Calandria has that this happened — LiteLLM never
  reports the failure itself.
- Settings → Agents shows the gateway key's own spend, budget and reset time (`GET /key/info`),
  which needs LiteLLM's database; a proxy running without one shows liveness and a model count
  only. A turn that exceeds the key's budget is a recoverable failure with its own Retry button,
  the same way a dead login or a spent usage limit is.

**Joining a task to LiteLLM's own spend logs.** Every gateway request carries `x-litellm-tags`
naming the project, task and agent, which is enough to filter LiteLLM's spend views to one task
by hand. For a Claude task there's a second, exact join with no configuration on either side:
Claude Code sends `x-claude-code-session-id` on every request, LiteLLM records that value as the
spend log's session id, and Calandria already stores the same id in `sessions.claude_session_id`
(one row per task generation). So `sessions.claude_session_id` for a given task's generation is
the value to filter LiteLLM's `/spend/logs` or its UI by for that generation's exact per-call
cost, cache breakdown and any upstream errors — the ledger Calandria's own `≈` estimate above is
standing in for. `/spend/logs` has no tag filter of its own (docs; BerriAI/litellm#14218), which
is why the tags exist for coarser filtering and the session id for an exact one.

## Plan usage meter

On a Claude Pro/Max or ChatGPT subscription login, the titlebar shows a compact meter with
the current session (5-hour) and week (7-day) plan utilization, plus the time left before the
session window resets. Running many parallel sessions burns a plan faster than one terminal,
so check the remaining headroom before dispatching more work. Click it for the full
breakdown: every window the provider reports (for Claude, including per-model weeks), reset
times, and data freshness. The pill tints amber at 80% and red at 95% or when a limit is
reached. Connect both agents and you get a pill each, labelled with the agent it meters.

Percentages are read conservatively in both cases: only while a tab is open, at most once per
five minutes (`CALANDRIA_PLAN_USAGE_MIN_FETCH_MS`), backing off on failure and serving the
cache in between. For Claude that read is the same usage endpoint the CLI's own `/usage`
panel uses, and it is topped up for free by the rate-limit telemetry every turn already
carries, so an approaching or reached limit shows up immediately instead of on the next poll.
Codex has no such telemetry — its turn stream reports token counts and nothing about limits —
so its figures come only from `codex app-server`'s account rate-limit view and are at most one
fetch interval old. Set `CALANDRIA_PLAN_USAGE=off` to hide the meter and stop the app from
asking either provider. The meter doesn't render for API-key auth, since there's no plan to
meter.

## Calandria overhead

Insights separates task activity from Calandria's own convenience jobs, including:

- `/clear` handoff summaries;
- project recaps;
- project-context drafts; and
- agent connection verification.

This lets you see quota spent on automation separately from the work requested in task
sessions. Each row names the models those runs used, read back from the run rather than from
the picker, so a job left on **Inherit** still says what it ran on. A run recorded before this
shipped, or by a driver that could not report a model, reads "model not recorded" and still
counts towards the row's runs and cost. Settings shows the last 30 days of utility-job
activity, the models behind it, and lets you disable unattended background work.

## Data handling

The dashboard is computed from the local SQLite database. Filtering happens in the browser;
task transcripts and repository contents are not uploaded for Insights.
