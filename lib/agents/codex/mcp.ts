// Which MCP servers a Codex run mounts.
//
// The Claude driver inherits the user's own MCP servers (settingSources in
// lib/agents/claude/driver.ts). Codex inherits them too, and by a different
// mechanism: the @openai/codex-sdk `config` object is flattened into LEAF-level
// `--config mcp_servers.calandria.command="…"` overrides, and the codex CLI
// merges those into ~/.codex/config.toml rather than replacing the table. So the
// user's servers arrive whether we ask for them or not, and Calandria mounts
// them by default (CODEX_INHERIT_MCP in lib/config.ts).
//
// An earlier version of this driver unmounted every inherited server by
// default, on the belief that `codex exec` had no approver and so every MCP
// tool call came back as `user cancelled MCP tool call` (observed once on
// codex-cli 0.146.0 with a probe server). That belief was wrong as a default:
// Codex tasks do call inherited tools. The disable path is kept as an OPT-OUT
// (CODEX_INHERIT_MCP=0) for a user whose servers should stay off the task, and
// "Agent MCP inheritance" in lib/agents/CLAUDE.md is the product-level
// statement.
//
// A disable override is not just `enabled = false`. Codex validates every
// mcp_servers entry BEFORE merging plugin-provided definitions, and an entry
// with no transport fails that validation, which took the whole startup down
// for anyone with a plugin server (cua_repl was the reported one). So each
// override carries an inert transport of the same KIND as the server it
// replaces: a command that resolves nowhere for stdio, a `.invalid` URL for
// HTTP. Only the server's name and transport type are read from `codex mcp
// list --json`; its real command, args, env, URL, headers and bearer-token
// variable are never copied into an override.
//
// The binary itself is resolved by ./bin.ts rather than spawned as a bare
// "codex": that name resolves nowhere on native Windows, where npm installs a
// `codex.cmd` shim, and the best-effort contract below would have turned that
// into a permanent silent regression.
//
// SDK-free on purpose (child_process + config only) so it can be unit-tested
// without @openai/codex-sdk.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CODEX_INHERIT_MCP } from "../../config";
import { codexSpawn } from "./bin";

const run = promisify(execFile);

// The name our own bridge is mounted under. Never disabled, and never treated
// as an inherited server even if the user happens to have one by that name —
// our leaf overrides would land on top of theirs either way.
export const CALANDRIA_SERVER = "calandria";

// The inert transports a disabled override carries. Neither resolves: the
// command is a name no PATH has, and `.invalid` is the RFC 2606 reserved TLD.
// Codex never spawns or connects to a disabled server, so they only ever have
// to pass its config validation.
export const DISABLED_STDIO_COMMAND = "calandria-disabled-mcp-server";
export const DISABLED_HTTP_URL = "https://mcp-disabled.invalid";

// One segment of a `--config` dotted path is a TOML bare key. The SDK builds
// those paths by string concatenation with no quoting, so a server named
// `foo.bar` or `foo bar` would address the wrong table (or fail to parse).
// Rather than emit a broken override we skip such a name — it stays mounted,
// which is exactly the pre-existing behavior, and is vanishingly rare.
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** The transport kinds `codex mcp list --json` reports. */
export type McpTransportType = "stdio" | "streamable_http";

/**
 * What this module keeps from a `codex mcp list --json` entry: the name and
 * the transport KIND, nothing else. The command, args, env, cwd, URL, headers
 * and bearer-token variable the CLI also prints are dropped at parse time so
 * they can never reach an override.
 */
export interface UserMcpServer {
  name: string;
  transport: McpTransportType;
}

/** The override that unmounts one inherited server, shaped for its transport. */
export type DisabledMcpServer =
  | { enabled: false; command: string }
  | { enabled: false; url: string };

/**
 * The MCP servers codex would mount from the user's own configuration, by name
 * and transport type. Read through the CLI (`codex mcp list --json`) rather
 * than by parsing ~/.codex/config.toml ourselves: the CLI is the authority on
 * what's actually enabled and where it came from (config.toml, plugins,
 * marketplaces), and the repo has no TOML parser. ~30ms, next to a turn that
 * runs for minutes.
 *
 * Best-effort by contract: any failure (CLI missing, malformed JSON, timeout)
 * degrades to an empty list, which leaves the user's servers mounted — the
 * default, never a failed turn.
 */
export async function listUserMcpServers(): Promise<UserMcpServer[]> {
  try {
    const list = codexSpawn(["mcp", "list", "--json"]);
    const { stdout } = await run(list.command, list.args, {
      timeout: 15_000,
      env: process.env,
      windowsVerbatimArguments: list.windowsVerbatimArguments,
    });
    return parseMcpList(stdout);
  } catch (e) {
    // ENOENT here just means codex isn't installed, which the auth surface
    // already reports far more usefully; anything else is worth a line.
    if ((e as { code?: string }).code !== "ENOENT") {
      console.warn(`[codex] could not enumerate MCP servers, leaving the user's mounted: ${(e as Error).message}`);
    }
    return [];
  }
}

/**
 * Parse `codex mcp list --json` output down to name + transport type. A
 * missing or unrecognized transport type is treated as stdio, the CLI's own
 * default when a config.toml entry names a `command`. Exported for tests.
 */
export function parseMcpList(json: string): UserMcpServer[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: UserMcpServer[] = [];
  for (const entry of parsed) {
    const name = (entry as { name?: unknown })?.name;
    if (typeof name !== "string" || name === CALANDRIA_SERVER) continue;
    const type = (entry as { transport?: { type?: unknown } })?.transport?.type;
    out.push({ name, transport: type === "streamable_http" ? "streamable_http" : "stdio" });
  }
  return out;
}

/**
 * `mcp_servers.<name>` = `{ enabled: false, <inert transport> }` for every
 * server we're unmounting, ready to be spread alongside the calandria entry.
 * Pure: the CODEX_INHERIT_MCP decision is `inheritedServerOverrides`'s.
 */
export function disableInheritedServers(servers: UserMcpServer[]): Record<string, DisabledMcpServer> {
  const out: Record<string, DisabledMcpServer> = {};
  for (const { name, transport } of servers) {
    if (name === CALANDRIA_SERVER || !BARE_KEY.test(name)) continue;
    out[name] =
      transport === "streamable_http"
        ? { enabled: false, url: DISABLED_HTTP_URL }
        : { enabled: false, command: DISABLED_STDIO_COMMAND };
  }
  return out;
}

/**
 * The two steps together: enumerate, then build the disable overrides. Empty,
 * without spawning anything, under the default (CODEX_INHERIT_MCP on): the
 * user's servers stay mounted and there is nothing to override.
 */
export async function inheritedServerOverrides(): Promise<Record<string, DisabledMcpServer>> {
  if (CODEX_INHERIT_MCP) return {};
  return disableInheritedServers(await listUserMcpServers());
}
