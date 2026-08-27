import path from "node:path";
import os from "node:os";
import { readEnv } from "./env.mjs";
import { findInDirs, findOnPath } from "./binPath";
import { resolveDbLocation, resolveWorktreesDir } from "./storage.mjs";

/**
 * Per-instance configuration, driven entirely by environment variables so an
 * instance can be relocated (fresh container, different user, different ports)
 * with zero code edits. Every value has a documented default — see docs/SELF_HOSTING.md
 * "Configuration" and .env.example.
 *
 * Server-side only. The two plain-Node entrypoints (server.js, pty-server.js)
 * can't import TS, so they read the same env vars directly — keep names in sync.
 */

/*
 * The two on-disk locations resolve through lib/storage.mjs rather than a bare
 * `env || default`, because an install that predates the Calandria rename still
 * has its data under the old names and nothing here ever moves it. See that
 * file for the rules; the boot warning is printed once by server.js.
 */

const dbLocation = resolveDbLocation();

/** App-data dir for the SQLite database (default `~/.calandria`). */
export const DB_DIR = dbLocation.dir;

/** The database itself — `calandria.db`, or a pre-rename `orchestrator.db` still in place. */
export const DB_PATH = dbLocation.path;

/** Where per-task git worktrees are created (must be outside any project repo). */
export const WORKTREES_DIR = resolveWorktreesDir().dir;

/**
 * Where `scripts/backup.mjs` writes its archives (default `<DB_DIR>/backups`).
 *
 * Declared here rather than only in the script because that is this repo's rule
 * for every per-instance knob — one documented default, one place to look — even
 * though the app itself never reads it: the backup runs as a plain-Node script
 * that can't import TS and reads the same env name directly, exactly as
 * server.js does. Point it at a different volume to keep backups off the disk
 * they are backing up.
 */
export const BACKUP_DIR = readEnv("CALANDRIA_BACKUP_DIR") || path.join(dbLocation.dir, "backups");

/** Where "Clone a repository" puts cloned repos (the container home's projects/). */
export const PROJECTS_DIR = readEnv("CALANDRIA_PROJECTS_DIR") || path.join(os.homedir(), "projects");

/**
 * Path to the user's logged-in `claude` binary (Max subscription). The SDK
 * auto-detects it on PATH, but Next's server may run with a trimmed PATH, so
 * we pin it.
 *
 * The default is extension-less, which is correct on POSIX and unspawnable on
 * Windows: Node's shell-less spawn hands the name to CreateProcess, which only
 * finds a file that actually exists under one of the PATHEXT extensions. So
 * win32 looks for the real thing — the native installer's `claude.exe` under
 * `%USERPROFILE%\.local\bin`, the same directory the POSIX default names, then
 * PATH — and only falls back to a literal `claude.exe` there so a "not
 * installed" failure names a plausible path instead of an extension-less one.
 * Resolved once at import like every other constant here; the escape hatch for
 * an install that appears later is the env var.
 *
 * An npm-shim install (`claude.cmd`) is found by the PATHEXT expansion but is
 * NOT usable, so a real `claude.exe` is the requirement on Windows rather than
 * a preference: this value goes to the Agent SDK's
 * `pathToClaudeCodeExecutable` and to node-pty for the login, and neither
 * offers a cmd.exe wrapper we could route a batch shim through (unlike the
 * codex helpers, which shell out through child_process — lib/binPath.ts's
 * spawnSpec). `.exe` is ordered ahead of `.cmd` in DEFAULT_PATHEXT for that
 * reason, and .env.example says so.
 */
const claudeDefaultPath = () => {
  const localBin = path.join(os.homedir(), ".local", "bin");
  if (process.platform !== "win32") return path.join(localBin, "claude");
  return (
    findInDirs("claude", [localBin]) ?? findOnPath("claude") ?? path.join(localBin, "claude.exe")
  );
};

export const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || claudeDefaultPath();

