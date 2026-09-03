import { describe, it, expect, beforeEach } from "vitest";
import { onPosix } from "./platform";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexProviderConfig, CODEX_LOCAL_PROVIDER_ID, CODEX_GATEWAY_PROVIDER_ID } from "@/lib/agents/codex/provider";
import {
  CODEX_PROVIDER_MIN_VERSION,
  clearCodexProviderChecks,
  codexCliVersion,
  readCodexProvider,
  serializeCodexConfigOverrides,
  verifyCodexProvider,
} from "@/lib/agents/codex/providerCheck";

// The guard on lib/agents/codex/provider.ts, which reaches into another tool's
// config schema with no version pin behind it.
//
// tests/codexProvider.test.ts asserts the mapping's SHAPE, which is necessary
// and cannot catch the thing that actually hurts: a codex release that stops
// UNDERSTANDING that shape. An unknown `-c` override is inert to the CLI, so
// the turn doesn't fail — it falls back to the built-in `openai` provider and
// bills the user's ChatGPT login while the header still says `local`. So the
// three cases below are the ones a shape test can't reach:
//
//  1. The argv the REAL SDK spawns matches what the probe verifies. Both halves
//     flatten the same object to `--config` strings, and if they ever disagree
//     the probe would be proving a shape no turn uses. Pinned against the real
//     @openai/codex-sdk driving a fake binary that dumps its argv.
//  2. The REAL codex CLI accepts that argv and says so. Skipped when no codex is
//     installed, in the spirit of tests/codexUpdateTaskPolicy.test.ts running the
//     real stdio bridge — an assertion about another program is only worth
//     anything against that program.
//  3. A CLI that ignores the mapping is REFUSED, not silently billed. Driven by
//     a fake binary standing in for the release that breaks this, which is the
//     regression we can't wait to observe in the wild.

const OVERRIDE = { OPENAI_BASE_URL: "http://localhost:11434/v1", CODEX_MODEL: "qwen3-coder" };
const BASE_URL = "http://localhost:11434/v1";

