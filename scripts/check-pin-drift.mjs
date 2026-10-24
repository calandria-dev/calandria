#!/usr/bin/env node
// Checks the Dockerfile's and package.json's pinned versions against upstream.
// Four npm packages are bumped by pull request as soon as the registry's
// `latest` dist-tag is a newer stable version: `@anthropic-ai/claude-code`
// (ARG CLAUDE_CODE_VERSION), `@openai/codex` (ARG CODEX_VERSION),
// `@openai/codex-sdk` (package.json, always equal to the Codex CLI) and
// `@anthropic-ai/claude-agent-sdk` (package.json). The pins stay exact, so a
// build is reproducible, and the workflow runs hourly so a release reaches the
// image within about an hour. `gh` is pinned by `ARG GH_VERSION` to a release
// tarball that stays downloadable, so a newer `gh` is a notice in the issue and
// not a bump. The agy CLI has no pin: the image installs the version the vendor
// manifest serves and verifies the manifest's sha512.
//
// The Codex target is the version of `@openai/codex-sdk`'s `latest` tag, and only
// when that SDK release depends on the same `@openai/codex` version. The CLI
// is published before its SDK, and a run in between waits for the next hour
// instead of failing tests/cliPins.test.ts. A Codex bump also rewrites
// DEFAULT_CODEX_MODEL in lib/agents/codex/pricing.ts and
// lib/agents/codex/embeddedDefault.json, and only when the new default already
// has a PRICES row of its own; otherwise the Codex pin is held and the issue
// asks a person for the price.
//
// Two behavior checks run between the pinned and latest CLIs: the model each
// Claude Code family alias resolves to, and the model Codex runs when nothing
// overrides it. The Codex default is read from the fallback catalog compiled
// into each binary, offline and with an empty CODEX_HOME, so no account catalog
// and no config.toml can answer for it. Runtime discovery
// (lib/agents/codex/catalog.ts) already resolves those two per account; this
// check covers the value the CLI itself falls back to.
//
// `--update-npm` records the bump plan for the bot pull request and drops the
// planned packages from the issue report. `--apply-npm` replays a saved plan
// against the files on disk. The workflow dispatches the complete test,
// desktop and image check set against the exact bot-branch head before enabling
// auto-merge.
//
// Usage: node scripts/check-pin-drift.mjs [--dockerfile <path>]
//        [--package-json <path>] [--report <path>]
//        --claude-alias-pinned-bin <path>
//        --claude-alias-latest-bin <path>
//        --codex-default-pinned-bin <path>
//        --codex-default-latest-bin <path>
//        [--update-npm] [--npm-summary <path>] [--apply-npm <path>]
//        [--codex-embedded-default <path>] [--codex-pricing <path>]
// Exit codes: 0 = current, 1 = drift found (report written), 2 = check itself failed.

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GH_RELEASES_LATEST = "https://api.github.com/repos/cli/cli/releases/latest";
const NPM_REGISTRY = "https://registry.npmjs.org";

// The npm-installed CLIs, each with the Dockerfile ARG that pins it. The
// package here is the CLI itself, never the SDK that drives it: the image sets
// CODEX_CLI_PATH to the globally installed binary (Dockerfile's `ENV
// CODEX_CLI_PATH`), so the ARG is what actually runs a turn there.
const NPM_PINS = [
  {
    pkg: "@anthropic-ai/claude-code",
    pin: "claudeCode",
    arg: "CLAUDE_CODE_VERSION",
  },
  { pkg: "@openai/codex", pin: "codexVersion", arg: "CODEX_VERSION" },
];

// npm packages pinned in package.json `dependencies` instead of by a
// Dockerfile ARG. The Agent SDK has no ARG because the image installs no copy
// of it. It is an ordinary dependency and the turn contract itself.
// `tests/cliPins.test.ts` holds it to an exact version, and the bump plan
// rewrites that version in place (`plan.sdkVersion`).
const PACKAGE_JSON_PINS = [{ pkg: "@anthropic-ai/claude-agent-sdk" }];

const CODEX_SDK_PKG = "@openai/codex-sdk";
const AGENT_SDK_PKG = "@anthropic-ai/claude-agent-sdk";

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_ATTEMPTS = 3;
const CLAUDE_PROBE_TIMEOUT_MS = 20_000;
const CODEX_PROBE_TIMEOUT_MS = 20_000;

// The fallback model catalog is compiled into the codex binary as this
// pretty-printed JSON object. lib/agents/codex/pricing.ts documents the same
// recipe for re-checking the embedded half by hand.
const CODEX_CATALOG_NEEDLE = '{\n  "models": [';

// Keep this list aligned with PROBE_ALIASES in
// lib/agents/claude/modelProbe.ts. The drift script runs under plain Node, so
// it cannot import the application's TypeScript module graph.
export const CLAUDE_PROBE_ALIASES = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "opusplan",
];

