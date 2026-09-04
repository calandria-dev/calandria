// Proving the provider override in ./provider.ts actually took, before a turn
// spends anything.
//
// The mapping reaches into another tool's configuration schema: three keys
// (`model_provider`, `model_providers.<name>`, `wire_api = "responses"`), none
// of them a public contract, against a `codex` CLI that autoupdates on the
// user's machine independently of Calandria. The SDK spawns whatever `codex` is
// on PATH, so there is no version this app controls.
//
// The failure mode is what makes this worth a subprocess. If a codex release
// renames a key or drops the `responses` wire API, the CLI does not error: an
// unknown `-c` override is inert and `model_provider` falls back to the built-in
// `openai` provider, i.e. the user's real ChatGPT login. A project configured
// for a free local endpoint would start spending paid quota, at cloud
// latency, with the session header still showing the `local` chip. Nothing
// surfaces. That is the silent-wrong-backend class lib/agents/connections.ts
// guards on the auth side, and the answer is the same: refuse, loudly.
//
// `codex doctor --json` is the CLI's own account of the configuration it just
// loaded, and it accepts the same `-c` overrides the SDK passes. Its
// `config.load` check reports the resolved `model provider`, which is exactly
// the fact in question: this app's own id ("calandria-local", or
// "calandria-gateway" for the LiteLLM entry) means the mapping took, "openai"
// means the turn was about to be billed to the ChatGPT login. The probe costs
// roughly a second, so the verdict is cached per endpoint against the CLI
// version that produced it and re-earned whenever that version moves.
//
// Fails closed: an unparseable or missing doctor report is "cannot prove it",
// not "probably fine". A refused turn costs the user a message; a silent
// fallback costs them money they did not agree to spend. The escape hatch is
// CALANDRIA_CODEX_PROVIDER_CHECK=off, named in the error text.
//
// SDK-free (config + bin.ts + store), so it can be tested without spawning the
// agent SDK, but it mirrors the SDK's own `--config` flattening, which
// tests/codexProviderCheck.test.ts pins against the real SDK's emitted argv.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CODEX_PROVIDER_CHECK, CODEX_PROVIDER_CHECK_MS } from "../../config";
import { getSetting, setSetting } from "../../store";
import { resolveCodexBin } from "./bin";
import { spawnSpec } from "../../binPath";
import { CODEX_LOCAL_PROVIDER_ID, type CodexConfigValue, type CodexProviderConfig } from "./provider";

const run = promisify(execFile);

/**
 * The codex release this mapping is known good against, and the floor for the
 * verification below: `codex doctor --json` and its `config.load` check are
 * what make the assertion possible at all. Stated in docs/AGENTS.md ("Local
 * models") beside the setup steps, and named in the error when the probe
 * can't run.
 */
export const CODEX_PROVIDER_MIN_VERSION = "0.146.0";

/** Where a proven endpoint is remembered: the CLI version that proved it. Keyed
 *  by the endpoint's own base URL, which is what keeps a gateway verdict and a
 *  local-endpoint verdict apart: same instance, different URLs, and a URL that
 *  matched the gateway's origin would be the gateway. */
const okKey = (baseUrl: string) => `codex_provider_ok:${baseUrl}`;

export type CodexProviderVerdict =
  | { ok: true; cliVersion: string | null }
  | { ok: false; message: string };

/**
 * The SDK's `serializeConfigOverrides`, restated. The SDK flattens its `config`
 * option to repeated `--config <dotted.path>=<toml>` arguments; the probe has to
 * send identical arguments or it verifies a shape the turn never uses.
 * Only the subset provider.ts emits is exercised, but the whole value grammar is
 * mirrored so the two can't drift silently: tests/codexProviderCheck.test.ts
 * asserts this output against the argv the real SDK spawns.
 */
export function serializeCodexConfigOverrides(config: Record<string, CodexConfigValue>): string[] {
  const out: string[] = [];
  const walk = (value: CodexConfigValue, prefix: string) => {
    if (!isPlainObject(value)) {
      if (prefix) out.push(`${prefix}=${toToml(value)}`);
      return;
    }
    const entries = Object.entries(value);
    if (prefix && entries.length === 0) {
      out.push(`${prefix}={}`);
      return;
    }
    for (const [key, child] of entries) {
      if (child === undefined) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (isPlainObject(child)) walk(child, path);
      else out.push(`${path}=${toToml(child)}`);
    }
  };
  walk(config, "");
  return out;
}

