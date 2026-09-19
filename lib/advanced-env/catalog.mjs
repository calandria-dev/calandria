/* The Settings -> Advanced environment catalog: declarative metadata for
 * every known Calandria/agent environment variable, plus the pure name and
 * value validators every later task (store, routes, UI, agent tools) shares.
 *
 * Plain .mjs on purpose, like lib/env.mjs: no fs, no database, no SDK, and no
 * process.env reads, so this module can be imported by the client bundle and
 * by plain Node loaders alike (tests/importGraph.test.ts pins the SDK-free
 * set). A descriptor's `defaultDescription` is prose describing what its
 * consuming parser does; it is never a live value read from this process's
 * environment.
 *
 * `source` on every descriptor is a `file:line` citation into the parser this
 * entry's default/behavior was read from, at the revision noted in the
 * Advanced Settings plan's source baseline. Re-verify against current code
 * before trusting a citation on a long-lived branch.
 */

/** @typedef {import("./types.js").EnvScope} EnvScope */
/** @typedef {import("./types.js").CatalogDescriptor} CatalogDescriptor */
/** @typedef {import("./types.js").ValidationResult} ValidationResult */
/** @typedef {import("./types.js").StoredVariable} StoredVariable */
/** @typedef {import("./types.js").PresentedVariable} PresentedVariable */

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_NAMES = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Every editable and provider-owned descriptor. Frozen so a caller can't
 * mutate shared metadata; entries are frozen individually too.
 * @type {readonly CatalogDescriptor[]}
 */
