# Scheduled Task Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a saved prompt run on a recurring schedule in the user's local timezone, with nobody logged in, so a weekday 08:30 `/jira-tasks` run lands triaged suggestions in the tray before the user sits down.

**Architecture:** A project-keyed `schedules` table owns a prompt; a server-owned 30s ticker adjudicates due occurrences against a `schedule_runs` ledger (whose `UNIQUE(schedule_id, scheduled_for)` is the durable claim), mints a fresh task per firing, and launches its first turn the way `lib/autoStart.ts` does. Scheduled turns carry an explicit `RunContext` marking them non-interactive, so the permission gate denies instead of parking on a human who isn't there.

**Tech Stack:** TypeScript (strict), Next.js App Router, better-sqlite3, vitest, Playwright. No new dependencies — the time math is `Intl`-only on purpose.

**Spec:** `docs/superpowers/specs/2026-08-14-scheduled-tasks-design.md` — read it first; this plan argues from it.

## Global Constraints

- **Tests run in a container**, always: `npm run test:docker`, single file `npm run test:docker -- tests/foo.test.ts`, types `npm run typecheck:docker`. Never run bare `npm test`.
- **No new npm dependencies.** The time math uses `Intl` only.
- **TypeScript is strict**; path alias `@/*` → repo root.
- **Env-driven config**: every knob goes in `lib/config.ts` **and** `.env.example` with a documented default.
- **`lib/schedule/time.ts`, `lib/schedule/store.ts` and `lib/runContext.ts` must stay SDK-free** and be added to `PINNED` in `tests/importGraph.test.ts`. `lib/scheduler.ts` reaches `lib/runner.ts` deliberately and is NOT pinned (same as `lib/autoStart.ts`).
- **Delete is hard delete** in this repo; nothing in this feature auto-deletes a task.
- **Commits explain the why**, not just the what.
- Day-of-week bitmask: `Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64`. **Weekdays = 62.**
- Run statuses: `claimed | running | succeeded | failed | stopped | interrupted | missed | skipped_overlap`.
- Triggers: `scheduled | catch_up | manual`.

## File Structure

The subsystem is split so the parts that must be heavily tested carry no dependencies, and the one part that reaches the agent SDKs is isolated behind a single module.

| File | Responsibility | SDK-free? |
|-|-|-|
| `lib/schedule/time.ts` | Wall-clock math: next occurrence, DST rules. `Intl` only. | pinned |
| `lib/schedule/store.ts` | `schedules` + `schedule_runs` queries, incl. the durable claim. | pinned |
| `lib/schedule/due.ts` | Adjudication: fire / catch up / miss / skip. Pure decision. | pinned |
| `lib/schedule/commands.ts` | Slash-command registry probe + prompt validation. | no (SDK) |
| `lib/runContext.ts` | Why a turn is running, and whether it may prompt. | pinned |
| `lib/scheduler.ts` | The ticker, preflight, mint, launch. Reaches the runner. | no |
| `lib/db.ts`, `lib/types.ts`, `lib/store.ts`, `lib/config.ts` | Schema, types, task creation, knobs. | unchanged status |
| `lib/permissions.ts`, `lib/runner.ts` | Honour the run context; settle runs truthfully. | unchanged status |
| `app/api/instance/scheduler/route.ts` | Boot hook. | no |
| `app/api/projects/[id]/schedules/*`, `app/api/schedules/*` | REST surface. | no |
| `app/orchestrator/Schedules.tsx` | Landing-pane card + editor. | client |

The split matters for one concrete reason: `tests/importGraph.test.ts` fails any pinned module that can reach an agent SDK, and its walker follows dynamic `import()`. Keeping adjudication in `due.ts` (pinned) and launching in `scheduler.ts` (not pinned) is what lets every scheduling decision be tested without an agent anywhere near it.

---

### Task 1: Wall-clock time math

Pure, dependency-free, the part that fails twice a year with nobody watching. Every epoch value in the tests below was verified against real ICU before this plan was written — they are not guesses.

**Files:**
- Create: `lib/schedule/time.ts`
- Test: `tests/scheduleTime.test.ts`
- Modify: `tests/importGraph.test.ts` (add to `PINNED`)

**Interfaces:**
- Consumes: nothing.
- Produces: `nextFireAt(spec: ScheduleSpec, afterMs: number): { ms: number; dstAdjusted: DstAdjustment }`, `type ScheduleSpec = { daysMask: number; timeOfDay: string; timezone: string }`, `type DstAdjustment = "" | "gap_forward" | "ambiguous_first"`.

- [ ] **Step 1: Write the failing test**

Create `tests/scheduleTime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextFireAt } from "@/lib/schedule/time";

const LA = "America/Los_Angeles";
const WEEKDAYS = 62; // Mon–Fri
const DAILY = 127;
const at = (iso: string) => Date.parse(iso);
const weekdays830 = { daysMask: WEEKDAYS, timeOfDay: "08:30", timezone: LA };

describe("nextFireAt", () => {
  it("fires at local 08:30 when the host clock is UTC", () => {
    // Wed 2026-08-12 02:00 PDT. 08:30 PDT that morning is 15:30Z.
    expect(nextFireAt(weekdays830, at("2026-08-12T09:00:00Z")).ms).toBe(at("2026-08-12T15:30:00Z"));
  });

  it("is strictly after: a tick at exactly the fire instant rolls to the next day", () => {
    expect(nextFireAt(weekdays830, at("2026-08-12T15:30:00Z")).ms).toBe(at("2026-08-13T15:30:00Z"));
  });

  it("skips the weekend", () => {
    // Friday afternoon → Monday morning.
    expect(nextFireAt(weekdays830, at("2026-08-14T16:00:00Z")).ms).toBe(at("2026-08-17T15:30:00Z"));
  });

  it("keeps the WALL CLOCK fixed across a DST boundary, moving the UTC instant", () => {
    const daily830 = { daysMask: DAILY, timeOfDay: "08:30", timezone: LA };
    // Spring forward (2026-03-08): 08:30 PST was 16:30Z, 08:30 PDT is 15:30Z.
    expect(nextFireAt(daily830, at("2026-03-06T20:00:00Z")).ms).toBe(at("2026-03-07T16:30:00Z"));
    expect(nextFireAt(daily830, at("2026-03-07T20:00:00Z")).ms).toBe(at("2026-03-08T15:30:00Z"));
    // Fall back (2026-11-01): back to 16:30Z.
    expect(nextFireAt(daily830, at("2026-10-31T20:00:00Z")).ms).toBe(at("2026-11-01T16:30:00Z"));
  });

  it("spring-forward gap: a nonexistent wall time fires at the first valid instant", () => {
    // 02:30 does not exist on 2026-03-08 in LA (02:00 jumps to 03:00).
    const r = nextFireAt({ daysMask: DAILY, timeOfDay: "02:30", timezone: LA }, at("2026-03-08T00:00:00Z"));
    expect(r.ms).toBe(at("2026-03-08T10:00:00Z")); // 03:00 local
    expect(r.dstAdjusted).toBe("gap_forward");
  });

  it("fall-back overlap: an ambiguous wall time fires ONCE, at the earlier instant", () => {
    const spec = { daysMask: DAILY, timeOfDay: "01:30", timezone: LA };
    const first = nextFireAt(spec, at("2026-11-01T00:00:00Z"));
    expect(first.ms).toBe(at("2026-11-01T08:30:00Z")); // 01:30 PDT, the first pass
    expect(first.dstAdjusted).toBe("ambiguous_first");
    // A tick landing on that instant must NOT schedule the second 01:30 (09:30Z).
    expect(nextFireAt(spec, first.ms).ms).toBe(at("2026-11-02T09:30:00Z"));
  });

  it("handles a fractional-offset zone", () => {
    // Asia/Kathmandu is +05:45.
    const r = nextFireAt({ daysMask: DAILY, timeOfDay: "08:30", timezone: "Asia/Kathmandu" }, at("2026-08-12T00:00:00Z"));
    expect(r.ms).toBe(at("2026-08-12T02:45:00Z"));
  });

  it("handles 30-minute DST (Lord Howe)", () => {
    const LH = "Australia/Lord_Howe";
    // 2026-10-04: 02:00 jumps to 02:30, so 02:15 does not exist.
    const gap = nextFireAt({ daysMask: DAILY, timeOfDay: "02:15", timezone: LH }, at("2026-10-03T00:00:00Z"));
    expect(gap.dstAdjusted).toBe("gap_forward");
    expect(gap.ms).toBe(at("2026-10-03T15:30:00Z")); // 02:30 local
    // 2026-04-05: 02:00 falls back to 01:30, so 01:45 happens twice.
    const dup = nextFireAt({ daysMask: DAILY, timeOfDay: "01:45", timezone: LH }, at("2026-04-04T00:00:00Z"));
    expect(dup.dstAdjusted).toBe("ambiguous_first");
    expect(dup.ms).toBe(at("2026-04-04T14:45:00Z"));
  });

  it("crosses leap day and the year boundary", () => {
    const daily = { daysMask: DAILY, timeOfDay: "08:30", timezone: LA };
    expect(nextFireAt(daily, at("2028-02-29T00:00:00Z")).ms).toBe(at("2028-02-29T16:30:00Z"));
    expect(nextFireAt(daily, at("2026-12-31T20:00:00Z")).ms).toBe(at("2027-01-01T16:30:00Z"));
  });

  it("rejects an unusable spec rather than guessing", () => {
    expect(() => nextFireAt({ daysMask: 0, timeOfDay: "08:30", timezone: LA }, Date.now())).toThrow(/days_mask/);
    expect(() => nextFireAt({ daysMask: 62, timeOfDay: "8:30", timezone: LA }, Date.now())).toThrow(/time_of_day/);
    expect(() => nextFireAt({ daysMask: 62, timeOfDay: "24:00", timezone: LA }, Date.now())).toThrow(/time_of_day/);
    expect(() => nextFireAt({ daysMask: 62, timeOfDay: "08:30", timezone: "Mars/Olympus" }, Date.now())).toThrow(/timezone/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:docker -- tests/scheduleTime.test.ts`
Expected: FAIL — cannot resolve `@/lib/schedule/time`.

- [ ] **Step 3: Write the implementation**

Create `lib/schedule/time.ts`:

```ts
// Wall-clock scheduling math. Intl only — no deps, no DB, no SDK (pinned by
// tests/importGraph.test.ts).
//
// The whole job: given "08:30 on weekdays, America/Los_Angeles", find the next
// UTC instant that RENDERS as that wall time in that zone. The server may be a
// container on UTC while the user is on Pacific, and the correct instant moves
// by an hour twice a year while the wall time does not.

export interface ScheduleSpec {
  /** Bitmask of allowed weekdays: Sun=1, Mon=2, … Sat=64. Weekdays = 62. */
  daysMask: number;
  /** 'HH:MM', 24-hour, local to `timezone`. */
  timeOfDay: string;
  /** IANA zone name. Never an offset — offsets don't survive DST. */
  timezone: string;
}

/** Which DST oddity (if any) moved this firing off its nominal wall time. */
export type DstAdjustment = "" | "gap_forward" | "ambiguous_first";

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    // Throws RangeError on an unknown zone — that's the validation.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timezone, f);
  }
  return f;
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** How `ms` renders on the wall clock in `timezone`. */
export function partsIn(ms: number, timezone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out as unknown as LocalParts;
}

/**
 * The zone's UTC offset at `ms`, derived by formatting the instant and reading
 * the result back as if it were UTC. Second-granular, which is all any real
 * zone needs.
 */
function offsetAt(ms: number, timezone: string): number {
  const p = partsIn(ms, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The first minute at or after `lo` carrying a different offset than `lo` —
 * i.e. the instant a DST transition completes. `lo` and `hi` must straddle it.
 * Only ever called on a spring-forward gap, so the binary search is free.
 */
function transitionBetween(lo: number, hi: number, timezone: string): number {
  const loOffset = offsetAt(lo, timezone);
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000;
    if (mid <= lo || mid >= hi) break;
    if (offsetAt(mid, timezone) === loOffset) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The instant for a nominal local wall time, and whether DST moved it.
 *
 * Candidates are built from the offsets a day either side, which brackets any
 * transition, then filtered to those that actually render back as the requested
 * wall time:
 *   - exactly one survives → the ordinary case;
 *   - two survive → the wall time happens twice (fall back); take the EARLIER
 *     so the schedule runs once, on the first pass;
 *   - none survive → the wall time doesn't exist (spring forward); run at the
 *     instant the gap closes, which is as soon as the clock permits.
 */
export function resolveWall(
  year: number, month: number, day: number, hour: number, minute: number, timezone: string
): { ms: number; dstAdjusted: DstAdjustment } {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const candidates = [...new Set([naive - offsetAt(naive - DAY_MS, timezone), naive - offsetAt(naive + DAY_MS, timezone)])]
    .sort((a, b) => a - b);
  const valid = candidates.filter((c) => offsetAt(c, timezone) + Math.floor(c / 1000) * 1000 === naive);
  if (valid.length === 0) {
    return { ms: transitionBetween(candidates[0], candidates[candidates.length - 1], timezone), dstAdjusted: "gap_forward" };
  }
  if (valid.length > 1) return { ms: valid[0], dstAdjusted: "ambiguous_first" };
  return { ms: valid[0], dstAdjusted: "" };
}

/**
 * The next firing strictly after `afterMs`. Strictly, so re-adjudicating a slot
 * we just fired can never fire it again.
 */
export function nextFireAt(spec: ScheduleSpec, afterMs: number): { ms: number; dstAdjusted: DstAdjustment } {
  const { daysMask, timeOfDay, timezone } = spec;
  const parsed = /^(\d{2}):(\d{2})$/.exec(timeOfDay);
  if (!parsed) throw new Error(`invalid time_of_day (want 'HH:MM'): ${timeOfDay}`);
  const hour = Number(parsed[1]);
  const minute = Number(parsed[2]);
  if (hour > 23 || minute > 59) throw new Error(`invalid time_of_day (out of range): ${timeOfDay}`);
  if (!Number.isInteger(daysMask) || daysMask <= 0 || daysMask > 127) {
    throw new Error(`invalid days_mask (want 1–127): ${daysMask}`);
  }
  try {
    formatter(timezone);
  } catch {
    throw new Error(`invalid timezone (want an IANA zone): ${timezone}`);
  }

  // Walk local CALENDAR dates, never epoch + 24h — the latter is wrong on a DST
  // day by exactly the amount that matters here.
  const start = partsIn(afterMs, timezone);
  for (let i = 0; i < 400; i++) {
    const nominal = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    if (!(daysMask & (1 << nominal.getUTCDay()))) continue;
    const resolved = resolveWall(
      nominal.getUTCFullYear(), nominal.getUTCMonth() + 1, nominal.getUTCDate(), hour, minute, timezone
    );
    if (resolved.ms > afterMs) return resolved;
  }
  // 400 > 366, so any non-empty mask resolves long before here.
  throw new Error("no occurrence found within 400 days");
}

/** Human summary for the UI and run notes, e.g. "Mon–Fri at 08:30 (America/Los_Angeles)". */
export function describeSpec(spec: ScheduleSpec): string {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = names.filter((_, i) => spec.daysMask & (1 << i));
  let label: string;
  if (days.length === 7) label = "Every day";
  else if (spec.daysMask === 62) label = "Mon–Fri";
  else if (spec.daysMask === 65) label = "Sat–Sun";
  else label = days.join(", ");
  return `${label} at ${spec.timeOfDay} (${spec.timezone})`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:docker -- tests/scheduleTime.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Pin the module as SDK-free**

In `tests/importGraph.test.ts`, add to the `PINNED` array after the `lib/permissions.ts` entry:

```ts
  "lib/schedule/time.ts", //     pure wall-clock math — no DB, no SDK