function parseArgs(argv) {
  const opts = {
    dockerfile: "Dockerfile",
    packageJson: "package.json",
    report: null,
    updateNpm: false,
    npmSummary: null,
    applyNpm: null,
    codexEmbeddedDefault: CODEX_EMBEDDED_DEFAULT_JSON,
    codexPricing: CODEX_PRICING_TS,
    pinnedClaude: null,
    latestClaude: null,
    pinnedCodex: null,
    latestCodex: null,
  };
  const paths = {
    "--dockerfile": "dockerfile",
    "--package-json": "packageJson",
    "--report": "report",
    "--npm-summary": "npmSummary",
    "--apply-npm": "applyNpm",
    "--codex-embedded-default": "codexEmbeddedDefault",
    "--codex-pricing": "codexPricing",
    "--claude-alias-pinned-bin": "pinnedClaude",
    "--claude-alias-latest-bin": "latestClaude",
    "--codex-default-pinned-bin": "pinnedCodex",
    "--codex-default-latest-bin": "latestCodex",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--update-npm") {
      opts.updateNpm = true;
    } else if (paths[arg]) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a path`);
      opts[paths[arg]] = value;
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  if (opts.npmSummary && !opts.updateNpm) {
    throw new Error(
      "--npm-summary describes what --update-npm wrote, so it needs --update-npm",
    );
  }
  if (opts.applyNpm && opts.updateNpm) {
    throw new Error(
      "--apply-npm replays a decision --update-npm already made; pass one or the other",
    );
  }
  if (Boolean(opts.pinnedClaude) !== Boolean(opts.latestClaude)) {
    throw new Error(
      "--claude-alias-pinned-bin and --claude-alias-latest-bin must name the two installed Claude Code binaries together",
    );
  }
  if (!opts.applyNpm && !opts.pinnedClaude) {
    throw new Error(
      "--claude-alias-pinned-bin and --claude-alias-latest-bin are required to check Claude alias resolution",
    );
  }
  if (Boolean(opts.pinnedCodex) !== Boolean(opts.latestCodex)) {
    throw new Error(
      "--codex-default-pinned-bin and --codex-default-latest-bin must name the two installed Codex binaries together",
    );
  }
  if (!opts.applyNpm && !opts.pinnedCodex) {
    throw new Error(
      "--codex-default-pinned-bin and --codex-default-latest-bin are required to check the Codex default model",
    );
  }
  return opts;
}

/** 1-indexed line number of a match offset, for `Dockerfile:90`-style refs. */
function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

export function extractPins(source, dockerfilePath) {
  const find = (re, label) => {
    const m = re.exec(source);
    if (!m) {
      throw new Error(
        `could not find ${label} in ${dockerfilePath}: the pin moved or was ` +
          `renamed, so this check is no longer looking at the real thing`,
      );
    }
    return { value: m[1], where: `${dockerfilePath}:${lineOf(source, m.index)}` };
  };
  return {
    gh: find(/^ARG GH_VERSION=(\S+)/m, "`ARG GH_VERSION`"),
    claudeCode: find(
      /^ARG CLAUDE_CODE_VERSION=(\S+)/m,
      "`ARG CLAUDE_CODE_VERSION`",
    ),
    codexVersion: find(/^ARG CODEX_VERSION=(\S+)/m, "`ARG CODEX_VERSION`"),
  };
}

/** The Codex embedded default recorded for ARG CODEX_VERSION. */
export const CODEX_EMBEDDED_DEFAULT_JSON = "lib/agents/codex/embeddedDefault.json";

const CLI_NPM_PLAN = [
  { pkg: "@anthropic-ai/claude-code", pin: "claudeCode", arg: "CLAUDE_CODE_VERSION" },
  { pkg: "@openai/codex", pin: "codexVersion", arg: "CODEX_VERSION" },
];

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Selects the stale npm pins for an automated bump: both Dockerfile CLIs
 * (`claudeCode`, `codexVersion`) and the Agent SDK in package.json
 * (`sdkVersion`). `observed` maps each package to the version to move to. The
 * Codex SDK moves to the same `codexVersion` when npm regenerates
 * package-lock.json. `packagePins` is extractPackagePins()'s result and may be
 * omitted by a caller that has no SDK to plan.
 */
export function npmBumpPlan(pins, observed, stale, packagePins) {
  const staleByPackage = new Map((stale ?? []).map((entry) => [entry.pkg, entry]));
  const targets = [
    ...CLI_NPM_PLAN.map(({ pkg, pin }) => ({ pkg, pin, current: pins[pin].value })),
    ...(packagePins?.[AGENT_SDK_PKG]
      ? [{ pkg: AGENT_SDK_PKG, pin: "sdkVersion", current: packagePins[AGENT_SDK_PKG].value }]
      : []),
  ];
  const plan = {};
  for (const { pkg, pin, current } of targets) {
    if (!staleByPackage.has(pkg)) continue;
    const version = observed?.[pkg];
    if (typeof version !== "string" || !EXACT_SEMVER.test(version)) {
      throw new Error(`${pkg} latest is not an exact stable semver: ${String(version)}`);
    }
    if (version === current) continue;
    plan[pin] = version;
  }
  return Object.keys(plan).length ? plan : null;
}

function replaceExactArg(source, arg, value, filePath) {
  if (typeof value !== "string" || !EXACT_SEMVER.test(value)) {
    throw new Error(`the npm bump has no valid exact version for ${arg}`);
  }
  const re = new RegExp(`^ARG ${arg}=(\\S+)`, "m");
  const match = re.exec(source);
  if (!match) {
    throw new Error(`could not find \`ARG ${arg}\` in ${filePath}: the pin moved or was renamed`);
  }
  if (match[1] === value) return { source, changed: false };
  const start = match.index + match[0].length - match[1].length;
  return {
    source: source.slice(0, start) + value + source.slice(start + match[1].length),
    changed: true,
  };
}

/** Apply CLI ARG pins without touching unrelated Dockerfile text. */
export function applyNpmDockerfilePins(source, plan, dockerfilePath = "Dockerfile") {
  let out = source;
  let changed = false;
  for (const { pin, arg } of CLI_NPM_PLAN) {
    if (plan?.[pin] === undefined) continue;
    const applied = replaceExactArg(out, arg, plan[pin], dockerfilePath);
    out = applied.source;
    changed ||= applied.changed;
  }
  return { source: out, changed };
}