export const CATALOG = Object.freeze(
  [
    // --- App scope: restart required -----------------------------------
    {
      name: "CALANDRIA_PERMISSION_PROMPT_TIMEOUT_MS",
      scope: "app",
      description: "How long a permission card waits for a decision before the turn is denied.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "4 hours (14400000 ms). 0 parks the card indefinitely.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:186",
    },
    {
      name: "CALANDRIA_PERMISSION_UNATTENDED_MS",
      scope: "app",
      description: "How long an unwatched turn waits before its permission gate auto-denies.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "45000 ms. 0 disables the unattended shortcut.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:196",
    },
    {
      name: "CALANDRIA_AGENT_TOOL_TIMEOUT_MS",
      scope: "app",
      description: "Bound on an agent tool call before agentToolGuard rewrites it into a failure.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "600000 ms (10 minutes). 0 disables the guard's own timeout.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:210",
    },
    {
      name: "CALANDRIA_BACKGROUND_LINGER",
      scope: "app",
      description: "Whether a finished turn may linger, held open for background work or a wakeup.",
      inputType: "boolean",
      defaultDescription: "on",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:235",
    },
    {
      name: "CALANDRIA_BACKGROUND_LINGER_MS",
      scope: "app",
      description: "Deadline on a lingering turn before it is force-ended.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "0 (no deadline).",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:253",
    },
    {
      name: "CALANDRIA_TURN_IDLE_MS",
      scope: "app",
      description: "How long a turn may sit idle before it is marked stale.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "1200000 ms (20 minutes). 0 turns the mark off.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:288",
    },
    {
      name: "CALANDRIA_TURN_IDLE_SWEEP_MS",
      scope: "app",
      description: "How often the idle-turn sweep runs.",
      inputType: "duration_ms",
      min: 1000,
      defaultDescription: "60000 ms, clamped to at least 1000 ms and at most the idle mark.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:296",
    },
    {
      name: "CALANDRIA_TURN_IDLE_NUDGE",
      scope: "app",
      description: "Whether the idle sweep sends a nudge message instead of only marking the turn.",
      inputType: "boolean",
      defaultDescription: "off",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:315",
    },
    {
      name: "CALANDRIA_SCHEDULER",
      scope: "app",
      description: "Whether the scheduled-task ticker runs.",
      inputType: "boolean",
      defaultDescription: "on",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:797",
    },
    {
      name: "CALANDRIA_SCHEDULE_TICK_MS",
      scope: "app",
      description: "Scheduler tick interval.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "30000 ms.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:769",
    },
    {
      name: "CALANDRIA_SCHEDULE_CATCHUP_MS",
      scope: "app",
      description: "How far back a missed schedule slot is still fired as a catch-up run.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "14400000 ms (4 hours). 0 disables catch-up.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:779",
    },
    {
      name: "CALANDRIA_SCHEDULE_PROBE_MS",
      scope: "app",
      description: "Bound on the schedule-validation probe run inside each ticker sweep.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "20000 ms.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:789",
    },
    {
      name: "CALANDRIA_RETENTION",
      scope: "app",
      description: "Whether the scheduled retention prune runs.",
      inputType: "boolean",
      defaultDescription: "on",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:816",
    },
    {
      name: "CALANDRIA_RETENTION_DAYS",
      scope: "app",
      description: "Age, in days, after which terminal/idle tasks become prunable.",
      inputType: "integer",
      min: 0,
      defaultDescription: "180 days.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:842",
    },
    {
      name: "CALANDRIA_USAGE_RETENTION_DAYS",
      scope: "app",
      description: "Age, in days, after which usage records are pruned.",
      inputType: "integer",
      min: 0,
      defaultDescription: "400 days.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:852",
    },
    {
      name: "CALANDRIA_RETENTION_SWEEP_MS",
      scope: "app",
      description: "How often the retention prune runs.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "21600000 ms (6 hours).",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:864",
    },
    {
      name: "CALANDRIA_RETENTION_VACUUM",
      scope: "app",
      description: "Whether a retention sweep also runs SQLite VACUUM to reclaim disk.",
      inputType: "boolean",
      defaultDescription: "off",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:876",
    },
    {
      name: "CALANDRIA_WORKTREE_RETENTION",
      scope: "app",
      description: "Whether the scheduled worktree sweep runs.",
      inputType: "boolean",
      defaultDescription: "off",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:897",
    },
    {
      name: "CALANDRIA_WORKTREE_RETENTION_DAYS",
      scope: "app",
      description: "Age, in days, after which a terminal task's worktree is swept.",
      inputType: "integer",
      min: 0,
      defaultDescription: "14 days.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:910",
    },
    {
      name: "CALANDRIA_WORKTREES_DISK_WARN_GB",
      scope: "app",
      description: "Worktree-directory disk usage, in GB, above which a warning is logged and shown.",
      inputType: "integer",
      min: 0,
      defaultDescription: "20 GB. 0 disables the warning.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:923",
    },
    {
      name: "CALANDRIA_GIT_FETCH",
      scope: "app",
      description: "Whether background fetches against a project's remote run at all.",
      inputType: "boolean",
      defaultDescription: "on",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:638",
    },
    {
      name: "CALANDRIA_GIT_FETCH_TIMEOUT_MS",
      scope: "app",
      description: "Hard timeout on a background git fetch.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "10000 ms.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:648",
    },
    {
      name: "CALANDRIA_GIT_FETCH_COOLDOWN_MS",
      scope: "app",
      description: "Minimum interval between background fetches for the same repo.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "15000 ms.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:659",
    },
    {
      name: "CALANDRIA_PR_STALE_MS",
      scope: "app",
      description: "Age after which a cached PR status is treated as stale and re-polled sooner.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "60000 ms.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:679",
    },
    {
      name: "CALANDRIA_PR_POLL_MS",
      scope: "app",
      description: "How often open PRs are polled for merge/close state.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "300000 ms (5 minutes). 0 disables polling.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:690",
    },
    {
      name: "CALANDRIA_PR_POLL_BATCH",
      scope: "app",
      description: "How many open PRs are polled per sweep.",
      inputType: "integer",
      min: 1,
      defaultDescription: "5.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:697",
    },
    {
      name: "CALANDRIA_CI_LOG_TAIL_LINES",
      scope: "app",
      description: "How many trailing CI log lines are fetched for a failed check.",
      inputType: "integer",
      min: 1,
      defaultDescription: "200.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:708",
    },
    {
      name: "CALANDRIA_MAX_UPLOAD_MB",
      scope: "app",
      description: "Maximum size of a single chat/task attachment upload.",
      inputType: "integer",
      min: 1,
      defaultDescription: "25 MB.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:68",
    },
    {
      name: "CALANDRIA_METRICS_SIZE_TTL_MS",
      scope: "app",
      description: "How long a computed metrics size is cached before being recomputed.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "60000 ms. 0 measures on every scrape.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:939",
    },
    {
      name: "CALANDRIA_LOG_FORMAT",
      scope: "app",
      description: "Server log line format.",
      inputType: "enum",
      enumValues: ["text", "json"],
      defaultDescription: "text.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/log.mjs:41",
    },
    {
      name: "CALANDRIA_FEATURE_SERVICES",
      scope: "app",
      description: "Whether the managed services feature is enabled.",
      inputType: "boolean",
      defaultDescription: "on",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/features.ts:32",
    },
    {
      name: "CALANDRIA_SERVICE_LOG_LINES",
      scope: "app",
      description: "Size of a managed service's in-memory log ring buffer.",
      inputType: "integer",
      min: 1,
      defaultDescription: "1500 lines.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:595",
    },
    {
      name: "CALANDRIA_SHUTDOWN_GRACE_MS",
      scope: "app",
      description: "How long graceful shutdown waits for in-flight turns to drain before exiting.",
      inputType: "duration_ms",
      min: 0,
      defaultDescription: "5000 ms.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:332",
    },
    {
      name: "CALANDRIA_UPDATE_CHECK",
      scope: "app",
      description: "Whether the app checks its update feed for a newer release.",
      inputType: "boolean",
      defaultDescription: "on. Set to off to disable.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/updates/check.ts:84",
    },
    {
      name: "CALANDRIA_UPDATE_FEED_URL",
      scope: "app",
      description: "URL polled for release metadata by the update check.",
      inputType: "string",
      defaultDescription: "the calandria-dev/calandria GitHub releases API.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/updates/check.ts:90",
    },
    {
      name: "CALANDRIA_ISSUE_REPO",
      scope: "app",
      description: "GitHub repo the report_issue agent tool files drafts against.",
      inputType: "string",
      defaultDescription: '"calandria-dev/calandria". Set to off to remove the tool.',
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:149",
    },
    {
      name: "CALANDRIA_GH_BIN",
      scope: "app",
      description: "Path to the gh CLI binary.",
      inputType: "string",
      defaultDescription: "empty (auto-resolved from PATH).",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:137",
    },
    {
      name: "CLAUDE_CLI_PATH",
      scope: "app",
      description: "Path to the Claude Code CLI binary.",
      inputType: "string",
      defaultDescription: "platform-dependent default path.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:101",
    },
    {
      name: "CODEX_CLI_PATH",
      scope: "app",
      description: "Path to the Codex CLI binary.",
      inputType: "string",
      defaultDescription: "empty (auto-resolved from PATH).",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:110",
    },
    {
      name: "AGY_CLI_PATH",
      scope: "app",
      description: "Path to the Antigravity (agy) CLI binary.",
      inputType: "string",
      defaultDescription: "empty (auto-resolved from PATH).",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:118",
    },
    {
      name: "CALANDRIA_CLAUDE_TOOL_TRANSPORT",
      scope: "app",
      description: "Whether Claude's Calandria tools run in-process or over the stdio MCP bridge.",
      inputType: "enum",
      enumValues: ["in-process", "stdio"],
      defaultDescription: "in-process.",
      effect: "restart",
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:627",
    },

    // --- Agent scope: next turn -----------------------------------------
    {
      name: "CODEX_TRANSPORT",
      scope: "agent",
      description: "Which Codex transport a turn uses.",
      inputType: "enum",
      enumValues: ["app-server", "exec"],
      defaultDescription: "app-server.",
      effect: "next_turn",
      supportedAgents: ["codex"],
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:369",
    },
    {
      name: "CODEX_APPROVAL_POLICY",
      scope: "agent",
      description: "Codex's approval policy for commands and file changes.",
      inputType: "enum",
      enumValues: ["never", "on-request", "on-failure", "inherit", "untrusted"],
      defaultDescription: '"never". "untrusted" is accepted and mapped to "on-request".',
      effect: "next_turn",
      supportedAgents: ["codex"],
      secretByDefault: false,
      ownership: "editable",
      source: "lib/agents/codex/policy.ts:48",
    },
    {
      name: "CODEX_WRITABLE_ROOTS",
      scope: "agent",
      description: "Extra filesystem roots Codex may write to, using the platform path delimiter.",
      inputType: "path_list",
      defaultDescription: "empty.",
      effect: "next_turn",
      supportedAgents: ["codex"],
      secretByDefault: false,
      ownership: "editable",
      source: "lib/agents/codex/policy.ts:156",
    },
    {
      name: "CODEX_EXTERNAL_SANDBOX",
      scope: "agent",
      description: "Whether Codex trusts an external sandbox instead of its own workspace-write check.",
      inputType: "boolean",
      defaultDescription: "off.",
      effect: "next_turn",
      supportedAgents: ["codex"],
      secretByDefault: false,
      ownership: "editable",
      source: "lib/agents/codex/sandbox.ts:119",
    },
    {
      name: "CODEX_INHERIT_MCP",
      scope: "agent",
      description: "Whether Codex turns inherit the project's configured MCP servers.",
      inputType: "boolean",
      defaultDescription: "on.",
      effect: "next_turn",
      supportedAgents: ["codex"],
      secretByDefault: false,
      ownership: "editable",
      source: "lib/agents/codex/mcp.ts:151",
    },
    {
      name: "CALANDRIA_CODEX_HOOK_TRACE",
      scope: "agent",
      description: "Whether Codex hook events are traced verbosely.",
      inputType: "boolean",
      defaultDescription: "off.",
      effect: "next_turn",
      supportedAgents: ["codex"],
      secretByDefault: false,
      ownership: "editable",
      source: "lib/config.ts:432",
    },
    {
      name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      scope: "agent",
      description:
        "Disables Claude Code's nonessential network traffic. A provider preset (for example, a local/Ollama route) may already set this; an explicit value here is preserved over that preset.",
      inputType: "boolean",
      defaultDescription: "unset (nonessential traffic allowed) unless a provider preset sets it.",
      effect: "next_turn",
      supportedAgents: ["claude"],
      secretByDefault: false,
      ownership: "editable",
      source: "lib/agentEnv.ts:65",
    },

    // --- Provider-owned: editable only in Settings -> Models ------------
    ...providerOwnedDescriptors(),
  ].map(freezeDescriptor),
);

