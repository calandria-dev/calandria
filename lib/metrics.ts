// The handful of numbers a Prometheus scrape needs (issue #16 item 3).
//
// Deliberately hand-rolled text exposition rather than a client library: the
// whole surface is ~8 series, the format is a documented plain-text contract,
// and prom-client would add a dependency (plus a default-metrics collector
// nobody asked for) to serialize numbers this file already has in hand.
//
// Three sources, three different lifetimes, and the difference matters when you
// write an alert against them:
//
//   counters   Turn starts and outcomes, incremented from lib/runner.ts at the
//              same two call sites that emit the lifecycle log lines — one
//              rule, so a `turn failed` line and a failed-turn increment can
//              never disagree. They live on globalThis (the app's convention
//              for state that must survive dev HMR) and therefore RESET WHEN
//              THE PROCESS DOES, which is exactly what a Prometheus counter
//              means; `calandria_process_start_time_seconds` is exported
//              alongside so a dashboard can see the restart that reset them.
//   live       Active turns, read from lib/abort.ts's registry — the same
//              source the shutdown drain and the idle daemon trust, and the
//              only one that is right after a crash (task.running in SQLite
//              can be stale; a process-local Map cannot).
//   on disk /  Sizes and the schedule ledger, computed AT SCRAPE TIME because
//   in the DB  nothing else in the app is watching them. The DB files are three
//              stats and are taken fresh every scrape; the worktrees directory
//              is a full `du` of every task checkout on the box, so it sits
//              behind a TTL cache — a 15s scrape interval must not walk every
//              node_modules on the instance four times a minute.
//
// SDK-free and pinned by tests/importGraph.test.ts: this is imported by
// lib/runner.ts AND by a route entry, so it must never grow a path to an agent
// SDK. Capability data comes from lib/agents/capabilities.ts if agent ids are
// ever needed here — never lib/agents/registry.ts.

import fs from "node:fs";
import pkg from "@/package.json";
import { activeTurnCount } from "@/lib/abort";
import { DB_PATH, METRICS_SIZE_TTL_MS, WORKTREES_DIR } from "@/lib/config";
import { readEnv } from "@/lib/env.mjs";
import { worktreeDiskUsage } from "@/lib/git";
import { SCHEDULE_RUN_STATUSES, runCountsByStatus } from "@/lib/schedule/store";

/**
 * How a turn ended. The SAME ladder the runner's second lifecycle line uses and
 * the same one the schedule ledger settles with — imported BY the runner so the
 * two can't drift into a state where the logs say `ok` and the counter says
 * `failed` for one turn. `interrupted` means the agent session never opened, so
 * the turn produced nothing.
 */
export type TurnOutcome = "ok" | "failed" | "stopped" | "interrupted";

const TURN_OUTCOMES: readonly TurnOutcome[] = ["ok", "failed", "stopped", "interrupted"];

interface SizeCache {
  bytes: number;
  at: number;
}

interface MetricsState {
  /** When this process's counters started counting — the reset marker. */
  startedAt: number;
  turnsStarted: number;
  turnsFinished: Record<TurnOutcome, number>;
  /** Last completed worktrees-dir measurement, however old. */
  worktrees: SizeCache | null;
  /** The in-flight measurement, so concurrent scrapes share one `du`. Resolves
   *  null only when it failed and there is no earlier measurement to fall back
   *  on — the one case the gauge is left off the scrape entirely. */
  worktreesScan: Promise<number | null> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaMetrics: MetricsState | undefined;
}

function state(): MetricsState {
  if (!global.__calandriaMetrics) {
    global.__calandriaMetrics = {
      startedAt: Date.now(),
      turnsStarted: 0,
      turnsFinished: { ok: 0, failed: 0, stopped: 0, interrupted: 0 },
      worktrees: null,
      worktreesScan: null,
    };
  }
  return global.__calandriaMetrics;
}

/** A turn began. Called from lib/runner.ts beside the `turn start` line. */
export function countTurnStarted(): void {
  state().turnsStarted++;
}

/** A turn ended, however it ended. Called beside the `turn <outcome>` line. */
export function countTurnFinished(outcome: TurnOutcome): void {
  state().turnsFinished[outcome]++;
}

/** Counters only, for tests — the rendered output is the real contract. */
export function turnCounters(): { started: number; finished: Record<TurnOutcome, number> } {
  const s = state();
  return { started: s.turnsStarted, finished: { ...s.turnsFinished } };
}

/** Drops every counter and cached size. Tests only: there is no operational
 *  reason to reset a counter, and doing it live would look like a restart to
 *  whatever is scraping. */
export function resetMetricsForTest(): void {
  global.__calandriaMetrics = undefined;
}

/**
 * Cold-start budget for the worktrees walk. Not an env knob because only the
 * FIRST scrape after a restart can ever wait on it — every later one is served
 * from the cache (stale if need be) while the scan runs on its own. A `du` that
 * blows through this leaves the series off that one response rather than
 * holding the connection until Prometheus times the scrape out itself.
 */
const SCAN_DEADLINE_MS = 5000;

/** Total apparent size of everything under CALANDRIA_WORKTREES_DIR, or null if
 *  it has never been measured successfully on this process. */
