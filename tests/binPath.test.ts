/* Finding and launching a CLI on Windows, from a POSIX suite.
 *
 * The bug this pins is invisible on Linux/macOS and total on native Windows:
 * Node's spawn is shell-less, so an extension-less name (`~/.local/bin/claude`)
 * or a bare one (`codex`) reaches CreateProcess, which only ever finds a file
 * that exists under a PATHEXT extension — and cannot execute the `.cmd` shims
 * npm writes at all. Every function in lib/binPath.ts therefore takes its
 * platform, PATH and PATHEXT as arguments, and this file drives the win32 rules
 * against real fixture directories on whatever OS the suite is running on.
 *
 * The fixture filenames are exact-case on purpose: NTFS wouldn't care, but this
 * runs on a case-sensitive filesystem, which is what pins the "PATHEXT is
 * uppercase, binaries on disk are not" lowercasing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PATHEXT,
  binCandidates,
  findInDirs,
  findOnPath,
  isExecutableFile,
  requiresShell,
  resolveBin,
  spawnSpec,
} from "@/lib/binPath";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-binpath-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let n = 0;
/** A fresh directory holding exactly `files`, each written non-executable unless named. */
function dir(files: string[] = [], mode = 0o644): string {
  const d = path.join(tmpRoot, `d${n++}`);
  fs.mkdirSync(d);
  for (const f of files) fs.writeFileSync(path.join(d, f), "", { mode });
  return d;
}

const win = { platform: "win32" as const, pathext: DEFAULT_PATHEXT };

describe("binCandidates", () => {
  it("is the name itself on POSIX — no extension games", () => {
    expect(binCandidates("codex", { platform: "linux" })).toEqual(["codex"]);
  });

  it("expands PATHEXT on win32, lowercased, in the OS's own order", () => {
    expect(binCandidates("codex", win)).toEqual(["codex.com", "codex.exe", "codex.bat", "codex.cmd"]);
  });

  it("puts .exe ahead of .cmd, so a real binary always beats an npm shim", () => {
    const c = binCandidates("claude", win);
    expect(c.indexOf("claude.exe")).toBeLessThan(c.indexOf("claude.cmd"));
  });

  it("leaves a name that already carries a PATHEXT extension alone", () => {
    expect(binCandidates("claude.exe", win)).toEqual(["claude.exe"]);
    expect(binCandidates("codex.CMD", win)).toEqual(["codex.CMD"]);
  });

  it("honors a custom PATHEXT and ignores its junk entries", () => {
    expect(binCandidates("gh", { platform: "win32", pathext: ".EXE;;.PS1; ;." })).toEqual(["gh.exe", "gh.ps1"]);
  });
});

describe("isExecutableFile", () => {
  it("requires the executable bit on POSIX", () => {
    const d = dir(["codex"]);
    expect(isExecutableFile(path.join(d, "codex"), "linux")).toBe(false);
    fs.chmodSync(path.join(d, "codex"), 0o755);
    expect(isExecutableFile(path.join(d, "codex"), "linux")).toBe(true);
  });

  it("accepts any existing file on win32 — X_OK is meaningless there, and the extension carries executability", () => {
    const d = dir(["codex.cmd"]);
    expect(isExecutableFile(path.join(d, "codex.cmd"), "win32")).toBe(true);
  });

  it("rejects a directory and a missing path on both", () => {
    const d = dir();
    expect(isExecutableFile(d, "win32")).toBe(false);
    expect(isExecutableFile(path.join(d, "nope"), "win32")).toBe(false);
  });
});

describe("findInDirs", () => {
  it("finds gh.exe for a bare 'gh' on win32 — the probe-dir miss that made every Windows install invisible", () => {
    const d = dir(["gh.exe"]);
    expect(findInDirs("gh", [d], win)).toBe(path.join(d, "gh.exe"));
    expect(findInDirs("gh", [d], { platform: "linux" })).toBeNull();
  });

  it("finds an npm .cmd shim when there is no .exe", () => {
    const d = dir(["codex.cmd"]);
    expect(findInDirs("codex", [d], win)).toBe(path.join(d, "codex.cmd"));
  });

  it("prefers the .exe when both are installed side by side", () => {
    const d = dir(["codex.cmd", "codex.exe"]);
    expect(findInDirs("codex", [d], win)).toBe(path.join(d, "codex.exe"));
  });

  it("takes the first directory that has any candidate, not the best candidate overall", () => {
    const first = dir(["codex.cmd"]);
    const second = dir(["codex.exe"]);
    expect(findInDirs("codex", [first, second], win)).toBe(path.join(first, "codex.cmd"));
  });

  it("skips empty entries and misses, and returns null when nothing matches", () => {
    expect(findInDirs("codex", ["", dir(["other.exe"])], win)).toBeNull();
  });
});

