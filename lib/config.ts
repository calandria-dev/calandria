import path from "node:path";
import os from "node:os";
import { readEnv } from "./env.mjs";
import { resolveLogFormat } from "./log.mjs";
import { findInDirs, findOnPath } from "./binPath";
import { resolveDbLocation, resolveWorktreesDir } from "./storage.mjs";
import { DEFAULT_MAX_UPLOAD_MB } from "./uploadTypes";

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
 * Largest single chat attachment, in megabytes (default 25).
 *
 * The cap is about DISK and the request buffer, not the context window: an
 * attachment is staged under `<DB_DIR>/uploads/<task>/` and only its path is
 * put in the message, so its bytes never reach the model unless the agent
 * chooses to open it (lib/uploads.ts). What 25 MB buys is a log bundle, a
 * design PDF or a small archive; what it stops is the multipart body being
 * buffered whole in the server's heap, which is why the route also rejects on
 * Content-Length before parsing. Raise it if your instance has the memory.
 *
 * Injected to the client as `window.__MAX_UPLOAD_MB` (app/layout.tsx) so the
 * composer can refuse an oversized drop without uploading it first; the server
 * check is the authority either way.
 */
export const MAX_UPLOAD_MB = Math.max(1, Number(readEnv("CALANDRIA_MAX_UPLOAD_MB")) || DEFAULT_MAX_UPLOAD_MB);

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
 * Whether a task session is told to push bulk context-collection into
 * subagents (buildProjectContext in lib/agents/shared.ts, and only for agents
 * whose capability descriptor says they have subagents at all).
 *
 * On by default, and it is a directive rather than a suggestion because it is
 * countermanding one: measured across 198 task sessions, 79% of a first turn's
 * tool calls are Bash and only ~12% of those are decisions, because the CLI's
 * own auto-mode guidance asks for work to go through Bash and says not to call
 * the Agent tool unless the user requested it. The same rule in a CLAUDE.md
 * file was measured firing late or not at all — a dispatch after a median of
 * two read-only commands, and once in nine runs as the turn's opening move;
 * appended to the prompt it opens with one five times in nine and reads a
 * median of nothing first (docs/DELEGATION.md). Set to off/0/false to leave
 * every session on the CLI's defaults — the escape hatch for an instance whose
 * plan makes subagent turns expensive, or whose work is small enough that the
 * dispatch overhead is the whole cost.
 */
export const DELEGATE_COLLECTION = !["0", "off", "false", "no"].includes(
  String(readEnv("CALANDRIA_DELEGATE_COLLECTION") || "").toLowerCase(),
);

/**
 * How long a LIVE turn may go without producing anything — no assistant text,
 * no tool call, no event — before the UI marks it as idle. Not a deadline:
 * nothing is stopped, nothing is killed, and the turn keeps its slot. The mark
 * exists because a wedged wait and a working turn are drawn identically today,
 * and with no linger deadline (BACKGROUND_LINGER_MS = 0, the default) a wait on
 * something that already finished holds the session open forever with nothing
 * to show for it.
 *
 * 20 minutes is above every ordinary gap — the longest single tool call in this
 * repo's own suite is well under it — and below the half hour it took to notice
 * the wedge this was written for. A long build tripping it is fine and expected:
 * the card reports the age and the human judges it, exactly as the schedules
 * card ages `lastTickAt` into "looks stuck". Set 0 to switch the mark off.
 */
export const TURN_IDLE_MS = ms(readEnv("CALANDRIA_TURN_IDLE_MS"), 20 * 60 * 1000);

/**
 * How often the idle sweep re-checks the live turns. Only runs while at least
 * one turn is live, and only ever publishes on the transition into idle, so
 * this is a cheap clock rather than a poll. Clamped below the idle window so a
 * short CALANDRIA_TURN_IDLE_MS (the suite sets one) is still detected promptly.
 */
export const TURN_IDLE_SWEEP_MS = Math.max(
  1000,
  Math.min(ms(readEnv("CALANDRIA_TURN_IDLE_SWEEP_MS"), 60_000), Math.max(1000, TURN_IDLE_MS || 60_000)),
);

