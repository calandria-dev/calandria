---
title: "Pushing bulk collection into subagents"
---

# Pushing bulk collection into subagents

`CLAUDE.md`'s **Collecting context** section tells a task session to dispatch a subagent rather
than run a fourth read-only command in a row. This document is the measurement behind that rule and
the A/B that checked it. Every number is reproducible; re-measure before arguing with it.

## What was measured

Every Claude Code transcript belonging to a Calandria task session on this instance —
`~/.claude/projects/*worktrees*/*.jsonl`, 198 of them, spanning 2026-08-22 to 2026-08-28. A **first
turn** is every assistant step from the opening user message up to the second user message that
isn't a `tool_result`. First turns are the target because they carry the orientation work and,
on this instance, about 60% of all spend.

| Fact | Value |
|-|-|
| First turns measured | 198 |
| First-turn `cache_read_input_tokens`, total | 1,815 M |
| Mean per first turn | 9.1 M |
| Median | 4.5 M |
| Median assistant steps in a first turn | 63 (max 346) |
| Median context, first step → last step | 17 k → 120 k |
| Tool calls in those first turns | 8,152, of which 6,464 (**79%**) are `Bash` |

## How much of it is collection

Two independent passes, because the answer is the whole basis for the rule. A regex classifier over
all 198 first turns, and a hand classification of the ten most expensive ones (1,214 Bash calls)
done by a subagent reading the raw call list.

| Bash call | Regex, all 198 | Hand, top 10 |
|-|-|-|
| **Collection** — `cat`, `head`, `sed -n`, `grep`, `find`, `ls`, `git log`, `git show` | 68.0% | 52.0% |
| **Decision** — test runs, `typecheck`, `build`, reproductions | **11.5%** | **12.1%** |
| **Mutation** — `sed -i`, heredocs onto tracked files, `git commit` | 7.5% | 18.7% |
| **Admin** — `cd`, `echo`, `which`, repeated log polls | 2.9% | 17.2% |
| Unclassified | 7.1% | — |

The two passes disagree on collection because of one session: 105 of its 194 Bash calls are
repeated `tail -c` and `grep -c` polls against a single backgrounded test log, which the regex reads
as collection and the hand pass as admin. The hand pass is right about that session, and the
disagreement doesn't matter, because **both agree on the decision figure to within 0.6 points.**
Only about an eighth of what a first turn does at the shell is work whose raw output the model has
to see. That is the number the rule rests on.

Collection does not arrive one call at a time. Counting unbroken runs of three or more collection
calls with no intervening decision or edit:

| | Calls inside a sweep of 3+ | Longest single sweep |
|-|-|-|
| Regex, all 198 first turns | 51.5% of all first-turn Bash | 43 |
| Hand, top 10 | 40.3% (489 / 1,214) | 43 |

Four of the ten most expensive sessions **open with 38–43 consecutive file reads before their first
edit**, each rebuilding the same kind of artifact: a call-site map for one concept.

## What the sweeps cost

- **31%** of all first-turn `cache_read` is spent on steps whose only tool call was collection.
  That is the direct bill for the sweep itself.
- **59%** of the context a first turn accumulates (17 k → 120 k median) is put there by
  collection-only steps. Every later step in the turn re-reads it, which is why the direct 31% is a
  floor and not an estimate — a sweep at step 10 is still being paid for at step 60.

And the control: across the **25 most expensive first turns, `Agent` was called zero times.** Across
all 198, 159 times. The sessions that spend the most delegate the least.

## Why the global policy didn't reach these sessions

`~/.claude/CLAUDE.md` has carried a delegation policy since 2026-07-25 — a month before the earliest
session measured here — including the sentence "don't read the harness's caution against unprompted
subagents as overriding it." It is not being followed.

The reason is in the session prompt. Calandria launches tasks in permission mode `auto`
(`DEFAULT_PERMISSION_MODE`, `lib/agents/claude/driver.ts`), and the CLI adds guidance to a session
in that mode which points the other way on both counts: it asks for work to go through Bash
"wherever it can accomplish the job", naming `cat`, `head`, `sed -n`, `grep` and `find`, with the
dedicated file tools as the fallback; and it says not to call the Agent tool "unless the user
requested it".

