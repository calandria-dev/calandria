import { getSetting, setSetting } from "../store";
import { publish } from "../events";
// SDK-free (fs + env only), the same file capabilities.ts reads the catalog
// corrections from; see the note in claude/provider.ts.
import { configuredProvider, type ClaudeProvider } from "./claude/provider";
// capabilities.ts, not registry.ts: this module only enumerates and validates
// agent ids, it never drives an agent, and importing the registry would drag
// both agent SDKs into every consumer's graph (the async-external poisoning
// documented in capabilities.ts). Staying SDK-free is what lets
// lib/agentTools.ts resolve a connected agent without poisoning the internal
// agent-tools routes. Pinned by tests/importGraph.test.ts.
import { listAgentIds, isAgentId, DEFAULT_AGENT } from "./capabilities";

// Per-agent connection state, persisted in the settings table keyed by agent id
// (`agent_conn_<id>`). Distinct from lib/onboarding.ts, which tracks the single
// required first-run Claude connection for the wizard's funnel; this is the
// generic "which agents are connected" record that the task-creation UI reads to
// gray out agents that aren't wired up yet (with a connect CTA), and that the
// generalized /api/agents/[id]/* routes write on a successful login / verify /
// api-key save.
//
// Stored as "method|email|plan|provider" (same compact encoding as
// onboarding_account), where method is "subscription" | "api_key" and provider
// is the backend the verify ran against. An absent key means not connected.
//
// The provider field keeps the record honest across a config change. A verify
// proves that a login works against one backend: an OAuth session proves
// nothing about Vertex, and Vertex ADC proves nothing about Bedrock. Claude
// Code picks its backend from ~/.claude/settings.json and the env, which the
// user can flip under a running instance, so a record verified against one
// provider must not keep reading "connected" once the CLI routes elsewhere;
// every turn would fail against a login that no longer applies, with nothing in
// the UI saying why. A record whose provider doesn't match the CLI's current
// one is therefore read as not connected, cleared, and flagged the way a dead
// login is, so the titlebar banner explains it and Reconnect writes a record
// against the new provider. Rows written before the field existed carry no
// provider and are read as "anthropic", the only backend that path ever
// verified, so an instance that has been on Anthropic all along never notices.

export type AgentConnMethod = "subscription" | "api_key";

/** The backend a connection was verified against. Claude reports one of its
 *  `ClaudeProvider`s; an agent with no provider concept (Codex) stores null,
 *  and null never mismatches. */
export type AgentConnProvider = ClaudeProvider | null;

export interface AgentConnection {
  method: AgentConnMethod;
  email: string | null;
  plan: string | null;
  provider: AgentConnProvider;
}

const key = (agentId: string) => `agent_conn_${agentId}`;

// The agent whose backend the CLI config selects. DEFAULT_AGENT happens to be
// the same id, but that names the app's default, a separate fact from which
// agent has providers.
const CLAUDE_AGENT = "claude";

const PROVIDERS: readonly ClaudeProvider[] = ["anthropic", "vertex", "bedrock"];

/** The provider a connection for this agent would be verified against right
 *  now, or null for an agent whose connection isn't provider-specific. */
export function currentConnectionProvider(agentId: string, env: NodeJS.ProcessEnv = process.env): AgentConnProvider {
  return agentId === CLAUDE_AGENT ? configuredProvider(env) : null;
}

/** Parse the stored provider field. Absent on rows written before the field
 *  existed: those were verified on the plain Anthropic path, so a Claude row
 *  reads "anthropic"; any other agent reads null. */
function parseProvider(agentId: string, raw: string | undefined): AgentConnProvider {
  if (raw && (PROVIDERS as readonly string[]).includes(raw)) return raw as ClaudeProvider;
  return agentId === CLAUDE_AGENT ? "anthropic" : null;
}

export function getAgentConnection(agentId: string): AgentConnection | null {
  const raw = getSetting(key(agentId));
  const conn = raw ? parseConnection(agentId, raw) : agentId === DEFAULT_AGENT ? legacyClaudeConnection() : null;
  if (!conn) return null;
  const current = currentConnectionProvider(agentId);
  if (current === null || conn.provider === current) return conn;
  invalidateForProvider(agentId, conn.provider, current);
  return null;
}

function parseConnection(agentId: string, raw: string): AgentConnection | null {
  const [method, email, plan, provider] = raw.split("|");
  if (method !== "subscription" && method !== "api_key") return null;
  return { method, email: email || null, plan: plan || null, provider: parseProvider(agentId, provider) };
}

const PROVIDER_LABEL: Record<ClaudeProvider, string> = {
  anthropic: "Anthropic",
  vertex: "Vertex AI",
  bedrock: "Amazon Bedrock",
};

/**
 * The record was verified against one backend and the CLI now routes through
 * another. Drop the record, since it proves nothing about the new backend, and
 * raise the same instance-wide flag a dead login raises, so the banner shows in
 * every tab and the connect card leads with the reason. Not
 * `clearAgentConnection()`, which clears the flag: that call is for the user
 * disconnecting on purpose, and this is the opposite. Idempotent: the flag
 * records the first sighting only and the event is published once per outage,
 * so a legacy onboarding-only record (nothing to delete) re-read on every
 * `/api/agents` doesn't re-announce.
 */