async function worktreesSizeBytes(): Promise<number | null> {
  const s = state();
  const cached = s.worktrees;
  if (cached && Date.now() - cached.at < METRICS_SIZE_TTL_MS) return cached.bytes;

  if (!s.worktreesScan) {
    // worktreeDiskUsage() is `du -sk` on POSIX (a subprocess, so the event loop
    // keeps serving turns while it walks) and an fs walk on win32, where there
    // is no du. It swallows its own failures; the catch here is for a rejection
    // it doesn't anticipate, which must not become an unhandled rejection on a
    // metrics scrape — and which falls back to the last good measurement rather
    // than to 0, since "we couldn't look" is not "there's nothing there".
    s.worktreesScan = worktreeDiskUsage(WORKTREES_DIR)
      .then((bytes) => {
        state().worktrees = { bytes, at: Date.now() };
        return bytes;
      })
      .catch(() => state().worktrees?.bytes ?? null)
      .finally(() => {
        state().worktreesScan = null;
      });
  }

  // A stale number now beats a fresh number late: the scan already running will
  // land in the cache for the next scrape, and a gauge one interval behind is
  // still a usable disk alert.
  if (cached) return cached.bytes;

  const deadline = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), SCAN_DEADLINE_MS);
    t.unref?.();
  });
  return Promise.race([s.worktreesScan, deadline]);
}

/** Bytes on disk for one file, 0 when it isn't there (a `-shm` only exists
 *  while a connection is open; a `-wal` only after the first write). */
function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** A label value, escaped per the exposition format: backslash, double quote
 *  and newline are the only three characters that need it. */
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * The whole scrape response, in Prometheus text exposition format (one metric
 * per HELP/TYPE block, values as plain numbers, trailing newline).
 *
 * Every label set a metric can take is emitted on every scrape, INCLUDING the
 * ones sitting at zero. An absent series is not the same as a zero one to
 * anything downstream: `rate(...{outcome="failed"}[5m])` on a series that only
 * appears once something has failed produces no data — so an alert on it stays
 * silent, and a graph starts at the first failure instead of showing the flat
 * line that preceded it.
 */
export async function renderMetrics(): Promise<string> {
  const counters = state();
  const worktrees = await worktreesSizeBytes();
  const scheduleRuns = runCountsByStatus();

  const out: string[] = [];
  const metric = (name: string, help: string, type: "counter" | "gauge", samples: string[]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
  };

  metric(
    "calandria_build_info",
    "Build provenance of the running instance; always 1, read the labels.",
    "gauge",
    [
      `calandria_build_info{version="${esc(pkg.version)}",sha="${esc(readEnv("CALANDRIA_GIT_SHA") ?? "unknown")}"} 1`,
    ],
  );

  metric(
    "calandria_process_start_time_seconds",
    "Start time of this app process, in seconds since the epoch. The counters below reset here.",
    "gauge",
    [`calandria_process_start_time_seconds ${counters.startedAt / 1000}`],
  );

  metric("calandria_turns_started_total", "Agent turns started since this process booted.", "counter", [
    `calandria_turns_started_total ${counters.turnsStarted}`,
  ]);

  metric(
    "calandria_turns_finished_total",
    "Agent turns that ended since this process booted, by outcome. interrupted = the agent session never opened.",
    "counter",
    TURN_OUTCOMES.map((o) => `calandria_turns_finished_total{outcome="${o}"} ${counters.turnsFinished[o]}`),
  );

  metric(
    "calandria_turns_active",
    "Agent turns running right now, from the in-process abort registry.",
    "gauge",
    [`calandria_turns_active ${activeTurnCount()}`],
  );

  metric(
    "calandria_db_size_bytes",
    "Size of the SQLite database and its WAL sidecars. A wal that never shrinks means checkpoints aren't landing.",
    "gauge",
    [
      `calandria_db_size_bytes{file="db"} ${fileSize(DB_PATH)}`,
      `calandria_db_size_bytes{file="wal"} ${fileSize(`${DB_PATH}-wal`)}`,
      `calandria_db_size_bytes{file="shm"} ${fileSize(`${DB_PATH}-shm`)}`,
    ],
  );

  // Omitted rather than zeroed when the first measurement hasn't landed yet: a
  // disk gauge that reads 0 for the first scrape after every restart would
  // resolve a firing "worktrees are eating the disk" alert without anything
  // having been reclaimed.
  if (worktrees !== null) {
    metric(
      "calandria_worktrees_size_bytes",
      `Apparent size of CALANDRIA_WORKTREES_DIR, cached for ${METRICS_SIZE_TTL_MS}ms between scrapes.`,
      "gauge",
      [`calandria_worktrees_size_bytes ${worktrees}`],
    );
  }

  metric(
    "calandria_schedule_runs",
    "Rows currently in the schedule run ledger by status. A GAUGE, not a counter: the ledger is capped per schedule, so this falls as old runs are pruned.",
    "gauge",
    SCHEDULE_RUN_STATUSES.map((s) => `calandria_schedule_runs{status="${s}"} ${scheduleRuns[s]}`),
  );

  return out.join("\n") + "\n";
}