/** @param {CatalogDescriptor} d */
function freezeDescriptor(d) {
  if (d.enumValues) Object.freeze(d.enumValues);
  if (d.supportedAgents) Object.freeze(d.supportedAgents);
  return Object.freeze(d);
}

/** Provider-routed keys the catalog recognizes only to redirect to Settings
 * -> Models; never offered in the editable selector. @returns {CatalogDescriptor[]} */
function providerOwnedDescriptors() {
  const guidance = "Managed by Settings -> Models; not editable here.";
  /** @type {[string, string][]} */
  const agentEnvKeys = [
    ["ANTHROPIC_BASE_URL", "lib/agentEnv.ts:56"],
    ["ANTHROPIC_AUTH_TOKEN", "lib/agentEnv.ts:57"],
    ["ANTHROPIC_MODEL", "lib/agentEnv.ts:58"],
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", "lib/agentEnv.ts:59"],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", "lib/agentEnv.ts:60"],
    ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "lib/agentEnv.ts:61"],
    ["ANTHROPIC_SMALL_FAST_MODEL", "lib/agentEnv.ts:62"],
    ["OPENAI_BASE_URL", "lib/agentEnv.ts:66"],
    ["CODEX_MODEL", "lib/agentEnv.ts:67"],
    ["OLLAMA_HOST", "lib/agentEnv.ts:68"],
    ["CODEX_OSS_BASE_URL", "lib/agentEnv.ts:69"],
    ["GOOGLE_GEMINI_BASE_URL", "lib/agentEnv.ts:70"],
    ["GEMINI_MODEL", "lib/agentEnv.ts:71"],
    ["CALANDRIA_GATEWAY_BILLING", "lib/agentEnv.ts:84"],
  ];
  /** @type {CatalogDescriptor[]} */
  const out = agentEnvKeys.map(([name, source]) => ({
    name,
    scope: "agent",
    description: guidance,
    inputType: "string",
    defaultDescription: guidance,
    effect: "next_turn",
    secretByDefault: true,
    ownership: "providers",
    source,
  }));
  out.push(
    {
      name: "CALANDRIA_LOCAL_MODEL_BASE_URL",
      scope: "app",
      description: guidance,
      inputType: "string",
      defaultDescription: guidance,
      effect: "restart",
      secretByDefault: false,
      ownership: "providers",
      source: "lib/config.ts:442",
    },
    {
      name: "CALANDRIA_LITELLM_BASE_URL",
      scope: "app",
      description: guidance,
      inputType: "string",
      defaultDescription: guidance,
      effect: "restart",
      secretByDefault: false,
      ownership: "providers",
      source: "lib/config.ts:450",
    },
    {
      name: "CALANDRIA_LITELLM_MCP",
      scope: "app",
      description: guidance,
      inputType: "boolean",
      defaultDescription: guidance,
      effect: "restart",
      secretByDefault: false,
      ownership: "providers",
      source: "lib/config.ts:455",
    },
    {
      name: "CALANDRIA_LITELLM_ADMIN_KEY",
      scope: "app",
      description: guidance,
      inputType: "string",
      defaultDescription: guidance,
      effect: "restart",
      secretByDefault: true,
      ownership: "providers",
      source: "lib/config.ts:463",
    },
    {
      name: "CALANDRIA_LITELLM_KEY_TIMEOUT_MS",
      scope: "app",
      description: guidance,
      inputType: "duration_ms",
      defaultDescription: guidance,
      effect: "restart",
      secretByDefault: false,
      ownership: "providers",
      source: "lib/config.ts:471",
    },
    {
      name: "CALANDRIA_LITELLM_KEY",
      scope: "app",
      description: guidance,
      inputType: "string",
      defaultDescription: guidance,
      effect: "restart",
      secretByDefault: true,
      ownership: "providers",
      source: "lib/config.ts:501",
    },
  );
  return out;
}

