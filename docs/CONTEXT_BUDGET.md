# CLAUDE.md's context budget

`CLAUDE.md` is loaded into every session in this repo before any code is read, so its size is
a fixed tax on every turn. This is the measurement behind how it's organized, and the decision
that came out of it. Re-measure before arguing with it — every number here is reproducible.

## How to measure it

Token counts here are **measured, not estimated**. Estimating from bytes is wrong by a wide
margin: this file's backtick-dense identifier prose tokenizes at ~2.7 chars/token, not the
~3.7 typical of English, so a byte-based guess undercounts by about a third.

The measurement is a usage diff — run a trivial turn in a directory with the file and in one
without, and subtract. Sum **all three** input buckets; `cache_creation_input_tokens` alone
undercounts once prompt caching kicks in on a second run.

```bash
claude -p "Reply with the single word: ok" --output-format json \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
| python3 -c "import json,sys; u=json.load(sys.stdin)['usage']; \
print(u.get('input_tokens',0)+u.get('cache_creation_input_tokens',0)+u.get('cache_read_input_tokens',0))"
```

## What it measured (2026-08-20, CLI 2.1.228)

| Fact | Value |
|-|-|
| `CLAUDE.md` | 52,205 bytes / **19,250 tokens** (reproducible to ±5) |
| Empty-dir baseline (system prompt + built-in tools, MCP off) | 23,152 tokens |
| Real session in this repo (full MCP inheritance) | 50,875 tokens |
| `CLAUDE.md`'s share of that real session | **37.8%** |
| Growth | 10,797 B (2026-07-12) → 52,205 B (2026-08-20) — **~1 KB/day** |

Two sections are 83% of the file, and one paragraph is 25% of it:

| Section | Bytes | Tokens |
|-|-|-|
| The turn lifecycle | 28,366 | 10,307 |
| — of which, the `lib/agents/claude/driver.ts` paragraph alone | 13,015 | 4,727 |
| Key modules | 15,366 | 5,816 |
| Conventions & gotchas | 4,040 | 1,611 |
| Commands | 2,079 | 858 |
| everything else | 2,346 | ~1,240 |

## Nested CLAUDE.md is genuinely lazy — verified both directions

This is the fact the decision turns on, so it was tested rather than assumed:

- A 37.5 KB `lib/agents/CLAUDE.md` adds **0 tokens** at session start, and the model confirms
  it cannot see a marker string planted inside it.
- Reading **any** file under that directory loads it — including from a deeper path
  (`lib/agents/claude/driver.ts` pulls in `lib/agents/CLAUDE.md`), so ancestor chaining works.

Directory-scoping therefore **defers** content, it does not delete it. That is a different
trade from "cut it and hope", and it is why the split below is safe.

## Duplication against `docs/` — real, but not the lever it looks like

Verbatim 8-gram overlap with all of `docs/` is only **5.6%**, so nothing was copy-pasted.
Topic-level overlap (matching shared code identifiers) is much higher: **46% against
`docs/ARCHITECTURE.md`, 50% against all docs**. The 13 KB driver paragraph alone is 65%
covered there.

The obvious move — delete the duplicated half and link to `docs/` — is **wrong**, and the
measurement is what shows it. Where the two files cover the same ground, `ARCHITECTURE.md` is
frequently the *fuller and fresher* one. These are real code facts documented there and
missing from `CLAUDE.md`:

| Fact | In code | `ARCHITECTURE.md` | `CLAUDE.md` |
|-|-|-|-|
| one-shots set `skills: []` | `lib/agents/claude/driver.ts:183` | yes | **no** |
| `blockedPath` forces a prompt | `lib/permissions.ts:73` | yes | **no** |
| tool defs shared via `lib/agentToolDefs.mjs` | `lib/agents/claude/driver.ts:41` | yes | **no** |
| one-shot `maxTurns` (1 / 40) | `lib/agents/claude/driver.ts:201,900` | yes | **no** |
| codex `costIsEstimated` | `lib/agents/types.ts:78` | yes | **no** |

So the always-loaded copy is the stale one. Maintaining the same "why" prose in two places has
already produced drift; cutting the loaded copy and linking would leave the accurate prose
only where agents don't reliably read. **The duplication finding argues for fixing drift, not
for trimming.**

## Decision: split by directory, not by deleting

"Leave it alone" was a live option and the measurement does not support it: 37.8% of every
session, growing ~1 KB/day, with a deferral mechanism that provably works.

The dividing line is **not** "important vs. unimportant" — all of it is load-bearing, which is
why none of it gets deleted. It is **when you need it**:

- **Root `CLAUDE.md` keeps what you need _before_ you know where you're going** — the commands
  (tests run in Docker), the conventions and gotchas, the turn lifecycle, the repo split.
  Critically this includes the Turbopack async-import rule and the `lib/autoStart.ts`
  `await import()` case: you need those while editing `lib/services.ts` or `lib/autoStart.ts`,
  neither of which is under `lib/agents/`, so a nested file would never load in time.
- **`lib/agents/CLAUDE.md` keeps what you need _once you're there_** — the Claude driver's
  permission modes and Vertex model corrections, one-shot isolation, MCP inheritance
  asymmetry, slash-command discovery, adding a third agent.

Measured result of exactly that split:

| | Tokens |
|-|-|
| Root `CLAUDE.md` today | 19,250 |
| Candidate root after the split | **10,289** (−47%) |
| Deferred into `lib/agents/CLAUDE.md` | 9,146 (loads on demand) |
| Pointer paragraph overhead | +185 |

A session that never touches `lib/agents/` starts ~8,961 tokens lighter; one that does pays
the same total as today, just later.

### The one gap to handle carefully

The permission material spans two trees. `lib/permissions.ts` is **not** under `lib/agents/`,
so a `lib/agents/CLAUDE.md` will not load for someone editing the gate itself. Split it: the
capability/`dontAsk`/Vertex material is driver-local and moves; the `canUseTool` gate's
contract stays reachable from the root file. Don't move a paragraph just because it mentions
an agent.

## Rules going forward

- Adding to root `CLAUDE.md` costs every session in the repo. Prefer the nearest directory-
  scoped file; put it in root only if it's needed before you'd open that directory.
- Don't restate `docs/` prose in `CLAUDE.md`. One of the copies will go stale, and the loaded
  one is not reliably the fresh one.
- Re-measure with the command above rather than counting bytes.
