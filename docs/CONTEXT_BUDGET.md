---
title: "CLAUDE.md's context budget"
---

# CLAUDE.md's context budget

`CLAUDE.md` is loaded into every session in this repo before any code is read, so its size is
a fixed tax on every turn. This document records the measurement behind how it's organized and
the decision that came out of it. Re-measure before arguing with it; every number here is
reproducible.

## How to measure it

Token counts here are measured, not estimated. Estimating from bytes is wrong by a wide margin:
this file's backtick-dense identifier prose tokenizes at ~2.7 chars/token, not the ~3.7 typical
of English, so a byte-based guess undercounts by about a third.

The measurement is a usage diff: run a trivial turn in a directory with the file and in one
without, and subtract. Sum all three input buckets; `cache_creation_input_tokens` alone
undercounts once prompt caching kicks in on a second run.

```bash
claude -p "Reply with the single word: ok" --model claude-sonnet-5 --output-format json \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
| python3 -c "import json,sys; u=json.load(sys.stdin)['usage']; \
print(u.get('input_tokens',0)+u.get('cache_creation_input_tokens',0)+u.get('cache_read_input_tokens',0))"
```

Two things about running it. Pass `--model` explicitly: a machine whose `~/.claude/settings.json`
pins a model that is out of quota fails every run otherwise, and the failure has nothing to do
with what is being measured. And the baseline is whatever that machine's own configuration loads
(a user-level `CLAUDE.md`, plugins, skills), so the absolute numbers below are not comparable
across machines. Only the with-minus-without diff is.

## Where it stands (2026-08-27, CLI 2.1.240)

The split below was carried out, together with a plain-language rewrite of both agent-instruction
files. Measured on one machine against an empty-directory baseline of 44,507 tokens:

| File | Before | After | Loaded |
|-|-|-|-|
| Root `CLAUDE.md` | 64,337 B / **23,683 tokens** | 48,122 B / **18,524 tokens** (−22%) | every session |
| `lib/agents/CLAUDE.md` | — | 17,330 B / **6,460 tokens** | on reading anything under `lib/agents/` |
| `.github/CLAUDE.md` | 2,366 B / 850 tokens | 2,467 B / **891 tokens** | on reading anything under `.github/` |

A session that never opens `lib/agents/` starts 5,159 tokens lighter. One that does pays 24,984,
about 5% more than the single file cost, which is the price of the pointer paragraphs and of
saying things in sentences instead of dash-chains.

The rewrite kept every fact, so it is not where the saving came from: the driver material
compressed by 26% on the way into `lib/agents/CLAUDE.md`, while "Key modules" stayed within 2% of
its old size no matter how hard it was squeezed. That section is invariants and identifiers with
almost no filler. **Prose style is not a lever on this file's size. Placement is.**

One fact was dropped rather than restated: `lib/idle.ts` had been deleted (`305a421`) while
`CLAUDE.md` still described it as the busy-tracking module. Liveness is `lib/abort.ts`'s turn
registry, exported as `calandria_turns_active` by `lib/metrics.ts`.

## What it measured (2026-08-20, CLI 2.1.228)

| Fact | Value |
|-|-|
| `CLAUDE.md` | 52,205 bytes / **19,250 tokens** (reproducible to ±5) |
| Empty-dir baseline (system prompt + built-in tools, MCP off) | 23,152 tokens |
| Real session in this repo (full MCP inheritance) | 50,875 tokens |
| `CLAUDE.md`'s share of that real session | **37.8%** |
| Growth | 10,797 B (2026-07-12) → 52,205 B (2026-08-20), **~1 KB/day** |

Two sections account for 83% of the file, and one paragraph alone is 25% of it:

| Section | Bytes | Tokens |
|-|-|-|
| The turn lifecycle | 28,366 | 10,307 |
| (of which) the `lib/agents/claude/driver.ts` paragraph alone | 13,015 | 4,727 |
| Key modules | 15,366 | 5,816 |
| Conventions & gotchas | 4,040 | 1,611 |
| Commands | 2,079 | 858 |
| everything else | 2,346 | ~1,240 |

## Nested CLAUDE.md defers content, it doesn't drop it

This is the fact the decision turns on, so it was tested rather than assumed:

- A 37.5 KB `lib/agents/CLAUDE.md` adds 0 tokens at session start, and the model confirms it
  cannot see a marker string planted inside it.
- Reading any file under that directory loads it, including from a deeper path
  (`lib/agents/claude/driver.ts` pulls in `lib/agents/CLAUDE.md`), so ancestor chaining works.

Directory-scoping defers content rather than deleting it. That's a different trade from cutting
material and hoping nobody needed it, and it's why the split below is safe.