function invalidateForProvider(agentId: string, stored: AgentConnProvider, current: ClaudeProvider): void {
  setSetting(key(agentId), null);
  const was = stored ? PROVIDER_LABEL[stored] : "another backend";
  const reason =
    `This connection was verified against ${was}, but Claude Code is now configured for ` +
    `${PROVIDER_LABEL[current]}. Reconnect to verify the ${PROVIDER_LABEL[current]} login.`;
  if (markAgentAuthBroken(agentId, reason, Date.now())) {
    // Same event the runner publishes on a dead login (lib/runner.ts). No task
    // detected this one, so the bus key is empty; /api/events relays it
    // verbatim without re-reading a row, exactly as it does for the runner's.
    publish("", { type: "agent_auth", agent: agentId, broken: true, reason });
  }
}

// Instances from before this seam existed recorded their first-run Claude
// connection only in the onboarding keys (agent_conn_claude didn't exist yet,
// and is only re-written on the next login/verify). Treat that record as a live
// Claude connection so connected-first resolution and the /api/agents
// `connected` flag never regress a legacy instance that has been running
// Claude turns all along.
function legacyClaudeConnection(): AgentConnection | null {
  const method = getSetting("onboarding_method");
  if (method !== "subscription" && method !== "api_key") return null;
  const acct = getSetting("onboarding_account");
  const [email, plan] = acct ? acct.split("|") : [null, null];
  // Verifies from before this seam existed only ever ran the plain Anthropic path.
  return { method, email: email || null, plan: plan || null, provider: "anthropic" };
}

/** Whether this agent has a working connection on record (login/verify/api-key). */
export function isAgentConnected(agentId: string): boolean {
  return getAgentConnection(agentId) !== null;
}

/** The first connected agent in registry order, or null when none is connected. */
export function firstConnectedAgent(): string | null {
  for (const id of listAgentIds()) if (isAgentConnected(id)) return id;
  return null;
}

/**
 * Resolve the first connected agent from an ordered preference list (unknown
 * ids and unconnected agents are skipped), falling back to any connected agent
 * at all. Returns null only when no agent is connected; callers turn that into
 * an actionable "connect an agent" error instead of driving a dead CLI.
 */
export function resolveConnectedAgent(preferred: (string | null | undefined)[]): string | null {
  for (const id of preferred) {
    if (id && isAgentId(id) && isAgentConnected(id)) return id;
  }
  return firstConnectedAgent();
}

/**
 * Record a working connection. The provider is stamped here from the CLI's
 * current config, not taken from the caller, because every caller is a login /
 * verify / api-key route that just proved the login against whatever backend
 * the CLI is configured for right now, and that is the fact worth keeping.
 */
export function setAgentConnection(agentId: string, conn: Omit<AgentConnection, "provider">): void {
  const provider = currentConnectionProvider(agentId) ?? "";
  setSetting(key(agentId), `${conn.method}|${conn.email ?? ""}|${conn.plan ?? ""}|${provider}`);
  // A fresh login / verify / api-key save is the repair; never leave a stale
  // "reconnect me" banner up after the user just did.
  clearAgentAuthBroken(agentId);
}

export function clearAgentConnection(agentId: string): void {
  setSetting(key(agentId), null);
  // Disconnected on purpose: the agent now reads as "not connected", which the
  // UI already explains, so a broken-connection banner on top would be noise.
  clearAgentAuthBroken(agentId);
}

// ---------- broken-connection flag (credentials died after connecting) ----------
// `agent_conn_<id>` says "this agent was wired up"; it can't say "and it just
// stopped working". An expired OAuth session leaves the connection record
// intact while every turn fails, so the runner records the failure here
// (lib/runner.ts, classified by lib/authFailure.ts) and the app surfaces it
// instance-wide instead of only inside the task that happened to run first.
// Stored as "<epoch ms>|<reason>"; reason may itself contain "|", so only the
// first separator is split on. Cleared by any successful turn or reconnect.

export interface AgentAuthBroken {
  /** When the failure was first seen (epoch ms). */
  at: number;
  /** The provider's own error text, so the UI can show what actually broke. */
  reason: string;
}

const brokenKey = (agentId: string) => `agent_auth_broken_${agentId}`;

export function getAgentAuthBroken(agentId: string): AgentAuthBroken | null {
  const raw = getSetting(brokenKey(agentId));
  if (!raw) return null;
  const sep = raw.indexOf("|");
  const at = Number(sep === -1 ? raw : raw.slice(0, sep));
  return { at: Number.isFinite(at) ? at : 0, reason: sep === -1 ? "" : raw.slice(sep + 1) };
}

/**
 * Record that this agent's credentials are dead. Returns true only the first
 * time (the flag was previously clear), so callers can publish or announce once
 * per outage instead of on every failing turn. The `at` timestamp is preserved
 * across repeats so the banner can say how long it's been broken.
 */
export function markAgentAuthBroken(agentId: string, reason: string, at: number): boolean {
  const prev = getAgentAuthBroken(agentId);
  setSetting(brokenKey(agentId), `${prev?.at ?? at}|${reason}`);
  return !prev;
}

/** Clear the flag. Returns true if it was actually set (i.e. this healed it). */
export function clearAgentAuthBroken(agentId: string): boolean {
  if (!getSetting(brokenKey(agentId))) return false;
  setSetting(brokenKey(agentId), null);
  return true;
}