That is the 79%-Bash figure and the zero-`Agent` figure, stated as policy. It's a reasonable default
for a session nobody has told otherwise, it comes from the CLI rather than from this repo, and it is
not ours to edit. What is ours is the repo's own instructions, read in the same window. So they have
to do two things a restatement of the general principle cannot: **name the conflict and settle it**
("dispatching a collection subagent is requested work"), and **give the trigger as a countable
condition** rather than a judgement call, because the general form has now had a month to work.

## The dispatches those sweeps should have been

Taken from the sampled sessions; the first three are in `CLAUDE.md` as the worked examples.

| Sweep | Calls | The one dispatch it should have been |
|-|-|-|
| Per-task base branch: every `project.branch` call site | 34 | "Grep `project.branch` and `proj.branch` across `lib/` and `app/`. Report every call site as `file:line` with its enclosing signature and one line on what it assumes." |
| Adding two agent tools: tracing an existing one | 33 | "Trace `withdraw_suggestion` through all five wiring points and report `file:line` for each plus the shape a new tool copies." |
| Idle/busy state: every status indicator | 43 | "Find every place `running` or `awaiting_input` renders a status dot, spinner or label across `app/shell/` and `lib/`. Report `file:line` plus the condition each tests." |
| Task groups phase 3: `task_groups` / `group_id` / `GroupChips` | 42 | "Grep those three across `lib/`, `app/` and `tests/` and report every call site with a one-line summary." |
| Settings drift: mapping the `PermissionRequest` pipeline | 38 | "Map the existing PermissionRequest pipeline end to end and report every `file:line` where a turn starts without a settings-file check." |
| Suggestion cards: how a `tool_use` becomes a transcript row | 38 | "Find every place a tool_use event becomes a transcript row and report how each stores the tool's title versus its raw name." |
| Starlight link validator: is it usable in place? | 14 | "Read `starlight-links-validator`'s link-resolution source and report whether it handles a Markdown file served in place rather than copied into `src/content`, with `file:line`." |
| Desktop bench: what's installed | 6 | "Read both desktop e2e docs in full and report which of openbox, dbus-x11, xdotool and dunst are installed on this host." |

## One thing that is not a delegation problem

The single largest block of avoidable calls found — 105 in one session — was neither collection nor
decision. It was **polling**: `tail -c 2000 /tmp/e2e.log` and `grep -cE "^  ✓" /tmp/e2e.log`
alternating against one backgrounded test run, with the identical `grep -c` repeated 20 times in a
row. No subagent fixes that. `Bash(run_in_background)` and waiting for the completion notification
does, and `Monitor` does it for a stream. `CLAUDE.md` says so in the same section, because a session
reaching for the wrong tool here reaches for it in the same moment.

## The dispatch has to be synchronous

The first A/B ran with the section telling sessions to dispatch but saying nothing about
`run_in_background`, whose default is `true`. Both treatment runs that dispatched got back an agent
id and a "working in the background" acknowledgement, and **not one subagent result ever reached
the coordinator** — zero notifications and zero result blocks in either transcript. The turn ended
first.

Cache-read still fell 29–34%, which is exactly what makes the failure dangerous: the tokens really
were never spent, so the metric improves while the sub-question the session delegated is silently
dropped. A rule that reduces spend by losing work is worse than no rule. Hence the section states
`run_in_background: false` as a requirement rather than a preference, and says why.

Two things follow from the same measurement. Wall clock regressed 14–23% in that first pass, and a
serial dispatch is the mechanism — the coordinator pays one agent's latency per call. So the
section also requires independent sweeps to go out in a single message. And one treatment prompt
whose whole task was research dispatched nothing at all, apparently reading "delegate the
collection" as inapplicable when collection is the entire job; the section now says to split such a
task by facet instead.

## The A/B

Four prompts, each an exhaustive read-heavy audit of this repo, run in two `git worktree --detach`
checkouts of `main` differing only in `CLAUDE.md`. Opus 5, `--permission-mode auto`, MCP off, four
runs concurrent so both arms saw the same contention. `p1` traces the permission-card path, `p2`
audits env vars, `p3` audits everything periodic, `p4` inventories the test suite.

