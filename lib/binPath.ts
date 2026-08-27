// Finding a CLI on disk, portably — the one thing every agent/tool binary we
// shell out to needs and that Node does not do for us.
//
// Node's spawn is shell-less, so on POSIX it takes the path verbatim and on
// win32 it hands the name to CreateProcess, which appends PATHEXT itself. That
// covers `claude.exe` and `gh.exe` but NOT the shims npm writes (`codex.cmd`,
// `claude.cmd`) — CreateProcess cannot execute a batch file at all, and since
// CVE-2024-27980 Node refuses to try (`EINVAL`) unless a shell is involved.
// Every bare-name or extension-less binary path in this repo therefore breaks
// on native Windows, silently in the one place it matters most
// (lib/agents/codex/mcp.ts, which degrades to "leave the user's MCP servers
// mounted"). Two exports answer the two halves:
//
//   * resolveBin/findOnPath/findInDirs — WHERE the binary is, trying each
//     PATHEXT extension on win32 so a `.cmd` shim is found rather than missed.
//   * spawnSpec — HOW to launch what was found, wrapping a `.cmd`/`.bat` in
//     cmd.exe because Node won't.
//
// SDK-free and dependency-free (node:fs + node:path) so anything can import it,
// and every function takes its platform/PATH/PATHEXT as arguments so the win32
// behavior is unit-testable from the Linux/macOS suite. See docs/WINDOWS.md §6.

import fs from "node:fs";
import path from "node:path";

/**
 * Windows' own default when PATHEXT is unset, trimmed to what a CLI is
 * plausibly shipped as. Order matters and is the OS's: a real `.exe` wins over
 * an npm `.cmd` shim for the same name, which is what we want everywhere —
 * spawning the executable directly avoids the cmd.exe wrapper below, and the
 * Claude SDK's `pathToClaudeCodeExecutable` spawns whatever we hand it with no
 * wrapper available at all.
 */
export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export interface BinLookupOptions {
  /** Defaults to the running platform; pass "win32" to exercise the Windows rules. */
  platform?: NodeJS.Platform;
  /** Raw PATHEXT value; defaults to the environment's, then DEFAULT_PATHEXT. */
  pathext?: string;
}

const isWin = (platform?: NodeJS.Platform) => (platform ?? process.platform) === "win32";

function extensions(opts: BinLookupOptions): string[] {
  const raw = opts.pathext ?? process.env.PATHEXT ?? DEFAULT_PATHEXT;
  return raw
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith(".") && e.length > 1);
}

/**
 * The filenames `name` could be on disk, in the order to try them. Just `[name]`
 * on POSIX; on win32 the PATHEXT expansion, unless the name already carries one
 * of those extensions (`claude.exe` is asking for exactly that file).
 *
 * Lowercased on purpose: PATHEXT is conventionally uppercase but binaries on
 * disk are not, and while NTFS doesn't care, the suite that pins this runs on a
 * case-sensitive filesystem.
 */
export function binCandidates(name: string, opts: BinLookupOptions = {}): string[] {
  if (!isWin(opts.platform)) return [name];
  const exts = extensions(opts);
  const lower = name.toLowerCase();
  if (exts.some((e) => lower.endsWith(e))) return [name];
  return exts.map((e) => name + e);
}

/**
 * Whether `p` is a file we could spawn. The X_OK check is meaningless on
 * Windows — it passes for any existing file, since executability there is
 * carried by the extension, not a mode bit — so win32 asks only "is this a
 * file", which combined with the PATHEXT candidates above is the same question.
 */
export function isExecutableFile(p: string, platform?: NodeJS.Platform): boolean {
  try {
    if (!isWin(platform)) fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** First `dirs` entry holding an executable `name` (PATHEXT applied), else null. */
export function findInDirs(name: string, dirs: string[], opts: BinLookupOptions = {}): string | null {
  const names = binCandidates(name, opts);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (isExecutableFile(full, opts.platform)) return full;
    }
  }
  return null;
}

/** Same, over the PATH the server process actually has. */
export function findOnPath(
  name: string,
  opts: BinLookupOptions & { pathEnv?: string } = {},
): string | null {
  const raw = opts.pathEnv ?? process.env.PATH ?? "";
  // path.delimiter follows the RUNNING platform, so a win32 lookup driven from
  // the suite must be split on ";" explicitly or a fake PATH never splits.
  const delimiter = isWin(opts.platform) ? ";" : ":";
  return findInDirs(name, raw.split(delimiter), opts);
}

/**
 * The full resolution for an unpinned binary: PATH first (what the user's own
 * shell would run), then the well-known install dirs a server process's
 * trimmed PATH can't see. Returns null when nothing was found — callers decide
 * whether to fall back to the bare name so the ENOENT lands in their existing
 * not-installed handling.
 */
export function resolveBin(
  name: string,
  opts: BinLookupOptions & { pathEnv?: string; probeDirs?: string[] } = {},
): string | null {
  return findOnPath(name, opts) ?? findInDirs(name, opts.probeDirs ?? [], opts);
}

/** A `.cmd`/`.bat` on win32 can't be spawned without a shell (see the header). */
export function requiresShell(bin: string, platform?: NodeJS.Platform): boolean {
  return isWin(platform) && /\.(cmd|bat)$/i.test(bin);
}

/**
 * cmd.exe splits on whitespace and on `&|<>^`, but leaves all of them alone
 * inside double quotes; `%VAR%` is the one expansion quotes don't stop, and is
 * the documented limit here (our own argv is fixed tokens, and a `%` in a
 * user-supplied string reaching a `.cmd` shim would need `setlocal` gymnastics
 * to be worth defending).
 */
function quoteForCmd(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  /** Set when we built the command line ourselves; pass it through to spawn/execFile. */
  windowsVerbatimArguments?: boolean;
}

/**
 * What to actually hand child_process (or node-pty) for `bin argv…`.
 * Pass-through everywhere except a win32 batch shim, which becomes
 * `cmd.exe /d /s /c ""<bin>" <argv…>"` — the same wrapper `shell: true` would
 * build, except we quote the pieces instead of letting Node join them with
 * spaces (an install under `C:\Program Files\…` otherwise splits in two). The
 * outer quote pair is what `/s` strips, so it has to be there for the inner
 * ones to survive; verbatim arguments then stop Node re-escaping the line.
 */
export function spawnSpec(
  bin: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; comspec?: string } = {},
): SpawnSpec {
  if (!requiresShell(bin, opts.platform)) return { command: bin, args };
  const line = [bin, ...args].map(quoteForCmd).join(" ");
  return {
    command: opts.comspec ?? process.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