const isPlainObject = (v: CodexConfigValue): v is { [k: string]: CodexConfigValue } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function toToml(value: CodexConfigValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return `${value}`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(toToml).join(", ")}]`;
  const parts = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .map(([k, child]) => `${BARE_KEY.test(k) ? k : JSON.stringify(k)} = ${toToml(child)}`);
  return `{${parts.join(", ")}}`;
}

/** How the probe spawns codex. `bin` is a test seam; production resolves it. */
// `env` is widened from NodeJS.ProcessEnv because the caller hands over the
// merged turn env (lib/agentEnv.ts), a plain Record without the NODE_ENV the
// augmented type demands, since the probe must run in the turn's environment
// rather than the server's.
export type CodexProbeOpts = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  bin?: string;
  /** Test seam for the win32 batch-shim path below; defaults to this host. */
  platform?: NodeJS.Platform;
};

const spec = (args: string[], opts: CodexProbeOpts) => spawnSpec(resolveCodexBin(opts.bin), args, { platform: opts.platform });

/** `codex-cli 0.146.0` -> `0.146.0`. Null when the binary is missing or mute. */
export async function codexCliVersion(opts: CodexProbeOpts = {}): Promise<string | null> {
  try {
    const spec_ = spec(["--version"], opts);
    const { stdout } = await run(spec_.command, spec_.args, {
      timeout: 10_000,
      env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
      windowsVerbatimArguments: spec_.windowsVerbatimArguments,
    });
    return stdout.match(/(\d+\.\d+\.\d+[\w.+-]*)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** What `codex doctor --json` said the effective model provider is. */
export type CodexDoctorReading =
  | { kind: "provider"; provider: string; cliVersion: string | null }
  | { kind: "unreadable"; detail: string }
  /** The probe can't compose faithful argv for this binary; see readCodexProvider. */
  | { kind: "unquotable" };

/**
 * Ask the CLI which provider it resolved, handing it the same `-c` overrides the
 * SDK will. Reads ONLY `checks["config.load"].details["model provider"]`: the
 * report's `overallStatus` is `fail` whenever a local server happens to be down,
 * which says nothing about whether the mapping took and must never refuse a turn
 * on its own.
 */
export async function readCodexProvider(overrides: string[], opts: CodexProbeOpts = {}): Promise<CodexDoctorReading> {
  const args = ["doctor", "--json"];
  for (const o of overrides) args.push("--config", o);
  const spec_ = spec(args, opts);
  // A win32 batch shim has to be run through `cmd.exe /d /s /c`, whose quoting
  // rules are not the C-runtime ones every other caller here relies on, and
  // every override sent here carries embedded quotes (`model_provider="…"`),
  // unlike the fixed tokens bin.ts was written for. So on that one path the argv
  // the CLI receives may not be the argv composed here, and a "wrong provider"
  // answer would be evidence about the quoting rather than about the mapping.
  // Report it as its own thing instead of refusing on it.
  if (spec_.windowsVerbatimArguments) return { kind: "unquotable" };
  let stdout = "";
  try {
    ({ stdout } = await run(spec_.command, spec_.args, {
      timeout: CODEX_PROVIDER_CHECK_MS,
      // doctor exits nonzero when any check fails (an unreachable local server
      // is the common one), and still prints the whole report; read the body,
      // not the exit code.
      cwd: opts.cwd,
      env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
      windowsVerbatimArguments: spec_.windowsVerbatimArguments,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (e) {
    const err = e as { code?: string; stdout?: string; killed?: boolean };
    if (err.code === "ENOENT") return { kind: "unreadable", detail: "the codex CLI isn't installed in this workspace" };
    if (err.killed) return { kind: "unreadable", detail: `it did not answer within ${CODEX_PROVIDER_CHECK_MS}ms` };
    stdout = err.stdout ?? "";
    if (!stdout.trim()) return { kind: "unreadable", detail: "it produced no report" };
  }
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { kind: "unreadable", detail: "its report wasn't JSON" };
  }
  const doc = report as { codexVersion?: unknown; checks?: Record<string, { details?: Record<string, unknown> }> };
  const cliVersion = typeof doc.codexVersion === "string" ? doc.codexVersion : null;
  const provider = doc.checks?.["config.load"]?.details?.["model provider"];
  if (typeof provider !== "string")
    return { kind: "unreadable", detail: "its report no longer carries the resolved model provider" };
  return { kind: "provider", provider, cliVersion };
}

/**
 * The gate the driver calls before building a Codex client for a turn whose
 * project (or task) redirects to a local endpoint or the LiteLLM gateway.
 * `{ ok: true }` for the cloud, which needs no mapping and so has nothing to
 * prove. The provider id it asserts on comes from the config it was handed, so
 * both entries are checked the same way.
 */
export async function verifyCodexProvider(local: CodexProviderConfig, opts: CodexProbeOpts = {}): Promise<CodexProviderVerdict> {
  if (Object.keys(local.config).length === 0) return { ok: true, cliVersion: null };
  const baseUrl = baseUrlOf(local) ?? "";
  if (!CODEX_PROVIDER_CHECK) return { ok: true, cliVersion: null };

  // The CLI moves independently of this app, so the remembered verdict is only
  // as good as the version that earned it. `codex --version` is ~30ms warm; the
  // doctor probe it guards is ~1s, and both are skipped entirely on the cloud
  // path above.
  const version = await codexCliVersion(opts);
  if (version && getSetting(okKey(baseUrl)) === version) return { ok: true, cliVersion: version };

  const reading = await readCodexProvider(serializeCodexConfigOverrides(local.config), opts);
  // The one case that passes without proof. Refusing here would break every
  // Windows instance whose codex is an npm `.cmd` shim on a suspicion about
  // the quoting, so it degrades to the pre-check behaviour and says so out
  // loud once per turn. Pinning CODEX_CLI_PATH at the real `codex.exe` spawns
  // it directly and restores the check.
  if (reading.kind === "unquotable") {
    console.warn(
      `[codex] running a local-endpoint turn UNVERIFIED: the resolved codex is a batch shim, whose command line ` +
        `can't carry the provider overrides faithfully enough to check. Point CODEX_CLI_PATH at the codex ` +
        `executable to re-enable the check.`
    );
    return { ok: true, cliVersion: version };
  }
  if (reading.kind === "unreadable")
    return { ok: false, message: unverifiableMessage(reading.detail, version, baseUrl) };
  if (reading.provider !== providerIdOf(local))
    return { ok: false, message: mismatchMessage(reading.provider, reading.cliVersion ?? version, baseUrl) };

  setSetting(okKey(baseUrl), reading.cliVersion ?? version ?? CODEX_PROVIDER_MIN_VERSION);
  return { ok: true, cliVersion: reading.cliVersion ?? version };
}

