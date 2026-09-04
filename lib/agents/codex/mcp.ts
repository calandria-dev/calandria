// Which MCP servers a Codex run mounts: a documented difference from the
// Claude driver.
//
// The Claude driver inherits the user's own MCP servers (settingSources in
// lib/agents/claude/driver.ts), and bypassPermissions auto-approves their tools,
// so a Claude task can genuinely use them. Codex cannot do the same, and the
// reason is the CLI, not a config gap:
//
//   * The @openai/codex-sdk `config` object is flattened into leaf-level
//     `--config mcp_servers.calandria.command="…"` overrides, and the codex
//     CLI merges those into ~/.codex/config.toml rather than replacing the
//     table. So the user's servers are already inherited today, with no code
//     asking for it.
//   * But codex gates every MCP tool call behind its own approval decision, and
//     `codex exec` (what the SDK spawns) has nobody to ask. A server that hasn't
//     set `default_tools_approval_mode = "approve"` therefore has tools the
//     model can see and can never call: each attempt returns
//     `error: "user cancelled MCP tool call"` immediately.
//
// Verified live with a probe MCP server: the tool is offered, the call is
// cancelled, and `mcp_servers.<name>.enabled = false` unmounts it entirely
// (the process isn't even spawned and the model doesn't see the tool).
// Visible-but-dead tools cost context and turns and teach the model nothing,
// so the driver disables them by default and says so; see CODEX_INHERIT_MCP
// in lib/config.ts for the escape hatch, and "Agent MCP inheritance is
// asymmetric" in lib/agents/CLAUDE.md for the product-level statement.
//
// The binary itself is resolved by ./bin.ts rather than spawned as a bare
// "codex": that name resolves nowhere on native Windows, where npm installs a
// `codex.cmd` shim, and the best-effort contract below would otherwise be a
// permanent silent regression, with every turn paying for uncallable
// inherited tools and nothing logged.
//
// SDK-free on purpose (child_process + config only) so it can be unit-tested
// without @openai/codex-sdk.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CODEX_INHERIT_MCP } from "../../config";
import { codexSpawn } from "./bin";

const run = promisify(execFile);

// The name the bridge is mounted under. Never disabled, and never treated as
// an inherited server even if the user happens to have one by that name: the
// leaf overrides land on top of theirs either way.
export const CALANDRIA_SERVER = "calandria";

// One segment of a `--config` dotted path is a TOML bare key. The SDK builds
// those paths by string concatenation with no quoting, so a server named
// `foo.bar` or `foo bar` would address the wrong table (or fail to parse).
// Rather than emit a broken override such a name is skipped; it stays mounted,
// which is exactly the pre-existing behavior, and is vanishingly rare.
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * The MCP servers codex would mount from the user's own configuration, by name.
 * Read through the CLI (`codex mcp list --json`) rather than by parsing
 * ~/.codex/config.toml directly: the CLI is the authority on what's actually
 * enabled and where it came from (config.toml, plugins, marketplaces), and the
 * repo has no TOML parser. ~30ms, next to a turn that runs for minutes.
 *
 * Best-effort by contract: any failure (CLI missing, malformed JSON, timeout)
 * degrades to an empty list, which leaves the user's servers mounted rather
 * than failing the turn.
 */
export async function listUserMcpServers(): Promise<string[]> {
  try {
    const list = codexSpawn(["mcp", "list", "--json"]);
    const { stdout } = await run(list.command, list.args, {
      timeout: 15_000,
      env: process.env,
      windowsVerbatimArguments: list.windowsVerbatimArguments,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((s) => (s as { name?: unknown })?.name)
      .filter((n): n is string => typeof n === "string" && n !== CALANDRIA_SERVER);
  } catch (e) {
    // ENOENT here just means codex isn't installed, which the auth surface
    // already reports more usefully; anything else is worth a line.
    if ((e as { code?: string }).code !== "ENOENT") {
      console.warn(`[codex] could not enumerate MCP servers, leaving the user's mounted: ${(e as Error).message}`);
    }
    return [];
  }
}

/**
 * `mcp_servers.<name>.enabled = false` for every server we're unmounting, ready
 * to be spread alongside the calandria entry. Empty when CODEX_INHERIT_MCP
 * is on (the user opted back into mounting them) or when there's nothing to
 * unmount.
 */
export function disableInheritedServers(names: string[]): Record<string, { enabled: false }> {
  if (CODEX_INHERIT_MCP) return {};
  const out: Record<string, { enabled: false }> = {};
  for (const name of names) {
    if (name === CALANDRIA_SERVER || !BARE_KEY.test(name)) continue;
    out[name] = { enabled: false };
  }
  return out;
}

/**
 * The two steps together: enumerate, then build the disable overrides. Skips
 * the subprocess entirely when the user has opted into inheriting.
 */
export async function inheritedServerOverrides(): Promise<Record<string, { enabled: false }>> {
  if (CODEX_INHERIT_MCP) return {};
  return disableInheritedServers(await listUserMcpServers());
}