/** Case-insensitive index over CATALOG, keyed by canonical (upper-cased)
 * name. @type {Map<string, CatalogDescriptor>} */
const CATALOG_BY_NAME = new Map(CATALOG.map((d) => [d.name.toUpperCase(), d]));

/** Names reserved everywhere, regardless of scope: deployment, identity,
 * storage, network, supervisor, and process-loader inputs, plus Calandria
 * variables not yet exposed through this catalog (build/test/desktop-only).
 * Matched case-insensitively after alias normalization. */
const GLOBAL_RESERVED_EXACT = new Set(
  [
    "PORT",
    "NODE_ENV",
    "NODE_OPTIONS",
    "PUBLIC_BASE_URL",
    "SERVICE_TOKEN",
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "LD_PRELOAD",
    "CALANDRIA_ENV_FILE",
    "CALANDRIA_DB_DIR",
    "CALANDRIA_WORKTREES_DIR",
    "CALANDRIA_GEMINI_HOMES_DIR",
    "CALANDRIA_HOSTNAME",
    "CALANDRIA_INTERNAL_BASE_URL",
    "CALANDRIA_ALLOWED_ORIGINS",
    "CALANDRIA_PTY_ALLOW_REMOTE",
    "CALANDRIA_ALLOW_API_KEY_ENV",
    "CALANDRIA_SERVICE_HOSTS",
    "CALANDRIA_SERVICE_PORT_BASE",
    "CALANDRIA_PUBLIC_HOST",
    "CALANDRIA_READY_TIMEOUT_MS",
    // Build/deploy/test-only Calandria variables: real, but not exposed here.
    "CALANDRIA_CONTAINER",
    "CALANDRIA_BUILT_AT",
    "CALANDRIA_GIT_SHA",
    "CALANDRIA_FLEET_TOKEN",
    "CALANDRIA_DB_LOCK",
    "CALANDRIA_DB_LOCK_WAIT_MS",
    "CALANDRIA_BACKUP_DIR",
    "CALANDRIA_PROJECTS_DIR",
    "CALANDRIA_INSTANCE_NAME",
    "CALANDRIA_MODEL_PROBE_MS",
    "CALANDRIA_CLAUDE_MODEL_PROBE",
    "CALANDRIA_CLAUDE_MODEL_PROBE_MS",
    "CALANDRIA_CODEX_PROVIDER_CHECK",
    "CALANDRIA_CODEX_PROVIDER_CHECK_MS",
    "CALANDRIA_PLAN_USAGE",
    "CALANDRIA_PLAN_USAGE_MIN_FETCH_MS",
    "CALANDRIA_DELEGATE_COLLECTION",
    // Desktop-only, read directly by desktop/*.js, never by the server.
    "CALANDRIA_DESKTOP_AUTO_UPDATE",
    "CALANDRIA_INSTANCES_FILE",
    "CALANDRIA_CREDENTIALS_FILE",
    "CALANDRIA_WINDOW_STATE_FILE",
    "CALANDRIA_DESKTOP_PATH_PROBE",
    "CALANDRIA_CPUS",
    "CALANDRIA_MEM",
    "CALANDRIA_IMAGE",
  ].map((n) => n.toUpperCase()),
);