/**
 * Whether the idle mark is also told to the MODEL. Off by default, and the only
 * knob here that spends tokens: when a turn is marked idle (above), the session
 * is sent a one-line message asking it to re-check whether what it is waiting on
 * is still worth waiting for, which starts a real turn and bills for it.
 *
 * Safe to switch on, but not free. It can only ever reach a LINGERING session —
 * the driver refuses a message mid-thought, so a long build or a slow tool call
 * is unreachable by construction — it lands at most once per turn, and it never
 * fires on a scheduled run, where nobody would read the outcome. See
 * lib/idleNudge.ts for the whole argument. Leave it off on an instance running a
 * fleet of long-lived tasks whose waits are legitimate; turn it on where a
 * wedged wait costs more than the turn that would end it.
 */
export const TURN_IDLE_NUDGE_ENABLED = ["1", "on", "true", "yes"].includes(
  String(readEnv("CALANDRIA_TURN_IDLE_NUDGE") || "").toLowerCase(),
);

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
 * MCP servers) — see "Agent MCP inheritance is asymmetric" in lib/agents/CLAUDE.md.
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
 * The endpoint the "Local model" preset in a project's settings points at, and
 * what `suggest_task`'s `provider: "local"` uses — an Ollama or LM Studio
 * server, or anything that speaks both the Anthropic Messages and the OpenAI
 * Responses API (lib/agentEnv.ts, docs/AGENTS.md "Local models"). One knob so
 * a Docker instance can say `http://host.docker.internal:11434` once instead
 * of in every project. Only the DEFAULT is instance-wide: the preset writes
 * the resolved URL into the project's override, where it can be edited per
 * project. A trailing `/v1` is tolerated and stripped.
 */
export const LOCAL_MODEL_BASE_URL =
  String(readEnv("CALANDRIA_LOCAL_MODEL_BASE_URL") || "http://localhost:11434").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");

/**
 * How long Calandria will wait for a local model server to say which models it
 * has (lib/modelEndpoint.ts) before calling it unreachable. Short on purpose:
 * this probe runs inside GET /api/agents, which every tab loads, and the answer
 * is a picker's suggestion list — a slow one must not hold up the app. A server
 * on this machine answers in single-digit milliseconds; the budget only matters
 * for a host that black-holes the connection instead of refusing it.
 */
export const MODEL_PROBE_MS = ms(readEnv("CALANDRIA_MODEL_PROBE_MS"), 2500);

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

/*
 * PR state (lib/prState.ts). The same shape as the fetch cooldown above and for
 * the same reason: every trigger is cheap only because a recent answer is
 * reused rather than re-fetched. `gh pr view` is a network round trip per call,
 * so the cost of "keep the chip live" has to be bounded by open PRs and by a
 * clock, never by how often a client asks.
 */

/**
 * How long a PR snapshot counts as fresh. Opening a task, its Refresh button
 * and the create-PR trigger all skip gh entirely inside this window, so
 * clicking through five tasks with PRs costs at most five fetches however many
 * times the panels remount.
 */
export const PR_STALE_MS = ms(readEnv("CALANDRIA_PR_STALE_MS"), 60_000);

/**
 * How often the background sweep re-reads OPEN PRs (0 disables it, leaving the
 * on-open and explicit-Refresh triggers). This is the "is CI green yet" clock:
 * long enough not to be a polling storm, short enough that a red build shows up
 * while you're still looking at the task. The ticker stops itself when no task
 * has an open PR, and skips a pass entirely when no browser tab is watching —
 * nobody can see a chip nothing is rendering, and an idle instance shouldn't
 * spawn gh forever.
 */
export const PR_POLL_MS = ms(readEnv("CALANDRIA_PR_POLL_MS"), 5 * 60_000);

/**
 * Most PRs refreshed per sweep. One `gh pr view` per task is a subprocess and a
 * network call, so a board with forty open PRs spreads them over several passes
 * (oldest sync first) instead of forking forty processes at once.
 */
