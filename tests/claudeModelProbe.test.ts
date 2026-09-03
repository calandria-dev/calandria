/* Showing what a family alias resolves to, without ever blocking on finding out.
 *
 * Three things are under test, and the third is the one that matters most:
 *
 *  1. Reading the resolved id off the CLI's `init` line, including killing a CLI
 *     that will not exit on its own.
 *  2. Overlaying that answer onto the model catalog — the id in the subtitle,
 *     the label left alone, the `[1m]` rows derived rather than probed.
 *  3. That the picker renders EXACTLY as it did before when the probe has said
 *     nothing: no cache, no CLI, a probe that timed out. The feature is allowed
 *     to be absent; it is not allowed to be in the way.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onPosix } from "./platform";
import { CLAUDE_CAPABILITIES, claudeCapabilities, subscriptionModels } from "../lib/agents/claude/capabilities";
import { clearResolvedModelIds, resolvedModelIds, setResolvedModelIds } from "../lib/agents/claude/modelIds";
import { ensureClaudeModelIds, probeModelId, readInit } from "../lib/agents/claude/modelProbe";

// The measured resolution on CLI 2.1.257 — the five values the probe actually
// spawns. The `[1m]` picker rows are absent on purpose: they are derived.
const MEASURED = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  opusplan: "claude-sonnet-5",
};

const row = <T extends { value: string }>(models: readonly T[], value: string): T =>
  models.find((m) => m.value === value)!;

afterEach(() => clearResolvedModelIds());

describe("reading the init line", () => {
  // Trimmed from a real run: `claude -p --bare --model opus --output-format
  // stream-json --verbose --no-session-persistence "hi"` on 2.1.257.
  const init = JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/tmp",
    session_id: "3cdee41f-7a56-4d00-b61d-51e73e0e406e",
    model: "claude-opus-5",
    claude_code_version: "2.1.257",
    permissionMode: "default",
    tools: ["Bash", "Read"],
  });

  it("takes the model and the version that resolved it", () => {
    expect(readInit(init)).toEqual({ model: "claude-opus-5", version: "2.1.257" });
  });

  it("ignores every other line the stream carries", () => {
    // The hook lines `--bare` suppresses still exist for a CLI run without it,
    // and an assistant/result line carries a `model` field of its own.
    const others = [
      "",
      "not json at all",
      JSON.stringify({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" }),
      JSON.stringify({ type: "assistant", model: "claude-opus-5" }),
      JSON.stringify({ type: "system", subtype: "init" }), // no model field
      JSON.stringify({ type: "system", subtype: "init", model: "  " }),
    ];
    for (const line of others) expect(readInit(line)).toBeNull();
  });

  it("survives a CLI that stops reporting the version", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5" });
    expect(readInit(line)).toEqual({ model: "claude-opus-5", version: null });
  });
});

describe("probing a fake CLI", () => {
  // The fixtures are `/bin/sh` scripts, so these run on POSIX only — a fact
  // about how a fake binary is spelled here, not about the code under test,
  // which is plain spawn/stdout handling.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-probe-"));
  const fake = (name: string, body: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };

  onPosix("reads the id and kills a CLI that would never exit", async () => {
    // The real thing does exactly this: with the API unreachable it prints init
    // and then sits retrying (measured: alive past two minutes). If the probe
    // waited for exit instead of killing on the line, this case would hang.
    const bin = fake(
      "hangs",
      `echo '{"type":"system","subtype":"init","model":"claude-fable-5-1","claude_code_version":"2.1.257"}'\nsleep 120`,
    );
    const started = Date.now();
    expect(await probeModelId("fable", bin)).toEqual({ model: "claude-fable-5-1", version: "2.1.257" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  onPosix("reassembles an init line that arrives split across chunks", async () => {
    // The line is several KB in production, so it really does come in pieces.
    const bin = fake(
      "chunked",
      `printf '{"type":"system","subtype":"init","model":"claude'\nsleep 0.2\nprintf -- '-opus-5"}\\n'\nsleep 5`,
    );
    expect(await probeModelId("opus", bin)).toEqual({ model: "claude-opus-5", version: null });
  });

  onPosix("gives up quietly on a CLI that says nothing", async () => {
    expect(await probeModelId("opus", fake("mute", "exit 1"))).toBeNull();
  });

  it("gives up quietly when there is no CLI at all", async () => {
    expect(await probeModelId("opus", path.join(dir, "definitely-not-here"))).toBeNull();
  });
});

describe("the catalog overlay", () => {
  it("puts the resolved id where the Vertex path puts it", () => {
    const models = subscriptionModels(MEASURED);
    expect(row(models, "fable").sub).toBe("claude-fable-5-1");
    expect(row(models, "opus").sub).toBe("claude-opus-5");
    expect(row(models, "sonnet").sub).toBe("claude-sonnet-5");
    expect(row(models, "haiku").sub).toBe("claude-haiku-4-5-20251001");
    // opusplan plans on Opus and runs on Sonnet; the probe reports the session
    // model, which is the one the window and the spend follow.
    expect(row(models, "opusplan").sub).toBe("claude-sonnet-5");
  });

  it("leaves the labels alone — '(latest)' is still true", () => {
    const models = subscriptionModels(MEASURED);
    for (const m of CLAUDE_CAPABILITIES.models) expect(row(models, m.value).label).toBe(m.label);
  });

  it("derives the [1m] rows instead of probing them", () => {
    const models = subscriptionModels(MEASURED);
    expect(row(models, "opus[1m]").sub).toBe("claude-opus-5[1m]");
    expect(row(models, "sonnet[1m]").sub).toBe("claude-sonnet-5[1m]");
    expect(row(models, "opusplan[1m]").sub).toBe("claude-sonnet-5[1m]");
  });

  it("touches nothing that isn't an alias", () => {
    const models = subscriptionModels(MEASURED);
    for (const value of ["claude-fable-5-1", "claude-opus-4-8", "claude-sonnet-4-6[1m]", "claude-opus-4-6"]) {
      expect(row(models, value)).toEqual(row(CLAUDE_CAPABILITIES.models, value));
    }
  });

  it("leaves a family that didn't answer exactly as written", () => {
    const models = subscriptionModels({ opus: "claude-opus-5" });
    expect(row(models, "opus").sub).toBe("claude-opus-5");
    for (const value of ["fable", "sonnet", "haiku", "opusplan", "sonnet[1m]"]) {
      expect(row(models, value)).toEqual(row(CLAUDE_CAPABILITIES.models, value));
    }
  });

  it("takes the context window off the resolved id, not off the row", () => {
    // The Vertex bug, on the subscription path: an alias that starts resolving
    // to a `[1m]` spelling makes it a 1M session, and a row still claiming 200k
    // would measure the task's context against a fifth of its real window.
    const models = subscriptionModels({ ...MEASURED, opus: "claude-opus-5[1m]" });
    expect(row(CLAUDE_CAPABILITIES.models, "opus").contextWindow).toBe(200_000);
    expect(row(models, "opus").contextWindow).toBe(1_000_000);
    expect(row(models, "opus[1m]").contextWindow).toBe(1_000_000);
    // Today's actual resolutions change no window at all.
    const measured = subscriptionModels(MEASURED);
    for (const m of CLAUDE_CAPABILITIES.models) {
      expect(row(measured, m.value).contextWindow).toBe(m.contextWindow);
    }
  });
});

describe("the descriptor without a probe", () => {
  it("is the static catalog, byte for byte", () => {
    expect(resolvedModelIds()).toBeNull();
    expect(claudeCapabilities({}).models).toEqual(CLAUDE_CAPABILITIES.models);
  });

  it("picks the answer up as soon as one lands, with no restart", () => {
    setResolvedModelIds({ version: "2.1.257", ids: MEASURED });
    expect(row(claudeCapabilities({}).models, "opus").sub).toBe("claude-opus-5");
    clearResolvedModelIds();
    expect(claudeCapabilities({}).models).toEqual(CLAUDE_CAPABILITIES.models);
  });

  it("does not overlay a Vertex instance, which reads its mapping instead", () => {
    setResolvedModelIds({ version: "2.1.257", ids: MEASURED });
    const env = { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5[1m]" };
    expect(row(claudeCapabilities(env).models, "opus").sub).toBe("claude-opus-5[1m]");
    // …and Vertex still drops Fable, which the overlay must not smuggle back in.
    expect(claudeCapabilities(env).models.some((m) => /fable/i.test(m.value))).toBe(false);
  });

  it("spawns nothing when the probe is turned off", () => {
    // CALANDRIA_CLAUDE_MODEL_PROBE=0 for the whole suite (tests/setup.ts), so
    // this is the Docker-image / opted-out instance: the trigger is inert and
    // the descriptor keeps its catalog.
    ensureClaudeModelIds();
    expect(resolvedModelIds()).toBeNull();
    expect(claudeCapabilities({}).models).toEqual(CLAUDE_CAPABILITIES.models);
  });
});