/** Forget every remembered verdict: for a test, or a deliberate re-probe. */
export function clearCodexProviderChecks(baseUrl: string): void {
  setSetting(okKey(baseUrl), null);
}

/** The entry's own id: `calandria-local` or `calandria-gateway`. Read back off
 *  the config rather than assumed, so the probe checks the provider the turn
 *  will actually select. */
function providerIdOf(local: CodexProviderConfig): string {
  const id = local.config.model_provider;
  return typeof id === "string" ? id : CODEX_LOCAL_PROVIDER_ID;
}

function baseUrlOf(local: CodexProviderConfig): string | null {
  const providers = local.config.model_providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return null;
  const entry = (providers as Record<string, CodexConfigValue>)[providerIdOf(local)];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const url = (entry as Record<string, CodexConfigValue>).base_url;
  return typeof url === "string" ? url : null;
}

// Both messages name the CLI version, because the version is the thing that
// changed: the mapping was right until the binary moved. The runner persists
// them verbatim to the transcript.

function mismatchMessage(actual: string, version: string | null, baseUrl: string): string {
  return (
    `Refusing this turn: the local model provider didn't take. codex ${version ?? "(unknown version)"} reports ` +
    `model_provider = "${actual}", not "${CODEX_LOCAL_PROVIDER_ID}", so the turn would have run against your ` +
    `ChatGPT login and billed your paid quota instead of ${baseUrl || "the local endpoint"}. ` +
    `That usually means a codex release changed the config.toml schema Calandria maps onto ` +
    `(model_provider / model_providers.<name> / wire_api = "responses"). Pin a known-good binary with ` +
    `CODEX_CLI_PATH (validated against codex ${CODEX_PROVIDER_MIN_VERSION}), or switch this project's ` +
    `Model provider back to Cloud in its settings.`
  );
}

function unverifiableMessage(detail: string, version: string | null, baseUrl: string): string {
  return (
    `Refusing this turn: couldn't confirm the local model provider took — asked codex ` +
    `${version ?? "(unknown version)"} for its effective configuration and ${detail}. Calandria refuses rather ` +
    `than risk running ${baseUrl || "this turn"} against your paid ChatGPT login. The check needs ` +
    `codex ${CODEX_PROVIDER_MIN_VERSION} or newer (\`codex doctor --json\`); upgrade the CLI, or set ` +
    `CALANDRIA_CODEX_PROVIDER_CHECK=off to run the turn unverified.`
  );
}
