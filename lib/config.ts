import path from "node:path";
import os from "node:os";

/**
 * Per-instance configuration, driven entirely by environment variables so an
 * instance can be relocated (fresh container, different user, different ports)
 * with zero code edits. Every value has a documented default — see docs/SELF_HOSTING.md
 * "Configuration" and .env.example.
 *
 * Server-side only. The two plain-Node entrypoints (server.js, pty-server.js)
 * can't import TS, so they read the same env vars directly — keep names in sync.
 */

/** App-data dir for the SQLite database. */
export const DB_DIR = process.env.ORCH_DB_DIR || path.join(os.homedir(), ".zen-orchestrator");

/** Where per-task git worktrees are created (must be outside any project repo). */
export const WORKTREES_DIR =
  process.env.ORCH_WORKTREES_DIR || path.join(os.homedir(), ".agent-orchestrator", "worktrees");

/** Where "Clone a repository" puts cloned repos (the container home's projects/). */
export const PROJECTS_DIR = process.env.ORCH_PROJECTS_DIR || path.join(os.homedir(), "projects");

/**
 * Path to the user's logged-in `claude` binary (Max subscription). The SDK
 * auto-detects it on PATH, but Next's server may run with a trimmed PATH, so
 * we pin it.
 */
export const CLAUDE_CLI_PATH =
  process.env.CLAUDE_CLI_PATH || path.join(os.homedir(), ".local", "bin", "claude");

/**
 * Path to the `codex` binary the Codex driver drives (via @openai/codex-sdk).
 * Empty = let the SDK auto-resolve the binary bundled with its @openai/codex
 * dependency, and let the auth helpers fall back to `codex` on PATH (the Docker
 * image installs it globally next to `claude`). Set this to pin a specific
 * binary when PATH is trimmed or a different install should be used.
 */
export const CODEX_CLI_PATH = process.env.CODEX_CLI_PATH || "";

// Number of milliseconds from an env var, falling back to `def` for anything
// unset, unparseable, or negative. (0 is meaningful for the knobs below — it
// means "no deadline" — so it must survive.)
const ms = (raw: string | undefined, def: number): number => {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : def;
};