// A stand-in `codex`, scripted per test through the env the probe passes it.
// FAKE_VERSION answers `--version`; FAKE_PROVIDER is what its doctor report
// claims resolved; FAKE_MODE=garbage makes doctor emit something unparseable,
// and FAKE_CALLS counts doctor invocations so the cache can be observed.
// A shebang script, so every case driving it is POSIX-only (`onPosix`, per
// tests/platform.ts): win32 can't exec one, and a `.cmd` rewrite would exercise
// the cmd.exe quoting path the probe declines outright rather than the logic
// these cases are about.
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (process.env.ARGV_OUT) fs.writeFileSync(process.env.ARGV_OUT, JSON.stringify(argv));
if (argv.includes("--version")) { process.stdout.write("codex-cli " + process.env.FAKE_VERSION + "\\n"); process.exit(0); }
if (argv[0] === "doctor") {
  if (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS, "1");
  if (process.env.FAKE_MODE === "garbage") { process.stdout.write("not json at all"); process.exit(1); }
  if (process.env.FAKE_MODE === "silent") process.exit(1);
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    codexVersion: process.env.FAKE_VERSION,
    overallStatus: "fail", // a local server that happens to be down; not our business
    checks: { "config.load": { id: "config.load", details: { "model provider": process.env.FAKE_PROVIDER } } },
  }));
  process.exit(1); // doctor exits nonzero on any failed check, report and all
}
process.exit(0);
`;

let dir: string;
let fakeBin: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-provider-check-"));
  fakeBin = path.join(dir, "codex");
  fs.writeFileSync(fakeBin, FAKE, { mode: 0o755 });
  clearCodexProviderChecks(BASE_URL);
});

const fakeEnv = (over: Record<string, string>) => ({ ...process.env, FAKE_VERSION: "9.9.9", FAKE_PROVIDER: CODEX_LOCAL_PROVIDER_ID, ...over });

describe("serializeCodexConfigOverrides", () => {
  it("flattens the provider entry the way the CLI's --config expects", () => {
    const { config } = codexProviderConfig(OVERRIDE);
    expect(serializeCodexConfigOverrides(config).sort()).toEqual(
      [
        `model_provider="${CODEX_LOCAL_PROVIDER_ID}"`,
        `model_providers.${CODEX_LOCAL_PROVIDER_ID}.base_url="${BASE_URL}"`,
        `model_providers.${CODEX_LOCAL_PROVIDER_ID}.name="Local model (Calandria)"`,
        `model_providers.${CODEX_LOCAL_PROVIDER_ID}.wire_api="responses"`,
      ].sort()
    );
  });

  it("mirrors the SDK's TOML value grammar for the types config can carry", () => {
    expect(serializeCodexConfigOverrides({ a: "s", b: 3, c: true, d: ["x", 1], e: {} })).toEqual([
      `a="s"`,
      "b=3",
      "c=true",
      `d=["x", 1]`,
      "e={}",
    ]);
    // A key that isn't a bare TOML key is quoted inside an inline table, matching
    // the SDK — the dotted PATH form is only reached for plain-object children.
    expect(serializeCodexConfigOverrides({ t: { "a.b": "v" } })).toEqual([`t.a.b="v"`]);
  });

  onPosix("emits exactly the --config arguments the real SDK spawns codex with", async () => {
    const { Codex } = await import("@openai/codex-sdk");
    const argvOut = path.join(dir, "argv.json");
    const { config } = codexProviderConfig(OVERRIDE);
    const codex = new Codex({
      codexPathOverride: fakeBin,
      config,
      env: { ...process.env, ARGV_OUT: argvOut, FAKE_VERSION: "9.9.9" } as Record<string, string>,
    });
    // The fake never speaks the SDK's JSONL protocol, so however this run ends
    // is not the assertion — the argv it recorded on the way is.
    try {
      const { events } = await codex.startThread({ skipGitRepoCheck: true, workingDirectory: dir }).runStreamed("hi");
      for await (const _ of events) void _;
    } catch {
      /* expected: the fake produced no thread */
    }

    const argv: string[] = JSON.parse(fs.readFileSync(argvOut, "utf8"));
    const emitted = argv.filter((_, i) => argv[i - 1] === "--config");
    // Every override the probe would send is one the SDK actually sends. If the
    // SDK's flattener ever changes, this is what catches it — before the probe
    // starts certifying a shape the turn no longer uses.
    for (const override of serializeCodexConfigOverrides(config)) expect(emitted).toContain(override);
  });
});

describe("readCodexProvider against the real codex CLI", () => {
  // Only meaningful with a codex on hand; a machine without one still runs
  // everything else in this file.
  const real = [path.join(process.cwd(), "node_modules", ".bin", "codex")].find((p) => fs.existsSync(p));

  onPosix("reports the mapped provider, and the default without it", async (ctx) => {
    if (!real) return ctx.skip();
    const version = await codexCliVersion({ bin: real });
    expect(version, "a codex that can't say its version can't certify anything").toBeTruthy();

    const { config } = codexProviderConfig(OVERRIDE);
    const mapped = await readCodexProvider(serializeCodexConfigOverrides(config), { bin: real, cwd: dir });
    expect(mapped, `codex ${version} no longer reports its resolved provider — the mapping can't be verified`).toMatchObject({
      kind: "provider",
      provider: CODEX_LOCAL_PROVIDER_ID,
    });

    // The control: without the overrides the very same probe reads the built-in
    // provider, so the assertion above is discriminating rather than vacuous.
    const bare = await readCodexProvider([], { bin: real, cwd: dir });
    expect(bare.kind).toBe("provider");
    expect(bare.kind === "provider" && bare.provider).not.toBe(CODEX_LOCAL_PROVIDER_ID);
  }, 60_000);

  // The gateway entry carries two keys the local one doesn't — `env_key` and a
  // nested `http_headers` table — and a dotted `--config` path with a hyphenated
  // leaf (`…http_headers.x-litellm-tags`). Measured accepted on codex-cli
  // 0.146.0, `config.load` ok and the provider resolved, with the named variable
  // UNSET: a gateway with no key configured still gets a turn attempted rather
  // than a config error, which is the behaviour the driver's refusal path
  // assumes.
  onPosix("accepts the gateway entry's env_key and http_headers too", async (ctx) => {
    if (!real) return ctx.skip();
    const GATEWAY = "http://gw.example:4000";
    const { config } = codexProviderConfig(
      { OPENAI_BASE_URL: `${GATEWAY}/v1`, CALANDRIA_GATEWAY_TAGS: "calandria,project:p1,task:t1,agent:codex" },
      GATEWAY,
    );
    const mapped = await readCodexProvider(serializeCodexConfigOverrides(config), {
      bin: real,
      cwd: dir,
      env: { ...process.env, CALANDRIA_GATEWAY_KEY: undefined },
    });
    expect(mapped).toMatchObject({ kind: "provider", provider: CODEX_GATEWAY_PROVIDER_ID });
  }, 60_000);
});