| Pair | Control cache-read | Treatment | Δ | Control s | Treatment s | Note |
|-|-|-|-|-|-|-|
| p1 | 5.14 M | 3.56 M | −31% | 367 | 370 | |
| p1 repeat | 3.51 M | 1.71 M | −51% | 445 | 378 | |
| p2 | 1.00 M | 1.41 M | **+41%** | 872 | 917 | control dispatched 4 agents unprompted |
| p3 | 2.33 M | 1.24 M | −47% | 326 | 270 | |
| p4 | 6.09 M | 1.38 M | −77% | 1130 | 486 | treatment answer was **wrong**, see below |
| p4 repeat | 4.67 M | 2.50 M | −46% | 434 | 504 | control had `node_modules`, treatment didn't |
| p4 symmetric | 8.05 M | **8.90 M** | **+11%** | 938 | 1294 | both arms clean, anti-proxy rule in place |

**The headline number does not survive scrutiny, and it should be stated that way.** Three things
undercut it:

- **The mechanism mostly didn't fire.** Across eight treatment runs, exactly one dispatched a
  subagent. `p1`, `p3` and `p4` delegated nothing and still came in 31–77% cheaper, so whatever
  produced those numbers, it was not delegation. The section may simply be priming frugality by
  telling the model what its context costs.
- **Control-arm variance rivals the effect.** Two identical control runs of `p1` measured 5.14 M and
  3.51 M — a 32% spread with no intervention at all. Differences of that size mean nothing at n=1.
- **The largest single win was the quality defect, not a saving.** `p4`'s −77% is the treatment arm
  declining to install `node_modules` and counting `it(` with grep instead of running vitest.

## What the quality check found

An independent judge read all eight answers, verified sampled claims against the checkout, and — for
`p4` — installed dependencies and ran the real suite for ground truth (147 files, 1,580 cases).

On `p1` the arms tied at 5/5 verified claims each; `p2` favoured the treatment (5/5 against 4/5);
`p3` favoured the control, which caught a `CLAUDE.md` contradiction the treatment missed
(`lib/deferredStart.ts` is a second ticker that launches turns and isn't gated by
`CALANDRIA_SCHEDULER`, so the claim that scheduled tasks are the only server-owned periodic work is
false — worth fixing on its own).

`p4` failed outright. The treatment reported `tests/importGraph.test.ts` as declaring 4 cases when
it declares **57** — they are generated in a loop, so a text search cannot see them — missed the
suite's actually-slowest file in its "five slowest" list, and was 52 short on the total. That is the
worst possible failure mode: a confident wrong number on the repo's most load-bearing invariant
test.

That produced the last rule in the section, and the re-run says the rule works. With
`node_modules` absent from both arms and the anti-proxy paragraph in place, the treatment installed
dependencies, ran vitest, and reported **57** and the real totals; the **control**, with no such
rule, estimated and reported **4** — the identical error, now on the other side. The defect was
never about delegation. It was about a session substituting a cheap proxy for a measurement, which
either arm will do given the chance.

## Verdict

**The token saving is not verified, and this document should not be cited as if it were.** The
direction was right in six of seven pairs, but the effect is inside the control's own variance, the
delegation mechanism fired once in eight runs, and the single clean symmetric comparison went the
*wrong* way — the treatment cost 11% more cache-read and 38% more wall clock, because it did the
work instead of guessing.

What *is* demonstrated is narrower and still worth having: the section reliably stops a session
answering a measurement question by estimating it, at a real cost in wall clock. Keep it for that,
at `+1,731` tokens per session, and treat the delegation half as unproven — the honest open problem
is that a `CLAUDE.md` section is losing to a system-prompt instruction seven times out of eight, and
that is what a further round should attack.

## How to re-measure

The scan is a throwaway script over the transcript JSONL rather than anything checked in, since it
reads a path outside the repo and is only run when this question comes up again. Segment each
transcript into turns at every `type: "user"` record whose content is not a `tool_result`, keep the
first, and sum `message.usage.cache_read_input_tokens` over its assistant steps. Classify
`tool_use` blocks named `Bash` by their `command`, and count a sweep as three or more consecutive
collection calls with nothing else between them.

For the A/B, run the same prompt in two `git worktree add --detach` checkouts of `main` that differ
only in `CLAUDE.md`, with `claude -p --model claude-opus-5 --permission-mode auto --output-format
json --strict-mcp-config --mcp-config '{"mcpServers":{}}'`. The mode flag matters: `auto` is what
Calandria launches tasks in and it is the mode carrying the instruction this section overrides.
Disabling MCP costs some fidelity and removes a large source of variance; both arms take the same
hit.