/** Rewrites one dependency's exact version in package.json text. */
function replaceExactDependency(source, json, pkg, value, packageJsonPath) {
  if (!EXACT_SEMVER.test(value)) {
    throw new Error(`the npm bump has no valid exact version for ${pkg}`);
  }
  if (json.dependencies?.[pkg] === undefined) {
    throw new Error(`could not find \`${pkg}\` in ${packageJsonPath} dependencies`);
  }
  if (json.dependencies[pkg] === value) return { source, changed: false };
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const re = new RegExp(`("${escaped}"\\s*:\\s*")[^"]+(")`);
  if (!re.test(source)) throw new Error(`could not locate \`${pkg}\` in ${packageJsonPath}`);
  return { source: source.replace(re, `$1${value}$2`), changed: true };
}

/**
 * Update the exact `@openai/codex-sdk` dependency (moves with `codexVersion`)
 * and the exact `@anthropic-ai/claude-agent-sdk` dependency (`sdkVersion`).
 * package-lock.json must be regenerated with `npm install --package-lock-only`
 * by the workflow after this operation.
 */
export function applyNpmPackagePins(source, plan, packageJsonPath = "package.json") {
  if (plan?.codexVersion === undefined && plan?.sdkVersion === undefined) {
    return { source, changed: false };
  }
  let json;
  try {
    json = JSON.parse(source);
  } catch {
    throw new Error(`${packageJsonPath} is not JSON`);
  }
  let out = source;
  let changed = false;
  for (const [pkg, value] of [
    [CODEX_SDK_PKG, plan.codexVersion],
    [AGENT_SDK_PKG, plan.sdkVersion],
  ]) {
    if (value === undefined) continue;
    const applied = replaceExactDependency(out, json, pkg, value, packageJsonPath);
    out = applied.source;
    changed ||= applied.changed;
  }
  return { source: out, changed };
}

/**
 * Carries the model probed from the latest Codex binary into a plan that moves
 * CODEX_VERSION, so the bump rewrites the recorded embedded default in the
 * same commit. The probe must have read the exact version the plan pins: a
 * release published between the npm lookup and the install would otherwise
 * record one version's model against another.
 */
export function withCodexEmbeddedDefault(plan, latest) {
  if (plan?.codexVersion === undefined) return plan;
  if (latest?.version !== plan.codexVersion) {
    throw new Error(
      `the latest Codex probe read ${String(latest?.version)}, but the bump pins ${plan.codexVersion}`,
    );
  }
  if (typeof latest.model !== "string" || !latest.model.trim()) {
    throw new Error("the latest Codex default probe did not resolve a model");
  }
  return { ...plan, codexModel: latest.model.trim() };
}

/**
 * Rewrite the recorded embedded default (CODEX_EMBEDDED_DEFAULT_JSON) to the
 * version and model a Codex bump carries. tests/cliPins.test.ts compares the
 * file against both ARG CODEX_VERSION and DEFAULT_CODEX_MODEL.
 */
export function applyCodexEmbeddedDefault(
  source,
  plan,
  filePath = CODEX_EMBEDDED_DEFAULT_JSON,
) {
  if (plan?.codexVersion === undefined) return { source, changed: false };
  const { codexVersion, codexModel } = plan;
  if (!/^\d+\.\d+\.\d+$/.test(codexVersion)) {
    throw new Error(`the npm bump has no valid exact version for ${filePath}`);
  }
  if (typeof codexModel !== "string" || !codexModel.trim()) {
    throw new Error(
      `the npm bump moves CODEX_VERSION to ${codexVersion} but carries no probed model for ${filePath}`,
    );
  }
  let json;
  try {
    json = JSON.parse(source);
  } catch {
    throw new Error(`${filePath} is not JSON`);
  }
  if (json.codexVersion === codexVersion && json.model === codexModel) {
    return { source, changed: false };
  }
  const next = { ...json, codexVersion, model: codexModel };
  return { source: `${JSON.stringify(next, null, 2)}\n`, changed: true };
}

/** The source file holding DEFAULT_CODEX_MODEL and the Codex price table. */
export const CODEX_PRICING_TS = "lib/agents/codex/pricing.ts";