export const PR_POLL_BATCH = num("CALANDRIA_PR_POLL_BATCH", readEnv("CALANDRIA_PR_POLL_BATCH"), 5);

/**
 * How many lines of a failed job's log the "Fix CI" button seeds its turn with.
 * `gh run view --log-failed` already drops the green steps, but a failing test
 * suite still prints thousands of lines and only the END of them says what
 * broke — so this is a TAIL, and it is a knob because the right depth is a
 * property of the repo's CI, not of the app: a linter needs ten lines, a
 * matrix build's stack trace needs a few hundred. Every failing check
 * contributes its own tail, so the prompt grows with the number of red jobs.
 */
export const CI_LOG_TAIL_LINES = num("CALANDRIA_CI_LOG_TAIL_LINES", readEnv("CALANDRIA_CI_LOG_TAIL_LINES"), 200);

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

/*
 * ---- retention (lib/retention.ts) ----
 *
 * Everything except `schedule_runs` used to grow forever — rows only ever left
 * by FK cascade behind a manual delete (issue #15). The sweep rides the
 * schedule ticker; these are its knobs.
 *
 * Windows are in DAYS because that is the unit this policy is thought about in
 * ("keep six months"), unlike every other duration here, which is a deadline.
 */

/**
 * Master switch. On by default: an off-by-default retention policy leaves every
 * instance exactly where the issue found it. Set to off/0/false/no to keep
 * everything forever — the pre-retention behavior, and the right choice for an
 * instance whose transcripts are a record somebody audits.
 */
export const RETENTION_ENABLED = !["0", "off", "false", "no"].includes(
  String(readEnv("CALANDRIA_RETENTION") || "").toLowerCase(),
);

const gib = (name: string, raw: string | undefined, def: number): number => {
  const n = num(name, raw, def);
  // Negative is meaningless (a threshold nothing can be under); 0 is the
  // documented "off", so only negatives fall back to the default.
  return (n >= 0 ? n : def) * 1024 ** 3;
};

const days = (name: string, raw: string | undefined, def: number): number => {
  const n = num(name, raw, def);
  // A negative window would delete rows from the future. 0 is meaningful — it
  // turns that half of the sweep off — so only negatives fall back.
  return n >= 0 ? n * 24 * 60 * 60 * 1000 : def * 24 * 60 * 60 * 1000;
};

/**
 * How long a FINISHED task keeps its own record: transcript, review comments,
 * the sessions a `/clear` retired, and its uploaded attachments. Six months, so
 * that "what did that task do?" is still answerable for anything within a
 * release cycle or two. 0 keeps them forever.
 *
 * Only terminal, idle, cold tasks are ever touched — see prunableTaskIds().
 */
export const RETENTION_MS = days("CALANDRIA_RETENTION_DAYS", readEnv("CALANDRIA_RETENTION_DAYS"), 180);

/**
 * How long the SPEND rows live: task_usage, task_merges, internal_usage. A
 * separate and deliberately longer window, because these are not a task's
 * record but the Insights dashboard's — /api/insights reads 180 days back and
 * asks for the same width again to compute prior-period deltas, so anything
 * under ~360 days would let a sweep carve a hole in a chart on screen. 400 days
 * clears that with a margin; 0 keeps them forever.
 */
export const USAGE_RETENTION_MS = days(
  "CALANDRIA_USAGE_RETENTION_DAYS",
  readEnv("CALANDRIA_USAGE_RETENTION_DAYS"),
  400,
);

/**
 * How often the sweep runs. Not the ticker's interval — the ticker wakes every
 * 30s to adjudicate firings, and re-scanning every task for retention that often
 * would be pure waste on a policy measured in months. Six hours means an
 * instance that is only up for part of the day still sweeps.
 */
export const RETENTION_SWEEP_MS = ms(readEnv("CALANDRIA_RETENTION_SWEEP_MS"), 6 * 60 * 60 * 1000);

