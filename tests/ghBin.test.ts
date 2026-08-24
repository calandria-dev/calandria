import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ghMissingMessage, resolveGhBin } from "../lib/github";

// resolveGhBin exists because the server process never reads a shell profile:
// a gh installed via linuxbrew/Homebrew/snap works in the user's terminal but
// ENOENTs under the server's PATH, which used to surface as "gh is not
// installed". Resolution order: ORCH_GH_BIN verbatim, then bare "gh" when the
// server's PATH can see it, then the well-known install dirs, then bare "gh"
// so callers' ENOENT handling still fires.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orch-ghbin-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let n = 0;
function dir(withGh: { executable: boolean } | false): string {
  const d = path.join(tmpRoot, `d${n++}`);
  fs.mkdirSync(d);
  if (withGh) fs.writeFileSync(path.join(d, "gh"), "#!/bin/sh\n", { mode: withGh.executable ? 0o755 : 0o644 });
  return d;
}

describe("resolveGhBin", () => {
  it("uses ORCH_GH_BIN verbatim when set, even over a PATH hit", () => {
    const onPath = dir({ executable: true });
    expect(resolveGhBin("/pinned/gh", onPath, [dir({ executable: true })])).toBe("/pinned/gh");
  });

  it("uses ORCH_GH_BIN verbatim even when the path does not exist (a wrong knob fails loudly, never papered over)", () => {
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

describe("ghMissingMessage", () => {
  it("blames the knob when ORCH_GH_BIN is set", () => {
    const msg = ghMissingMessage("/pinned/gh");
    expect(msg).toContain("ORCH_GH_BIN");
    expect(msg).toContain("/pinned/gh");
  });

  it("explains the server-PATH-vs-shell-profile gap and names the knob when unset", () => {
    const msg = ghMissingMessage("");
    expect(msg).toContain("ORCH_GH_BIN");
    expect(msg).toContain("shell profile");
    expect(msg).toContain("https://cli.github.com");
  });
});
