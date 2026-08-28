---
title: "Pushing bulk collection into subagents"
---

# Pushing bulk collection into subagents

A task session is told to dispatch a subagent rather than run a third read-only command in a row.
The rule is in the **session prompt** — `buildProjectContext()` in `lib/agents/shared.ts`, appended
to every Claude turn's system prompt — rather than in `CLAUDE.md`, and this document is why.
Round one is the measurement the rule came from and the A/B that checked it. Round two is what
happened when the same rule moved out of `CLAUDE.md` and into the prompt, because in `CLAUDE.md` it
was losing to the CLI's own instructions. Every number is reproducible; re-measure before arguing
with it.

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

### What the CLI actually injects (2.1.240)

Round two rests on knowing exactly what is being argued with, so it was read out of the CLI bundle
rather than inferred. Three separate texts, gated three different ways:

| Text | Where | Gate |
|-|-|-|
| *"Do your work through the Bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find … Fall back to a dedicated tool only when Bash genuinely cannot do the job."* | a meta message in the conversation | permission mode: `auto` ("While auto mode is active"), `bypassPermissions` (same text, different preamble), and any mode with the bash-first flag set |
| *"Do not call the AgentTool unless the user requested it"* / *"Do not use workflows or deep-research unless the user requested it"* | system prompt | the **model**, not the mode — an Opus 5 prompt bundle, plus an experiment that can override the string outright |
| *"## Delegating to subagents — Subagents multiply cost and time … Do not fan out multiple subagents on a single small task."* | system prompt | an experiment (`CLAUDE_CODE_THISTLE_GREBE`, values `default` / `no_nudges` / `counter_steer`), with a per-model floor |