describe("findOnPath", () => {
  it("splits a win32 PATH on ';' regardless of the OS running the suite", () => {
    const miss = dir();
    const hit = dir(["claude.exe"]);
    expect(findOnPath("claude", { ...win, pathEnv: [miss, hit].join(";") })).toBe(path.join(hit, "claude.exe"));
  });

  it("does not split a win32 PATH on ':' — a drive letter is not a separator", () => {
    const hit = dir(["claude.exe"]);
    expect(findOnPath("claude", { ...win, pathEnv: `C:\\Windows;${hit}` })).toBe(path.join(hit, "claude.exe"));
  });

  it("splits on ':' for POSIX", () => {
    const hit = dir(["claude"], 0o755);
    expect(findOnPath("claude", { platform: "linux", pathEnv: `${dir()}:${hit}` })).toBe(path.join(hit, "claude"));
  });
});

describe("resolveBin", () => {
  it("prefers PATH over the well-known install dirs", () => {
    const onPath = dir(["codex.exe"]);
    const probe = dir(["codex.exe"]);
    expect(resolveBin("codex", { ...win, pathEnv: onPath, probeDirs: [probe] })).toBe(path.join(onPath, "codex.exe"));
  });

  it("falls back to the probe dirs when PATH misses", () => {
    const probe = dir(["codex.cmd"]);
    expect(resolveBin("codex", { ...win, pathEnv: dir(), probeDirs: [probe] })).toBe(path.join(probe, "codex.cmd"));
  });

  it("returns null when nothing is found, so callers pick their own fallback", () => {
    expect(resolveBin("codex", { ...win, pathEnv: dir(), probeDirs: [dir()] })).toBeNull();
  });
});

describe("requiresShell", () => {
  it("is true only for a win32 batch shim", () => {
    expect(requiresShell("C:\\x\\codex.cmd", "win32")).toBe(true);
    expect(requiresShell("C:\\x\\codex.BAT", "win32")).toBe(true);
    expect(requiresShell("C:\\x\\codex.exe", "win32")).toBe(false);
    // The same name on POSIX is just a file that happens to end in .cmd.
    expect(requiresShell("/usr/bin/codex.cmd", "linux")).toBe(false);
  });
});

describe("spawnSpec", () => {
  const comspec = "C:\\Windows\\system32\\cmd.exe";

  it("passes a real executable straight through, untouched", () => {
    expect(spawnSpec("C:\\x\\codex.exe", ["mcp", "list"], { platform: "win32", comspec })).toEqual({
      command: "C:\\x\\codex.exe",
      args: ["mcp", "list"],
    });
    expect(spawnSpec("/usr/bin/codex", ["mcp"], { platform: "linux" })).toEqual({
      command: "/usr/bin/codex",
      args: ["mcp"],
    });
  });

  it("wraps a .cmd shim in cmd.exe — Node refuses to spawn one without a shell (CVE-2024-27980)", () => {
    expect(spawnSpec("C:\\x\\codex.cmd", ["mcp", "list", "--json"], { platform: "win32", comspec })).toEqual({
      command: comspec,
      args: ["/d", "/s", "/c", '"C:\\x\\codex.cmd mcp list --json"'],
      windowsVerbatimArguments: true,
    });
  });

  it("quotes an install path with spaces, inside the outer pair /s strips", () => {
    const spec = spawnSpec("C:\\Program Files\\codex\\codex.cmd", ["login", "status"], { platform: "win32", comspec });
    // Outer quotes are consumed by `cmd /s`; the inner pair is what keeps
    // "Program Files" from splitting into two arguments.
    expect(spec.args[3]).toBe('""C:\\Program Files\\codex\\codex.cmd" login status"');
  });

  it("quotes an argument with spaces or cmd metacharacters", () => {
    const spec = spawnSpec("c.cmd", ["exec", "Reply with exactly: OK", "a&b"], { platform: "win32", comspec });
    expect(spec.args[3]).toBe('"c.cmd exec "Reply with exactly: OK" "a&b""');
  });

  it("falls back to cmd.exe when COMSPEC is unset", () => {
    expect(spawnSpec("c.cmd", [], { platform: "win32" }).command).toBe(process.env.COMSPEC || "cmd.exe");
  });
});