const DEFAULT_CODEX_MODEL_RE = /^(export const DEFAULT_CODEX_MODEL = ")([^"]*)(";)$/m;

/** The `prefix` of every row in pricing.ts's PRICES table, in table order. */
export function codexPricePrefixes(source, filePath = CODEX_PRICING_TS) {
  const start = source.indexOf("const PRICES");
  const end = start === -1 ? -1 : source.indexOf("];", start);
  if (start === -1 || end === -1) {
    throw new Error(`could not find the PRICES table in ${filePath}`);
  }
  const prefixes = [...source.slice(start, end).matchAll(/\{\s*prefix:\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  if (!prefixes.length) throw new Error(`the PRICES table in ${filePath} has no rows`);
  return prefixes;
}

/**
 * The PRICES row a model id is billed at, by the same first-prefix match
 * estimateCostUsd() uses, or null when the model has a row of its own nowhere.
 * A model counts as priced only when it IS a row's prefix or extends one with a
 * dated suffix (`gpt-5.4-mini-2026-03-01`). A family catch-all such as `gpt-5`
 * does not price `gpt-5.7`, because those rates were published for another
 * model, so a new default under a catch-all is a pricing decision for a human.
 */
export function codexPricedPrefix(model, prefixes) {
  const row = prefixes.find((prefix) => model.startsWith(prefix));
  if (row === undefined) return null;
  const rest = model.slice(row.length);
  return rest === "" || /^-\d[\d-]*$/.test(rest) ? row : null;
}

/**
 * Splits a Codex bump the price table cannot follow off the npm plan. The
 * returned plan keeps every other pin; `unpriced` names the version and model
 * held back so the drift issue can ask for the price row.
 */
export function holdUnpricedCodexBump(plan, prefixes) {
  if (plan?.codexVersion === undefined) return { plan, unpriced: null };
  if (codexPricedPrefix(plan.codexModel, prefixes) !== null) return { plan, unpriced: null };
  const { codexVersion, codexModel, ...rest } = plan;
  return {
    plan: Object.keys(rest).length ? rest : null,
    unpriced: { version: codexVersion, model: codexModel },
  };
}

/**
 * Rewrite DEFAULT_CODEX_MODEL in pricing.ts to the model a Codex bump carries.
 * Refuses a model with no price row of its own, so the bump can never land a
 * default that estimateCostUsd() would price at another model's rates.
 */
export function applyDefaultCodexModel(source, plan, filePath = CODEX_PRICING_TS) {
  if (plan?.codexVersion === undefined) return { source, changed: false };
  const model = plan.codexModel;
  const match = DEFAULT_CODEX_MODEL_RE.exec(source);
  if (!match) {
    throw new Error(`could not find \`export const DEFAULT_CODEX_MODEL\` in ${filePath}`);
  }
  if (codexPricedPrefix(model, codexPricePrefixes(source, filePath)) === null) {
    throw new Error(`${model} has no row in the PRICES table in ${filePath}`);
  }
  if (match[2] === model) return { source, changed: false };
  return { source: source.replace(DEFAULT_CODEX_MODEL_RE, `$1${model}$3`), changed: true };
}

/**
 * The PACKAGE_JSON_PINS half, keyed by package name. Separate from
 * extractPins() so that function's signature and return shape stay exactly
 * what tests/cliPins.test.ts imports and reads.
 *
 * The version must be exact: a range means the drift check would report a pin
 * that npm is already free to move, and the exactness is what
 * tests/cliPins.test.ts asserts in the first place.
 *
 * @returns {Record<string, { value: string, where: string }>}
 */
export function extractPackagePins(source, packageJsonPath) {
  let json;
  try {
    json = JSON.parse(source);
  } catch {
    throw new Error(`${packageJsonPath} is not JSON`);
  }
  const out = {};
  for (const { pkg } of PACKAGE_JSON_PINS) {
    const value = json.dependencies?.[pkg];
    if (!value) {
      throw new Error(
        `could not find \`${pkg}\` in ${packageJsonPath} dependencies: the ` +
          "dependency moved or was renamed, so this check is no longer " +
          "looking at the real thing",
      );
    }
    if (!/^\d+\.\d+\.\d+$/.test(value)) {
      throw new Error(
        `\`${pkg}\` is \`${value}\` in ${packageJsonPath}, not an exact ` +
          "version: a range floats on its own and is not a pin this check " +
          "can report on",
      );
    }
    // The dependency block is one entry per line, so locating the key in the
    // raw text gives a `package.json:32` an issue body can be clicked through.
    const index = source.indexOf(`"${pkg}"`);
    out[pkg] = {
      value,
      where:
        index === -1
          ? packageJsonPath
          : `${packageJsonPath}:${lineOf(source, index)}`,
    };
  }
  return out;
}

async function fetchText(url, extraHeaders = {}) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "calandria-pin-drift-check", ...extraHeaders },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      // A transient failure here would otherwise file a bogus "check broke"
      // issue, so retry before giving up.
      if (attempt < FETCH_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  }
  throw new Error(`could not read ${url}: ${lastError?.message ?? lastError}`);
}

/**
 * The newest `gh` release, as a bare version. The release tag carries a
 * leading `v`. `GITHUB_TOKEN`, when set, lifts the unauthenticated rate limit.
 */
async function upstreamGh() {
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const text = await fetchText(GH_RELEASES_LATEST, headers);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("the cli/cli latest release document is not JSON");
  }
  const tag = json.tag_name;
  if (typeof tag !== "string" || !/^v?\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`the cli/cli latest release has no usable tag_name: ${String(tag)}`);
  }
  return tag.replace(/^v/, "");
}

/**
 * The registry packument for `pkg`: its `latest` dist-tag and each version's
 * declared dependencies.
 */
async function upstreamNpm(pkg) {
  const text = await fetchText(`${NPM_REGISTRY}/${pkg.replace("/", "%2f")}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`the ${pkg} registry document is not JSON`);
  }
  const latest = json["dist-tags"]?.latest;
  if (!latest || !json.versions) {
    throw new Error(`the ${pkg} registry document has no dist-tags/versions`);
  }
  return { latest, versions: json.versions };
}

/**
 * The Codex version a bump may move to, or null when none is ready. The target
 * is `@openai/codex-sdk`'s `latest`, accepted only when that SDK release depends
 * on exactly the same `@openai/codex` version, since the SDK exact-depends on
 * its CLI and tests/cliPins.test.ts holds the two equal. The CLI is published
 * before its SDK, so a run in between returns null and the next run catches up.
 */
export function codexTargetVersion(sdkLatest, sdkVersions) {
  const dep = sdkVersions?.[sdkLatest]?.dependencies?.["@openai/codex"];
  return dep === sdkLatest ? sdkLatest : null;
}

/** Numeric semver compare, prerelease suffix ignored. */
export function compareVersions(a, b) {
  const parts = (v) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * Whether an npm pin is behind. A pin is stale as soon as the registry's
 * `latest` dist-tag is a stable version (no prerelease suffix) strictly newer
 * than the pin; a prerelease or older `latest` leaves it alone. Pure and
 * exported, so tests/pinDrift.test.ts covers it without the registry.
 *
 * @returns {{ reasons: string[] } | null}
 */
export function npmStaleness({ pinned, latest }) {
  if (latest.includes("-")) return null;
  if (compareVersions(latest, pinned) <= 0) return null;
  return { reasons: [`latest is ${latest}`] };
}

/**
 * The family aliases are a CLI contract. A version can be close enough to
 * skip npm staleness while one of these aliases starts selecting a new model.
 *
 * Both maps must answer every alias. An absent answer is an operational probe
 * failure, never evidence that the two CLIs agree.
 */
export function compareClaudeAliasResolutions(pinned, latest) {
  const read = (readings, label, alias) => {
    const reading = readings?.[alias];
    if (typeof reading?.model !== "string" || !reading.model.trim()) {
      throw new Error(
        `the ${label} Claude alias probe did not resolve \`${alias}\``,
      );
    }
    if (typeof reading.version !== "string" || !reading.version.trim()) {
      throw new Error(
        `the ${label} Claude alias probe did not report a version for \`${alias}\``,
      );
    }
    return { model: reading.model.trim(), version: reading.version.trim() };
  };

  const changes = [];
  const versions = { pinned: null, latest: null };
  for (const alias of CLAUDE_PROBE_ALIASES) {
    const pinnedReading = read(pinned, "pinned", alias);
    const latestReading = read(latest, "latest", alias);
    for (const [label, reading] of [
      ["pinned", pinnedReading],
      ["latest", latestReading],
    ]) {
      if (versions[label] && versions[label] !== reading.version) {
        throw new Error(
          `the ${label} Claude alias probe reported multiple versions: ` +
            `\`${versions[label]}\` and \`${reading.version}\``,
        );
      }
      versions[label] = reading.version;
    }
    if (pinnedReading.model !== latestReading.model) {
      changes.push({
        alias,
        pinned: pinnedReading.model,
        latest: latestReading.model,
        pinnedVersion: pinnedReading.version,
        latestVersion: latestReading.version,
      });
    }
  }
  return changes;
}