/**
 * Path to the `codex` binary the Codex driver drives (via @openai/codex-sdk).
 * Empty = let the SDK auto-resolve the binary bundled with its @openai/codex
 * dependency, and let the auth helpers fall back to `codex` on PATH (the Docker
 * image installs it globally next to `claude`). Set this to pin a specific
 * binary when PATH is trimmed or a different install should be used.
 */
export const CODEX_CLI_PATH = process.env.CODEX_CLI_PATH || "";

/**
 * Path to the GitHub CLI (`gh`) used for repo listing/cloning, the guided
 * device-flow login, and opening PRs. Empty = auto-resolve: bare `gh` if the
 * server's PATH can see it, else a best-effort probe of the usual install dirs
 * (linuxbrew/Homebrew, /usr/local/bin, snap, ~/.local/bin). The probe exists
 * because the server process never reads a shell profile — a gh that works in
 * the user's terminal (Homebrew, snap) can be invisible to the app's PATH and
 * used to be reported as "not installed". Set this to pin a specific binary.
 */
export const GH_BIN = readEnv("CALANDRIA_GH_BIN") || "";

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
export const PERMISSION_PROMPT_TIMEOUT_MS = ms(readEnv("CALANDRIA_PERMISSION_PROMPT_TIMEOUT_MS"), 4 * 60 * 60 * 1000);

/**
 * The same deadline when NOBODY is watching — an auto-started task
 * (lib/autoStart.ts) or any turn running while the app is closed. There is no
 * one to answer, so the prompt fails closed quickly rather than wedging the
 * turn; the grace window exists only so a tab opening moments later still gets
 * to decide (the gate re-checks and switches to the attended timeout above).
 * 0 disables the unattended shortcut, making every prompt use the attended cap.
 */
export const PERMISSION_UNATTENDED_MS = ms(readEnv("CALANDRIA_PERMISSION_UNATTENDED_MS"), 45_000);

/**
 * Master switch for background linger. Each Claude turn is one SDK query
 * whose CLI process owns both the run_in_background children and the
 * in-memory task registry that promises "you'll be notified when it
 * completes" — so ending the query at result time kills the work silently.
 * With linger on (the default), the driver holds the session open
 * (streaming-input mode) until the tasks settle and their notifications wake
 * the model. The task stays `running` the whole time (Stop works, the
 * SIGTERM drain covers it, follow-up messages queue) and shows "working in
 * background". Set to off/0/false for the pre-feature behavior: turns end at
 * result time and background tasks die with the CLI.
 */
export const BACKGROUND_LINGER_ENABLED = !["0", "off", "false", "no"].includes(
  String(readEnv("CALANDRIA_BACKGROUND_LINGER") || "").toLowerCase(),
);

/**
 * Optional deadline on a linger, measured from the first moment the turn
 * starts lingering (wake turns don't reset it). Default 0 = NO deadline —
 * the session waits until the work settles, the user presses Stop, or the
 * process shuts down. That's a deliberate default: the lingering state is
 * visible ("working in background", with how long it's been), so a session
 * held too long is the user's call to kick, whereas an automatic cut kills
 * real work to enforce a bound nobody asked for. Set a positive value to
 * auto-stop lingering work at that age instead — the work is killed and a
 * transcript notice names what was cut so the next turn doesn't assume it
 * finished. The cost of an unbounded linger is one idle CLI process and the
 * task's turn slot; a backgrounded process that never exits (a dev server)
 * holds both until stopped.
 */
export const BACKGROUND_LINGER_MS = ms(readEnv("CALANDRIA_BACKGROUND_LINGER_MS"), 0);

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
export const SHUTDOWN_GRACE_MS = ms(readEnv("CALANDRIA_SHUTDOWN_GRACE_MS"), 5000);

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
 * ~/.codex/config.toml, alongside Calandria's own bridge. Off by default,
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
  String(readEnv("CALANDRIA_ALLOW_API_KEY_ENV") || "").toLowerCase(),
);