The third one matters more than its size suggests: it is a full section arguing the opposite of
this repo's rule, it is off by default on this machine today (verified by asking a session, on both
Opus and Sonnet, whether its instructions contain "Subagents multiply cost and time" — no by
default, yes with the env var set to `counter_steer`), and nothing about it is ours to control. Any
delegation rule that only works while it happens to be off is not a rule, which is why round two
measures it forced on.

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
  subagent. (Re-derived from the stored results for round two: 2 of 7 — `p1 repeat` and `p2` each
  show a subagent model beside `opus` in `usage.modelUsage`. Round two also found this rate is not
  stable across days, so treat the exact figure as an anecdote and see "The `CLAUDE.md` arm is not
  stable" below.) `p1`, `p3` and `p4` delegated nothing and still came in 31–77% cheaper, so whatever
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

## Verdict on round one

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

*Round two did attack it, and revised two things in this verdict: the delegation half now fires
(from the prompt rather than from here), and the "seven times out of eight" is not a rate that
reproduces. The `+1,731` tokens are also gone — most of that section moved out.*

## Round two: the same rule, moved into the prompt

Round one left a mechanical problem, not a content problem: the rule was right and nobody ran it.
The change that carries round two is therefore **where the rule is stated**. The delegation half of
the `CLAUDE.md` section was deleted and re-stated in `buildProjectContext()`, which the Claude
driver passes as `systemPrompt.append`, so it lands after every section the CLI wrote, including
both of the ones that argue the other way. Two wordings changed with it, each condemned by
something round one had already seen — so the arms below differ in placement *and* in these, and a
reader who wants placement isolated should re-run with the round-one text appended verbatim:

- **The trigger became a pure count.** Round one said "a third read-only command in a row against
  the same question". A model that rules each command a different question never fires it by its
  own reckoning, and that is a judgement call wearing a number's clothes. It now reads: two
  read-only commands since your last edit or decision, the third goes to a subagent, *whatever it
  is about*.
- **It names what it is overriding.** Not "delegate more" but "this overrides the standing caution
  against unprompted subagents and auto mode's instruction to work through Bash". A general
  principle loses to a specific instruction; a specific counter-instruction does not.

### What is measured, and what is not

**Dispatch rate is the metric.** Round one's cache-read numbers could not settle anything — two
identical control runs differed by 32%, the same magnitude as the effect. A run counts as
dispatching if any `Agent` tool_use appears in the **main loop**; subagent steps (`parent_tool_use_id`
set) are excluded from every count here.

Runs are **capped at 20 main-loop assistant blocks**, which is what makes 30 runs affordable: a full
run is 30–100 turns and millions of cache-read tokens, and the decision being measured is made in
the first few. The cap can only *censor* a late dispatch, never invent an early one, so it is
conservative in the direction that matters. One asymmetry it introduces, and the reason the token
columns below are reported but not argued from: a dispatching run spends its blocks on `Agent`
calls and often finishes its subagents before hitting the cap, while a reading run hits 20 blocks
quickly, so the two arms are truncated at the same block count but at different points in the work.

### Auto mode, three prompts, three runs each

`p1`, `p3` and `p4` are round one's prompts — the three that delegated nothing then. Same model
(`claude-opus-5`), same `--permission-mode auto`, MCP off, two `git worktree --detach` checkouts
that differ only in `CLAUDE.md`, with the treatment arm additionally passing the shipped directive
via `--append-system-prompt`. Runs are concurrent so both arms see the same contention.

| Prompt | Arm | Dispatched | Bash before the first dispatch | Bash in the window | Agents dispatched |
|-|-|-|-|-|-|
| p1 | `CLAUDE.md` | 2/3 | 1, 2, — | 14, 11, 11 | 0, 2, 2 |
| p1 | session prompt | **3/3** | 0, 1, 1 | **2, 3, 2** | 4, 7, 4 |
| p3 | `CLAUDE.md` | 3/3 | 1, 0, 2 | 10, 8, 13 | 2, 3, 2 |
| p3 | session prompt | **3/3** | 0, 0, 0 | **2, 1, 1** | 4, 4, 4 |
| p4 | `CLAUDE.md` | 2/3 | 4, —, 3 | 8, 10, 8 | 1, 0, 1 |
| p4 | session prompt | **3/3** | 0, 2, 2 | **7, 7, 7** | 2, 3, 4 |

Aggregate: **9/9 against 7/9** on the binary, which at that n proves nothing on its own. The
separation is in *when* and *how much*:

| | `CLAUDE.md` (n=9) | Session prompt (n=9) |
|-|-|-|
| Dispatched at all | 7 | 9 |
| Median read-only Bash calls before the first dispatch | 2 | **0** |
| Opened the turn with a dispatch (turn 1) | 1 | **5** |
| Bash calls inside the 20-block window, mean | 10.3 | **3.6** |
| Largest batch sent in a single message | 3 | **6** |
| Main-loop `cache_read`, mean | 0.60 M | 0.33 M |
| Subagent `cache_read`, mean | 1.21 M | 6.04 M |

The behavioural claim this supports is narrow and is the one that was asked for: **the rule fires,
and it fires before the sweep rather than after it.** In `CLAUDE.md` the model reads first and
delegates what's left; in the prompt it delegates first. `p4` is the honest exception — the
test-suite inventory keeps 7 Bash calls in both arms, which is what the anti-proxy rule demands of
it, since counting test cases means running vitest rather than delegating a grep.

One round-one rule held everywhere: **all 32 dispatches across both arms passed
`run_in_background: false`.** 26 went to `general-purpose`/`sonnet` and 6 to `Explore`/`haiku`, and
the briefs were facet-split ("the decision half", "the persistence and transport half") rather than
one agent handed the whole question.

### The `CLAUDE.md` arm is not stable, and round one's "one in eight" should not be quoted

The same arm, the same prompts and the same machine dispatched in **2 of 7** round-one runs and
**7 of 9** round-two runs, four hours apart. (Round one's rate was re-derived independently for
this, from `usage.modelUsage` in its stored results: a run that dispatched shows a `haiku` or
`sonnet` entry beside the `opus` one.) Nothing in the repo changed between them, so something
outside it did — CLI experiment arms are fetched per session, and the anti-delegation section
above is exactly the sort of thing that flips. Two consequences: the "seven times in eight" framing
should be retired, and **any single-digit dispatch-rate comparison across days is worthless**. Both
arms of round two were run inside the same hour, which is the only reason its numbers are
comparable to each other.

### Permission mode is part of the effect

Round one blamed `auto`'s Bash-first meta message. Probed directly — the `CLAUDE.md` text with no
appended directive, `p1`, twice per mode:

| Mode | Dispatched | Bash before the first dispatch |
|-|-|-|
| `auto` (from the table above) | 2/3 | 1, 2, — |
| `acceptEdits` | 2/2 | 0, 0 |
| `bypassPermissions` | 2/2 | 0, 0 |

Small n, but the direction is consistent and it matches what the CLI bundle says: outside `auto`
the same rule dispatches immediately. So part of what round one measured really was a permission-mode
artifact, and Calandria cannot fix it by changing mode — `auto` is the default for good reasons.
What the appended directive does is recover turn-one dispatch *inside* `auto`.

### With the CLI's anti-delegation section forced on

`CLAUDE_CODE_THISTLE_GREBE=counter_steer` injects the "## Delegating to subagents" section
("subagents multiply cost and time … do not fan out"), which is the strongest thing the CLI can say
against this rule and which may one day be on by default.

| Prompt | Arm | Dispatched | Bash before the first dispatch | Bash in the window |
|-|-|-|-|-|
| p1 | `CLAUDE.md` | no | — | 13 |
| p1 | session prompt | yes, 4 agents | 1 | 6 |
| p3 | `CLAUDE.md` | yes, 1 agent | 2 | 11 |
| p3 | session prompt | yes, 2 agents | 0 | 2 |
| p4 | `CLAUDE.md` | no | — | 10 |
| p4 | session prompt | yes, 3 agents | 2 | 7 |

One run per cell, so this is a smoke test rather than a measurement — but the direction is the one
that matters. Forcing the section on takes the `CLAUDE.md` arm from 7/9 to **1/3** (11.3 Bash calls
per run) while the prompt arm holds at **3/3** (5.0). Both arms delegate less under it than without
it; only one of them still delegates at all. The rule survives the strongest thing the CLI says
against it, and the file that had been carrying it does not.

It also offers a candidate explanation for round one: if that experiment was on for those sessions,
round one measured the `CLAUDE.md` rule against the strong form of the CLI's objection and round two
measured it against the weak one, which would account for the same arm reading 2/7 in the morning
and 7/9 in the afternoon. That is unverifiable after the fact and is flagged, not claimed.

### What round two does not show

- **Nothing about cost.** The token columns are recorded because they were free to collect, not
  because they settle anything: the two arms are truncated at different points in the work, and the
  subagent bill rises by more than the coordinator's falls inside that window. Whether the whole
  turn ends up cheaper is the next round's question, and it needs uncapped runs.
- **Nothing about answer quality.** A capped run has no final answer to judge. Round one's judge
  pass found the arms roughly level and found one real defect, which produced the anti-proxy rule
  that both arms now carry.

### What shipped

The directive is in `buildProjectContext()`, gated on `CALANDRIA_DELEGATE_COLLECTION` (default on)
and on the `dispatchesSubagents` capability, so a Codex turn — which has no subagent verb — never
sees it. It costs **620 tokens on every turn's system prompt**, measured; root `CLAUDE.md` gave back
552 of that once per session in this repo, and every other project on the instance pays the 620 with
no offset. `tests/delegateCollection.test.ts` pins the three things that are load-bearing rather
than editorial: that it is present, that it is **last**, and that the trigger is a count.

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

For round two, three changes to that recipe, all of which are what made 30 runs affordable and the
numbers comparable:

- `--output-format stream-json --verbose` instead of `json`, read line by line. The result JSON has
  no tool calls in it, so dispatch has to be inferred from `usage.modelUsage`; the stream has the
  `tool_use` blocks themselves, and `parent_tool_use_id` is what separates the main loop from its
  subagents. Group main-loop blocks by `message.id` before counting "turns" — the CLI emits one
  stream event per content block, so four parallel `Agent` calls arrive as four events in one
  message, and counting events makes a batch look like a serial chain.
- **Kill the run at 20 main-loop assistant blocks.** A full run is 30–100 turns; the dispatch
  decision is made in the first handful. `subprocess.Popen(..., start_new_session=True)` and
  `os.killpg` on the way out, or the CLI's children outlive the runner.
- Both arms inside the same hour, and the treatment as `--append-system-prompt "$(…)"` rather than
  as a second checkout, so the only difference is the text under test. Verify the append actually
  landed before trusting a null result — one cheap run asking whether the instructions contain a
  distinctive sentence from it.

To re-check the robustness case, set `CLAUDE_CODE_THISTLE_GREBE=counter_steer` in the runner's
environment; to check whether it is on by default on some future CLI, ask a one-line session
whether its instructions contain "Subagents multiply cost and time".