/** The `system/init` row that carries an alias's resolved model id. */
function resolvedModelFromInit(line) {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  try {
    const row = JSON.parse(text);
    if (row.type !== "system" || row.subtype !== "init") return null;
    if (typeof row.model !== "string" || !row.model.trim()) return null;
    if (
      typeof row.claude_code_version !== "string" ||
      !row.claude_code_version.trim()
    ) {
      return null;
    }
    return {
      model: row.model.trim(),
      version: row.claude_code_version.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Read an alias before Claude Code can make a request. The unreachable
 * loopback endpoint keeps this side-effect free, and the child is killed as
 * soon as its init record arrives.
 */
function probeClaudeAlias(bin, alias) {
  const args = [
    "-p",
    "--bare",
    "--model",
    alias,
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "hi",
  ];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: os.tmpdir(),
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
          DISABLE_AUTOUPDATER: "1",
        },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err) {
      reject(new Error(`could not start Claude alias probe for \`${alias}\`: ${err.message}`));
      return;
    }

    let done = false;
    const finish = (err, model) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(model);
    };
    const timer = setTimeout(() => {
      finish(new Error(`Claude alias probe timed out for \`${alias}\``));
    }, CLAUDE_PROBE_TIMEOUT_MS);

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const model = resolvedModelFromInit(line);
        if (model) {
          finish(null, model);
          return;
        }
      }
    });
    child.on("error", (err) => {
      finish(new Error(`Claude alias probe failed for \`${alias}\`: ${err.message}`));
    });
    child.on("close", () => {
      finish(new Error(`Claude alias probe ended before resolving \`${alias}\``));
    });
  });
}

/** Read every family alias from one installed Claude Code binary. */
async function probeClaudeAliasResolutions(bin) {
  const readings = {};
  for (const alias of CLAUDE_PROBE_ALIASES) {
    readings[alias] = await probeClaudeAlias(bin, alias);
  }
  return readings;
}

/**
 * The fallback model catalog compiled into a codex binary. `bytes` is the
 * executable's contents (a Buffer, or its latin1 string). Exactly one catalog
 * must be present: zero means the layout changed and the check can no longer
 * see it, two means it cannot tell which one the CLI reads.
 */
export function extractCodexEmbeddedCatalog(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("latin1") : String(bytes);
  const start = text.indexOf(CODEX_CATALOG_NEEDLE);
  if (start === -1) {
    throw new Error("the codex binary embeds no fallback model catalog");
  }
  if (text.indexOf(CODEX_CATALOG_NEEDLE, start + 1) !== -1) {
    throw new Error("the codex binary embeds more than one fallback model catalog");
  }
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new Error("the codex binary's fallback model catalog is unterminated");
  }
  let catalog;
  try {
    catalog = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`the codex binary's fallback model catalog is not JSON: ${err.message}`);
  }
  if (!Array.isArray(catalog?.models)) {
    throw new Error("the codex binary's fallback model catalog has no `models` array");
  }
  return catalog;
}

/**
 * The model codex runs with no `--model`, no config.toml `model`, and no
 * account catalog: the listed entry with the lowest `priority`. Same rule as
 * `lib/agents/codex/catalog.ts` applies to the account catalog. A missing
 * `visibility` counts as listed and "hide" is the only exclusion.
 */
export function codexEmbeddedDefault(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  let best = null;
  for (const entry of models) {
    if (typeof entry?.slug !== "string" || !entry.slug.trim()) continue;
    if (entry.visibility != null && entry.visibility !== "list") continue;
    if (typeof entry.priority !== "number" || !Number.isFinite(entry.priority)) continue;
    if (best == null || entry.priority < best.priority) {
      best = { slug: entry.slug.trim(), priority: entry.priority };
    }
  }
  if (!best) {
    throw new Error("the codex fallback model catalog lists no model with a priority");
  }
  return best;
}

/**
 * The no-override default is a CLI contract in the same way the Claude
 * aliases are: a patch release can move it while every staleness threshold
 * stays quiet. Both readings must carry a model and a version. An absent
 * reading is a probe failure, never evidence that the two CLIs agree.
 */