## Duplication against `docs/` is real, but not the lever it looks like

Verbatim 8-gram overlap with all of `docs/` is only 5.6%, so nothing was copy-pasted.
Topic-level overlap (matching shared code identifiers) is much higher: 46% against
`docs/ARCHITECTURE.md`, 50% against all docs. The 13 KB driver paragraph alone is 65% covered
there.

Deleting the duplicated half and linking to `docs/` looks like the obvious move, but the
measurement rules it out. Where the two files cover the same ground, `ARCHITECTURE.md` is
often the fuller and fresher one. These are real code facts documented there and missing from
`CLAUDE.md`:

| Fact | In code | `ARCHITECTURE.md` | `CLAUDE.md` |
|-|-|-|-|
| one-shots set `skills: []` | `lib/agents/claude/driver.ts:183` | yes | **no** |
| `blockedPath` forces a prompt | `lib/permissions.ts:73` | yes | **no** |
| tool defs shared via `lib/agentToolDefs.mjs` | `lib/agents/claude/driver.ts:41` | yes | **no** |
| one-shot `maxTurns` (1 / 40) | `lib/agents/claude/driver.ts:201,900` | yes | **no** |
| codex `costIsEstimated` | `lib/agents/types.ts:78` | yes | **no** |

So the always-loaded copy is the stale one. Maintaining the same rationale in two places has
already produced drift; cutting the loaded copy and linking would leave the accurate prose only
where agents don't reliably read it. The duplication finding argues for fixing drift, not for
trimming.

The 2026-08-27 rewrite closed the first and fourth rows (`skills: []` and both one-shot
`maxTurns` values are now in `lib/agents/CLAUDE.md`) and corrected a fifth drift the table
missed: the file claimed a turn's `settingSources` was `["user", "project", "local"]` and the
SDK's own default, when `SETTING_SOURCES` is `["user", "project"]` and drops `local` on purpose.

## Decision: split by directory, not by deleting

Leaving the file alone was a live option, but the measurement doesn't support it: 37.8% of
every session, growing ~1 KB/day, with a deferral mechanism that provably works.

The dividing line isn't important versus unimportant; all of it is load-bearing, which is why
none of it gets deleted. The line is when you need it:

- Root `CLAUDE.md` keeps what you need before you know where you're going: the commands (tests
  run in Docker), the conventions and gotchas, the turn lifecycle, the scope note. This includes
  the Turbopack async-import rule and the `lib/autoStart.ts` `await import()` case, because you
  need those while editing `lib/services.ts` or `lib/autoStart.ts`. Neither is under
  `lib/agents/`, so a nested file would never load in time.
- `lib/agents/CLAUDE.md` keeps what you need once you're there: the Claude driver's permission
  modes and Vertex model corrections, one-shot isolation, MCP inheritance asymmetry,
  slash-command discovery, adding a third agent.

Measured projection for exactly that split, made on 2026-08-20 against the 52,205-byte file:

| | Tokens |
|-|-|
| Root `CLAUDE.md` then | 19,250 |
| Candidate root after the split | **10,289** (−47%) |
| Deferred into `lib/agents/CLAUDE.md` | 9,146 (loads on demand) |
| Pointer paragraph overhead | +185 |

The split landed on 2026-08-27 at 18,478 root tokens rather than 10,289, for two reasons. The
file grew by 12 KB in the week between the projection and the split, and "Key modules" stayed in
root, as the keep-list above says it should: it is the orientation material you need *before* you
know which directory you're heading for, and its modules sit directly in `lib/`, where a nested
file would load for almost every session anyway.

### The one gap to handle carefully

The permission material spans two trees. `lib/permissions.ts` is not under `lib/agents/`, so a
`lib/agents/CLAUDE.md` won't load for someone editing the gate itself. Split it: the
capability/`dontAsk`/Vertex material is driver-local and moves; the `canUseTool` gate's contract
stays reachable from the root file. Don't move a paragraph just because it mentions an agent.

## Rules going forward

- Adding to root `CLAUDE.md` costs every session in the repo. Prefer the nearest
  directory-scoped file; put it in root only if it's needed before you'd open that directory.
  Driver-specific material has a home already: `lib/agents/CLAUDE.md`.
- Don't restate `docs/` prose in `CLAUDE.md`. One of the copies will go stale, and the loaded
  one isn't reliably the fresh one.
- Re-measure with the command above rather than counting bytes, and record the new numbers here.
- Don't reach for a style pass to shrink this file. One was done on 2026-08-27 and returned about
  2% on the sections that stayed put. Move material or cut it; rewording it does neither.