const GLOBAL_RESERVED_PREFIX = ["PTY_", "ELECTRON_", "CF_ACCESS_", "DYLD_", "CALANDRIA_E2E_", "CALANDRIA_TEST_"];

/** Reserved only when the requested scope is "agent": task/turn identity,
 * bridge operation, and the mutation-approval capability itself. */
const AGENT_SCOPE_RESERVED_EXACT = new Set(
  [
    "CALANDRIA_TASK_ID",
    "CALANDRIA_PROJECT_ID",
    "CALANDRIA_BASE_URL",
    "CALANDRIA_LANDING_MODE",
    "CALANDRIA_MCP_ASK_USER",
    "CALANDRIA_ENV_EDIT_CAPABILITY",
  ].map((n) => n.toUpperCase()),
);
const AGENT_SCOPE_RESERVED_PREFIX = ["CALANDRIA_GATEWAY_"];

/** @param {string} name */
function canonicalize(name) {
  const upper = String(name).trim().toUpperCase();
  return upper.startsWith("ORCH_") ? "CALANDRIA_" + upper.slice("ORCH_".length) : upper;
}

/** @param {string} name */
function matchesPrefixList(name, prefixes) {
  return prefixes.some((p) => name.startsWith(p));
}

/** True if `name` (any case, ORCH_ or CALANDRIA_ spelling) is reserved in
 * every scope. @param {string} name */