/**
 * Run a full VACUUM after a sweep that deleted something. Off by default.
 *
 * The sweep always checkpoints the WAL (TRUNCATE), which is what actually
 * reclaims the file that grows during a big delete. It cannot shrink
 * `calandria.db` itself — freed pages go on the freelist and are reused by
 * later writes — and only VACUUM does, by rewriting the whole database under a
 * write lock. That is a fine trade on a small database and a stall on a large
 * one, so it is opted into rather than assumed.
 */
export const RETENTION_VACUUM = ["1", "on", "true", "yes"].includes(
  String(readEnv("CALANDRIA_RETENTION_VACUUM") || "").toLowerCase(),
);

/*
 * ---- worktree retention + disk warning (lib/worktreeSweep.ts) ----
 *
 * The other half of issue #15: per-task worktrees are a full checkout of the
 * project repo EACH, so they are the biggest disk-growth vector in the product
 * and the only one measured in gigabytes rather than rows.
 */

/**
 * Opt-in, unlike the table prune above, and that asymmetry is deliberate. The
 * table windows (180/400 days) are longer than most instances have existed, so
 * defaulting them ON changes nothing on an upgrade; a worktree window measured
 * in WEEKS would start removing checkouts on the first tick after an upgrade
 * nobody asked for. Set to 1/on/true/yes to sweep automatically — the manual
 * path (Settings -> Storage) is unaffected either way.
 */
export const WORKTREE_SWEEP_ENABLED = ["1", "on", "true", "yes"].includes(
  String(readEnv("CALANDRIA_WORKTREE_RETENTION") || "").toLowerCase(),
);

/**
 * How long a FINISHED task keeps its git worktree once the sweep is on. Weeks,
 * not months: the checkout is regenerable (`ensureWorktree` re-cuts it from the
 * task's branch on the next turn) and its branch is never deleted here, so what
 * ages out is disk, not history. Only terminal, idle, cold tasks are ever
 * touched — the sweep reuses prunableTaskIds() rather than owning a predicate —
 * and a checkout with uncommitted edits or unmerged commits is always skipped,
 * however old. 0 keeps them forever.
 */
export const WORKTREE_RETENTION_MS = days(
  "CALANDRIA_WORKTREE_RETENTION_DAYS",
  readEnv("CALANDRIA_WORKTREE_RETENTION_DAYS"),
  14,
);

/**
 * Warn in the server log when WORKTREES_DIR crosses this size. Independent of
 * the switch above on purpose: the instance that has NOT opted into automatic
 * reclaim is exactly the one that needs telling, since the only remedy there is
 * a human opening Settings -> Storage. In gigabytes; 0 disables the check (and
 * with the sweep off too, the ticker no longer has to start at all).
 */
export const WORKTREES_DISK_WARN_BYTES = gib(
  "CALANDRIA_WORKTREES_DISK_WARN_GB",
  readEnv("CALANDRIA_WORKTREES_DISK_WARN_GB"),
  20,
);

/**
 * How long /api/instance/metrics reuses one measurement of the worktrees
 * directory (lib/metrics.ts). Everything else on that endpoint is a counter, a
 * Map size or three `stat` calls; this one is a `du` over every task checkout on
 * the box, and a scraper set to 15s would otherwise walk every `node_modules`
 * on the instance four times a minute for a number that moves in megabytes per
 * hour. A minute is short enough that a disk alert still fires promptly; raise
 * it on an instance carrying many large worktrees. 0 measures on every scrape.
 */
export const METRICS_SIZE_TTL_MS = ms(readEnv("CALANDRIA_METRICS_SIZE_TTL_MS"), 60_000);

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

/**
 * How every log line is rendered: `text` (default — the `[component] message
 * key=value` form this app has always printed) or `json` (one JSON object per
 * line, with `ts`/`level`/`component`/`msg` plus the line's own fields) for an
 * instance whose output is being shipped somewhere that parses it.
 *
 * Re-exported here for discoverability alongside every other knob, but the
 * emitters do NOT read this constant: lib/log.mjs resolves the value per line,
 * because server.js and pty-server.js emit through the same module and can't
 * import this file at all. Both ends call the same resolver, so they cannot
 * disagree.
 */
export const LOG_FORMAT = resolveLogFormat();
