import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IS_WIN } from "./platform";

// Pins the stdin handling of the wizard's "Verify connection" step for Codex.
//
// `codex exec` treats a non-TTY stdin as pending input: it prints "Reading
// additional input from stdin..." and blocks on the read before running the
// turn. execFile always hands the child a stdin pipe, so verifyCodexTurn()
// must write to or close it, or the child waits until the 90s timeout and the
// wizard reports a failed verify. A TTY stdin isn't treated as pending input,
// so the hang is invisible when driven from a terminal.
//
// codex exits 0 on the timeout's SIGTERM, so the hang surfaces as a
// successful execFile with empty stdout, not as an error. The stand-in below
// mimics that, so a regression fails on the assertion instead of hanging the
// suite.

// A stand-in for the codex binary. Emits the JSONL of a successful turn only
// once stdin reaches EOF; if stdin stays open it gives up with empty stdout
// and exit 0, the way the real CLI does when the timeout kills it.
const fakeCodexBody = `
const EVENTS = [
  JSON.stringify({ type: "thread.started", thread_id: "t-verify" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "OK" } }),
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 11, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 },
  }),
].join("\\n") + "\\n";

process.stderr.write("Reading additional input from stdin...\\n");
let ended = false;
process.stdin.on("end", () => {
  ended = true;
  process.stdout.write(EVENTS);
  process.exit(0);
});
process.stdin.resume();
// Stands in for the 90s timeout: exit 0 with nothing on stdout, as codex does.
setTimeout(() => {
  if (!ended) process.exit(0);
}, 1_500);
`;

function installFakeCodex(): string {
  const dir = fs.mkdtempSync(path.join(process.env.CALANDRIA_TEST_TMP!, "codex-verify-"));
  if (!IS_WIN) {
    // Shebanged with the absolute node binary so it carries no PATH dependency.
    const bin = path.join(dir, "codex");
    fs.writeFileSync(bin, `#!${process.execPath}${fakeCodexBody}`, { mode: 0o755 });
    return bin;
  }
  // Windows has no shebang; CreateProcess runs a file by its extension, so
  // the stand-in is the same pair npm itself installs: the script, plus a .cmd
  // shim that launches it with node. That also puts the real Windows launch
  // path under test, since Node refuses to spawn a .cmd without a shell and
  // lib/binPath.ts is what wraps it in cmd.exe (CVE-2024-27980).
  const script = path.join(dir, "codex.js");
  fs.writeFileSync(script, fakeCodexBody);
  const bin = path.join(dir, "codex.cmd");
  fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return bin;
}

// CODEX_CLI_PATH is read at import time by lib/config, so the module graph has
// to be reset and re-imported after the stand-in is pointed at.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("codex verify turn", () => {
  it("closes the child's stdin so `codex exec` doesn't block on pending input", async () => {
    vi.stubEnv("CODEX_CLI_PATH", installFakeCodex());
    const { verifyCodexTurn } = await import("@/lib/agents/codex/auth");

    const res = await verifyCodexTurn();

    expect(res.error).toBeNull();
    expect(res.ok).toBe(true);
    expect(res.output).toBe("OK");
  });
});