export function isGloballyReservedName(name) {
  const canonical = canonicalize(name);
  return GLOBAL_RESERVED_EXACT.has(canonical) || matchesPrefixList(canonical, GLOBAL_RESERVED_PREFIX);
}

/** True if `name` is reserved specifically because it's being added under
 * agent scope. @param {string} name */
export function isAgentScopeReservedName(name) {
  const canonical = canonicalize(name);
  return AGENT_SCOPE_RESERVED_EXACT.has(canonical) || matchesPrefixList(canonical, AGENT_SCOPE_RESERVED_PREFIX);
}

/** The catalog descriptor for `name`, matched case-insensitively and after
 * ORCH_ alias normalization, or undefined. @param {string} name
 * @returns {CatalogDescriptor | undefined} */
export function lookupDescriptor(name) {
  return CATALOG_BY_NAME.get(canonicalize(name));
}

/** Only descriptors a custom-variable dialog may offer: editable ownership,
 * optionally filtered to one scope. @param {EnvScope} [scope]
 * @returns {CatalogDescriptor[]} */
export function listEditableDescriptors(scope) {
  return CATALOG.filter((d) => d.ownership === "editable" && (!scope || d.scope === scope));
}

/** Shape-only validation shared by every name, catalog or custom: identifier
 * syntax and the prototype-pollution denylist. Does not check reservation or
 * scope. @param {string} name @returns {ValidationResult} */
export function validateNameShape(name) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    return { ok: false, code: "invalid_name", reason: "Name must match ^[A-Za-z_][A-Za-z0-9_]*$." };
  }
  if (FORBIDDEN_NAMES.has(name.toLowerCase())) {
    return { ok: false, code: "invalid_name", reason: `"${name}" cannot be used as a variable name.` };
  }
  return { ok: true };
}

/**
 * Full name validation for a given scope: shape, then reservation,
 * provider ownership, and (for a catalog name) scope match. A custom name
 * outside every reserved/provider/catalog set is accepted. This is the one
 * gate custom input goes through too, so it cannot bypass reservation by
 * skipping the catalog, and an unclassified CALANDRIA_ or ORCH_ name is
 * rejected rather than silently accepted as custom.
 * @param {string} name @param {EnvScope} scope @returns {ValidationResult}
 */
export function validateNameForScope(name, scope) {
  const shape = validateNameShape(name);
  if (!shape.ok) return shape;

  if (isGloballyReservedName(name)) {
    return { ok: false, code: "reserved_name", reason: `"${name}" is reserved and cannot be edited here.` };
  }
  if (scope === "agent" && isAgentScopeReservedName(name)) {
    return {
      ok: false,
      code: "reserved_name",
      reason: `"${name}" is reserved for task/turn identity and cannot be edited here.`,
    };
  }

  const descriptor = lookupDescriptor(name);
  if (descriptor) {
    if (descriptor.ownership === "providers") {
      return {
        ok: false,
        code: "provider_owned",
        reason: `"${name}" is managed in Settings -> Models, not here.`,
      };
    }
    if (descriptor.ownership === "reserved") {
      return { ok: false, code: "reserved_name", reason: `"${name}" is reserved and cannot be edited here.` };
    }
    if (descriptor.scope !== scope) {
      return {
        ok: false,
        code: "wrong_scope",
        reason: `"${name}" belongs to the ${descriptor.scope} table, not ${scope}.`,
      };
    }
    return { ok: true };
  }

  const canonical = canonicalize(name);
  if (canonical.startsWith("CALANDRIA_") || canonical.startsWith("ORCH_")) {
    return { ok: false, code: "unsupported_name", reason: `"${name}" is not a supported Calandria setting.` };
  }

  return { ok: true };
}