/**
 * Base TCP port for per-project managed services. Each project is assigned a
 * stable port (base + slot) at creation, stored on its row, injected as PORT
 * into the dev/setup/test service env and the project's PTY shell. Override to
 * relocate the block (e.g. avoid a clash with the app/pty ports). See lib/services.ts.
 */
export const SERVICE_PORT_BASE = num("CALANDRIA_SERVICE_PORT_BASE", readEnv("CALANDRIA_SERVICE_PORT_BASE"), 4300);

/**
 * Per-service log ring-buffer cap (lines). Each managed service keeps at most
 * this many captured stdout/stderr lines in memory — enough to scroll back
 * through startup + recent output without growing unbounded for a dev server
 * that's been up for days.
 */
export const SERVICE_LOG_LINES = num("CALANDRIA_SERVICE_LOG_LINES", readEnv("CALANDRIA_SERVICE_LOG_LINES"), 1500);

/**
 * The origin the app answers on over loopback, for in-container server-to-server
 * calls. The stdio MCP bridge (scripts/calandria-mcp.mjs, spawned by the Codex CLI)
 * POSTs the suggest_task / expose_service tool calls back to the app's internal
 * endpoints at this base. Defaults to 127.0.0.1 on the app's own PORT (server.js
 * reads the same PORT). Override only if the app is reached differently from
 * inside the box.
 */
export const INTERNAL_BASE_URL =
  readEnv("CALANDRIA_INTERNAL_BASE_URL") || `http://127.0.0.1:${process.env.PORT || 3000}`;

/** Absolute path to the stdio MCP bridge the non-Claude drivers register per turn. */
export const CALANDRIA_MCP_SCRIPT = path.join(process.cwd(), "scripts", "calandria-mcp.mjs");

/**
 * Whether the app may talk to a project's git remote at all. On by default: a
 * best-effort `git fetch` of the base branch is what keeps new task worktrees
 * from branching off a tip that went stale the moment a PR merged on GitHub.
 * Set to "off"/"0"/"false" for an air-gapped instance, a repo whose fetch is
 * ruinously expensive, or anywhere the network should never be touched — every
 * remote-aware surface then degrades to the purely local behaviour.
 */
export const GIT_FETCH_ENABLED = !["0", "off", "false", "no"].includes(
  String(readEnv("CALANDRIA_GIT_FETCH") || "").toLowerCase(),
);

/**
 * Hard ceiling on a best-effort fetch. Fetching is never allowed to hold up a
 * task launch, so the subprocess is killed at this deadline and the launch
 * carries on from the best ref it already has locally. Keep it short — this is
 * latency a user waits through when they click Start.
 */
export const GIT_FETCH_TIMEOUT_MS = num(
  "CALANDRIA_GIT_FETCH_TIMEOUT_MS",
  readEnv("CALANDRIA_GIT_FETCH_TIMEOUT_MS"),
  10_000,
);

/**
 * How long a successful fetch of a repo counts as fresh. Opening a project and
 * immediately launching five tasks should cost ONE fetch, not six; within this
 * window the extra calls reuse the refs the first one wrote.
 */
export const GIT_FETCH_COOLDOWN_MS = num(
  "CALANDRIA_GIT_FETCH_COOLDOWN_MS",
  readEnv("CALANDRIA_GIT_FETCH_COOLDOWN_MS"),
  15_000,
);

/**
 * The public origin the app is served from (e.g. https://calandria.example.com when
 * behind a tunnel/reverse proxy). Used by the client to build absolute
 * ws(s):// URLs. Empty = same-origin via window.location, which is correct for
 * any single-hostname deployment.
 */
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

/**
 * Web Push (lib/push/). VAPID is how this instance identifies itself to the
 * browsers' push services (RFC 8292); the subject is the contact they may use
 * about the traffic — a `mailto:` or `https:` URL. Defaults to PUBLIC_BASE_URL
 * when that is https (the instance's own address is a truthful contact), else
 * `mailto:admin@localhost`. That fallback is accepted by FCM (Chrome, Android,
 * Firefox) but REJECTED by Apple's push service with 403 BadJwtToken — Apple
 * validates the subject and won't take `localhost` — so an instance that wants
 * iOS push must set this to a real `https:` origin or `mailto:` address (or set
 * PUBLIC_BASE_URL to its https origin, which this then adopts).
 */