// Same idea as ms(), for the plain integer knobs below (ports, buffer sizes)
// that have no meaningful "unset" default to silently prefer. Unlike ms(),
// a bad value here is loud: it's a typo in an env file, not a deliberate
// choice, and left unguarded it used to surface as a deep SQLite bind-type
// error on project creation instead of a named boot warning (issue #18 item 1).
const num = (name: string, raw: string | undefined, def: number): number => {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[config] ${name}=${JSON.stringify(raw)} is not a number; using default ${def}`);
    return def;
  }
  return n;
};

/**
 * How long a tool-permission prompt parks waiting for a human who IS around
 * (at least one browser tab is watching — see watcherCount() in lib/events.ts)
 * before it gives up and denies the call. Generous by default: nobody should
 * hit it mid-review, but a turn left parked overnight still releases its slot
 * instead of holding the task "running" (and the instance busy) forever.
 * Set to 0 to park indefinitely, exactly like an unanswered question card.
 */
export const PERMISSION_PROMPT_TIMEOUT_MS = ms(process.env.ORCH_PERMISSION_PROMPT_TIMEOUT_MS, 4 * 60 * 60 * 1000);

/**
 * The same deadline when NOBODY is watching — an auto-started task
 * (lib/autoStart.ts) or any turn running while the app is closed. There is no
 * one to answer, so the prompt fails closed quickly rather than wedging the
 * turn; the grace window exists only so a tab opening moments later still gets
 * to decide (the gate re-checks and switches to the attended timeout above).
 * 0 disables the unattended shortcut, making every prompt use the attended cap.
 */
export const PERMISSION_UNATTENDED_MS = ms(process.env.ORCH_PERMISSION_UNATTENDED_MS, 45_000);

/**
 * How long a Claude turn may linger after the model stops, keeping the CLI
 * process alive while run_in_background tasks it started are still running.
 * Each turn is one SDK query whose CLI process owns those children AND the
 * in-memory task registry that promises "you'll be notified when it
 * completes" — so ending the query at result time kills the work silently.
 * Instead the driver holds the session open (streaming-input mode) until the
 * tasks settle and their notifications wake the model, bounded by this
 * deadline measured from the first moment the turn starts lingering (wake
 * turns don't reset it). On expiry the work is stopped and a transcript
 * notice says so. The task stays `running` (Stop works, the SIGTERM drain
 * covers it, follow-up messages queue) and shows "working in background".
 * Set to 0 to disable lingering entirely — turns then end at result time and
 * background tasks die with the CLI, the pre-feature behavior.
 */
export const BACKGROUND_LINGER_MS = ms(process.env.ORCH_BACKGROUND_LINGER_MS, 30 * 60 * 1000);

/**
 * How long the graceful-shutdown drain (POST /api/instance/drain, pinged by
 * server.js's SIGTERM/SIGINT handler before it exits) waits for in-flight
 * turns to abort and unwind before giving up and letting the process exit
 * anyway. This is what turns a `docker stop`/Ctrl-C into the same settlement a
 * Stop-button press gets (DENIED_INTERRUPTED permission cards, running/
 * awaiting_input flipped, turn_end published) instead of a bare exit cutting
 * every live turn off mid-write. Bounded on purpose: the unwind is local
 * SQLite writes and in-memory pub/sub with no network round trip, so a few
 * seconds is generous — and the container runtime SIGKILLs after its own grace
 * period regardless, so waiting longer only risks losing the drain's own work.
 * 0 waits indefinitely (not recommended — see this file's `ms()` contract).
 */
export const SHUTDOWN_GRACE_MS = ms(process.env.ORCH_SHUTDOWN_GRACE_MS, 5000);

/**
 * The `approval_policy` the Codex driver passes to the CLI for turns and
 * one-shot helpers. Default "never" is the auto-run analog of Claude's
 * bypassPermissions — turns run unattended in isolated worktrees, with nobody
 * in the loop to answer approval prompts. Enterprise-managed Codex deployments
 * can disallow "never"; the CLI then warns and downgrades, and the driver
 * detects that warning and self-heals to "on-request" from the next turn on
 * (see lib/approvalFailure.ts). Set this to "on-request" or "on-failure" to
 * pick an approval-capable policy up front, or to "inherit" to omit the
 * override entirely so ~/.codex/config.toml and the enterprise requirements
 * decide.
 *
 * "untrusted" (codex's UnlessTrusted) is deliberately NOT accepted: it is the
 * one value that managed requirements allow but that is fatal under the exec
 * transport — non-interactive runs cannot service approvals, so every
 * non-allowlisted command is rejected ("approval request failed") and the task
 * flails. It maps to "on-request", the closest policy that actually works.
 * Unknown values fall back to "never".
 */
export const CODEX_APPROVAL_POLICY = (() => {
  const v = String(process.env.CODEX_APPROVAL_POLICY || "never").toLowerCase();
  if (v === "untrusted") return "on-request";
  return ["never", "on-request", "on-failure", "inherit"].includes(v) ? v : "never";
})();

/**
 * Whether Codex tasks inherit the MCP servers configured in the user's
 * ~/.codex/config.toml, alongside the orchestrator's own bridge. Off by default,
 * and deliberately asymmetric with the Claude driver (which inherits ~/.claude
 * MCP servers) — see "Agent MCP inheritance" in CLAUDE.md.
 *
 * The short version: `codex exec` has no approver, so an inherited server's
 * tools are visible to the model but every call comes straight back as
 * `user cancelled MCP tool call` (verified on codex-cli 0.146.0). Mounting them
 * only spends context and turns on tools that cannot work, so the driver
 * disables them per-server. Set to 1/true/on to mount them anyway — the escape
 * hatch for a future CLI that can auto-approve them, or for a user who has set
 * `default_tools_approval_mode = "approve"` on their own servers.
 */
export const CODEX_INHERIT_MCP = ["1", "true", "on"].includes(
  String(process.env.CODEX_INHERIT_MCP || "").toLowerCase(),
);

/**
 * Opt-in to billing an environment-provided agent API key (ANTHROPIC_API_KEY /
 * ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY). Off by default: both entrypoints
 * strip those vars at boot (lib/env-keys.mjs — server.js and pty-server.js read
 * the env name directly, as does docker/entrypoint.sh) so a key leaked in from
 * a shell profile or unit file can't silently switch turns from the connected
 * subscription login to per-token billing (issue #4). Keys saved through the
 * app's own "I have an API key" path are unaffected — they're re-applied from
 * their 0600 files at db init, after the strip.
 */
export const ALLOW_API_KEY_ENV = ["1", "true", "on"].includes(
  String(process.env.ORCH_ALLOW_API_KEY_ENV || "").toLowerCase(),
);

/**
 * Base TCP port for per-project managed services. Each project is assigned a
 * stable port (base + slot) at creation, stored on its row, injected as PORT
 * into the dev/setup/test service env and the project's PTY shell. Override to
 * relocate the block (e.g. avoid a clash with the app/pty ports). See lib/services.ts.
 */
export const SERVICE_PORT_BASE = num("ORCH_SERVICE_PORT_BASE", process.env.ORCH_SERVICE_PORT_BASE, 4300);

/**
 * Per-service log ring-buffer cap (lines). Each managed service keeps at most
 * this many captured stdout/stderr lines in memory — enough to scroll back
 * through startup + recent output without growing unbounded for a dev server
 * that's been up for days.
 */
export const SERVICE_LOG_LINES = num("ORCH_SERVICE_LOG_LINES", process.env.ORCH_SERVICE_LOG_LINES, 1500);

/**
 * The origin the app answers on over loopback, for in-container server-to-server
 * calls. The stdio MCP bridge (scripts/orch-mcp.mjs, spawned by the Codex CLI)
 * POSTs the suggest_task / expose_service tool calls back to the app's internal
 * endpoints at this base. Defaults to 127.0.0.1 on the app's own PORT (server.js
 * reads the same PORT). Override only if the app is reached differently from
 * inside the box.
 */
export const INTERNAL_BASE_URL =
  process.env.ORCH_INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

/** Absolute path to the stdio MCP bridge the non-Claude drivers register per turn. */
export const ORCH_MCP_SCRIPT = path.join(process.cwd(), "scripts", "orch-mcp.mjs");

/**
 * Whether the app may talk to a project's git remote at all. On by default: a
 * best-effort `git fetch` of the base branch is what keeps new task worktrees
 * from branching off a tip that went stale the moment a PR merged on GitHub.
 * Set to "off"/"0"/"false" for an air-gapped instance, a repo whose fetch is
 * ruinously expensive, or anywhere the network should never be touched — every
 * remote-aware surface then degrades to the purely local behaviour.
 */
export const GIT_FETCH_ENABLED = !["0", "off", "false", "no"].includes(
  String(process.env.ORCH_GIT_FETCH || "").toLowerCase(),
);

/**
 * Hard ceiling on a best-effort fetch. Fetching is never allowed to hold up a
 * task launch, so the subprocess is killed at this deadline and the launch
 * carries on from the best ref it already has locally. Keep it short — this is
 * latency a user waits through when they click Start.
 */
export const GIT_FETCH_TIMEOUT_MS = num("ORCH_GIT_FETCH_TIMEOUT_MS", process.env.ORCH_GIT_FETCH_TIMEOUT_MS, 10_000);

/**
 * How long a successful fetch of a repo counts as fresh. Opening a project and
 * immediately launching five tasks should cost ONE fetch, not six; within this
 * window the extra calls reuse the refs the first one wrote.
 */
export const GIT_FETCH_COOLDOWN_MS = num(
  "ORCH_GIT_FETCH_COOLDOWN_MS",
  process.env.ORCH_GIT_FETCH_COOLDOWN_MS,
  15_000,
);

/**
 * The public origin the app is served from (e.g. https://orch.example.com when
 * behind a tunnel/reverse proxy). Used by the client to build absolute
 * ws(s):// URLs. Empty = same-origin via window.location, which is correct for
 * any single-hostname deployment.
 */
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

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
 * How long the fire-time slash-command probe (lib/schedule/commands.ts) may
 * take before the sweep gives up on it and treats the registry as unreachable.
 * The probe spawns the agent CLI and reads its `init` message, which normally
 * arrives in ~1.5s; the cap exists because that read happens INSIDE the ticker's
 * single-flight sweep, so a stalled CLI would otherwise wedge every schedule on
 * the instance with no error to show for it.
 */
export const SCHEDULE_PROBE_MS = ms(process.env.ORCH_SCHEDULE_PROBE_MS, 20_000);

/**
 * Master switch for the schedule ticker. On by default. Set to off/0/false for
 * an instance that must never start work on its own — a shared box, a debugging
 * session, or a second container pointed at a copy of the database.
 */
export const SCHEDULER_ENABLED = !["0", "off", "false", "no"].includes(
  String(process.env.ORCH_SCHEDULER || "").toLowerCase(),
);

/**
 * Subscription plan-usage display (the titlebar session/week meter). On by
 * default. Set to off/0/false to hide it and never touch the provider's usage
 * API — for an instance that shares a rate-limited plan with many other
 * consumers, or one that should make no requests beyond the turns themselves.
 */
export const PLAN_USAGE_ENABLED = !["0", "off", "false", "no"].includes(
  String(process.env.ORCH_PLAN_USAGE || "").toLowerCase(),
);

/**
 * Floor between two fetches of a provider's plan-usage API. Anthropic
 * rate-limits its usage endpoint aggressively, so the app fetches at most this
 * often — and only while a browser is actually asking (the meter polls; no tab
 * open means no fetches at all). 300s matches the Claude CLI's own minimum
 * interval for the same endpoint. Between fetches the display coasts on the
 * cache plus the passive rate-limit telemetry that rides every turn for free.
 */
export const PLAN_USAGE_MIN_FETCH_MS = ms(process.env.ORCH_PLAN_USAGE_MIN_FETCH_MS, 300_000);