/**
 * Value validation, shared by catalog and custom names alike. Values are
 * kept literal: no shell expansion, no coercion. NUL is the only universally
 * rejected byte; everything else (spaces, quotes, `=`, `$`, backticks,
 * newlines, an empty string) is a valid literal for a custom or string-typed
 * variable.
 * @param {CatalogDescriptor | undefined} descriptor
 * @param {string} value
 * @returns {ValidationResult}
 */
export function validateValue(descriptor, value) {
  if (typeof value !== "string") {
    return { ok: false, code: "invalid_value", reason: "Value must be a string." };
  }
  if (value.includes("\0")) {
    return { ok: false, code: "invalid_value", reason: "Value cannot contain a NUL character." };
  }
  if (!descriptor) return { ok: true };

  switch (descriptor.inputType) {
    case "boolean": {
      const allowed = new Set(["1", "0", "true", "false", "on", "off", "yes", "no"]);
      if (!allowed.has(value.toLowerCase())) {
        return { ok: false, code: "invalid_value", reason: `Value must be one of: ${[...allowed].join(", ")}.` };
      }
      return { ok: true };
    }
    case "enum": {
      const values = descriptor.enumValues || [];
      if (!values.includes(value)) {
        return { ok: false, code: "invalid_value", reason: `Value must be one of: ${values.join(", ")}.` };
      }
      return { ok: true };
    }
    case "integer":
    case "duration_ms": {
      if (!/^-?\d+$/.test(value)) {
        return { ok: false, code: "invalid_value", reason: "Value must be an integer." };
      }
      const n = Number(value);
      if (typeof descriptor.min === "number" && n < descriptor.min) {
        return { ok: false, code: "invalid_value", reason: `Value must be at least ${descriptor.min}.` };
      }
      if (typeof descriptor.max === "number" && n > descriptor.max) {
        return { ok: false, code: "invalid_value", reason: `Value must be at most ${descriptor.max}.` };
      }
      return { ok: true };
    }
    case "path_list":
    case "string":
    default:
      return { ok: true };
  }
}

/** Canonical form used for portable (case-insensitive) duplicate-name
 * checks within a scope. @param {string} name */
export function canonicalizeForUniqueness(name) {
  return String(name).trim().toUpperCase();
}

/**
 * Whether `name` would collide with an existing row in the same scope,
 * portably (case-insensitive), excluding one row id (for a rename that keeps
 * its own name). @param {readonly StoredVariable[]} rows @param {EnvScope} scope
 * @param {string} name @param {string} [excludeId]
 */
export function findDuplicateRow(rows, scope, name, excludeId) {
  const canonical = canonicalizeForUniqueness(name);
  return rows.find((r) => r.scope === scope && r.id !== excludeId && canonicalizeForUniqueness(r.name) === canonical);
}

/**
 * Redact a stored row into its presented shape. A secret row's `name` and
 * `value` are both `null`; `hasValue` is true whenever a value (including an
 * explicit empty string) is stored. `overriddenByHost` is supplied by the
 * caller (only real for app-scope rows, computed against the live host
 * environment elsewhere) since this module never reads process.env.
 * @param {StoredVariable} row
 * @param {{ overriddenByHost?: boolean }} [opts]
 * @returns {PresentedVariable}
 */
export function redactStoredVariable(row, opts) {
  const descriptor = lookupDescriptor(row.name);
  const effect = descriptor ? descriptor.effect : row.scope === "app" ? "restart" : "next_turn";
  const secret = !!row.secret;
  return {
    id: row.id,
    scope: row.scope,
    name: secret ? null : row.name,
    value: secret ? null : row.value,
    secret,
    hasValue: true,
    revision: row.revision,
    effect,
    overriddenByHost: !!(opts && opts.overriddenByHost),
  };
}