describe("verifyCodexProvider", () => {
  it("has nothing to prove for a cloud turn", async () => {
    const cloud = codexProviderConfig({});
    // No `bin`, so a subprocess here would reach for a real codex — the point is
    // that it never gets that far.
    expect(await verifyCodexProvider(cloud, { bin: path.join(dir, "does-not-exist") })).toEqual({ ok: true, cliVersion: null });
  });

  onPosix("passes when the CLI confirms the mapping took", async () => {
    const local = codexProviderConfig(OVERRIDE);
    expect(await verifyCodexProvider(local, { bin: fakeBin, env: fakeEnv({}) })).toEqual({ ok: true, cliVersion: "9.9.9" });
  });

  onPosix("REFUSES rather than falling through to the paid login when the mapping didn't take", async () => {
    const local = codexProviderConfig(OVERRIDE);
    const verdict = await verifyCodexProvider(local, { bin: fakeBin, env: fakeEnv({ FAKE_PROVIDER: "openai" }) });
    expect(verdict.ok).toBe(false);
    const msg = verdict.ok ? "" : verdict.message;
    expect(msg).toContain("9.9.9"); // the version is the thing that changed
    expect(msg).toContain("openai"); // what it fell back to
    expect(msg).toContain(BASE_URL); // what the user asked for
    expect(msg).toContain("CODEX_CLI_PATH"); // how to pin a working one
  });

  onPosix("refuses when it cannot read an answer at all, naming the version floor", async () => {
    const local = codexProviderConfig(OVERRIDE);
    for (const mode of ["garbage", "silent"]) {
      const verdict = await verifyCodexProvider(local, { bin: fakeBin, env: fakeEnv({ FAKE_MODE: mode }) });
      expect(verdict.ok, `FAKE_MODE=${mode} must not be read as "probably fine"`).toBe(false);
      const msg = verdict.ok ? "" : verdict.message;
      expect(msg).toContain(CODEX_PROVIDER_MIN_VERSION);
      expect(msg).toContain("CALANDRIA_CODEX_PROVIDER_CHECK");
    }
  });

  it("runs a batch shim UNVERIFIED rather than refusing on our own cmd.exe quoting", async () => {
    // Every override carries embedded quotes, which a `cmd.exe /d /s /c` line
    // can't be trusted to deliver intact — so a "wrong provider" answer there
    // would indict our quoting, not the mapping. The documented exception: it
    // degrades to the pre-check behaviour instead of refusing every Windows
    // instance whose codex is an npm `.cmd` shim.
    expect(await readCodexProvider(["x=1"], { bin: "C:\\codex.cmd", platform: "win32" })).toEqual({ kind: "unquotable" });
    const local = codexProviderConfig(OVERRIDE);
    expect(await verifyCodexProvider(local, { bin: "C:\\codex.cmd", platform: "win32" })).toMatchObject({ ok: true });
  });

  it("refuses when the binary isn't there", async () => {
    const local = codexProviderConfig(OVERRIDE);
    const verdict = await verifyCodexProvider(local, { bin: path.join(dir, "absent") });
    expect(verdict.ok).toBe(false);
  });

  onPosix("asserts on the GATEWAY id for a gateway entry, and keeps the two verdicts apart", async () => {
    const GATEWAY = "http://gw.example:4000";
    const gw = codexProviderConfig({ OPENAI_BASE_URL: `${GATEWAY}/v1` }, GATEWAY);
    expect(gw.config.model_provider).toBe(CODEX_GATEWAY_PROVIDER_ID);

    // The id the probe demands comes from the config it was handed, so the entry
    // that says `calandria-gateway` is only satisfied by that answer …
    const ok = await verifyCodexProvider(gw, { bin: fakeBin, env: fakeEnv({ FAKE_PROVIDER: CODEX_GATEWAY_PROVIDER_ID }) });
    expect(ok).toEqual({ ok: true, cliVersion: "9.9.9" });

    // … and a verdict earned here says nothing about the local endpoint, whose
    // base URL keys a cache entry of its own.
    const local = codexProviderConfig(OVERRIDE);
    const stolen = await verifyCodexProvider(local, { bin: fakeBin, env: fakeEnv({ FAKE_PROVIDER: CODEX_GATEWAY_PROVIDER_ID }) });
    expect(stolen.ok).toBe(false);
    expect(stolen.ok ? "" : stolen.message).toContain(BASE_URL);
  });

  onPosix("probes once per endpoint, then re-earns the verdict when the CLI version moves", async () => {
    const local = codexProviderConfig(OVERRIDE);
    const calls = path.join(dir, "calls");
    const env = (over: Record<string, string> = {}) => fakeEnv({ FAKE_CALLS: calls, ...over });
    const probes = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").length : 0);

    expect(await verifyCodexProvider(local, { bin: fakeBin, env: env() })).toEqual({ ok: true, cliVersion: "9.9.9" });
    expect(probes()).toBe(1);

    // Same version: the remembered verdict stands, and doctor isn't re-run.
    expect(await verifyCodexProvider(local, { bin: fakeBin, env: env() })).toEqual({ ok: true, cliVersion: "9.9.9" });
    expect(probes()).toBe(1);

    // The CLI autoupdated under us and the new one ignores the mapping. The
    // cached "yes" must not outlive the binary that earned it.
    const after = await verifyCodexProvider(local, { bin: fakeBin, env: env({ FAKE_VERSION: "9.9.10", FAKE_PROVIDER: "openai" }) });
    expect(probes()).toBe(2);
    expect(after.ok).toBe(false);
    expect(after.ok ? "" : after.message).toContain("9.9.10");
  });
});
