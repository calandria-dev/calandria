import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pins the stdin handling of the wizard's "Verify connection" step for Codex.
//
// `codex exec` treats a non-TTY stdin as pending input: it prints "Reading
// additional input from stdin..." and blocks on the read before running the
// turn. execFile always hands the child a stdin *pipe*, and nothing in
// verifyCodexTurn() wrote to or closed it, so the child waited forever — the
// call sat there until the 90s timeout and the wizard reported a failed verify.
// It only looked fine when driven from a terminal, where a TTY stdin isn't
// treated as pending input. Verified on codex-cli 0.146.0: identical commands,
// 0 bytes of output after 60s with the pipe left open vs. 344 bytes in 6.7s
// with it closed.
//
// Note the shape of the failure this guards against: codex exits 0 on the
// timeout's SIGTERM, so the hang surfaced as a *successful* execFile with empty
// stdout ("the test turn returned no output"), not as an error. The stand-in
// below mimics that, so a regression fails on the assertion instead of hanging
// the suite.

// A stand-in for the codex binary. Emits the JSONL of a successful turn only
// once stdin reaches EOF; if stdin stays open it gives up quietly (empty
// stdout, exit 0) the way the real CLI does when the timeout kills it.
// Shebanged with the absolute node binary so it carries no PATH dependency.
const fakeCodex = `#!${process.execPath}
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
  const bin = path.join(dir, "codex");
  fs.writeFileSync(bin, fakeCodex, { mode: 0o755 });
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
