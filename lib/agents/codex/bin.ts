// Which `codex` to spawn, for the two helpers that shell out to the CLI
// directly instead of going through @openai/codex-sdk (auth.ts, mcp.ts).
//
// Both used to hold a module-level `const CODEX = CODEX_CLI_PATH || "codex"`.
// The bare name is fine on POSIX — execvp searches PATH — and broken on native
// Windows, where the npm global install writes `codex.cmd` and nothing named
// `codex`: CreateProcess never finds it. mcp.ts is the expensive half, because
// its failure is SILENT by contract (a dead `codex mcp list` degrades to "leave
// the user's MCP servers mounted"), so a Windows instance would quietly pay the
// context cost of uncallable inherited tools on every single turn with no error
// anywhere. See docs/WINDOWS.md §6.
//
// SDK-free (config + lib/binPath only), and resolved per call rather than at
// import, matching resolveGhBin: a handful of stat()s, and installing codex
// mid-session works on the next click.

import { CODEX_CLI_PATH } from "../../config";
import { resolveBin, spawnSpec, type SpawnSpec } from "../../binPath";

/**
 * The codex binary: CODEX_CLI_PATH verbatim if pinned (a wrong knob should fail
 * loudly, not be papered over), else the PATHEXT-aware PATH lookup, else bare
 * "codex" so the ENOENT lands in the callers' existing not-installed handling —
 * which on POSIX is exactly the old behavior, since a PATH hit there resolves
 * to the same file execvp would have found.
 */
export function resolveCodexBin(configured: string = CODEX_CLI_PATH): string {
  if (configured) return configured;
  return resolveBin("codex") ?? "codex";
}

/**
 * The same, ready to hand to execFile/spawn: on Windows an npm-installed codex
 * is a `.cmd` shim, which Node refuses to spawn without a shell, so spawnSpec
 * wraps it in cmd.exe. Every argv we pass is fixed tokens (`login status`,
 * `mcp list --json`), so the quoting limits documented there don't bite.
 */
export function codexSpawn(args: string[]): SpawnSpec {
  return spawnSpec(resolveCodexBin(), args);
}