export function compareCodexDefaults(pinned, latest) {
  const read = (reading, label) => {
    if (typeof reading?.model !== "string" || !reading.model.trim()) {
      throw new Error(`the ${label} Codex default probe did not resolve a model`);
    }
    if (typeof reading.version !== "string" || !reading.version.trim()) {
      throw new Error(`the ${label} Codex default probe did not report a version`);
    }
    return { model: reading.model.trim(), version: reading.version.trim() };
  };
  const pinnedReading = read(pinned, "pinned");
  const latestReading = read(latest, "latest");
  if (pinnedReading.model === latestReading.model) return [];
  return [
    {
      pinned: pinnedReading.model,
      latest: latestReading.model,
      pinnedVersion: pinnedReading.version,
      latestVersion: latestReading.version,
    },
  ];
}

/**
 * `@openai/codex`'s `codex` bin is a Node shim that spawns the native
 * executable from the platform package installed beside it
 * (`@openai/codex-<os>-<arch>/vendor/<triple>/bin/codex`). npm installs only
 * the platform package that matches the runner, so exactly one must be found.
 */
async function locateCodexExecutable(shim) {
  const resolved = await realpath(shim);
  const scope = path.resolve(path.dirname(resolved), "..", "..");
  const found = [];
  for (const pkg of await readdir(scope)) {
    if (!pkg.startsWith("codex-")) continue;
    const vendor = path.join(scope, pkg, "vendor");
    let triples;
    try {
      triples = await readdir(vendor);
    } catch {
      continue;
    }
    for (const triple of triples) {
      for (const name of ["codex", "codex.exe"]) {
        const candidate = path.join(vendor, triple, "bin", name);
        try {
          if ((await stat(candidate)).isFile()) found.push(candidate);
        } catch {
          // Not this platform's layout.
        }
      }
    }
  }
  if (found.length !== 1) {
    throw new Error(
      `expected one native codex executable beside \`${shim}\`, found ${found.length}` +
        (found.length ? `: ${found.join(", ")}` : ""),
    );
  }
  return found[0];
}

/**
 * `codex --version` under an empty CODEX_HOME. The CLI reads that directory
 * for config.toml and the cached account catalog, so an empty one makes the
 * reading the binary's own. `--version` sends nothing, so this is offline.
 */