```

- [ ] **Step 6: Run the pin test and typecheck**

Run: `npm run test:docker -- tests/importGraph.test.ts && npm run typecheck:docker`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/schedule/time.ts tests/scheduleTime.test.ts tests/importGraph.test.ts
git commit -m "Add DST-correct wall-clock math for schedules

Given 'weekdays 08:30 America/Los_Angeles', find the next UTC instant that
renders as that wall time. The container runs UTC while the user is on Pacific,
so the instant moves by an hour twice a year and the wall time must not.

Both DST edges are decided rather than left to luck: a nonexistent wall time
(spring forward) fires at the instant the gap closes — as soon as the clock
permits — and an ambiguous one (fall back) fires once, on the earlier pass.
Verified against real ICU, including a fractional-offset zone (Kathmandu) and
30-minute DST (Lord Howe)."
```

---

### Task 2: Schema, types, and the durable claim

**Files:**
- Modify: `lib/db.ts` (new tables in `init`, `tasks.schedule_id` in `migrate`)
- Modify: `lib/types.ts` (append `Schedule`, `ScheduleRun`; add `schedule_id` to `Task`)
- Modify: `lib/store.ts` (`createTask` accepts `schedule_id`; `updateTask` stops dropping it)
- Create: `lib/schedule/store.ts`
- Test: `tests/scheduleStore.test.ts`
- Modify: `tests/importGraph.test.ts`

**Interfaces:**
- Consumes: `nextFireAt` from Task 1.
- Produces: `createSchedule`, `getSchedule`, `listSchedules(projectId)`, `listEnabledSchedules()`, `updateSchedule`, `deleteSchedule`, `claimRun`, `startRun`, `settleRun`, `recordMissedRun`, `recordSkippedRun`, `listRuns(scheduleId, limit)`, `lastRun(scheduleId)`, `activeRun(scheduleId)`, `specOf(schedule)`.

- [ ] **Step 1: Write the failing test**

Create `tests/scheduleStore.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { createProject } from "@/lib/store";
import {
  createSchedule, getSchedule, listSchedules, listEnabledSchedules, updateSchedule,
  deleteSchedule, claimRun, settleRun, recordMissedRun, listRuns, lastRun, specOf,
} from "@/lib/schedule/store";

const at = (iso: string) => Date.parse(iso);

function project() {
  return createProject({ name: `sched-${Math.random().toString(36).slice(2)}` }).id;
}

function schedule(projectId: string, over: Partial<Parameters<typeof createSchedule>[0]> = {}) {
  return createSchedule({
    project_id: projectId,
    name: "Jira triage",
    prompt: "/jira-tasks",
    days_mask: 62,
    time_of_day: "08:30",
    timezone: "America/Los_Angeles",
    agent: "claude",
    permission_mode: "bypassPermissions",
    ...over,
  });
}

describe("schedule store", () => {
  let pid: string;
  beforeEach(() => { pid = project(); });

  it("computes next_fire_at at creation", () => {
    const s = schedule(pid);
    expect(s.next_fire_at).toBeGreaterThan(Date.now());
    expect(specOf(s)).toEqual({ daysMask: 62, timeOfDay: "08:30", timezone: "America/Los_Angeles" });
  });

  it("lists per project, and only enabled ones for the ticker", () => {
    const a = schedule(pid);
    const b = schedule(pid, { name: "Paused one" });
    updateSchedule(b.id, { enabled: 0 });
    expect(listSchedules(pid).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(listEnabledSchedules().map((s) => s.id)).toEqual([a.id]);
  });

  it("recomputes next_fire_at when the spec changes", () => {
    const s = schedule(pid);
    const moved = updateSchedule(s.id, { time_of_day: "17:45" })!;
    expect(moved.next_fire_at).not.toBe(s.next_fire_at);
  });

  it("resuming a paused schedule skips the slots it was paused through", () => {
    const s = schedule(pid);
    updateSchedule(s.id, { enabled: 0 });
    const resumed = updateSchedule(s.id, { enabled: 1 })!;
    expect(resumed.next_fire_at).toBeGreaterThan(Date.now());
  });

  it("claims an occurrence exactly once — the durable claim", () => {
    const s = schedule(pid);
    const slot = at("2026-08-12T15:30:00Z");
    const first = claimRun(s.id, slot, "scheduled");
    const second = claimRun(s.id, slot, "scheduled");
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // the UNIQUE index adjudicated, not a read-then-write check
    expect(listRuns(s.id, 10)).toHaveLength(1);
  });

  it("settles a run with a real outcome", () => {
    const s = schedule(pid);
    const run = claimRun(s.id, at("2026-08-12T15:30:00Z"), "scheduled")!;
    settleRun(run.id, "failed", "the repo path no longer exists");
    const settled = lastRun(s.id)!;
    expect(settled.status).toBe("failed");
    expect(settled.detail).toBe("the repo path no longer exists");
    expect(settled.finished_at).toBeGreaterThan(0);
  });

  it("records a missed occurrence so a skipped morning is visible", () => {
    const s = schedule(pid);
    recordMissedRun(s.id, at("2026-08-12T15:30:00Z"), "the app was not running");
    const run = lastRun(s.id)!;
    expect(run.status).toBe("missed");
    expect(run.task_id).toBeNull();
  });

  it("keeps run history when the schedule's tasks are gone, and drops it with the schedule", () => {
    const s = schedule(pid);
    claimRun(s.id, at("2026-08-12T15:30:00Z"), "scheduled");
    expect(listRuns(s.id, 10)).toHaveLength(1);
    deleteSchedule(s.id);
    expect(getSchedule(s.id)).toBeNull();
    expect(listRuns(s.id, 10)).toHaveLength(0);
  });

  it("prunes run history beyond the retention cap", () => {
    const s = schedule(pid);
    const base = at("2026-08-12T15:30:00Z");
    for (let i = 0; i < 55; i++) claimRun(s.id, base + i * 86_400_000, "scheduled");
    expect(listRuns(s.id, 200).length).toBeLessThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:docker -- tests/scheduleStore.test.ts`
Expected: FAIL — cannot resolve `@/lib/schedule/store`.

- [ ] **Step 3: Add the tables to `lib/db.ts`**

In `init()`, inside the big `db.exec(...)` template literal, add after the `permission_rules` table:

```sql
    -- A recurring prompt: "run /jira-tasks at 08:30 on weekdays". Project-keyed
    -- and deliberately its OWN table rather than a column on a task row, so a
    -- schedule outlives the tasks it mints (each firing creates a fresh one).
    -- time_of_day is wall clock in `timezone`, which is an IANA zone name and
    -- never an offset — the offset changes twice a year and the wall time must
    -- not. next_fire_at is a CACHE of lib/schedule/time.ts, recomputed on edit,
    -- after each firing, and revalidated on boot (tzdata moves).
    CREATE TABLE IF NOT EXISTS schedules (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      days_mask       INTEGER NOT NULL,          -- Sun=1 … Sat=64; weekdays = 62
      time_of_day     TEXT NOT NULL,             -- 'HH:MM'
      timezone        TEXT NOT NULL,             -- IANA zone
      enabled         INTEGER NOT NULL DEFAULT 1,
      agent           TEXT NOT NULL DEFAULT 'claude',
      permission_mode TEXT,
      send_context    INTEGER NOT NULL DEFAULT 1,
      priority        TEXT NOT NULL DEFAULT 'med',
      catch_up_ms     INTEGER NOT NULL DEFAULT -1, -- -1 = use the instance default
      next_fire_at    INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    -- One row per OCCURRENCE, including the ones that never ran. Without the
    -- non-firing rows a schedule that quietly stopped looks exactly like one
    -- that had nothing to do, which is the failure this feature must not have.
    --
    -- UNIQUE(schedule_id, scheduled_for) is the DURABLE CLAIM: it is what makes
    -- a double fire impossible when two ticks overlap, when a tick races "Run
    -- now", or when a restart re-adjudicates a slot it already handled. A
    -- select-then-insert check is racy; this is not.
    CREATE TABLE IF NOT EXISTS schedule_runs (
      id            TEXT PRIMARY KEY,
      schedule_id   TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      scheduled_for INTEGER NOT NULL,
      claimed_at    INTEGER NOT NULL,
      fired_at      INTEGER NOT NULL DEFAULT 0,
      finished_at   INTEGER NOT NULL DEFAULT 0,
      task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      status        TEXT NOT NULL,
      trigger       TEXT NOT NULL,
      detail        TEXT NOT NULL DEFAULT '',
      dst_adjusted  TEXT NOT NULL DEFAULT '',
      UNIQUE(schedule_id, scheduled_for)
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_project ON schedules(project_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, scheduled_for DESC);
```

In `migrate()`, alongside the other `taskCols` additions:

```ts
  // Which schedule minted this task (lib/scheduler.ts). SET NULL rather than
  // cascade — deleting a schedule must not delete the work it produced.
  if (!taskCols.includes("schedule_id")) db.exec("ALTER TABLE tasks ADD COLUMN schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL");
```

- [ ] **Step 3b: Let `createTask` set it, and stop `updateTask` from silently dropping it**

`lib/store.ts`'s `updateTask` takes a `Partial<Task>` but writes an EXPLICIT column list, so any field missing from that list type-checks and then silently writes nothing. `schedule_id` must be set at creation rather than patched in afterwards.

In `createTask`'s input type, after `permission_mode`:

```ts
  /** The schedule that minted this task (lib/scheduler.ts). null for hand-made tasks. */
  schedule_id?: string | null;
```

and in its INSERT, add the column and value (keeping the two lists aligned):

```ts
      `INSERT INTO tasks (id, project_id, title, description, priority, status, suggested, agent, send_context, permission_mode, schedule_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'not_started', ?, ?, ?, ?, ?, ?, ?, ?)`
```

```ts
      id, input.project_id, input.title, input.description ?? "", input.priority ?? "med", input.suggested ? 1 : 0,
      agent, sendContext ? 1 : 0, input.permission_mode || null, input.schedule_id ?? null, position, now, now
```

Then add `schedule_id` to `updateTask`'s column list too, so the next person to patch it doesn't hit the same silent no-op:

```ts
      `UPDATE tasks SET title=?, …, awaiting_input=?, schedule_id=?, updated_at=? WHERE id=?`
```

with `n.schedule_id ?? null` in the matching position.

- [ ] **Step 4: Add the types**

In `lib/types.ts`, add to the `Task` interface after `auto_start`:

```ts
  schedule_id: string | null; // the schedule that minted this task (lib/scheduler.ts); null = created by hand
```

and append at the end of the file:

```ts
/** A recurring prompt. See docs/superpowers/specs/2026-08-14-scheduled-tasks-design.md. */
export interface Schedule {
  id: string;
  project_id: string;
  name: string;
  prompt: string;
  days_mask: number;   // Sun=1 … Sat=64; weekdays = 62
  time_of_day: string; // 'HH:MM' wall clock in `timezone`
  timezone: string;    // IANA zone name
  enabled: number;
  agent: string;
  permission_mode: string | null;
  send_context: number;
  priority: Priority;
  catch_up_ms: number;  // -1 = inherit the instance default
  next_fire_at: number; // cached from lib/schedule/time.ts
  created_at: number;
  updated_at: number;
}

export type ScheduleRunStatus =
  | "claimed" | "running" | "succeeded" | "failed" | "stopped" | "interrupted"
  | "missed" | "skipped_overlap";

export type ScheduleTrigger = "scheduled" | "catch_up" | "manual";

/** One occurrence of a schedule — including occurrences that never ran. */
export interface ScheduleRun {
  id: string;
  schedule_id: string;
  scheduled_for: number;
  claimed_at: number;
  fired_at: number;
  finished_at: number;
  task_id: string | null;
  status: ScheduleRunStatus;
  trigger: ScheduleTrigger;
  detail: string;
  dst_adjusted: string;
}
```

- [ ] **Step 5: Write the store module**

Create `lib/schedule/store.ts`:

```ts
// Typed queries for schedules and their run ledger. DB only — no runner, no
// SDK (pinned by tests/importGraph.test.ts), so the ticker's adjudication can
// be tested without launching anything.

import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { nextFireAt, type ScheduleSpec } from "@/lib/schedule/time";
import type { Priority, Schedule, ScheduleRun, ScheduleRunStatus, ScheduleTrigger } from "@/lib/types";

/** How many run rows to keep per schedule. Audit records, not user work. */
export const RUN_RETENTION = 50;

export const specOf = (s: Schedule): ScheduleSpec => ({
  daysMask: s.days_mask,
  timeOfDay: s.time_of_day,
  timezone: s.timezone,
});

export function getSchedule(id: string): Schedule | null {
  return (getDb().prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Schedule) ?? null;
}

export function listSchedules(projectId: string): Schedule[] {
  return getDb()
    .prepare("SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at ASC")
    .all(projectId) as Schedule[];
}

export function listEnabledSchedules(): Schedule[] {
  return getDb()
    .prepare("SELECT * FROM schedules WHERE enabled = 1 ORDER BY next_fire_at ASC")
    .all() as Schedule[];
}

export function createSchedule(input: {
  project_id: string;
  name: string;
  prompt: string;
  days_mask: number;
  time_of_day: string;
  timezone: string;
  agent?: string;
  permission_mode?: string | null;
  send_context?: boolean;
  priority?: Priority;
  catch_up_ms?: number;
}): Schedule {
  const now = Date.now();
  const id = nanoid();
  // Throws on an unusable spec — better a 400 at creation than a schedule that
  // silently never fires.
  const next = nextFireAt(
    { daysMask: input.days_mask, timeOfDay: input.time_of_day, timezone: input.timezone },
    now
  ).ms;
  getDb()
    .prepare(
      `INSERT INTO schedules (id, project_id, name, prompt, days_mask, time_of_day, timezone, enabled,
                              agent, permission_mode, send_context, priority, catch_up_ms, next_fire_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, input.project_id, input.name, input.prompt, input.days_mask, input.time_of_day, input.timezone,
      input.agent || "claude", input.permission_mode ?? null, input.send_context === false ? 0 : 1,
      input.priority ?? "med", input.catch_up_ms ?? -1, next, now, now
    );
  return getSchedule(id)!;
}

const SPEC_FIELDS = ["days_mask", "time_of_day", "timezone"] as const;