export const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || (PUBLIC_BASE_URL.startsWith("https://") ? PUBLIC_BASE_URL : "mailto:admin@localhost");

/**
 * The VAPID private key: a base64url-encoded raw P-256 scalar (32 bytes) — the
 * format `npx web-push generate-vapid-keys` prints, so a key made elsewhere can
 * be pinned here. Empty (the default) means the instance mints one on first
 * use and keeps it at `<CALANDRIA_DB_DIR>/vapid.json`, beside the database it
 * belongs with: every push subscription is bound to the key it was created
 * under, so a key that travels separately from the subscriptions strands all
 * of them. Set this only to hold one key across instances that share a
 * database, or to survive a wiped data dir with the subscriptions restored
 * from a backup.
 */
export const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || "").trim();

/**
 * How often the schedule ticker wakes to adjudicate due firings
 * (lib/scheduler.ts). Firings are minute-granular, so this bounds how late one
 * can be. Short enough to be punctual, long enough to be free.
 */
export const SCHEDULE_TICK_MS = ms(readEnv("CALANDRIA_SCHEDULE_TICK_MS"), 30_000);

/**
 * How late a missed firing may still run. The machine sleeps, the container
 * restarts, the app is down at 08:30 — on the next tick a firing this recent is
 * run ONCE (marked `catch_up`), and anything older is recorded as `missed`
 * rather than skipped silently. For a morning run, arriving at noon and finding
 * it ran is useful; finding it start at 6pm is not. 0 disables catch-up
 * entirely; a schedule can override this with its own catch_up_ms.
 */
export const SCHEDULE_CATCHUP_MS = ms(readEnv("CALANDRIA_SCHEDULE_CATCHUP_MS"), 4 * 60 * 60 * 1000);

/**
 * How long the fire-time slash-command probe (lib/schedule/commands.ts) may
 * take before the sweep gives up on it and treats the registry as unreachable.
 * The probe spawns the agent CLI and reads its `init` message, which normally
 * arrives in ~1.5s; the cap exists because that read happens INSIDE the ticker's
 * single-flight sweep, so a stalled CLI would otherwise wedge every schedule on
 * the instance with no error to show for it.
 */
export const SCHEDULE_PROBE_MS = ms(readEnv("CALANDRIA_SCHEDULE_PROBE_MS"), 20_000);

/**
 * Master switch for the schedule ticker. On by default. Set to off/0/false for
 * an instance that must never start work on its own — a shared box, a debugging
 * session, or a second container pointed at a copy of the database.
 */
export const SCHEDULER_ENABLED = !["0", "off", "false", "no"].includes(
  String(readEnv("CALANDRIA_SCHEDULER") || "").toLowerCase(),
);

/**
 * Subscription plan-usage display (the titlebar session/week meter). On by
 * default. Set to off/0/false to hide it and never touch the provider's usage
 * API — for an instance that shares a rate-limited plan with many other
 * consumers, or one that should make no requests beyond the turns themselves.
 */
export const PLAN_USAGE_ENABLED = !["0", "off", "false", "no"].includes(
  String(readEnv("CALANDRIA_PLAN_USAGE") || "").toLowerCase(),
);

/**
 * Floor between two fetches of a provider's plan-usage API. Anthropic
 * rate-limits its usage endpoint aggressively, so the app fetches at most this
 * often — and only while a browser is actually asking (the meter polls; no tab
 * open means no fetches at all). 300s matches the Claude CLI's own minimum
 * interval for the same endpoint. Between fetches the display coasts on the
 * cache plus the passive rate-limit telemetry that rides every turn for free.
 */
export const PLAN_USAGE_MIN_FETCH_MS = ms(readEnv("CALANDRIA_PLAN_USAGE_MIN_FETCH_MS"), 300_000);