async function probeCodexVersion(bin) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-default-probe-"));
  try {
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(bin, ["--version"], {
          cwd: home,
          env: { ...process.env, CODEX_HOME: home },
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch (err) {
        reject(new Error(`could not start Codex version probe: ${err.message}`));
        return;
      }
      let done = false;
      const finish = (err, version) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          child.kill();
          reject(err);
        } else {
          resolve(version);
        }
      };
      const timer = setTimeout(() => {
        finish(new Error("Codex version probe timed out"));
      }, CODEX_PROBE_TIMEOUT_MS);
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.on("error", (err) => {
        finish(new Error(`Codex version probe failed: ${err.message}`));
      });
      child.on("close", (code) => {
        const match = /(\d+\.\d+\.\d+\S*)/.exec(out);
        if (code !== 0 || !match) {
          finish(
            new Error(
              `Codex version probe exited ${code} without a version: ${JSON.stringify(out.trim())}`,
            ),
          );
        } else {
          finish(null, match[1]);
        }
      });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** The version and embedded default model of one installed codex shim. */
export async function probeCodexEmbeddedDefault(shim) {
  const version = await probeCodexVersion(shim);
  const executable = await locateCodexExecutable(shim);
  const catalog = extractCodexEmbeddedCatalog(await readFile(executable));
  return { model: codexEmbeddedDefault(catalog).slug, version };
}

/**
 * One row per npm pin, whichever file it lives in, so the staleness loop and
 * the observed-upstream table read both sources the same way. `pinLabel` is
 * what the tables print: an ARG carries its name, a package.json dependency is
 * already named by its package.
 */
export function npmPinEntries(pins, packagePins) {
  return [
    ...NPM_PINS.map(({ pkg, pin, arg }) => ({
      pkg,
      pin: `\`${arg}\``,
      where: pins[pin].where,
      pinned: pins[pin].value,
      pinLabel: `${arg}=${pins[pin].value}`,
    })),
    ...PACKAGE_JSON_PINS.map(({ pkg }) => ({
      pkg,
      pin: `\`${pkg}\``,
      where: packagePins[pkg].where,
      pinned: packagePins[pkg].value,
      pinLabel: packagePins[pkg].value,
    })),
  ];
}

/**
 * `updateNpm` drops the packages a bump plan covers from `stale`. The plan
 * rides the bot pull request, so repeating those rows in the issue would
 * duplicate work the branch already carries. The upstream values still appear
 * in the observed table because they are the source of each saved bump plan.
 */
async function collectFindings(
  pins,
  packagePins,
  {
    updateNpm = false,
    pinnedClaude,
    latestClaude,
    pinnedCodex,
    latestCodex,
    codexPricePrefixes: pricePrefixes = [],
  } = {},
) {
  const findings = [];

  // `gh` is pinned to a release tarball that stays downloadable, so a newer
  // release is a notice and never a broken build.
  const gh = await upstreamGh();
  if (compareVersions(gh, pins.gh.value) > 0) {
    findings.push({
      pin: "`GH_VERSION`",
      where: pins.gh.where,
      pinned: pins.gh.value,
      upstream: gh,
      fix:
        `A newer \`gh\` release exists. Bump \`ARG GH_VERSION\` at ${pins.gh.where} ` +
        `to \`${gh}\`. The pinned release tarball is permanent, so the build ` +
        "keeps working until you do.",
    });
  }

  const stale = [];
  const npm = {};
  const entries = npmPinEntries(pins, packagePins);
  const packuments = new Map();
  for (const entry of entries) {
    const up = await upstreamNpm(entry.pkg);
    packuments.set(entry.pkg, up);
  }
  // The Codex CLI moves only to a version its SDK is already published for.
  const codexSdk = await upstreamNpm(CODEX_SDK_PKG);
  const codexTarget = codexTargetVersion(codexSdk.latest, codexSdk.versions);
  for (const entry of entries) {
    const up = packuments.get(entry.pkg);
    const latest = entry.pkg === "@openai/codex" ? (codexTarget ?? entry.pinned) : up.latest;
    npm[entry.pkg] = latest;
    const verdict = npmStaleness({ pinned: entry.pinned, latest });
    if (!verdict) continue;
    stale.push({
      pin: entry.pin,
      pkg: entry.pkg,
      where: entry.where,
      pinned: entry.pinned,
      upstream: latest,
      why: verdict.reasons.join(", "),
    });
  }

  const aliasDrift = compareClaudeAliasResolutions(
    await probeClaudeAliasResolutions(pinnedClaude),
    await probeClaudeAliasResolutions(latestClaude),
  );
  const latestCodexDefault = await probeCodexEmbeddedDefault(latestCodex);
  const codexDefaultDrift = compareCodexDefaults(
    await probeCodexEmbeddedDefault(pinnedCodex),
    latestCodexDefault,
  );
  // A Codex bump moves DEFAULT_CODEX_MODEL with it, and that constant prices
  // every turn on an account with no catalog. A new default with no price row
  // of its own stays out of the bot PR and lands in the issue instead.
  const held = updateNpm
    ? holdUnpricedCodexBump(
        withCodexEmbeddedDefault(
          npmBumpPlan(pins, npm, stale, packagePins),
          latestCodexDefault,
        ),
        pricePrefixes,
      )
    : { plan: null, unpriced: null };
  const npmBumps = held.plan;
  const bumpedPackages = new Set(
    npmBumps
      ? [
          ...CLI_NPM_PLAN.filter(({ pin }) => npmBumps[pin]).map(({ pkg }) => pkg),
          ...(npmBumps.sdkVersion ? [AGENT_SDK_PKG] : []),
        ]
      : [],
  );
  return {
    findings,
    aliasDrift,
    // The bot PR carries a priced default change, so the issue drops it.
    codexDefaultDrift: npmBumps?.codexVersion === undefined ? codexDefaultDrift : [],
    codexUnpriced: held.unpriced,
    stale: updateNpm
      ? stale.filter(({ pkg }) => !bumpedPackages.has(pkg))
      : stale,
    entries,
    npmBumps,
    observed: { gh, npm },
  };
}

function buildReport(
  { findings, aliasDrift, codexDefaultDrift, codexUnpriced, stale, entries, observed },
  pins,
) {
  const lines = [];

  if (codexUnpriced) {
    lines.push(
      "## Codex bump held: the new default model has no price",
      "",
      `\`@openai/codex\` ${codexUnpriced.version} defaults to \`${codexUnpriced.model}\`,`,
      "and the `PRICES` table in `lib/agents/codex/pricing.ts` has no row of its",
      "own for that model. The bot PR moves `DEFAULT_CODEX_MODEL` with every Codex",
      "bump, and that constant prices every default turn, so the Codex pin stays",
      "where it is until a person decides the price.",
      "",
      "Add a `PRICES` row for the model from OpenAI's published API prices, merge",
      "it, and the next `Pin drift` run opens the Codex bump on its own.",
      "",
    );
  }

  if (findings.length) {
    lines.push(
      "## Newer release available",
      "",
      "These pins still resolve, so the build is fine. A newer upstream release",
      "exists and nothing bumps these pins automatically.",
      "",
      "| Pin | Where | Pinned | Upstream |",
      "|-|-|-|-|",
    );
    for (const f of findings) {
      lines.push(
        `| ${f.pin} | ${f.where} | \`${f.pinned}\` | \`${f.upstream}\` |`,
      );
    }
    lines.push("");
    for (const f of findings) {
      lines.push(`### ${f.pin}`, "", f.fix, "");
    }
  }

  if (stale.length) {
    lines.push(
      "## Behind: a bump is waiting",
      "",
      "The bot pull request bumps these on every new stable release. A row stays",
      "here only when no bump was planned for it in this run.",
      "",
      "| Pin | Where | Pinned | Latest | Why |",
      "|-|-|-|-|-|",
    );
    for (const s of stale) {
      lines.push(
        `| ${s.pin} | ${s.where} | \`${s.pinned}\` | \`${s.upstream}\` | ${s.why} |`,
      );
    }
    lines.push("");
  }

  if (aliasDrift.length) {
    lines.push(
      "## Alias resolution changed",
      "",
      "These family aliases resolve to different model ids in the pinned and",
      "latest Claude Code releases. This signal does not wait for a staleness",
      "threshold. Review CLI and Agent SDK compatibility before choosing a",
      "bump. Their exact pins are independently versioned.",
      "",
      "| Alias | Pinned CLI | Pinned model | Latest CLI | Latest model |",
      "|-|-|-|-|-|",
      ...aliasDrift.map(
        ({ alias, pinnedVersion, pinned, latestVersion, latest }) =>
          `| \`${alias}\` | \`${pinnedVersion}\` | \`${pinned}\` | \`${latestVersion}\` | \`${latest}\` |`,
      ),
      "",
    );
  }

  if (codexDefaultDrift.length) {
    lines.push(
      "## Codex default model changed",
      "",
      "The model Codex runs with no `--model`, no config.toml `model` and no",
      "account catalog differs between the pinned and latest `@openai/codex`",
      "releases, read from the fallback catalog compiled into each binary.",
      "This signal does not wait for a staleness threshold. An account catalog",
      "still overrides it at runtime; the app resolves that per account.",
      "Review `DEFAULT_CODEX_MODEL` in `lib/agents/codex/pricing.ts` against",
      "the new value before choosing a bump.",
      "",
      "| Pinned CLI | Pinned default | Latest CLI | Latest default |",
      "|-|-|-|-|",
      ...codexDefaultDrift.map(
        ({ pinnedVersion, pinned, latestVersion, latest }) =>
          `| \`${pinnedVersion}\` | \`${pinned}\` | \`${latestVersion}\` | \`${latest}\` |`,
      ),
      "",
    );
  }

  lines.push(
    "### Currently observed upstream",
    "",
    `Latest \`gh\` release: \`${observed.gh}\`.`,
    "",
    "| Package | Target | Pinned |",
    "|-|-|-|",
    ...entries.map(
      ({ pkg, pinLabel }) =>
        `| \`${pkg}\` | \`${observed.npm[pkg]}\` | \`${pinLabel}\` |`,
    ),
    "",
    `Dockerfile pin: \`GH_VERSION=${pins.gh.value}\`.`,
    "",
    "---",
    "",
    "Filed by `.github/workflows/pin-drift.yml`. This body is rewritten on each",
    "run and the issue closes itself once the Dockerfile catches up.",
    `Last checked: ${new Date().toISOString()}`,
    "",
  );
  return lines.join("\n");
}

async function applySavedNpmBump(opts) {
  const plan = JSON.parse(await readFile(opts.applyNpm, "utf8"));
  if (!plan || !Object.keys(plan).length) {
    console.log("Nothing to apply: the summary records no npm bump.");
    return 0;
  }
  const dockerfile = await readFile(opts.dockerfile, "utf8");
  const packageJson = await readFile(opts.packageJson, "utf8");
  const dockerApplied = applyNpmDockerfilePins(
    dockerfile,
    plan,
    opts.dockerfile,
  );
  const packageApplied = applyNpmPackagePins(
    packageJson,
    plan,
    opts.packageJson,
  );
  if (dockerApplied.changed) {
    await writeFile(opts.dockerfile, dockerApplied.source, "utf8");
  }
  if (packageApplied.changed) {
    await writeFile(opts.packageJson, packageApplied.source, "utf8");
  }
  const defaultApplied = applyCodexEmbeddedDefault(
    await readFile(opts.codexEmbeddedDefault, "utf8"),
    plan,
    opts.codexEmbeddedDefault,
  );
  if (defaultApplied.changed) {
    await writeFile(opts.codexEmbeddedDefault, defaultApplied.source, "utf8");
  }
  const modelApplied = applyDefaultCodexModel(
    await readFile(opts.codexPricing, "utf8"),
    plan,
    opts.codexPricing,
  );
  if (modelApplied.changed) {
    await writeFile(opts.codexPricing, modelApplied.source, "utf8");
  }
  const also = [
    packageApplied.changed && opts.packageJson,
    defaultApplied.changed && opts.codexEmbeddedDefault,
    modelApplied.changed && opts.codexPricing,
  ].filter(Boolean);
  console.log(
    `Applied npm CLI pins to ${opts.dockerfile}` +
      (also.length ? ` and ${also.join(" and ")}.` : "."),
  );
  return 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.applyNpm) return applySavedNpmBump(opts);
  let source = await readFile(opts.dockerfile, "utf8");
  let pins = extractPins(source, opts.dockerfile);
  const packagePins = extractPackagePins(
    await readFile(opts.packageJson, "utf8"),
    opts.packageJson,
  );
  const result = await collectFindings(pins, packagePins, {
    updateNpm: opts.updateNpm,
    pinnedClaude: opts.pinnedClaude,
    latestClaude: opts.latestClaude,
    pinnedCodex: opts.pinnedCodex,
    latestCodex: opts.latestCodex,
    codexPricePrefixes: opts.updateNpm
      ? codexPricePrefixes(await readFile(opts.codexPricing, "utf8"), opts.codexPricing)
      : [],
  });

  if (opts.updateNpm && opts.npmSummary) {
    await writeFile(
      opts.npmSummary,
      `${JSON.stringify(result.npmBumps ?? {}, null, 2)}\n`,
      "utf8",
    );
  }

  const total =
    (result.codexUnpriced ? 1 : 0) +
    result.findings.length +
    result.aliasDrift.length +
    result.codexDefaultDrift.length +
    result.stale.length;
  if (total === 0) {
    console.log(
      `Pins are current: GH_VERSION=${pins.gh.value}, ` +
        `CLAUDE_CODE_VERSION=${pins.claudeCode.value}, ` +
        `CODEX_VERSION=${pins.codexVersion.value}, ` +
        PACKAGE_JSON_PINS.map(
          ({ pkg }) => `${pkg}=${packagePins[pkg].value}`,
        ).join(", ") +
        ".",
    );
    return 0;
  }

  const report = buildReport(result, pins);
  if (opts.report) await writeFile(opts.report, report, "utf8");
  console.log(report);
  console.error(
    `\n${result.findings.length} pin(s) have a newer release, ` +
      `${result.aliasDrift.length} alias resolution(s) changed, ` +
      `${result.codexDefaultDrift.length} Codex default(s) changed, and ` +
      `${result.stale.length} are behind.`,
  );
  return 1;
}

// Only run when invoked as a script. tests/pinDrift.test.ts imports the pure
// helpers above to pin the Dockerfile regexes, and must not reach the network.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`pin drift check failed: ${err?.message ?? err}`);
      process.exit(2);
    },
  );
}