export function updateSchedule(
  id: string,
  fields: Partial<Pick<Schedule, "name" | "prompt" | "days_mask" | "time_of_day" | "timezone" | "enabled"
    | "agent" | "permission_mode" | "send_context" | "priority" | "catch_up_ms">>
): Schedule | null {
  const before = getSchedule(id);
  if (!before) return null;
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length) {
    getDb()
      .prepare(`UPDATE schedules SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, v]) => v as string | number | null), Date.now(), id);
  }
  const after = getSchedule(id)!;
  // Recompute when the spec moved, and whenever a paused schedule resumes: on
  // resume the next occurrence is strictly after NOW, so unpausing something
  // parked for a month doesn't greet the user with a month of missed rows.
  const specChanged = SPEC_FIELDS.some((f) => f in fields && before[f] !== after[f]);
  const resumed = "enabled" in fields && !before.enabled && !!after.enabled;
  if (specChanged || resumed) return refreshNextFire(after);
  return after;
}

/** Recompute and persist next_fire_at from the spec. Also the boot revalidation. */
export function refreshNextFire(schedule: Schedule, afterMs = Date.now()): Schedule {
  const next = nextFireAt(specOf(schedule), afterMs).ms;
  getDb().prepare("UPDATE schedules SET next_fire_at = ?, updated_at = ? WHERE id = ?").run(next, Date.now(), schedule.id);
  return getSchedule(schedule.id)!;
}

/** Move next_fire_at past a slot we've just adjudicated. */
export function advanceNextFire(scheduleId: string, pastMs: number): void {
  const s = getSchedule(scheduleId);
  if (!s) return;
  const next = nextFireAt(specOf(s), pastMs).ms;
  getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(next, scheduleId);
}

export function deleteSchedule(id: string): void {
  getDb().prepare("DELETE FROM schedules WHERE id = ?").run(id);
}

// ---------- the run ledger ----------

/**
 * Claim an occurrence. Returns the new run, or null when this slot was already
 * claimed — the UNIQUE(schedule_id, scheduled_for) index is the adjudicator, so
 * two concurrent ticks (or a tick racing Run now) cannot both win.
 */
export function claimRun(scheduleId: string, scheduledFor: number, trigger: ScheduleTrigger, dstAdjusted = ""): ScheduleRun | null {
  const id = nanoid();
  const now = Date.now();
  try {
    getDb()
      .prepare(
        `INSERT INTO schedule_runs (id, schedule_id, scheduled_for, claimed_at, status, trigger, dst_adjusted)
         VALUES (?, ?, ?, ?, 'claimed', ?, ?)`
      )
      .run(id, scheduleId, scheduledFor, now, trigger, dstAdjusted);
  } catch {
    return null; // UNIQUE violation: somebody else owns this slot
  }
  pruneRuns(scheduleId);
  return getRun(id);
}

export function getRun(id: string): ScheduleRun | null {
  return (getDb().prepare("SELECT * FROM schedule_runs WHERE id = ?").get(id) as ScheduleRun) ?? null;
}

/** The turn actually launched: link the task and mark it live. */
export function startRun(runId: string, taskId: string): void {
  getDb()
    .prepare("UPDATE schedule_runs SET status = 'running', task_id = ?, fired_at = ? WHERE id = ?")
    .run(taskId, Date.now(), runId);
}

/** Terminal outcome. Idempotent — a settled run is never re-settled. */
export function settleRun(runId: string, status: ScheduleRunStatus, detail = ""): void {
  getDb()
    .prepare("UPDATE schedule_runs SET status = ?, detail = ?, finished_at = ? WHERE id = ? AND finished_at = 0")
    .run(status, detail, Date.now(), runId);
}

/** A slot that elapsed while the app was down or the window had passed. */
export function recordMissedRun(scheduleId: string, scheduledFor: number, detail: string): void {
  const run = claimRun(scheduleId, scheduledFor, "scheduled");
  if (run) settleRun(run.id, "missed", detail);
}

/** A slot skipped because the previous run was still going. */
export function recordSkippedRun(scheduleId: string, scheduledFor: number, detail: string): void {
  const run = claimRun(scheduleId, scheduledFor, "scheduled");
  if (run) settleRun(run.id, "skipped_overlap", detail);
}

export function listRuns(scheduleId: string, limit = 20): ScheduleRun[] {
  return getDb()
    .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY scheduled_for DESC LIMIT ?")
    .all(scheduleId, limit) as ScheduleRun[];
}

export const lastRun = (scheduleId: string): ScheduleRun | null => listRuns(scheduleId, 1)[0] ?? null;

/** The run still in flight for this schedule, if any (overlap detection). */
export function activeRun(scheduleId: string): ScheduleRun | null {
  return (
    (getDb()
      .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? AND status IN ('claimed','running') ORDER BY scheduled_for DESC LIMIT 1")
      .get(scheduleId) as ScheduleRun) ?? null
  );
}

function pruneRuns(scheduleId: string): void {
  getDb()
    .prepare(
      `DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN (
         SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY scheduled_for DESC LIMIT ?
       )`
    )
    .run(scheduleId, scheduleId, RUN_RETENTION);
}
```

- [ ] **Step 6: Run the test**

Run: `npm run test:docker -- tests/scheduleStore.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Pin, typecheck, and run the whole suite**

Add to `PINNED` in `tests/importGraph.test.ts`:

```ts
  "lib/schedule/store.ts", //    schedules + run ledger; DB only, no driving
```

Run: `npm run typecheck:docker && npm run test:docker`
Expected: PASS. The new `Task.schedule_id` field is nullable, so existing task fixtures keep compiling.

- [ ] **Step 8: Commit**

```bash
git add lib/db.ts lib/types.ts lib/store.ts lib/schedule/store.ts tests/scheduleStore.test.ts tests/importGraph.test.ts
git commit -m "Add the schedules + schedule_runs tables and their queries

Schedules get their own project-keyed table rather than a column on a task row,
because a schedule has to outlive the tasks it mints — each firing creates a
fresh one, so re-using a durable row would grow one session's context without
bound.

UNIQUE(schedule_id, scheduled_for) is the load-bearing line: it makes a double
fire structurally impossible across overlapping ticks, a tick racing Run now, or
a restart re-adjudicating a slot. claimRun() leans on the index rather than
checking first, because select-then-insert is exactly the race this prevents.

schedule_runs records occurrences that never ran (missed, skipped_overlap) as
well as ones that did — a schedule that quietly stopped must not look like one
that had nothing to do. tasks.schedule_id is SET NULL, not cascade: deleting a
schedule must not delete the work it produced."
```

---

### Task 3: Config knobs

**Files:**
- Modify: `lib/config.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `SCHEDULE_TICK_MS`, `SCHEDULE_CATCHUP_MS`, `SCHEDULER_ENABLED`.

- [ ] **Step 1: Add the config**

Append to `lib/config.ts`:

```ts
/**
 * How often the schedule ticker wakes to adjudicate due firings
 * (lib/scheduler.ts). Firings are minute-granular, so this bounds how late one
 * can be. Short enough to be punctual, long enough to be free.
 */
export const SCHEDULE_TICK_MS = ms(process.env.ORCH_SCHEDULE_TICK_MS, 30_000);

/**
 * How late a missed firing may still run. The machine sleeps, the container
 * restarts, the app is down at 08:30 — on the next tick a firing this recent is
 * run ONCE (marked `catch_up`), and anything older is recorded as `missed`
 * rather than skipped silently. For a morning run, arriving at noon and finding
 * it ran is useful; finding it start at 6pm is not. 0 disables catch-up
 * entirely; a schedule can override this with its own catch_up_ms.
 */
export const SCHEDULE_CATCHUP_MS = ms(process.env.ORCH_SCHEDULE_CATCHUP_MS, 4 * 60 * 60 * 1000);

/**
 * Master switch for the schedule ticker. On by default. Set to off/0/false for
 * an instance that must never start work on its own — a shared box, a debugging
 * session, or a second container pointed at a copy of the database.
 */
export const SCHEDULER_ENABLED = !["0", "off", "false", "no"].includes(
  String(process.env.ORCH_SCHEDULER || "").toLowerCase()
);
```

- [ ] **Step 2: Document them in `.env.example`**

Append:

```bash
# --- Scheduled tasks (lib/scheduler.ts) ---------------------------------------
# Master switch for the schedule ticker. off/0/false stops this instance from
# ever starting scheduled work on its own.
#ORCH_SCHEDULER=on
# How often the ticker wakes to check for due firings (ms).
#ORCH_SCHEDULE_TICK_MS=30000
# How late a missed firing may still run (ms). Past this it is recorded as
# `missed` instead — never skipped silently. 0 disables catch-up.
#ORCH_SCHEDULE_CATCHUP_MS=14400000
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:docker`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/config.ts .env.example
git commit -m "Add schedule ticker config: interval, catch-up window, master switch

Per the env-driven convention, every knob is an env var with a documented
default in both lib/config.ts and .env.example. The catch-up window (4h) is the
one with a real product judgement in it: an 08:30 job that runs at noon is still
useful, one that starts at 6pm is not, and anything past the window is recorded
as missed rather than skipped quietly."
```

---

### Task 4: RunContext and a permission gate that can't park a scheduled turn

**Files:**
- Create: `lib/runContext.ts`
- Modify: `lib/permissions.ts` (`waitForPermission`, `promptDeadline`)
- Test: `tests/runContext.test.ts`
- Modify: `tests/importGraph.test.ts`

**Interfaces:**
- Produces: `type RunContext = { origin: "user" | "dependency" | "schedule"; interactionPolicy: "interactive" | "deny"; scheduleRunId?: string }`, `setRunContext(taskId, ctx)`, `clearRunContext(taskId, ctx)`, `getRunContext(taskId)`, `interactionDenied(taskId): boolean`, `SCHEDULED_RUN_CONTEXT`.

- [ ] **Step 1: Write the failing test**

Create `tests/runContext.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import {
  SCHEDULED_RUN_CONTEXT, clearRunContext, getRunContext, interactionDenied, setRunContext,
} from "@/lib/runContext";
import { waitForPermission } from "@/lib/permissions";

describe("run context", () => {
  beforeEach(() => clearRunContext("t1"));

  it("remembers a scheduled turn's context for the life of the turn", () => {
    const ctx = { ...SCHEDULED_RUN_CONTEXT, scheduleRunId: "run-1" };
    setRunContext("t1", ctx);
    expect(getRunContext("t1")?.origin).toBe("schedule");
    expect(getRunContext("t1")?.scheduleRunId).toBe("run-1");
    expect(interactionDenied("t1")).toBe(true);
  });

  it("defaults to interactive for an ordinary turn", () => {
    expect(getRunContext("t-unknown")).toBeUndefined();
    expect(interactionDenied("t-unknown")).toBe(false);
  });

  it("only the owning context may clear it, so a later turn's entry survives", () => {
    const first = { ...SCHEDULED_RUN_CONTEXT };
    const second = { ...SCHEDULED_RUN_CONTEXT };
    setRunContext("t1", first);
    setRunContext("t1", second);
    clearRunContext("t1", first); // the stale turn settling late
    expect(getRunContext("t1")).toBe(second);
    clearRunContext("t1", second);
    expect(getRunContext("t1")).toBeUndefined();
  });

  it("denies a permission request immediately for a scheduled turn, however many tabs are open", async () => {
    setRunContext("t1", SCHEDULED_RUN_CONTEXT);
    const started = Date.now();
    // A generous attended cap that a watched turn WOULD park on.
    const result = await waitForPermission({
      taskId: "t1", id: "ask-1", attendedMs: 60_000, unattendedMs: 45_000,
    });
    expect(result).toEqual({ expired: "unattended" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:docker -- tests/runContext.test.ts`
Expected: FAIL — cannot resolve `@/lib/runContext`.

- [ ] **Step 3: Write the module**

Create `lib/runContext.ts`:

```ts
// Why a turn is running, and whether anyone can answer it.
//
// The permission gate (lib/permissions.ts) has always inferred "is a human
// around?" from watcherCount() — presence, not intent. That is a decent
// heuristic for a turn the user launched, and the wrong question entirely for a
// scheduled one: a tab open on a second monitor at 08:30 would let a card park
// for the full attended cap on a turn nobody asked for and nobody is reading.
//
// So a scheduled turn says so explicitly. The runner owns the entry's lifetime
// (registered as the turn starts, cleared in its finally), keyed by task id —
// the same globalThis-on-a-single-process pattern as lib/abort.ts and
// lib/asks.ts. Deliberately a named shape rather than a bare boolean so the
// planned RunContext work (task S6asJLbDQpfWp_u3pDpEC) can widen it in place.
//
// No DB, no SDK — pinned by tests/importGraph.test.ts.

export type RunOrigin = "user" | "dependency" | "schedule";

export interface RunContext {
  origin: RunOrigin;
  /** "deny" = settle any permission/ask request at once instead of parking. */
  interactionPolicy: "interactive" | "deny";
  /** The schedule_runs row this turn belongs to, so the runner can settle it. */
  scheduleRunId?: string;
}

/** What a scheduled firing runs under. */
export const SCHEDULED_RUN_CONTEXT: RunContext = { origin: "schedule", interactionPolicy: "deny" };

declare global {
  // eslint-disable-next-line no-var
  var __orchRunContexts: Map<string, RunContext> | undefined;
}

const contexts = (): Map<string, RunContext> => (global.__orchRunContexts ??= new Map());

export function setRunContext(taskId: string, ctx: RunContext): void {
  contexts().set(taskId, ctx);
}

/**
 * Drop the entry, but only if `ctx` is still the live one. A turn that settles
 * late must not wipe the context of the turn that replaced it (the same
 * identity check unregisterTurn() makes in lib/abort.ts). Omit `ctx` to clear
 * unconditionally.
 */
export function clearRunContext(taskId: string, ctx?: RunContext): void {
  if (ctx && contexts().get(taskId) !== ctx) return;
  contexts().delete(taskId);
}

export const getRunContext = (taskId: string): RunContext | undefined => contexts().get(taskId);

/** True when this turn must never park on a human. */
export const interactionDenied = (taskId: string): boolean =>
  contexts().get(taskId)?.interactionPolicy === "deny";
```

- [ ] **Step 4: Teach the permission gate about it**

In `lib/permissions.ts`, add the import next to the `watcherCount` one:

```ts
import { interactionDenied } from "./runContext";
```

In `waitForPermission`, replace the line computing `attended`:

```ts
  let attended = unattendedMs <= 0 || watcherCount() > 0;
```

with:

```ts
  // A scheduled turn is unattended BY DECLARATION, whatever watcherCount()
  // says: the user didn't launch it, so an open tab is not consent to be
  // interrupted by it. Settle at once rather than parking — there is no answer
  // coming, and the runner already knows what to do with an unattended deny.
  const denied = interactionDenied(taskId);
  if (denied) {
    cancelAsk(taskId, id, "unattended: scheduled run");
    await answer.catch(() => {});
    return { expired: "unattended" };
  }
  let attended = unattendedMs <= 0 || watcherCount() > 0;
```

Then make the recorded deadline agree, so the card never renders a countdown it won't honor. Replace the body of `promptDeadline`:

```ts
export function promptDeadline(attendedMs: number, unattendedMs: number, taskId?: string): number {
  // A declared-unattended turn is decided immediately; anything else is the
  // presence heuristic.
  if (taskId && interactionDenied(taskId)) return Date.now();
  return deadlineFrom(unattendedMs > 0 && watcherCount() === 0 ? unattendedMs : attendedMs);
}
```

Callers that don't pass `taskId` keep their current behaviour.

- [ ] **Step 5: Run the tests**

Run: `npm run test:docker -- tests/runContext.test.ts tests/permissions.test.ts tests/permissionGate.test.ts`
Expected: PASS. The existing gate tests set no run context, so `interactionDenied` is false and their behaviour is unchanged.

- [ ] **Step 6: Pin and typecheck**

Add to `PINNED` in `tests/importGraph.test.ts`:

```ts
  "lib/runContext.ts", //        why a turn is running; a Map on globalThis, nothing more
```

Run: `npm run typecheck:docker && npm run test:docker -- tests/importGraph.test.ts`
Expected: PASS — `lib/permissions.ts` is itself pinned, and `lib/runContext.ts` imports nothing.

- [ ] **Step 7: Commit**

```bash
git add lib/runContext.ts lib/permissions.ts tests/runContext.test.ts tests/importGraph.test.ts
git commit -m "Let a turn declare it is unattended instead of inferring it from open tabs

The permission gate decides how long a card may park from watcherCount() —
presence, not intent. For a turn the user launched that is a fair heuristic. For
a scheduled 08:30 run it is backwards: a tab open on a second monitor would let
a card park for the full four-hour attended cap on a turn nobody asked for and
nobody is reading.

So a scheduled turn says so. RunContext is deliberately a named shape rather
than a bare boolean, so the planned explicit-RunContext work
(S6asJLbDQpfWp_u3pDpEC) can widen it in place; the AgentDriver seam is left
alone, because restructuring that belongs to the same task. The runner owns the
entry's lifetime and clears it identity-checked, so a turn settling late cannot
wipe its successor's context."
```

---

### Task 5: Thread the context through the runner and settle runs truthfully

`fired` is an event, not an outcome. Only the turn's own `finally` knows whether the session opened, whether it errored, and whether it was stopped.

**Files:**
- Modify: `lib/runner.ts` (`startTurn` signature, context registration, the settle block)
- Test: `tests/scheduleRunner.test.ts`

**Interfaces:**
- Consumes: `RunContext`, `setRunContext`, `clearRunContext` (Task 4); `settleRun` (Task 2).
- Produces: `startTurn(task, project, userText, syncNote, controller?, runContext?)`.

- [ ] **Step 1: Write the failing test**

Create `tests/scheduleRunner.test.ts`. It drives the real runner against the mock driver the way `tests/agentDriver.test.ts` does — read that file first and mirror its driver-mocking setup exactly:

```ts
import { describe, expect, it, beforeEach, vi } from "vitest";

// Mirror tests/agentDriver.test.ts: mock the driver registry so the runner
// drives a scripted agent instead of a real CLI.
const events: Record<string, unknown>[] = [];
vi.mock("@/lib/agents/registry", () => ({
  getDriver: () => ({
    id: "mock",
    label: "Mock",
    async *runTurn() {
      yield { type: "session", sessionId: "s1" };
      for (const e of events) yield e;
      yield { type: "done", sessionId: "s1" };
    },
  }),
}));

import { createProject, createTask, getProject, getTask } from "@/lib/store";
import { claimRun, createSchedule, getRun, startRun } from "@/lib/schedule/store";
import { startTurn } from "@/lib/runner";
import { SCHEDULED_RUN_CONTEXT, getRunContext } from "@/lib/runContext";
import { hasTurn } from "@/lib/abort";

const settled = async () => {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (!hasTurn(taskId)) return;
  }
  throw new Error("turn never settled");
};

let taskId = "";

describe("scheduled turns in the runner", () => {
  let projectId = "";
  let runId = "";

  beforeEach(() => {
    events.length = 0;
    const p = createProject({ name: `runner-${Math.random().toString(36).slice(2)}` });
    projectId = p.id;
    const s = createSchedule({
      project_id: projectId, name: "n", prompt: "/x",
      days_mask: 62, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    runId = claimRun(s.id, Date.now(), "scheduled")!.id;
    taskId = createTask({ project_id: projectId, title: "scheduled run" }).id;
    startRun(runId, taskId);
  });

  const scheduled = () => ({ ...SCHEDULED_RUN_CONTEXT, scheduleRunId: runId });

  it("settles the run as succeeded and leaves 'needs you' alone", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    expect(getRun(runId)!.status).toBe("succeeded");
    // Success is quiet: a scheduled run must not park itself in the "N need
    // you" pill forever.
    expect(getTask(taskId)!.awaiting_input).toBe(0);
  });

  it("settles a failed run and DOES surface it", async () => {
    events.push({ type: "error", message: "boom" });
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    const run = getRun(runId)!;
    expect(run.status).toBe("failed");
    expect(run.detail).toContain("boom");
    expect(getTask(taskId)!.awaiting_input).toBe(1);
  });

  it("clears the run context when the turn ends", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    expect(getRunContext(taskId)).toBeUndefined();
  });

  it("leaves an ordinary turn's awaiting_input behaviour untouched", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "hello", "");
    await settled();
    expect(getTask(taskId)!.awaiting_input).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:docker -- tests/scheduleRunner.test.ts`
Expected: FAIL — `startTurn` takes no 6th argument.

- [ ] **Step 3: Thread the context into `startTurn`**

In `lib/runner.ts`, add the imports:

```ts
import { clearRunContext, setRunContext, type RunContext } from "./runContext";
import { settleRun } from "./schedule/store";
```

Change the `startTurn` signature and register the context before the detached `run()`:

```ts
export function startTurn(
  task: Task,
  project: Project,
  userText: string,
  syncNote: string,
  controller?: AbortController,
  runContext?: RunContext
): void {
```

Immediately after the `abortController` is resolved and the `if (!abortController)` guard returns, add:

```ts
  // Declare WHY this turn is running for its whole life. The permission gate
  // reads this instead of guessing from open tabs, and the finally below uses
  // it to settle the schedule run. Registered here rather than inside run() so
  // it is in place before the first tool call can possibly arrive.
  if (runContext) setRunContext(task.id, runContext);
```

- [ ] **Step 4: Settle the run and quiet a successful scheduled turn**

In `run()`'s finally block in `lib/runner.ts`, find:

```ts
    if (!generationAdvanced && !superseded) {
      updateTask(id, { running: 0, session_id: sessionId, awaiting_input: opened ? 1 : 0 });
    }
```

and replace it with:

```ts
    // A scheduled turn that finished cleanly is NOT waiting on anybody: nobody
    // asked for it, and awaiting_input feeds the shared NEEDS_YOU predicate
    // behind the "N need you" pill. Left at 1 it would park a permanent,
    // unanswerable item there every single morning, which is how a user learns
    // to ignore the pill. Success is quiet; a scheduled turn that FAILED still
    // raises its hand exactly like any other.
    const scheduledOk = runContext?.origin === "schedule" && !turnError && !stopped;
    if (!generationAdvanced && !superseded) {
      updateTask(id, { running: 0, session_id: sessionId, awaiting_input: opened && !scheduledOk ? 1 : 0 });
    }

    // Settle the schedule run from HERE, because this is the only place that
    // knows the outcome: whether a session opened, whether it errored, whether
    // it was stopped. Polling task.running from outside cannot reconstruct it.
    if (runContext?.scheduleRunId) {
      const status = stopped ? "stopped" : turnError ? "failed" : opened ? "succeeded" : "interrupted";
      const detail = turnError ? String(turnError).slice(0, 500) : !opened ? "the agent session never opened" : "";
      try {
        settleRun(runContext.scheduleRunId, status, detail);
      } catch (err) {
        console.error(`[runner] could not settle schedule run ${runContext.scheduleRunId}:`, err);
      }
    }
    if (runContext) clearRunContext(id, runContext);
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:docker -- tests/scheduleRunner.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the full suite — this task touches the hottest file in the repo**

Run: `npm run typecheck:docker && npm run test:docker`
Expected: PASS. `runContext` is optional, so every existing `startTurn` caller is unaffected; the `awaiting_input` change is gated on `origin === "schedule"`.

- [ ] **Step 7: Commit**

```bash
git add lib/runner.ts tests/scheduleRunner.test.ts
git commit -m "Settle schedule runs from the turn's own finally, and keep successes quiet

'fired' is an event, not an outcome. Only the turn's finally knows whether the
session opened, whether it errored, and whether it was stopped — so that is
where the schedule_runs row is settled. Reconstructing this from outside by
polling task.running cannot work, and a run ledger that says 'fired' and nothing
more is exactly the kind of visibility that teaches a user not to trust it.

Also: every turn that opens a session ends with awaiting_input = 1, which feeds
the shared NEEDS_YOU predicate behind the 'N need you' pill. Untouched, a
weekday schedule would file a permanent unanswerable item there every morning.
Success is now quiet for scheduled turns; failure still raises its hand."
```

---

### Task 6: Slash-command validation (the free guard against a fake success)

An unregistered command is not an error: the CLI answers `"Unknown command: /x"` with `subtype: "success"`, `is_error: false`, and no tool calls. A schedule would record `succeeded` with an empty tray. The session's `init` message carries the whole command registry and arrives before any model call, so the check costs no tokens.

**Files:**
- Create: `lib/schedule/commands.ts`
- Test: `tests/scheduleCommands.test.ts`

**Interfaces:**
- Produces: `slashCommandOf(prompt): string | null`, `isRegistered(command, registry): boolean`, `listSlashCommands(project, agent): Promise<string[]>`, `validatePrompt(prompt, project, agent): Promise<{ ok: boolean; error?: string; suggestions?: string[] }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/scheduleCommands.test.ts` — the pure matching logic is unit-tested; the live SDK probe is not (it needs a logged-in CLI):

```ts
import { describe, expect, it } from "vitest";
import { isRegistered, slashCommandOf, suggestionsFor } from "@/lib/schedule/commands";

describe("slashCommandOf", () => {
  it("extracts a leading slash command", () => {
    expect(slashCommandOf("/jira-tasks")).toBe("jira-tasks");
    expect(slashCommandOf("  /jira-tasks  ")).toBe("jira-tasks");
    expect(slashCommandOf("/ce-aura:jira-tasks")).toBe("ce-aura:jira-tasks");
    expect(slashCommandOf("/jira-tasks --since yesterday")).toBe("jira-tasks");
  });

  it("is null for an ordinary prompt", () => {
    expect(slashCommandOf("Triage my Jira tickets")).toBeNull();
    expect(slashCommandOf("look in ./src and /etc")).toBeNull();
    expect(slashCommandOf("")).toBeNull();
  });
});

describe("isRegistered", () => {
  const registry = ["jira", "confluence", "superpowers:brainstorming", "jira-tasks"];

  it("matches an exact registration", () => {
    expect(isRegistered("jira-tasks", registry)).toBe(true);
    expect(isRegistered("superpowers:brainstorming", registry)).toBe(true);
  });

  it("rejects a near miss rather than guessing", () => {
    // This is the whole point: the CLI answers "Unknown command" with
    // subtype "success", so a typo would otherwise record a green check.
    expect(isRegistered("jira-taks", registry)).toBe(false);
    expect(isRegistered("jira-tasks-daily", registry)).toBe(false);
  });

  it("offers near misses so the editor can correct them", () => {
    expect(suggestionsFor("jira-taks", registry)).toContain("jira-tasks");
    expect(suggestionsFor("brainstorming", registry)).toContain("superpowers:brainstorming");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:docker -- tests/scheduleCommands.test.ts`
Expected: FAIL — cannot resolve `@/lib/schedule/commands`.

- [ ] **Step 3: Write the module**

Create `lib/schedule/commands.ts`:

```ts
// Slash-command validation for schedule prompts.
//
// A scheduled prompt is typically a skill invocation like "/jira-tasks", and
// the slash form matters: the CLI EXPANDS it textually before the model sees it
// (verified — zero tool calls, the skill body becomes the prompt), whereas the
// bare name makes the model notice a name and choose to call the Skill tool.
// Only the first belongs in unattended work.
//
// The hazard is that an unregistered command is NOT an error. The CLI answers
// "Unknown command: /x. Did you mean …?" with subtype "success", is_error
// false, and no tool calls — so a typo'd schedule would record `succeeded` with
// an empty tray, and the user would conclude Jira had nothing for them. A
// silent skip wearing a green check.
//
// The guard is free: the session's `init` message carries the whole registry
// and arrives BEFORE any model call (~1.5s), so we start a session, read the
// list, and abandon it without spending a token.

import type { Project } from "@/lib/types";

/** The command a prompt invokes, or null when it isn't a slash prompt. */
export function slashCommandOf(prompt: string): string | null {
  const m = /^\s*\/([A-Za-z0-9_:-]+)/.exec(prompt);
  return m ? m[1] : null;
}

/** Exact match only — a near miss is what this exists to catch. */
export const isRegistered = (command: string, registry: string[]): boolean => registry.includes(command);

/**
 * Registered commands that look like what was typed, for the editor's "did you
 * mean". Matches on suffix (a plugin namespace the user omitted) or a small
 * edit distance (a typo).
 */
export function suggestionsFor(command: string, registry: string[]): string[] {
  const lower = command.toLowerCase();
  return registry
    .filter((r) => {
      const rl = r.toLowerCase();
      return rl.endsWith(`:${lower}`) || rl.includes(lower) || editDistance(rl, lower) <= 2;
    })
    .slice(0, 5);
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * The slash commands a session in this project would have. Costs no tokens: we
 * read the init message and abandon the session before the model is called.
 * Best-effort — on any failure the caller degrades to "can't check" rather than
 * blocking the user.
 */
export async function listSlashCommands(project: Project, agent: string): Promise<string[] | null> {
  if (agent !== "claude") return null; // only the Claude CLI has this surface
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const session = query({
      prompt: "noop",
      options: {
        cwd: project.repo_path || process.cwd(),
        // Must match the driver's SETTING_SOURCES, or we'd validate against a
        // different set of commands than the scheduled turn actually gets.
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
      },
    });
    let commands: string[] | null = null;
    for await (const message of session) {
      if (message.type === "system" && message.subtype === "init") {
        commands = (message as { slash_commands?: string[] }).slash_commands ?? [];
        break;
      }
      if (message.type === "assistant") break; // shouldn't happen; don't spend a turn
    }
    await session.interrupt?.().catch(() => {});
    return commands;
  } catch {
    return null;
  }
}

export interface PromptValidation {
  ok: boolean;
  /** Set when the prompt names a command that isn't registered. */
  error?: string;
  suggestions?: string[];
  /** True when we could not reach the registry — save is allowed, with a note. */
  unchecked?: boolean;
}

/** Validate a schedule's prompt. Non-slash prompts are always fine. */
export async function validatePrompt(prompt: string, project: Project, agent: string): Promise<PromptValidation> {
  const command = slashCommandOf(prompt);
  if (!command) return { ok: true };
  const registry = await listSlashCommands(project, agent);
  if (!registry) return { ok: true, unchecked: true };
  if (isRegistered(command, registry)) return { ok: true };
  return {
    ok: false,
    error: `/${command} is not a command this project's sessions have. An unknown command does not fail — the run would report success having done nothing.`,
    suggestions: suggestionsFor(command, registry),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test:docker -- tests/scheduleCommands.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:docker`
Expected: PASS. Note this module imports the SDK dynamically and must NOT be added to `PINNED`.

- [ ] **Step 6: Commit**

```bash
git add lib/schedule/commands.ts tests/scheduleCommands.test.ts
git commit -m "Validate a schedule's slash command, because an unknown one reports success

Probing the real SDK turned up the nastiest failure mode in this feature: an
unregistered slash command is not an error. The CLI answers 'Unknown command:
/x. Did you mean …?' with subtype 'success', is_error false, and no tool calls.
A typo'd schedule would therefore record `succeeded` with an empty tray, and the
user would conclude Jira had nothing for them — a silent skip wearing a green
check, which is precisely what this feature is supposed to be incapable of.

The guard costs nothing: the session's init message carries the whole command
registry and arrives before any model call, so we start a session, read the
list, and abandon it without spending a token. Exact matching only, with 'did
you mean' suggestions, since near-miss tolerance would reintroduce the bug —
'jira-tasks' vs 'ce-aura-claude-code:jira-tasks' is exactly the mistake to
catch while the user is still sitting there."
```

---

### Task 7: Due adjudication — fire, catch up, miss, or skip

The decision half of the ticker, kept SDK-free so it can be tested without launching anything.

**Files:**
- Create: `lib/schedule/due.ts`
- Test: `tests/scheduleDue.test.ts`
- Modify: `tests/importGraph.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `type Verdict = { kind: "fire"; run: ScheduleRun } | { kind: "missed" } | { kind: "skipped" } | { kind: "none" }`, `adjudicate(schedule, now, isBusy): Verdict`, `catchUpWindow(schedule): number`.

- [ ] **Step 1: Write the failing test**

Create `tests/scheduleDue.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { createProject } from "@/lib/store";
import { getDb } from "@/lib/db";
import { createSchedule, getSchedule, listRuns, updateSchedule } from "@/lib/schedule/store";
import { adjudicate } from "@/lib/schedule/due";
import { nextFireAt } from "@/lib/schedule/time";

const LA = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);
const never = () => false;

function makeSchedule() {
  const pid = createProject({ name: `due-${Math.random().toString(36).slice(2)}` }).id;
  return createSchedule({
    project_id: pid, name: "Jira triage", prompt: "/jira-tasks",
    days_mask: 62, time_of_day: "08:30", timezone: LA,
  });
}

/** Force the row's next_fire_at to a specific slot, as a real elapsed slot would be. */
function pinNextFire(id: string, ms: number) {
  getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(ms, id);
  return getSchedule(id)!;
}

describe("adjudicate", () => {
  let s: ReturnType<typeof makeSchedule>;
  beforeEach(() => { s = makeSchedule(); });

  it("does nothing before the schedule is due", () => {
    expect(adjudicate(s, Date.now(), never).kind).toBe("none");
  });

  it("fires when the slot arrives", () => {
    const slot = at("2026-08-12T15:30:00Z");
    const pinned = pinNextFire(s.id, slot);
    const verdict = adjudicate(pinned, slot + 1_000, never);
    expect(verdict.kind).toBe("fire");
    if (verdict.kind === "fire") expect(verdict.run.trigger).toBe("scheduled");
    // and the schedule has moved on, so the same slot can't be re-adjudicated
    expect(getSchedule(s.id)!.next_fire_at).toBeGreaterThan(slot);
  });

  it("catches a recent miss up ONCE, marking it as such", () => {
    const slot = at("2026-08-12T15:30:00Z");
    const pinned = pinNextFire(s.id, slot);
    const verdict = adjudicate(pinned, slot + 2 * 60 * 60 * 1000, never); // 2h late, inside the 4h window
    expect(verdict.kind).toBe("fire");
    if (verdict.kind === "fire") expect(verdict.run.trigger).toBe("catch_up");
  });

  it("records a stale slot as missed instead of running it at teatime", () => {
    const slot = at("2026-08-12T15:30:00Z");
    const pinned = pinNextFire(s.id, slot);
    const verdict = adjudicate(pinned, slot + 9 * 60 * 60 * 1000, never); // 9h late
    expect(verdict.kind).toBe("missed");
    expect(listRuns(s.id, 10)[0].status).toBe("missed");
  });

  it("clears a whole weekend of backlog in ONE sweep, firing at most once", () => {
    // Down from Friday 08:30 until Monday 10:00 local.
    const friday = at("2026-08-14T15:30:00Z");
    const pinned = pinNextFire(s.id, friday);
    const mondayLate = at("2026-08-17T17:00:00Z"); // Mon 10:00 PDT, 1.5h after the slot
    const verdict = adjudicate(pinned, mondayLate, never);
    expect(verdict.kind).toBe("fire");
    if (verdict.kind === "fire") {
      expect(verdict.run.trigger).toBe("catch_up");
      expect(verdict.run.scheduled_for).toBe(at("2026-08-17T15:30:00Z")); // Monday's slot, not Friday's
    }
    // Friday is on the record as missed, not quietly dropped.
    const statuses = listRuns(s.id, 10).map((r) => r.status);
    expect(statuses).toContain("missed");
    // Next up is Tuesday — the backlog is fully consumed.
    expect(getSchedule(s.id)!.next_fire_at).toBe(at("2026-08-18T15:30:00Z"));
  });

  it("skips while the previous run is still going, and says why", () => {
    const slot = at("2026-08-12T15:30:00Z");
    const pinned = pinNextFire(s.id, slot);
    const verdict = adjudicate(pinned, slot + 1_000, () => true);
    expect(verdict.kind).toBe("skipped");
    expect(listRuns(s.id, 10)[0].status).toBe("skipped_overlap");
    // It still moves on, or one wedged turn would freeze the schedule forever.
    expect(getSchedule(s.id)!.next_fire_at).toBeGreaterThan(slot);
  });

  it("honours a per-schedule catch-up window of zero", () => {
    const slot = at("2026-08-12T15:30:00Z");
    updateSchedule(s.id, { catch_up_ms: 0 });
    const pinned = pinNextFire(s.id, slot);
    expect(adjudicate(pinned, slot + 60_000, never).kind).toBe("missed");
  });

  it("never double-claims a slot two ticks race for", () => {
    const slot = at("2026-08-12T15:30:00Z");
    const pinned = pinNextFire(s.id, slot);
    const a = adjudicate(pinned, slot + 1_000, never);
    const b = adjudicate(pinned, slot + 1_000, never); // same stale snapshot
    const fired = [a, b].filter((v) => v.kind === "fire");
    expect(fired).toHaveLength(1);
  });

  it("a pause landing between the tick and the claim wins", () => {
    // The ticker adjudicates from a snapshot taken up to a tick ago; adjudicate()
    // re-reads, so a pause in that window must stop the firing.
    const slot = at("2026-08-12T15:30:00Z");
    const stale = pinNextFire(s.id, slot);
    updateSchedule(s.id, { enabled: 0 });
    expect(adjudicate(stale, slot + 1_000, never).kind).toBe("none");
    // And a paused schedule accrues NO missed rows — unpausing must not greet
    // the user with a wall of red for slots they deliberately skipped.
    expect(listRuns(s.id, 10)).toHaveLength(0);
  });

  it("a schedule deleted mid-tick is a no-op, not a crash", () => {
    const slot = at("2026-08-12T15:30:00Z");
    const stale = pinNextFire(s.id, slot);
    getDb().prepare("DELETE FROM schedules WHERE id = ?").run(s.id);
    expect(adjudicate(stale, slot + 1_000, never).kind).toBe("none");
  });

  it("carries the DST adjustment onto the run", () => {
    const pid = createProject({ name: `dst-${Math.random().toString(36).slice(2)}` }).id;
    const gap = createSchedule({
      project_id: pid, name: "gap", prompt: "x",
      days_mask: 127, time_of_day: "02:30", timezone: LA,
    });
    const slot = nextFireAt({ daysMask: 127, timeOfDay: "02:30", timezone: LA }, at("2026-03-08T00:00:00Z"));
    const pinned = pinNextFire(gap.id, slot.ms);
    const verdict = adjudicate(pinned, slot.ms + 1_000, never);
    if (verdict.kind === "fire") expect(verdict.run.dst_adjusted).toBe("gap_forward");
    else throw new Error(`expected a fire, got ${verdict.kind}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:docker -- tests/scheduleDue.test.ts`
Expected: FAIL — cannot resolve `@/lib/schedule/due`.

- [ ] **Step 3: Write the module**

Create `lib/schedule/due.ts`:

```ts
// The DECISION half of the ticker: given a schedule and the time, decide
// whether this occurrence fires, was missed, or is skipped — and claim it.
// DB + time math only, no runner and no SDK, so every branch is testable
// without launching an agent.

import { SCHEDULE_CATCHUP_MS } from "@/lib/config";
import { nextFireAt } from "@/lib/schedule/time";
import {
  advanceNextFire, claimRun, getSchedule, recordMissedRun, recordSkippedRun, specOf,
} from "@/lib/schedule/store";
import type { Schedule, ScheduleRun } from "@/lib/types";

export type Verdict =
  | { kind: "fire"; run: ScheduleRun }
  | { kind: "missed" }
  | { kind: "skipped" }
  | { kind: "none" };

/** The effective catch-up window: the schedule's own, else the instance default. */
export const catchUpWindow = (schedule: Schedule): number =>
  schedule.catch_up_ms >= 0 ? schedule.catch_up_ms : SCHEDULE_CATCHUP_MS;

/**
 * Adjudicate one schedule at `now`. `isBusy` reports whether this schedule's
 * previous run is still live (real turn liveness — NOT task.status, which stays
 * "in progress" long after a turn ends).
 *
 * Every elapsed slot is consumed in ONE call: down from Friday to Monday, the
 * Friday slot is recorded missed and Monday's fires — the caller never has to
 * tick repeatedly to drain a backlog, and a week offline can never produce a
 * week of firings.
 */
export function adjudicate(schedule: Schedule, now: number, isBusy: (scheduleId: string) => boolean): Verdict {
  // Re-read: the snapshot may be stale by a whole tick, and the row may have
  // been paused, edited, or deleted since.
  const fresh = getSchedule(schedule.id);
  if (!fresh || !fresh.enabled) return { kind: "none" };
  if (fresh.next_fire_at > now) return { kind: "none" };

  const window = catchUpWindow(fresh);

  // Walk the backlog. Everything but the newest due slot is missed by
  // definition — we are never going to run Friday's job on Monday.
  let slot = fresh.next_fire_at;
  let dstAdjusted = "";
  for (let guard = 0; guard < 1000; guard++) {
    const upcoming = nextFireAt(specOf(fresh), slot);
    if (upcoming.ms > now) {
      dstAdjusted = upcoming.dstAdjusted;
      break;
    }
    recordMissedRun(fresh.id, slot, "the app was not running at this time");
    slot = upcoming.ms;
  }
  // `slot` is now the newest slot that is due, and the loop above recorded the
  // rest. Move the schedule on FIRST, so a crash between here and the launch
  // costs one run rather than wedging the schedule on a slot forever.
  advanceNextFire(fresh.id, slot);

  const lateBy = now - slot;
  if (lateBy > window) {
    recordMissedRun(fresh.id, slot, window === 0
      ? "catch-up is disabled for this schedule"
      : `the app was not running, and this was ${Math.round(lateBy / 60_000)} minutes past the catch-up window`);
    return { kind: "missed" };
  }

  // One wedged turn must not silently swallow every future occurrence, so the
  // skip is recorded and the schedule still advances.
  if (isBusy(fresh.id)) {
    recordSkippedRun(fresh.id, slot, "the previous run of this schedule was still going");
    return { kind: "skipped" };
  }

  const trigger = lateBy > 60_000 ? "catch_up" : "scheduled";
  const run = claimRun(fresh.id, slot, trigger, dstAdjusted);
  // Null means another tick claimed this exact slot first — the unique index
  // doing its job. Not an error, and not ours to run.
  return run ? { kind: "fire", run } : { kind: "none" };
}
```

Note the `dstAdjusted` recorded on the run is the *upcoming* resolution; to stamp the fired slot's own adjustment instead, capture it when the slot is computed. Use this corrected loop body in place of the one above:

```ts
  let slot = fresh.next_fire_at;
  let dstAdjusted = nextFireAt(specOf(fresh), slot - 1).dstAdjusted;
  for (let guard = 0; guard < 1000; guard++) {
    const upcoming = nextFireAt(specOf(fresh), slot);
    if (upcoming.ms > now) break;
    recordMissedRun(fresh.id, slot, "the app was not running at this time");
    slot = upcoming.ms;
    dstAdjusted = upcoming.dstAdjusted;
  }
```

- [ ] **Step 4: Run the test**

Run: `npm run test:docker -- tests/scheduleDue.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Pin and typecheck**

Add to `PINNED` in `tests/importGraph.test.ts`:

```ts
  "lib/schedule/due.ts", //      fire/miss/skip adjudication; store + time math only
```

Run: `npm run typecheck:docker && npm run test:docker -- tests/importGraph.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/schedule/due.ts tests/scheduleDue.test.ts tests/importGraph.test.ts
git commit -m "Adjudicate due schedules: fire, catch up once, or record a miss

One sweep consumes the WHOLE backlog rather than one slot per tick. Down from
Friday to Monday, Friday is recorded missed and Monday's slot fires once — a
week offline can never produce a week of firings, and the user can still see
exactly which mornings were lost.

Two ordering choices are deliberate. next_fire_at advances BEFORE the launch, so
a crash in between costs one run instead of wedging the schedule on a slot
forever. And an overlap skip still advances, because a single wedged turn must
not silently swallow every future occurrence — the skip is recorded with the
blocking run named, rather than the schedule just going quiet.

Kept free of the runner so every branch is testable without launching an agent."
```

---

### Task 8: Launch a firing

**Files:**
- Create: `lib/scheduler.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: `fireSchedule(schedule, run): Promise<void>`, `runScheduleNow(scheduleId): Promise<ScheduleRun | null>`, `tickSchedules(now?): Promise<number>`, `startScheduler(): void`, `schedulerHealth(): { started: boolean; lastTickAt: number; lastError: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/scheduler.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from "vitest";

const started: { taskId: string; text: string }[] = [];
vi.mock("@/lib/runner", () => ({
  startTurn: (task: { id: string }, _p: unknown, userText: string) => {
    started.push({ taskId: task.id, text: userText });
  },
}));

// The real validator spawns a CLI session to read the command registry; drive
// it from the test instead so the unknown-command branch is reachable offline.
let promptCheck: { ok: boolean; error?: string; suggestions?: string[] } = { ok: true };
vi.mock("@/lib/schedule/commands", () => ({
  validatePrompt: async () => promptCheck,
}));

import { createProject, getTask, listTasks } from "@/lib/store";
import { createSchedule, getSchedule, lastRun, listRuns } from "@/lib/schedule/store";
import { runScheduleNow, tickSchedules } from "@/lib/scheduler";
import { getDb } from "@/lib/db";
import { makeRepo } from "./helpers";

const at = (iso: string) => Date.parse(iso);

async function projectWithRepo() {
  const repo = await makeRepo();
  return createProject({ name: `sched-${Math.random().toString(36).slice(2)}`, repo_path: repo });
}

describe("scheduler", () => {
  beforeEach(() => { started.length = 0; promptCheck = { ok: true }; });

  it("mints a fresh task per firing, tagged with its schedule", async () => {
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "Jira triage", prompt: "/jira-tasks",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
      permission_mode: "bypassPermissions",
    });
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);

    await tickSchedules(Date.now());

    const tasks = listTasks(p.id).filter((t) => t.schedule_id === s.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain("Jira triage");
    expect(tasks[0].permission_mode).toBe("bypassPermissions");
    expect(started[0].text).toBe("/jira-tasks");
    expect(lastRun(s.id)!.status).toBe("running");
    expect(lastRun(s.id)!.task_id).toBe(tasks[0].id);
  });

  it("a second firing mints a SECOND task rather than reusing the first", async () => {
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "n", prompt: "go",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);
    await tickSchedules(Date.now());
    // Settle the first run so overlap doesn't skip the second.
    getDb().prepare("UPDATE schedule_runs SET status = 'succeeded', finished_at = ? WHERE schedule_id = ?")
      .run(Date.now(), s.id);
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);
    await tickSchedules(Date.now());

    expect(listTasks(p.id).filter((t) => t.schedule_id === s.id)).toHaveLength(2);
  });

  it("refuses to mint a doomed task when the project has no working directory", async () => {
    const p = createProject({ name: `norepo-${Math.random().toString(36).slice(2)}` });
    const s = createSchedule({
      project_id: p.id, name: "n", prompt: "go",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);

    await tickSchedules(Date.now());

    const run = lastRun(s.id)!;
    expect(run.status).toBe("failed");
    expect(run.detail).toMatch(/working directory/i);
    expect(listTasks(p.id).filter((t) => t.schedule_id === s.id)).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("Run now fires immediately without moving the next scheduled occurrence", async () => {
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "n", prompt: "go",
      days_mask: 62, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    const before = getSchedule(s.id)!.next_fire_at;

    const run = await runScheduleNow(s.id);

    expect(run!.trigger).toBe("manual");
    expect(getSchedule(s.id)!.next_fire_at).toBe(before);
    expect(started).toHaveLength(1);
  });

  it("refuses to run an unknown slash command, which would otherwise report success", async () => {
    promptCheck = { ok: false, error: "/jira-taks is not a command", suggestions: ["jira-tasks"] };
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "n", prompt: "/jira-taks",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);

    await tickSchedules(Date.now());

    const run = lastRun(s.id)!;
    expect(run.status).toBe("failed");
    expect(run.detail).toContain("/jira-tasks"); // the suggestion, so it's fixable
    expect(started).toHaveLength(0);
  });

  it("does not fire a paused schedule", async () => {
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "n", prompt: "go",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET enabled = 0, next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);

    await tickSchedules(Date.now());

    expect(started).toHaveLength(0);
    expect(listRuns(s.id, 10)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:docker -- tests/scheduler.test.ts`
Expected: FAIL — cannot resolve `@/lib/scheduler`.

- [ ] **Step 3: Write the module**

Create `lib/scheduler.ts`:

```ts
// The server-owned schedule ticker: the app's first piece of periodic work that
// does not need a browser.
//
// (The recap "sweep" that looks like a scheduler is driven by a setInterval in
// app/orchestrator/useRecaps.ts, so it does nothing when no tab is open. This
// has to run at 08:30 with nobody logged in, so it lives here, in the server
// process, started from a boot self-ping — see app/api/instance/scheduler.)
//
// Reaches lib/runner.ts to launch turns, exactly as lib/autoStart.ts does, and
// is therefore NOT in tests/importGraph.test.ts's SDK-free PINNED set. The
// decision logic lives in lib/schedule/due.ts, which IS pinned.

import fs from "node:fs";
import { SCHEDULER_ENABLED, SCHEDULE_TICK_MS } from "@/lib/config";
import { getProject, createTask, updateTask, addMessage } from "@/lib/store";
import { adjudicate } from "@/lib/schedule/due";
import {
  activeRun, getSchedule, listEnabledSchedules, refreshNextFire, claimRun, settleRun, startRun,
} from "@/lib/schedule/store";
import { specOf } from "@/lib/schedule/store";
import { describeSpec } from "@/lib/schedule/time";
import { validatePrompt } from "@/lib/schedule/commands";
import { startTurn } from "@/lib/runner";
import { claimTurn, hasTurn, unregisterTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { publish } from "@/lib/events";
import { ensureWorktree } from "@/lib/git";
import { isAgentConnected } from "@/lib/agents/connections";
import { SCHEDULED_RUN_CONTEXT } from "@/lib/runContext";
import { workEnded, workStarted } from "@/lib/idle";
import type { Schedule, ScheduleRun } from "@/lib/types";

declare global {
  // eslint-disable-next-line no-var
  var __orchScheduler: { timer: NodeJS.Timeout | null; ticking: boolean; lastTickAt: number; lastError: string } | undefined;
}

const state = () => (global.__orchScheduler ??= { timer: null, ticking: false, lastTickAt: 0, lastError: "" });

export const schedulerHealth = () => {
  const s = state();
  return { started: !!s.timer, lastTickAt: s.lastTickAt, lastError: s.lastError };
};

/**
 * Start the ticker. Idempotent — the boot ping and a lazy call from the
 * schedules API can both reach it, and only the first wins.
 */
export function startScheduler(): void {
  const s = state();
  if (s.timer || !SCHEDULER_ENABLED) return;
  // A restart can land mid-slot, and a tzdata update can move a cached
  // next_fire_at. Revalidate every enabled schedule against its spec before the
  // first tick, so boot catch-up adjudicates from a correct position.
  for (const schedule of listEnabledSchedules()) {
    try {
      if (schedule.next_fire_at <= 0) refreshNextFire(schedule);
    } catch (err) {
      console.error(`[scheduler] schedule ${schedule.id} has an unusable spec:`, err);
    }
  }
  s.timer = setInterval(() => { void tickSchedules(); }, SCHEDULE_TICK_MS);
  // Never hold the process open on the ticker alone.
  s.timer.unref?.();
  void tickSchedules();
}

export function stopScheduler(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

/**
 * One sweep. Single-flight (a slow sweep must not overlap itself) and
 * sequential (ten schedules at 08:30 must not spawn ten worktree setups and ten
 * CLIs at once). Returns how many firings launched.
 */
export async function tickSchedules(now = Date.now()): Promise<number> {
  const s = state();
  if (s.ticking) return 0;
  s.ticking = true;
  let launched = 0;
  try {
    for (const schedule of listEnabledSchedules()) {
      try {
        const verdict = adjudicate(schedule, now, isScheduleBusy);
        if (verdict.kind !== "fire") continue;
        const fresh = getSchedule(schedule.id);
        if (!fresh) continue;
        await fireSchedule(fresh, verdict.run);
        launched++;
      } catch (err) {
        // One bad schedule must never abort the sweep.
        s.lastError = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] schedule ${schedule.id} failed to fire:`, err);
      }
    }
    s.lastTickAt = Date.now();
  } finally {
    s.ticking = false;
  }
  return launched;
}

/**
 * Is this schedule's previous run still live? Turn liveness comes from the
 * abort registry, not task.status — a task stays "in progress" long after its
 * turn ends, and every finished turn sets awaiting_input.
 */
function isScheduleBusy(scheduleId: string): boolean {
  const active = activeRun(scheduleId);
  if (!active) return false;
  if (!active.task_id) return active.status === "claimed"; // mid-launch
  return hasTurn(active.task_id);
}

/** Fire NOW, out of band. Does not disturb the next scheduled occurrence. */
export async function runScheduleNow(scheduleId: string): Promise<ScheduleRun | null> {
  const schedule = getSchedule(scheduleId);
  if (!schedule) return null;
  // scheduled_for is the moment the button was pressed, so a manual run can
  // never collide with a real slot under the unique claim (and two rapid
  // presses collide with each other, which is what we want).
  const run = claimRun(schedule.id, Date.now(), "manual");
  if (!run) return null;
  await fireSchedule(schedule, run);
  return run;
}

/**
 * Preflight, mint, launch. Mirrors the initial-turn branch of
 * POST /api/tasks/[id]/messages (and lib/autoStart.ts launchInitialTurn) —
 * keep in step with those.
 */
export async function fireSchedule(schedule: Schedule, run: ScheduleRun): Promise<void> {
  // ---- preflight: fail with something actionable rather than minting a task
  // that cannot possibly work.
  const project = getProject(schedule.project_id);
  if (!project) {
    settleRun(run.id, "failed", "the project this schedule belongs to no longer exists");
    return;
  }
  if (!project.repo_path.trim()) {
    settleRun(run.id, "failed", `"${project.name}" has no working directory set, so a session cannot start`);
    return;
  }
  if (!isAgentConnected(schedule.agent)) {
    // Checked for THIS agent — never allowed to fall back to another, which
    // would silently run the work on the wrong login.
    settleRun(run.id, "failed", `${schedule.agent} is not connected — reconnect it and the next run will work`);
    return;
  }
  // Re-check the slash command at FIRE time, not just at save time: a plugin
  // can be uninstalled or renamed between the two, and an unknown command does
  // not fail — it returns "Unknown command: /x" as a SUCCESS, so the run would
  // report green having done nothing. Best-effort: `unchecked` (no registry
  // reachable) proceeds rather than blocking the morning's work on a probe.
  const check = await validatePrompt(schedule.prompt, project, schedule.agent);
  if (!check.ok) {
    const hint = check.suggestions?.length ? ` Did you mean ${check.suggestions.map((c) => `/${c}`).join(", ")}?` : "";
    settleRun(run.id, "failed", `${check.error}${hint}`);
    return;
  }

  workStarted();
  try {
    fs.mkdirSync(project.repo_path, { recursive: true });
    const stamp = new Date(run.scheduled_for).toISOString().slice(0, 16).replace("T", " ");
    const task = createTask({
      project_id: schedule.project_id,
      title: `${schedule.name} — ${stamp}`,
      description: `Created automatically by the "${schedule.name}" schedule (${describeSpec(specOf(schedule))}).`,
      priority: schedule.priority,
      agent: schedule.agent,
      send_context: schedule.send_context !== 0,
      permission_mode: schedule.permission_mode,
      // Set at creation, not patched afterwards: updateTask writes an explicit
      // column list, so a field it doesn't name is silently dropped.
      schedule_id: schedule.id,
    });
    startRun(run.id, task.id);

    const controller = claimTurn(task.id);
    if (!controller) {
      settleRun(run.id, "failed", "the task's turn slot was already taken");
      return;
    }
    let launched = false;
    try {
      await withTaskLock(task.id, async () => {
        let fresh = { ...task };
        try {
          const wt = await ensureWorktree(project.repo_path, task.id, project.branch);
          if (wt) {
            fresh = { ...fresh, worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha };
            updateTask(task.id, { worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha });
          }
        } catch {
          // fall back to repo_path, exactly as the route and autoStart do
        }
        const userMsg = addMessage(task.id, fresh.generation, "user", schedule.prompt);
        updateTask(task.id, { running: 1, awaiting_input: 0 });
        publish(task.id, {
          type: "user", content: userMsg.content, msgId: userMsg.id,
          generation: fresh.generation, ts: userMsg.created_at,
        });
        const late = run.trigger === "catch_up" ? " (catching up — the app was not running at the scheduled time)" : "";
        const note = `▶ Scheduled — ${schedule.name}, ${describeSpec(specOf(schedule))}${late}.`;
        startTurn(fresh, project, schedule.prompt, note, controller, {
          ...SCHEDULED_RUN_CONTEXT,
          scheduleRunId: run.id,
        });
        launched = true;
      });
    } finally {
      if (!launched) {
        unregisterTurn(task.id, controller);
        settleRun(run.id, "failed", "the turn could not be launched");
      }
    }
  } catch (err) {
    settleRun(run.id, "failed", err instanceof Error ? err.message : String(err));
  } finally {
    workEnded();
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test:docker -- tests/scheduler.test.ts`
Expected: PASS, 6 tests. If the connected-agent preflight rejects everything in the test environment, set the connection in the test with `setAgentConnection` from `@/lib/agents/connections` in `beforeEach` — check how `tests/agentFallback.test.ts` does it and mirror that.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck:docker && npm run test:docker`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/scheduler.ts tests/scheduler.test.ts
git commit -m "Launch a scheduled firing: preflight, mint a fresh task, start its turn

The launch mirrors the initial-turn branch of POST /api/tasks/[id]/messages and
lib/autoStart.ts — claim the slot, ensure the worktree under the task lock,
persist and publish the prompt, hand to startTurn — differing only in the
schedule's prompt, the RunContext, and a sync note that records WHY the session
began, so the transcript explains itself at 08:30.

Preflight refuses to mint a doomed task: no project, no working directory, or a
disconnected agent each record an actionable run instead of leaving a broken
task on the board. The agent check is for THIS agent specifically and never
falls back, since falling back would quietly run the work on the wrong login.

The sweep is single-flight and sequential — ten schedules at 08:30 must not
spawn ten worktree setups and ten CLIs at once — and one bad schedule can never
abort the rest of it."
```

---

### Task 9: Boot wiring — the ticker must start with the server, not with a browser

**Files:**
- Create: `app/api/instance/scheduler/route.ts`
- Modify: `middleware.ts` (service-token path list)
- Modify: `server.js` (boot ping)
- Test: `tests/schedulerBoot.test.ts`

**Interfaces:**
- Consumes: `startScheduler`, `schedulerHealth` (Task 8).

- [ ] **Step 1: Write the route**

Create `app/api/instance/scheduler/route.ts`:

```ts
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Boot trigger for the schedule ticker. server.js pings this over loopback
// right after listen (with the service token, mirroring the health probes and
// the services restore) so schedules fire with the SERVER, not with a browser —
// the whole point is a run at 08:30 with nobody logged in.
//
// Idempotent: startScheduler() is guarded on globalThis, so re-pinging (or a
// user request beating the ping) is safe.
//
// Deliberately its OWN route rather than folded into
// /api/instance/services-restore: that route is PINNED SDK-free by
// tests/importGraph.test.ts, whose walker follows dynamic import() too, and the
// scheduler reaches lib/runner.ts and therefore both agent SDKs. An
// instrumentation.ts hook would be the idiomatic home and breaks Turbopack dev
// on better-sqlite3, same as documented on the services-restore route.
//
// lib/scheduler is imported DYNAMICALLY for the reason spelled out on that
// route: its graph reaches the ESM agent-SDK externals, which Turbopack
// compiles as async modules, and a static namespace import can be read back
// before the async factory resolves.
export async function POST() {
  const { startScheduler, schedulerHealth } = await import("@/lib/scheduler");
  startScheduler();
  return NextResponse.json({ ok: true, ...schedulerHealth() });
}

export async function GET() {
  const { schedulerHealth } = await import("@/lib/scheduler");
  return NextResponse.json(schedulerHealth());
}
```

- [ ] **Step 2: Allow the boot ping through the auth gate**

In `middleware.ts`, below the `SERVICES_RESTORE_PATH` constant:

```ts
// The boot-time self-ping from server.js that starts the schedule ticker.
const SCHEDULER_PATH = "/api/instance/scheduler";
```

and add it to `isServiceTokenPath`:

```ts
    pathname === SERVICES_RESTORE_PATH ||
    pathname === SCHEDULER_PATH
```

Also add it to the `countsAsActivity` exclusion list in `server.js` (below), so the boot ping doesn't read as user activity to the idle daemon.

- [ ] **Step 3: Ping it from `server.js`**

In `server.js`, generalize the existing boot ping. Replace the `restorePersistedServices` function with a parameterised version and a caller for each path:

```js
// Loopback boot pings: work the SERVER must start on its own, without waiting
// for a browser. The service token clears the origin gate the same way the
// health probes do; retries paper over Next's route compilation on a cold dev
// boot.
function bootPing(label, path) {
  const url = `http://127.0.0.1:${port}${path}`;
  const headers = process.env.SERVICE_TOKEN
    ? { "x-service-token": process.env.SERVICE_TOKEN }
    : {};
  let attempts = 0;
  const ping = () => {
    attempts++;
    fetch(url, { method: "POST", headers })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
      })
      .catch((err) => {
        if (attempts < 5) setTimeout(ping, 3000).unref?.();
        else console.warn(`[${label}] boot ping failed: ${err?.message || err}`);
      });
  };
  ping();
}
```

Update the existing call site (currently `restorePersistedServices();`) to:

```js
    // Managed dev servers with desired_state='running' restart with the box.
    bootPing("services", "/api/instance/services-restore");
    // Scheduled tasks fire with the server, not with a browser.
    bootPing("scheduler", "/api/instance/scheduler");
```

And extend `countsAsActivity` so neither ping wakes the idle daemon:

```js
    p !== "/api/instance/services-restore" &&
    p !== "/api/instance/scheduler"
```

- [ ] **Step 4: Write the test**

Create `tests/schedulerBoot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

// The ticker is useless if it doesn't start with the server, and every link in
// that chain is in a different file and a different language. Pin the chain.
describe("scheduler boot chain", () => {
  it("server.js pings the scheduler route at boot", () => {
    const src = read("server.js");
    expect(src).toContain("/api/instance/scheduler");
  });

  it("the boot ping does not read as user activity to the idle daemon", () => {
    const src = read("server.js");
    const guard = src.slice(src.indexOf("const countsAsActivity"), src.indexOf("const countsAsActivity") + 600);
    expect(guard).toContain("/api/instance/scheduler");
  });

  it("middleware lets the service-token ping through", () => {
    expect(read("middleware.ts")).toContain('"/api/instance/scheduler"');
  });

  it("the route exists and starts the ticker", () => {
    const src = read("app/api/instance/scheduler/route.ts");
    expect(src).toContain("startScheduler");
    // Dynamic import, or Turbopack's async-external compilation bites (the same
    // bug the services-restore route documents).
    expect(src).toContain('await import("@/lib/scheduler")');
  });

  it("the pinned services-restore route still never reaches the scheduler", () => {
    expect(read("app/api/instance/services-restore/route.ts")).not.toContain("scheduler");
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:docker -- tests/schedulerBoot.test.ts tests/importGraph.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck:docker && npm run test:docker`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/api/instance/scheduler/route.ts middleware.ts server.js tests/schedulerBoot.test.ts
git commit -m "Start the schedule ticker from a boot self-ping, so it needs no browser

This is the first server-owned periodic work in the app. The recap sweep that
resembles a scheduler is a browser setInterval hitting /api/recaps/sweep, which
does nothing when no tab is open — and 'nobody is logged in' is the entire
premise here.

Its own route rather than folding into the existing services-restore ping:
that route is PINNED SDK-free by tests/importGraph.test.ts, whose walker follows
dynamic import() as well as static, and the scheduler reaches lib/runner.ts and
therefore both agent SDKs. The pin guards a bug this project has already been
bitten by in production, so it is not the thing to bend.

The middleware entry only matters under Cloudflare Access — local mode already
permits a loopback self-ping by Host — but this repo supports Access natively,
so omitting it would ship a scheduler that silently never ticks for Access
self-hosters. tests/schedulerBoot.test.ts pins the whole chain, because it
spans three files in two languages and fails silently when it breaks."
```

---

### Task 10: HTTP API

**Files:**
- Create: `app/api/projects/[id]/schedules/route.ts` (GET list, POST create)
- Create: `app/api/schedules/[id]/route.ts` (PATCH, DELETE)
- Create: `app/api/schedules/[id]/run/route.ts` (POST Run now)
- Create: `app/api/schedules/validate/route.ts` (POST prompt validation)
- Test: `tests/scheduleApi.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 6, 8.
- Produces: REST endpoints returning `Schedule`, `{ schedule, runs, next_fire_at }`, and `PromptValidation`.

- [ ] **Step 1: Write the list/create route**

Create `app/api/projects/[id]/schedules/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { createSchedule, lastRun, listRuns, listSchedules } from "@/lib/schedule/store";

export const dynamic = "force-dynamic";

/** Each schedule with the history the landing card needs to be trustworthy. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "no such project" }, { status: 404 });
  // Lazily start the ticker: a dev boot that missed the self-ping still works.
  const { startScheduler, schedulerHealth } = await import("@/lib/scheduler");
  startScheduler();
  const schedules = listSchedules(id).map((s) => ({ ...s, last_run: lastRun(s.id), runs: listRuns(s.id, 5) }));
  return NextResponse.json({ schedules, scheduler: schedulerHealth() });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "no such project" }, { status: 404 });
  const body = await req.json();
  if (!body?.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!body?.prompt?.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 });
  try {
    // createSchedule computes next_fire_at and throws on an unusable spec — a
    // 400 now beats a schedule that silently never fires.
    const schedule = createSchedule({
      project_id: id,
      name: String(body.name).trim(),
      prompt: String(body.prompt),
      days_mask: Number(body.days_mask),
      time_of_day: String(body.time_of_day),
      timezone: String(body.timezone),
      agent: typeof body.agent === "string" ? body.agent : undefined,
      permission_mode: typeof body.permission_mode === "string" ? body.permission_mode : undefined,
      send_context: typeof body.send_context === "boolean" ? body.send_context : undefined,
      priority: body.priority,
      catch_up_ms: typeof body.catch_up_ms === "number" ? body.catch_up_ms : undefined,
    });
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
    return NextResponse.json(schedule, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
```

- [ ] **Step 2: Write the update/delete route**

Create `app/api/schedules/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { deleteSchedule, getSchedule, listRuns, updateSchedule } from "@/lib/schedule/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const schedule = getSchedule(id);
  if (!schedule) return NextResponse.json({ error: "no such schedule" }, { status: 404 });
  return NextResponse.json({ schedule, runs: listRuns(id, 20) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getSchedule(id)) return NextResponse.json({ error: "no such schedule" }, { status: 404 });
  const body = await req.json();
  const fields: Record<string, unknown> = {};
  for (const k of ["name", "prompt", "days_mask", "time_of_day", "timezone", "agent", "permission_mode", "priority", "catch_up_ms"]) {
    if (body[k] !== undefined) fields[k] = body[k];
  }
  // Pause/resume. Resuming recomputes from NOW, so unpausing a schedule parked
  // for a month doesn't greet the user with a month of missed occurrences.
  if (body.enabled !== undefined) fields.enabled = body.enabled ? 1 : 0;
  if (body.send_context !== undefined) fields.send_context = body.send_context ? 1 : 0;
  try {
    const schedule = updateSchedule(id, fields);
    return NextResponse.json(schedule);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Hard delete, like everything else here. The tasks it minted survive
  // (tasks.schedule_id is ON DELETE SET NULL) — deleting the schedule must not
  // delete the work it produced.
  deleteSchedule(id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Write the Run-now and validate routes**

Create `app/api/schedules/[id]/run/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getSchedule } from "@/lib/schedule/store";

export const dynamic = "force-dynamic";

// Fire now, out of band. Uses the same unattended policy as a real firing (a
// scheduled prompt must behave identically whether a human pressed the button
// or the clock did) and deliberately does NOT move the next occurrence.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getSchedule(id)) return NextResponse.json({ error: "no such schedule" }, { status: 404 });
  const { runScheduleNow } = await import("@/lib/scheduler");
  const run = await runScheduleNow(id);
  if (!run) return NextResponse.json({ error: "a run is already starting for this schedule" }, { status: 409 });
  return NextResponse.json(run, { status: 201 });
}
```

Create `app/api/schedules/validate/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";

export const dynamic = "force-dynamic";

// Check a schedule's prompt before it is saved. Matters because an unknown
// slash command does not fail — it returns "Unknown command: /x" with a SUCCESS
// result, so the run would report success having done nothing.
export async function POST(req: Request) {
  const body = await req.json();
  const project = getProject(String(body?.project_id ?? ""));
  if (!project) return NextResponse.json({ error: "valid project_id required" }, { status: 400 });
  const { validatePrompt } = await import("@/lib/schedule/commands");
  const result = await validatePrompt(String(body?.prompt ?? ""), project, String(body?.agent || project.default_agent));
  return NextResponse.json(result);
}
```

- [ ] **Step 4: Write the test**

Create `tests/scheduleApi.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { createProject } from "@/lib/store";
import { getSchedule, listSchedules } from "@/lib/schedule/store";
import { GET as listSchedulesRoute, POST as createRoute } from "@/app/api/projects/[id]/schedules/route";
import { DELETE as deleteRoute, PATCH as patchRoute } from "@/app/api/schedules/[id]/route";

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (url: string, body: unknown) =>
  new Request(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("schedules API", () => {
  let pid = "";
  beforeEach(() => { pid = createProject({ name: `api-${Math.random().toString(36).slice(2)}` }).id; });

  const body = {
    name: "Jira triage", prompt: "/jira-tasks", days_mask: 62,
    time_of_day: "08:30", timezone: "America/Los_Angeles",
  };

  it("creates a schedule and lists it", async () => {
    const created = await createRoute(post("http://x/api", body), { params: Promise.resolve({ id: pid }) });
    expect(created.status).toBe(201);
    const listed = await listSchedulesRoute(new Request("http://x/api"), { params: Promise.resolve({ id: pid }) });
    const json = await listed.json();
    expect(json.schedules).toHaveLength(1);
    expect(json.schedules[0].name).toBe("Jira triage");
    expect(json.scheduler).toBeDefined();
  });

  it("rejects an unusable spec at creation rather than never firing", async () => {
    const res = await createRoute(
      post("http://x/api", { ...body, timezone: "Mars/Olympus" }),
      { params: Promise.resolve({ id: pid }) }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/timezone/);
    expect(listSchedules(pid)).toHaveLength(0);
  });

  it("pauses and resumes", async () => {
    const created = await (await createRoute(post("http://x/api", body), { params: Promise.resolve({ id: pid }) })).json();
    await patchRoute(patch("http://x/api", { enabled: false }), { params: Promise.resolve({ id: created.id }) });
    expect(getSchedule(created.id)!.enabled).toBe(0);
    await patchRoute(patch("http://x/api", { enabled: true }), { params: Promise.resolve({ id: created.id }) });
    const resumed = getSchedule(created.id)!;
    expect(resumed.enabled).toBe(1);
    expect(resumed.next_fire_at).toBeGreaterThan(Date.now());
  });

  it("deletes", async () => {
    const created = await (await createRoute(post("http://x/api", body), { params: Promise.resolve({ id: pid }) })).json();
    await deleteRoute(new Request("http://x/api", { method: "DELETE" }), { params: Promise.resolve({ id: created.id }) });
    expect(getSchedule(created.id)).toBeNull();
  });
});
```

- [ ] **Step 5: Run the test and typecheck**

Run: `npm run test:docker -- tests/scheduleApi.test.ts && npm run typecheck:docker`
Expected: PASS. `next typegen` validates every handler's signature against its route, so a mismatched `params` type fails the typecheck.

- [ ] **Step 6: Commit**

```bash
git add app/api/projects/\[id\]/schedules app/api/schedules tests/scheduleApi.test.ts
git commit -m "Add the schedules REST API: list, create, edit, pause, delete, run now, validate

Creation validates the spec by computing next_fire_at up front, so an unusable
timezone or day mask is a 400 while the user is looking at it rather than a
schedule that silently never fires. Resuming a paused schedule recomputes from
now, so unpausing something parked for a month doesn't produce a month of missed
occurrences.

Run now shares the firing path exactly — same unattended policy, since a
scheduled prompt must behave the same whether the clock or a human started it —
and deliberately leaves the next occurrence where it was.

The list endpoint also starts the ticker lazily, so a dev boot that missed the
self-ping still schedules, and reports scheduler health so the UI can say when
the ticker itself is dead."
```

---

### Task 11: The Schedules card in the project landing pane

**Files:**
- Create: `app/orchestrator/Schedules.tsx`
- Modify: `app/orchestrator/ProjectLanding.tsx` (mount the card)
- Modify: `app/orchestrator/types.ts` (client types)

**Interfaces:**
- Consumes: the Task 10 endpoints; `jget`/`jsend` from `app/orchestrator/api.ts`.
- Produces: `<Schedules projectId={...} />`.

- [ ] **Step 1: Add the client types**

In `app/orchestrator/types.ts`, append:

```ts
export interface ScheduleRunRow {
  id: string;
  scheduled_for: number;
  fired_at: number;
  finished_at: number;
  task_id: string | null;
  status: "claimed" | "running" | "succeeded" | "failed" | "stopped" | "interrupted" | "missed" | "skipped_overlap";
  trigger: "scheduled" | "catch_up" | "manual";
  detail: string;
  dst_adjusted: string;
}

export interface ScheduleRow {
  id: string;
  project_id: string;
  name: string;
  prompt: string;
  days_mask: number;
  time_of_day: string;
  timezone: string;
  enabled: number;
  agent: string;
  permission_mode: string | null;
  next_fire_at: number;
  last_run: ScheduleRunRow | null;
  runs: ScheduleRunRow[];
}

export interface SchedulesResponse {
  schedules: ScheduleRow[];
  scheduler: { started: boolean; lastTickAt: number; lastError: string };
}
```

- [ ] **Step 2: Write the card**

Create `app/orchestrator/Schedules.tsx`. Read `app/orchestrator/Services.tsx` first and match its markup and class conventions — this card sits beside it and must not look foreign.

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { jget, jsend } from "./api";
import type { ScheduleRow, ScheduleRunRow, SchedulesResponse } from "./types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = 62;

const maskLabel = (mask: number) =>
  mask === 127 ? "Every day" : mask === WEEKDAYS ? "Mon–Fri" : mask === 65 ? "Sat–Sun"
    : DAYS.filter((_, i) => mask & (1 << i)).join(", ");

/** "tomorrow 08:30" beats an ISO string when you're deciding whether to trust it. */
function whenLabel(ms: number, timezone: string): string {
  if (!ms) return "—";
  const now = new Date();
  const then = new Date(ms);
  const day = new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: "short", month: "short", day: "numeric" }).format(then);
  const time = new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(then);
  const days = Math.round((then.setHours(0, 0, 0, 0) - now.setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return `${day} ${time}`;
}

const OUTCOME: Record<ScheduleRunRow["status"], { label: string; tone: string }> = {
  claimed: { label: "starting", tone: "muted" },
  running: { label: "running", tone: "busy" },
  succeeded: { label: "ran", tone: "ok" },
  failed: { label: "failed", tone: "bad" },
  stopped: { label: "stopped", tone: "muted" },
  interrupted: { label: "interrupted", tone: "bad" },
  missed: { label: "missed", tone: "warn" },
  skipped_overlap: { label: "skipped", tone: "warn" },
};

function RunLine({ run, timezone }: { run: ScheduleRunRow; timezone: string }) {
  const outcome = OUTCOME[run.status];
  // Show what it was DUE at next to when it actually went, whenever they differ —
  // otherwise a catch-up looks like the schedule fires at the wrong time.
  const late = run.fired_at && Math.abs(run.fired_at - run.scheduled_for) > 60_000;
  return (
    <div className="sched-run">
      <span className={`sched-badge sched-${outcome.tone}`}>{outcome.label}</span>
      <span className="sched-when">{whenLabel(run.scheduled_for, timezone)}</span>
      {late ? <span className="sched-note">ran {whenLabel(run.fired_at, timezone)}</span> : null}
      {run.trigger === "catch_up" ? <span className="sched-note">catch-up</span> : null}
      {run.trigger === "manual" ? <span className="sched-note">manual</span> : null}
      {run.dst_adjusted ? <span className="sched-note">DST adjusted</span> : null}
      {run.detail ? <span className="sched-detail">{run.detail}</span> : null}
    </div>
  );
}

export function Schedules({ projectId }: { projectId: string }) {
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await jget<SchedulesResponse>(`/api/projects/${projectId}/schedules`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  if (!data) return null;
  if (!data.schedules.length) return null; // the editor lives in the project settings; nothing to show yet

  return (
    <section className="sched-card">
      <h3>Schedules</h3>
      {/* A dead ticker is worse than no schedule, so say so rather than showing
          a next-run time that will never arrive. */}
      {!data.scheduler.started ? (
        <p className="sched-alert">The scheduler is not running on this instance — nothing will fire.</p>
      ) : null}
      {error ? <p className="sched-alert">{error}</p> : null}
      {data.schedules.map((s: ScheduleRow) => (
        <div key={s.id} className={`sched-row${s.enabled ? "" : " sched-paused"}`}>
          <div className="sched-head">
            <strong>{s.name}</strong>
            <span className="sched-spec">{maskLabel(s.days_mask)} at {s.time_of_day}</span>
            <span className="sched-next">
              {s.enabled ? `next ${whenLabel(s.next_fire_at, s.timezone)}` : "paused"}
            </span>
            <button disabled={busy === s.id}
              onClick={() => act(s.id, () => jsend(`/api/schedules/${s.id}`, "PATCH", { enabled: !s.enabled }))}>
              {s.enabled ? "Pause" : "Resume"}
            </button>
            <button disabled={busy === s.id}
              onClick={() => act(s.id, () => jsend(`/api/schedules/${s.id}/run`, "POST"))}>
              Run now
            </button>
          </div>
          {s.last_run ? <RunLine run={s.last_run} timezone={s.timezone} /> : <div className="sched-run">no runs yet</div>}
          {/* A wedged turn skips every future occurrence, so the blocking run
              is named and stoppable from here — otherwise the schedule just
              goes quiet and the user has no idea why. */}
          {s.last_run?.status === "skipped_overlap" && s.runs.find((r) => r.status === "running")?.task_id ? (
            <div className="sched-run">
              <span className="sched-note">blocked by a run still going</span>
              <button disabled={busy === s.id}
                onClick={() => act(s.id, () =>
                  jsend(`/api/tasks/${s.runs.find((r) => r.status === "running")!.task_id}/abort`, "POST"))}>
                Stop it
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 3: Mount it**

`ProjectLanding` (`app/orchestrator/ProjectLanding.tsx`) is `({ project, recap, onNewTask, onRefreshRecap })` and has FOUR return branches: recap-generating, recap-failed, `hasRecap`, and the default "No task selected" empty state. The card belongs in the two branches a user actually sits and reads — `hasRecap` and the default — not the two transient ones.

Add the import:

```tsx
import { Schedules } from "./Schedules";
```

In the `hasRecap` branch, inside the `<div className="tw" style={{ maxWidth: 720 }}>`, immediately after the closing `</div>` of `.recap-card`:

```tsx
          <Schedules projectId={project.id} />
```

The default branch is a centred `.empty` block, so wrap it so the card can sit beneath it:

```tsx
  return (
    <div className="transcript">
      <div className="tw" style={{ maxWidth: 720 }}>
        <div className="empty" style={{ margin: "auto" }}>
          <div className="e-ic">{Icon.bolt()}</div>
          <div className="e-t">No task selected</div>
          <div className="e-s">Create a task to start an agent session.</div>
          <button className="btn btn-accent" style={{ marginTop: 16 }} onClick={onNewTask}>{Icon.plus()} New task</button>
        </div>
        <Schedules projectId={project.id} />
      </div>
    </div>
  );
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck:docker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/orchestrator/Schedules.tsx app/orchestrator/ProjectLanding.tsx app/orchestrator/types.ts
git commit -m "Show schedules on the project landing pane, with their real outcomes

The landing pane is what you see when you open a project in the morning, which
is exactly when a schedule's output matters — so that is where the card lives.

It shows what a user needs to actually trust the thing: the next run in local
words, the last outcome including missed and skipped, what a run was DUE at
alongside when it really went (a catch-up otherwise looks like the schedule
fires at the wrong time), and a warning when the ticker itself is not running,
because a dead scheduler showing a confident 'next run tomorrow 08:30' is worse
than showing nothing."
```

---

### Task 12: Editor, docs, and the end-to-end proof

**Files:**
- Modify: `app/orchestrator/Schedules.tsx` (add the create/edit form)
- Create: `e2e/10-schedules.spec.ts`
- Modify: `README.md`, `docs/FEATURES.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add the editor to the card**

Extend `app/orchestrator/Schedules.tsx` with a "New schedule" form. It must always render (so the card appears for a project with no schedules — remove the `if (!data.schedules.length) return null;` early return). Add `useMemo` to the existing `react` import. The form fields: name, prompt, day checkboxes, time (`<input type="time">`), timezone (defaulting to `Intl.DateTimeFormat().resolvedOptions().timeZone`), agent, and permission mode.

Permission mode is a real field, not a hidden default, and it needs a sentence of plain English next to it — "never prompt" and "allow everything" are different things and the form should not conflate them:

```tsx
// A scheduled run cannot answer a permission prompt: nobody is there, so the
// gate declines and the turn degrades. Saying so beside the picker is the
// difference between a considered choice and a surprise.
<label>
  Permission mode
  <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
    <option value="bypassPermissions">Auto-run — no prompts, full tool access</option>
    <option value="acceptEdits">Accept edits — prompts are declined automatically</option>
    <option value="plan">Plan mode — prompts are declined automatically</option>
  </select>
</label>
<p className="sched-note">
  {permissionMode === "bypassPermissions"
    ? "This run does whatever the prompt needs without asking. Nobody is around at 08:30 to approve anything."
    : "Anything needing approval will be declined automatically, and the run may stop early."}
</p>
```

Two more behaviours are the point of the form, not decoration:

```tsx
// Validate a slash prompt BEFORE saving. An unknown command does not fail at
// run time — it returns "Unknown command: /x" as a SUCCESS — so catching it
// here is the difference between a working schedule and one that reports green
// every morning having done nothing.
const [check, setCheck] = useState<{ ok: boolean; error?: string; suggestions?: string[]; unchecked?: boolean } | null>(null);
const validate = async (prompt: string, agent: string) => {
  if (!prompt.trim().startsWith("/")) { setCheck(null); return; }
  try {
    setCheck(await jsend(`/api/schedules/validate`, "POST", { project_id: projectId, prompt, agent }));
  } catch {
    setCheck(null);
  }
};
```

```tsx
// Preview the next three occurrences. A timezone or day-mask mistake should be
// visible while the user is still looking at the form, not the following Monday.
const preview = useMemo(() => {
  try {
    const spec = { daysMask: mask, timeOfDay: time, timezone: tz };
    const out: number[] = [];
    let cursor = Date.now();
    for (let i = 0; i < 3; i++) {
      cursor = nextFireAt(spec, cursor).ms;
      out.push(cursor);
    }
    return out;
  } catch {
    return [];
  }
}, [mask, time, tz]);
```

`nextFireAt` is imported from `@/lib/schedule/time` — it is pure and dependency-free, so the client can import it directly.

Render the validation failure prominently, with the suggestions as clickable fixes, and the three preview lines under the time field.

- [ ] **Step 2: Write the e2e spec**

Create `e2e/10-schedules.spec.ts`. Read `e2e/README.md` first — the suite runs the **built** bundle against the deterministic mock agent, and a stale build is the classic false failure here. This mirrors the setup in `e2e/09-permissions.spec.ts`, whose helpers (`ensureOnboarded`, `createProject`, `makeFixtureRepo`, `gotoApp`, `uid`, `waitForIdle`) are the ones to reuse:

```ts
// Scheduling is unit-tested to death; this proves the loop a user actually
// performs — create a schedule on the landing pane, fire it, and watch a real
// task come out the other end.

import { expect, test } from "@playwright/test";
import { createProject, ensureOnboarded, gotoApp, makeFixtureRepo, uid, waitForIdle } from "./helpers";

const PROJECT = `Schedules ${uid()}`;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("schedules") });
});

test("a schedule can be created, run on demand, and paused", async ({ page }) => {
  await gotoApp(page);
  // Selecting the project with no task selected lands on ProjectLanding, which
  // is where the Schedules card lives.
  await page.getByText(PROJECT).first().click();

  await page.getByRole("button", { name: "New schedule" }).click();
  await page.getByLabel("Name").fill("Morning triage");
  await page.getByLabel("Prompt").fill("say hello");
  await page.getByLabel("Mon", { exact: true }).check();
  await page.getByLabel("Time").fill("08:30");
  await page.getByRole("button", { name: "Create schedule" }).click();

  await expect(page.getByText("Morning triage")).toBeVisible();
  // The preview is the guard against a timezone mistake, so it must render.
  await expect(page.getByText(/next /)).toBeVisible();

  // Run now exercises the entire firing path without waiting until 08:30.
  await page.getByRole("button", { name: "Run now" }).click();
  await waitForIdle(page);
  await expect(page.getByText(/\b(ran|running)\b/)).toBeVisible();

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("paused")).toBeVisible();
});
```

If a helper's signature differs, follow `e2e/09-permissions.spec.ts` verbatim rather than inventing one.

- [ ] **Step 3: Run the e2e suite**

Run: `npm run test:e2e:docker`
Expected: PASS. Remember the suite runs the **built** bundle — a stale build is the classic false failure here.

- [ ] **Step 4: Update the docs**

`README.md` — add scheduled tasks to the feature list.

`docs/FEATURES.md` — a section covering: what a schedule is, that each firing mints a fresh task, timezone handling, the catch-up window and what `missed` means, overlap skipping, that scheduled runs cannot answer permission prompts (and what that implies for the permission mode), and the slash-command gotcha.

`CLAUDE.md` — add a paragraph to the architecture section. Suggested text:

> **Scheduled tasks** (`lib/scheduler.ts`, `lib/schedule/`) are the app's only server-owned periodic work — the recap sweep that resembles one is a browser `setInterval`, so it does nothing with no tab open. A `schedules` row owns a prompt + project; each firing MINTS A FRESH TASK (tagged `tasks.schedule_id`) and launches its first turn the way `lib/autoStart.ts` does. `lib/schedule/time.ts` is `Intl`-only wall-clock math: an IANA zone, never an offset, with both DST edges decided (a nonexistent wall time fires when the gap closes; an ambiguous one fires once, on the earlier pass). `UNIQUE(schedule_id, scheduled_for)` on `schedule_runs` is the durable claim that makes a double fire impossible across overlapping ticks, a Run-now race, or a restart. One sweep consumes the whole backlog: older slots are recorded `missed`, the newest fires once as `catch_up` if it's inside the window — never silently skipped. Scheduled turns carry a `RunContext` (`lib/runContext.ts`) marking them `interactionPolicy: "deny"`, so the permission gate settles instead of parking on the watcher-count heuristic, and the runner settles the run from its own `finally` and leaves `awaiting_input` at 0 on success — otherwise every morning's run would file a permanent item in the "N need you" pill. The ticker starts from a boot self-ping to `/api/instance/scheduler` (its own route: `/api/instance/services-restore` is PINNED SDK-free and the scheduler reaches the runner).

- [ ] **Step 5: Full preflight**

Run: `npm run preflight:docker`
Expected: PASS — unit and e2e.

- [ ] **Step 6: Commit**

```bash
git add app/orchestrator/Schedules.tsx e2e/10-schedules.spec.ts README.md docs/FEATURES.md CLAUDE.md
git commit -m "Add the schedule editor, an e2e proof, and the docs

The editor earns its keep with two things rather than the form fields: it
validates a slash prompt against the session's real command registry before
saving (an unknown command reports SUCCESS at run time, so this is the only
cheap place to catch it), and it previews the next three occurrences, so a
timezone or day-mask mistake is visible while the user is still looking at the
form instead of the following Monday.

The e2e spec drives the loop a user actually performs — create, Run now, see a
task come out, pause — because the unit tests prove the machinery and none of
them prove the thing is reachable."
```

---

## Verification against the definition of done

After Task 12, confirm each spec criterion explicitly:

- [ ] A schedule can be created and paused from the UI — Tasks 10–12.
- [ ] It survives an app restart — `next_fire_at` is persisted (Task 2), revalidated by `startScheduler` (Task 8), and the ticker restarts from the boot ping (Task 9).
- [ ] It fires at the right local wall-clock time across a DST boundary — Task 1, pinned by tests asserting the UTC instant moves while the wall time doesn't.
- [ ] A missed firing behaves as designed rather than by accident — Task 7, including the whole-backlog sweep and the visible `missed` row.
- [ ] A weekday 08:30 run of the jira-tasks skill lands suggested tasks in the tray with nobody logged in — needs a **live manual check** the automated suite cannot make: create the real schedule against the real project, confirm the editor validates `/jira-tasks` (getting the plugin namespace right), use Run now, and confirm suggestions appear in the tray. Then set it for the next weekday morning, close every browser tab, and check the following morning.
