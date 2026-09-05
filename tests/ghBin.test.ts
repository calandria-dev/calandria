import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ghMissingMessage, resolveGhBin } from "../lib/github";
import { IS_WIN } from "./platform";

// resolveGhBin exists because the server process never reads a shell profile:
// a gh installed via linuxbrew/Homebrew/snap works in the user's terminal but
// ENOENTs under the server's PATH. Resolution order: CALANDRIA_GH_BIN verbatim,
// then bare "gh" when the server's PATH can see it, then the well-known
// install dirs, then bare "gh" so callers' ENOENT handling still fires.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-ghbin-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let n = 0;
function dir(withGh: { executable: boolean } | false): string {
  const d = path.join(tmpRoot, `d${n++}`);
  fs.mkdirSync(d);
  if (withGh) fs.writeFileSync(path.join(d, "gh"), "#!/bin/sh\n", { mode: withGh.executable ? 0o755 : 0o644 });
  return d;
}

/** A directory holding `gh.exe`, what every Windows package manager installs. */
function winDir(withGh = true): string {
  const d = path.join(tmpRoot, `w${n++}`);
  fs.mkdirSync(d);
  if (withGh) fs.writeFileSync(path.join(d, "gh.exe"), "");
  return d;
}
const WIN = { platform: "win32" as const, pathext: ".COM;.EXE;.BAT;.CMD" };

// Split by which platform's rules a case exercises, because only one half can
// run everywhere. The win32 cases below pass `WIN` explicitly, so they are real
// assertions on any OS. These take the platform from the process, and their
// fixtures are POSIX facts a Windows filesystem cannot represent: a bare `gh`
// with no extension (which CreateProcess would never find) and the executable
// bit (`fs.access(X_OK)` is a no-op on Windows, so mode 0o644 and 0o755 are
// indistinguishable there). These cases are skipped on Windows instead of
// ported.
describe.skipIf(IS_WIN)("resolveGhBin on POSIX", () => {
  it("uses CALANDRIA_GH_BIN verbatim when set, even over a PATH hit", () => {
    const onPath = dir({ executable: true });
    expect(resolveGhBin("/pinned/gh", onPath, [dir({ executable: true })])).toBe("/pinned/gh");
  });

  it("uses CALANDRIA_GH_BIN verbatim even when the path does not exist (a wrong knob fails loudly, never papered over)", () => {
    expect(resolveGhBin("/nope/gh", dir({ executable: true }), [dir({ executable: true })])).toBe("/nope/gh");
  });

  it("returns bare gh when the server PATH resolves it", () => {
    const pathEnv = [dir(false), dir({ executable: true })].join(path.delimiter);
    expect(resolveGhBin("", pathEnv, [dir({ executable: true })])).toBe("gh");
  });

  it("falls back to the first probe-dir hit when PATH misses", () => {
    const miss = dir(false);
    const hit = dir({ executable: true });
    const later = dir({ executable: true });
    expect(resolveGhBin("", miss, [dir(false), hit, later])).toBe(path.join(hit, "gh"));
  });

  it("skips a non-executable gh on PATH and probes instead", () => {
    const notExec = dir({ executable: false });
    const hit = dir({ executable: true });
    expect(resolveGhBin("", notExec, [hit])).toBe(path.join(hit, "gh"));
  });

  it("returns bare gh when nothing is found, so callers' ENOENT handling fires", () => {
    expect(resolveGhBin("", dir(false), [dir(false)])).toBe("gh");
  });
});

// Driven through the explicit `WIN` descriptor, so these run on every
// platform, including the Linux/macOS lanes. The Windows rules are pinned by
// the suite everybody runs, not only by a Windows CI lane.
describe("resolveGhBin on win32", () => {
  // On Windows the file is gh.exe, never gh, so a candidate built without the
  // extension misses every winget/scoop/MSI install even when the server's
  // PATH cannot see it. Bare "gh" is still the answer for a PATH hit
  // (CreateProcess repeats the PATH+PATHEXT search itself); the probe half is
  // what needs the extension.
  it("finds gh.exe on a win32 PATH and still answers bare gh", () => {
    expect(resolveGhBin("", [winDir(false), winDir()].join(";"), [], WIN)).toBe("gh");
  });

  it("finds gh.exe in a win32 probe dir when PATH misses", () => {
    const hit = winDir();
    expect(resolveGhBin("", winDir(false), [winDir(false), hit], WIN)).toBe(path.join(hit, "gh.exe"));
  });

  it("does not split a win32 PATH on ':' — a drive letter is not a separator", () => {
    const hit = winDir();
    expect(resolveGhBin("", `C:\\Windows;${hit}`, [], WIN)).toBe("gh");
  });
});

describe("ghMissingMessage", () => {
  it("blames the knob when CALANDRIA_GH_BIN is set", () => {
    const msg = ghMissingMessage("/pinned/gh");
    expect(msg).toContain("CALANDRIA_GH_BIN");
    expect(msg).toContain("/pinned/gh");
  });

  it("explains the server-PATH-vs-shell-profile gap and names the knob when unset", () => {
    const msg = ghMissingMessage("");
    expect(msg).toContain("CALANDRIA_GH_BIN");
    expect(msg).toContain("shell profile");
    expect(msg).toContain("https://cli.github.com");
  });
});
