#!/usr/bin/env node
// Checks the Dockerfile's pinned CLI versions against upstream. A pin that's
// GONE (`gh=`, `AGY_VERSION`: their upstreams serve only the newest build)
// fails the image build outright; a pin that's merely BEHIND
// (CLAUDE_CODE_VERSION, CODEX_VERSION, and the exactly pinned
// `@anthropic-ai/claude-agent-sdk` in package.json) still builds but can ship a
// model the CLI is too old to run, so it's reported on staleness instead. Run
// daily by .github/workflows/pin-drift.yml. That workflow automates the CLI
// pins and files or updates one labeled issue for the pins that still require
// manual review. Two behavior checks run between the pinned and latest CLIs,
// independent of the version-distance thresholds: the model each Claude Code
// family alias resolves to, and the model Codex runs when nothing overrides
// it. The Codex default is read from the fallback catalog compiled into each
// binary, offline and with an empty CODEX_HOME, so no account catalog and no
// config.toml can answer for it. Runtime discovery (lib/agents/codex/catalog.ts)
// already resolves those two per account; this check covers the value the CLI
// itself falls back to.
//
// `--update-agy` rewrites AGY_VERSION and both SHA-512 ARGs from the manifests
// this run already fetched. `--update-npm` records stale Claude Code and Codex
// CLI versions for the same bot pull request. All related pins move together
// or none of them move, malformed upstream data is refused, and automated
// findings drop out of the issue report. The workflow dispatches the complete
// test, desktop and image check set against the exact bot-branch head before
// enabling auto-merge.
//
// Usage: node scripts/check-pin-drift.mjs [--dockerfile <path>]
//        [--package-json <path>] [--report <path>]
//        --claude-alias-pinned-bin <path>
//        --claude-alias-latest-bin <path>
//        --codex-default-pinned-bin <path>
//        --codex-default-latest-bin <path>
//        [--update-agy] [--agy-summary <path>] [--apply-agy <path>]
//        [--update-npm] [--npm-summary <path>] [--apply-npm <path>]
// Exit codes: 0 = current, 1 = drift found (report written), 2 = check itself failed.

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const AGY_MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const GH_PACKAGES_BASE = "https://cli.github.com/packages/dists/stable/main";
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
// of it. It is an ordinary dependency, and it is the turn contract itself, not
// a subprocess. `tests/cliPins.test.ts` holds it to an exact version, so
// nothing floats it and nothing else reports that it is behind.
//
// Age and patch distance both fire for this one. The SDK moves on the PATCH
// inside a single 0.3.x minor (0.3.159 to 0.3.263 is 104 patches and zero
// minors), so MAX_MINORS_BEHIND counts nothing here and MAX_PATCHES_BEHIND is
// what sees a gap. Each trigger is bounded to one notice per package per
// window and the issue closes itself on the bump. This pin stays issue-only
// while the CLI ARGs go to the bot pull request: the SDK is the turn contract
// every Claude session runs through, so its bump wants a behavioural review.
const PACKAGE_JSON_PINS = [{ pkg: "@anthropic-ai/claude-agent-sdk" }];

// A class-two pin is reported once it reaches this age, regardless of
// whether something newer exists. Age is the only metric that stays quiet
// under a fast release cadence on one minor line: each package can produce
// at most one notice per window, and the issue closes itself on the bump.
const MAX_PIN_AGE_DAYS = 21;

// Second trigger, for a 0.x CLI where the wire protocol moves on the minor.
// A pin several minors back can be a broken feature well before it's an old
// pin, so this fires independently of age. Counted as distinct newer minors,
// since a package that ships several patches of one minor hasn't moved.
const MAX_MINORS_BEHIND = 3;

// Third trigger, for a package that ships nearly every release inside one
// minor line, where the two above are both blind. Counted as stable releases
// published above the pin within the pin's own major.minor. Claude Code put 18
// patches between 2.1.260 and 2.1.278 while minorsAhead stayed 0 and the age
// clock still had 5 days to run.
//
// The number comes from the measured cadence of @anthropic-ai/claude-code and
// @anthropic-ai/claude-agent-sdk, which publish 6 to 8 stable releases a week
// on one minor line (npm registry `time` map, read 2026-09-19). Across the
// whole 2.1 and 0.3 lines, reaching 5 patches ahead took a median of 5.3 days
// and never less than 1.0 day. So a pin left alone is reported inside a week,
// and a pin bumped to the newest version cannot be reported again on the day
// upstream publishes. @openai/codex moves its minor (0.155 carried 2
// releases), so this trigger stays quiet there and MAX_MINORS_BEHIND remains
// its signal.
const MAX_PATCHES_BEHIND = 5;

// Both arches are checked, not just amd64: the image is built for both
// (publish-image.yml's matrix), each has its own apt index and its own agy
// tarball with its own SHA-512, and a pin only has to be missing on one of
// them to fail half the build.
const ARCHES = ["amd64", "arm64"];

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
    updateAgy: false,
    agySummary: null,
    applyAgy: null,
    updateNpm: false,
    npmSummary: null,
    applyNpm: null,
    codexEmbeddedDefault: CODEX_EMBEDDED_DEFAULT_JSON,
    pinnedClaude: null,
    latestClaude: null,
    pinnedCodex: null,
    latestCodex: null,
  };
  const paths = {
    "--dockerfile": "dockerfile",
    "--package-json": "packageJson",
    "--report": "report",
    "--agy-summary": "agySummary",
    "--apply-agy": "applyAgy",
    "--npm-summary": "npmSummary",
    "--apply-npm": "applyNpm",
    "--codex-embedded-default": "codexEmbeddedDefault",
    "--claude-alias-pinned-bin": "pinnedClaude",
    "--claude-alias-latest-bin": "latestClaude",
    "--codex-default-pinned-bin": "pinnedCodex",
    "--codex-default-latest-bin": "latestCodex",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--update-agy") {
      opts.updateAgy = true;
    } else if (arg === "--update-npm") {
      opts.updateNpm = true;
    } else if (paths[arg]) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a path`);
      opts[paths[arg]] = value;
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  if (opts.agySummary && !opts.updateAgy) {
    throw new Error(
      "--agy-summary describes what --update-agy wrote, so it needs --update-agy",
    );
  }
  if (opts.applyAgy && opts.updateAgy) {
    throw new Error(
      "--apply-agy replays a decision --update-agy already made; pass one or the other",
    );
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
  if (!opts.applyAgy && !opts.applyNpm && !opts.pinnedClaude) {
    throw new Error(
      "--claude-alias-pinned-bin and --claude-alias-latest-bin are required to check Claude alias resolution",
    );
  }
  if (Boolean(opts.pinnedCodex) !== Boolean(opts.latestCodex)) {
    throw new Error(
      "--codex-default-pinned-bin and --codex-default-latest-bin must name the two installed Codex binaries together",
    );
  }
  if (!opts.applyAgy && !opts.applyNpm && !opts.pinnedCodex) {
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
    agyVersion: find(/^ARG AGY_VERSION=(\S+)/m, "`ARG AGY_VERSION`"),
    agySha: {
      amd64: find(/^ARG AGY_SHA512_AMD64=(\S+)/m, "`ARG AGY_SHA512_AMD64`"),
      arm64: find(/^ARG AGY_SHA512_ARM64=(\S+)/m, "`ARG AGY_SHA512_ARM64`"),
    },
    // Matches the `gh=<version>` inside the apt-get install line. Anchored
    // on the word boundary so it can't pick up a longer package name ending in "gh".
    gh: find(/\bgh=(\d[^\s\\]*)/, "the `gh=` apt pin"),
    claudeCode: find(
      /^ARG CLAUDE_CODE_VERSION=(\S+)/m,
      "`ARG CLAUDE_CODE_VERSION`",
    ),
    codexVersion: find(/^ARG CODEX_VERSION=(\S+)/m, "`ARG CODEX_VERSION`"),
  };
}

// The three ARGs an agy bump moves, paired with the key each takes its new
// value from. One list, so extraction and rewriting can never watch different
// ARGs.
const AGY_ARGS = [
  { arg: "AGY_VERSION", key: "version" },
  { arg: "AGY_SHA512_AMD64", key: "amd64" },
  { arg: "AGY_SHA512_ARM64", key: "arm64" },
];

// What the Dockerfile will accept. The version goes into a `case` glob against
// the manifest URL and the digests go into `sha512sum -c`, so anything outside
// these shapes would fail the build after the PR is open rather than here.
const AGY_VERSION_SHAPE = /^\d+(?:\.\d+){1,3}$/;
const SHA512_SHAPE = /^[0-9a-f]{128}$/;

/**
 * What an agy bump would write, or null when the Dockerfile already says it.
 * Pure, so tests/pinDrift.test.ts can drive every refusal without a network.
 *
 * Refuses rather than guesses. A manifest missing a field, a version or digest
 * in a shape the Dockerfile could not use, and two arches advertising
 * different versions are all upstream states this cannot turn into one
 * reviewable commit, and half a bump is worse than none: the Dockerfile's own
 * guard compares the manifest URL against AGY_VERSION, so a version written
 * without its digests fails `sha512sum -c` on both arches.
 *
 * A version going BACKWARDS is not refused. The manifest is the only thing the
 * build resolves against, so a vendor rollback has to be followed, not ignored.
 */
export function agyBumpPlan(pins, perArch) {
  const seen = {};
  for (const arch of ARCHES) {
    const manifest = perArch?.[arch];
    if (
      !manifest ||
      typeof manifest.version !== "string" ||
      typeof manifest.sha512 !== "string"
    ) {
      throw new Error(
        `the agy ${arch} manifest has no version/sha512, so there is nothing ` +
          "safe to write into the Dockerfile",
      );
    }
    const sha512 = manifest.sha512.trim().toLowerCase();
    if (!AGY_VERSION_SHAPE.test(manifest.version)) {
      throw new Error(
        `the agy ${arch} manifest names version \`${manifest.version}\`, ` +
          "which is not a shape the Dockerfile's AGY_VERSION guard can match",
      );
    }
    if (!SHA512_SHAPE.test(sha512)) {
      throw new Error(
        `the agy ${arch} manifest's sha512 is not 128 hex characters, so ` +
          "`sha512sum -c` could not read it",
      );
    }
    seen[arch] = { version: manifest.version, sha512 };
  }

  if (seen.amd64.version !== seen.arm64.version) {
    throw new Error(
      "the agy manifests disagree on the version: amd64 serves " +
        `${seen.amd64.version} and arm64 serves ${seen.arm64.version}. One ` +
        "AGY_VERSION covers both arches, so this waits for upstream to settle",
    );
  }

  const version = seen.amd64.version;
  const from = pins.agyVersion.value;
  const current =
    version === from &&
    seen.amd64.sha512 === pins.agySha.amd64.value.toLowerCase() &&
    seen.arm64.sha512 === pins.agySha.arm64.value.toLowerCase();
  if (current) return null;

  return {
    // A rebuilt tarball under an unchanged version is a different sentence for
    // whoever reads the PR title, and it is the case worth looking at hardest.
    kind: version === from ? "digest" : "version",
    version,
    from,
    amd64: seen.amd64.sha512,
    arm64: seen.arm64.sha512,
  };
}

/**
 * The bump applied to the Dockerfile source. Returns the whole new text, so
 * the caller writes once and the three ARGs land together or not at all.
 * `changed` is false when the source already carries every value, which is
 * what makes re-running this a no-op.
 */
export function applyAgyPin(source, plan, dockerfilePath = "Dockerfile") {
  // Located before anything is rewritten: a Dockerfile missing one of the
  // three must not come back with the other two moved.
  const sites = AGY_ARGS.map(({ arg, key }) => {
    const value = plan?.[key];
    if (typeof value !== "string" || !value) {
      throw new Error(`the agy bump has no \`${key}\` to write into ${arg}`);
    }
    const match = new RegExp(`^ARG ${arg}=(\\S+)`, "m").exec(source);
    if (!match) {
      throw new Error(
        `could not find \`ARG ${arg}\` in ${dockerfilePath}: the pin moved ` +
          "or was renamed, so this check is no longer looking at the real thing",
      );
    }
    return { match, value };
  });

  let out = source;
  let changed = false;
  // Highest offset first, so a replacement can never shift an offset that has
  // not been used yet. Sorted rather than assumed: the offsets come from the
  // file, and nothing says the ARGs appear in AGY_ARGS order.
  const ordered = [...sites].sort((a, b) => b.match.index - a.match.index);
  for (const { match, value } of ordered) {
    if (match[1] === value) continue;
    // Only the captured value is replaced, so anything the line carries after
    // it survives.
    const start = match.index + match[0].length - match[1].length;
    out = out.slice(0, start) + value + out.slice(start + match[1].length);
    changed = true;
  }
  return { source: out, changed };
}

/** The Codex embedded default recorded for ARG CODEX_VERSION. */
export const CODEX_EMBEDDED_DEFAULT_JSON = "lib/agents/codex/embeddedDefault.json";

const CLI_NPM_PLAN = [
  { pkg: "@anthropic-ai/claude-code", pin: "claudeCode", arg: "CLAUDE_CODE_VERSION" },
  { pkg: "@openai/codex", pin: "codexVersion", arg: "CODEX_VERSION" },
];

/**
 * Selects stale CLI pins for an automated bump. The Agent SDK has no
 * Dockerfile CLI coupling and stays on its behavioral-review path. The Codex
 * SDK moves to the same `codexVersion` when npm regenerates package-lock.json.
 */
export function npmBumpPlan(pins, observed, stale) {
  const staleByPackage = new Map((stale ?? []).map((entry) => [entry.pkg, entry]));
  const plan = {};
  for (const { pkg, pin } of CLI_NPM_PLAN) {
    const entry = staleByPackage.get(pkg);
    if (!entry) continue;
    const version = observed?.[pkg];
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`${pkg} latest is not an exact stable semver: ${String(version)}`);
    }
    if (version === pins[pin].value) continue;
    plan[pin] = version;
  }
  return Object.keys(plan).length ? plan : null;
}

function replaceExactArg(source, arg, value, filePath) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
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

/**
 * Update the exact Codex SDK dependency. package-lock.json must be regenerated
 * with `npm install --package-lock-only` by the workflow after this operation.
 */
export function applyNpmPackagePins(source, plan, packageJsonPath = "package.json") {
  if (plan?.codexVersion === undefined) return { source, changed: false };
  const value = plan.codexVersion;
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error("the npm bump has no valid exact version for @openai/codex-sdk");
  }
  let json;
  try {
    json = JSON.parse(source);
  } catch {
    throw new Error(`${packageJsonPath} is not JSON`);
  }
  if (json.dependencies?.["@openai/codex-sdk"] === undefined) {
    throw new Error(`could not find \`@openai/codex-sdk\` in ${packageJsonPath} dependencies`);
  }
  if (json.dependencies["@openai/codex-sdk"] === value) return { source, changed: false };
  const re = new RegExp(`(\"@openai/codex-sdk\"\\s*:\\s*\")[^\"]+(\")`);
  if (!re.test(source)) throw new Error(`could not locate \`@openai/codex-sdk\` in ${packageJsonPath}`);
  return { source: source.replace(re, `$1${value}$2`), changed: true };
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

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "calandria-pin-drift-check" },
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
 * Newest `gh` in the apt repo, per architecture. The index is a Debian
 * control file: stanzas separated by blank lines, one field per line.
 * Parsed as the general format, even though it currently holds one stanza.
 */
async function upstreamGh(arch) {
  const text = await fetchText(`${GH_PACKAGES_BASE}/binary-${arch}/Packages`);
  for (const stanza of text.split(/\n\s*\n/)) {
    if (!/^Package:\s*gh\s*$/m.test(stanza)) continue;
    const version = /^Version:\s*(\S+)\s*$/m.exec(stanza)?.[1];
    if (version) return version;
  }
  throw new Error(`no gh package stanza in the ${arch} apt index`);
}

/** The single build the Antigravity updater manifest currently names. */
async function upstreamAgy(arch) {
  // The manifest paths use the vendor's own platform names, not dpkg's.
  const manifest = arch === "amd64" ? "linux_amd64" : "linux_arm64";
  const text = await fetchText(`${AGY_MANIFEST_BASE}/${manifest}.json`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`the ${manifest} manifest is not JSON`);
  }
  if (!json.version || !json.sha512) {
    throw new Error(`the ${manifest} manifest has no version/sha512`);
  }
  return { version: json.version, sha512: json.sha512 };
}

/**
 * The full registry packument, the only document carrying publish times: the
 * abbreviated (`application/vnd.npm.install-v1+json`) form drops `time`, and
 * there is no lighter endpoint for it.
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
  if (!latest || !json.time || !json.versions) {
    throw new Error(`the ${pkg} registry document has no dist-tags/time/versions`);
  }
  return { latest, time: json.time, versions: Object.keys(json.versions) };
}

/** `0.146.3` -> `0.146`. */
function minorKey(v) {
  return v.split(".").slice(0, 2).join(".");
}

/** Numeric semver compare, prerelease suffix ignored. */
function compareVersions(a, b) {
  const parts = (v) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * Whether a class-two (npm) pin has gone stale, and which trigger says so.
 * Pure and exported, so tests/pinDrift.test.ts can pin both thresholds and
 * the prerelease handling without reaching the registry.
 *
 * Returns null when the pin is current enough to stay quiet: being merely
 * behind is the normal state of every npm pin here and doesn't warrant an
 * issue.
 */
export function npmStaleness({ pinned, latest, pinnedAt, versions, now }) {
  if (pinned === latest) return null;
  const at = pinnedAt ? Date.parse(pinnedAt) : NaN;
  const ageDays = Number.isNaN(at)
    ? null
    : Math.floor(((now ?? Date.now()) - at) / 86_400_000);
  // Distinct minor lines published above the pinned one. Two exclusions, both
  // so the number means what its label says: prereleases are never what the
  // Dockerfile installs, and later patches of the pin's own minor don't count
  // as a newer minor (0.146.1 would otherwise make 0.146 count as one).
  const pinnedMinor = minorKey(pinned);
  const minorsAhead = new Set(
    versions
      .filter((v) => !v.includes("-"))
      .map(minorKey)
      .filter((m) => compareVersions(`${m}.0`, `${pinnedMinor}.0`) > 0),
  ).size;
  // Stable releases published above the pin on the pin's own minor line. The
  // prerelease exclusion is the one above; the pin itself is excluded by the
  // strict compare, so the number is how many installable releases this line
  // has moved since the pin.
  const patchesAhead = versions.filter(
    (v) =>
      !v.includes("-") &&
      minorKey(v) === pinnedMinor &&
      compareVersions(v, pinned) > 0,
  ).length;

  const reasons = [];
  if (ageDays !== null && ageDays >= MAX_PIN_AGE_DAYS) {
    reasons.push(`pinned ${ageDays} days ago`);
  }
  if (minorsAhead >= MAX_MINORS_BEHIND) {
    reasons.push(
      `${minorsAhead} newer minor${minorsAhead === 1 ? "" : "s"} published`,
    );
  }
  if (patchesAhead >= MAX_PATCHES_BEHIND) {
    reasons.push(
      `${patchesAhead} newer patch${patchesAhead === 1 ? "" : "es"} on ${pinnedMinor}`,
    );
  }
  return reasons.length
    ? { ageDays, minorsAhead, patchesAhead, reasons }
    : null;
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
 * Both arches nearly always report the same upstream version, so reporting one
 * row per arch would just say everything twice. Collapse equal values into one
 * finding and name the arches only when they actually disagree.
 */
export function byUpstreamValue(perArch) {
  const groups = new Map();
  for (const arch of ARCHES) {
    const key = String(perArch[arch]);
    if (!groups.has(key)) groups.set(key, { value: perArch[arch], arches: [] });
    groups.get(key).arches.push(arch);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    // Empty when every arch agrees, so the common case reads plainly.
    label: g.arches.length === ARCHES.length ? "" : ` (${g.arches.join(", ")})`,
  }));
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
 * `updateAgy` drops AGY rows from `findings`, and `updateNpm` drops stale CLI
 * rows from `stale`. Those changes share one bot pull request, so repeating
 * them in the issue would duplicate work the branch already carries. The
 * upstream values still appear in the observed table because they are the
 * source of each saved bump plan.
 */
async function collectFindings(
  pins,
  packagePins,
  {
    updateAgy = false,
    updateNpm = false,
    pinnedClaude,
    latestClaude,
    pinnedCodex,
    latestCodex,
  } = {},
) {
  const findings = [];

  const gh = Object.fromEntries(
    await Promise.all(ARCHES.map(async (a) => [a, await upstreamGh(a)])),
  );
  for (const { value: upstream, label } of byUpstreamValue(gh)) {
    if (upstream === pins.gh.value) continue;
    findings.push({
      pin: `\`gh=\` apt pin${label}`,
      where: pins.gh.where,
      pinned: pins.gh.value,
      upstream,
      fix:
        `Bump the \`gh=\` version at ${pins.gh.where} to \`${upstream}\`. ` +
        "cli.github.com serves only its newest release, so " +
        `\`apt-get install gh=${pins.gh.value}\` now fails on any build ` +
        "that does not hit a cached layer.",
    });
  }

  const agy = Object.fromEntries(
    await Promise.all(ARCHES.map(async (a) => [a, await upstreamAgy(a)])),
  );
  const agyVersions = Object.fromEntries(
    ARCHES.map((a) => [a, agy[a].version]),
  );
  for (const { value: upstream, label } of updateAgy ? [] : byUpstreamValue(agyVersions)) {
    if (upstream === pins.agyVersion.value) continue;
    findings.push({
      pin: `\`AGY_VERSION\`${label}`,
      where: pins.agyVersion.where,
      pinned: pins.agyVersion.value,
      upstream,
      fix:
        `Bump \`AGY_VERSION\` at ${pins.agyVersion.where} to ` +
        `\`${upstream}\` and refresh BOTH SHA-512 ARGs from the ` +
        "manifests (the Dockerfile comment above them has the curl lines). " +
        "The manifest names one build, so the existing pin no longer " +
        "resolves and the Dockerfile's own guard fails the build.",
    });
  }

  // Digests are inherently per-arch, so these are never collapsed. Only
  // meaningful where the version still matches; a moved version is already
  // reported above and takes both digests with it.
  for (const arch of updateAgy ? [] : ARCHES) {
    if (agy[arch].version !== pins.agyVersion.value) continue;
    if (agy[arch].sha512 !== pins.agySha[arch].value) {
      // Same version, different digest: a rebuilt tarball. `sha512sum -c`
      // fails, so this breaks the build just as hard as a version move, and
      // nothing else would tell us.
      findings.push({
        pin: `\`AGY_SHA512_${arch.toUpperCase()}\``,
        where: pins.agySha[arch].where,
        pinned: `${pins.agySha[arch].value.slice(0, 16)}…`,
        upstream: `${agy[arch].sha512.slice(0, 16)}…`,
        fix:
          `The manifest still names ${agy[arch].version} but serves a ` +
          "different tarball, so `sha512sum -c` fails. Replace the digest at " +
          `${pins.agySha[arch].where} with \`${agy[arch].sha512}\` after ` +
          "confirming the change is expected.",
      });
    }
  }

  // Class two. Separate list, because "this pin no longer exists and every
  // uncached build fails" and "this pin still builds but is three weeks of
  // model releases behind" are different jobs for whoever reads the issue.
  const stale = [];
  const npm = {};
  const entries = npmPinEntries(pins, packagePins);
  for (const entry of entries) {
    const up = await upstreamNpm(entry.pkg);
    npm[entry.pkg] = up.latest;
    const verdict = npmStaleness({
      pinned: entry.pinned,
      latest: up.latest,
      pinnedAt: up.time[entry.pinned],
      versions: up.versions,
    });
    if (!verdict) continue;
    stale.push({
      pin: entry.pin,
      pkg: entry.pkg,
      where: entry.where,
      pinned: entry.pinned,
      upstream: up.latest,
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
  const npmBumps = updateNpm
    ? withCodexEmbeddedDefault(npmBumpPlan(pins, npm, stale), latestCodexDefault)
    : null;
  const bumpedPackages = new Set(
    npmBumps
      ? CLI_NPM_PLAN.filter(({ pin }) => npmBumps[pin]).map(({ pkg }) => pkg)
      : [],
  );
  return {
    findings,
    aliasDrift,
    codexDefaultDrift,
    stale: updateNpm
      ? stale.filter(({ pkg }) => !bumpedPackages.has(pkg))
      : stale,
    entries,
    npmBumps,
    observed: { gh, agy, npm },
  };
}

// The Agent SDK remains manual because it is the in-process turn contract.
// The CLI pins above run as subprocesses and move through the bot PR instead.
// Keep the manual SDK checklist in the issue body so it is present where the
// remaining action is assigned.
const BUMP_CHECKLIST = [
  "### Before merging an `@anthropic-ai/claude-agent-sdk` bump",
  "",
  "The SDK is the turn contract, so a bump can change how any turn behaves",
  "without changing a line of this repo. Bump it with",
  "`npm install --save-exact @anthropic-ai/claude-agent-sdk@<version>`, then:",
  "",
  '1. Re-add `"gypfile": false` to the `node_modules/better-sqlite3` entry in',
  "   `package-lock.json`. `npm install` strips it every time it rewrites the",
  "   lockfile, and `tests/lockfileGypfile.test.ts` goes red until it is put",
  "   back by hand.",
  "2. `npm run typecheck && npm test`.",
  "3. Run one real turn against a live login, covering all six of these:",
  "   a plain prompt; a tool call; a `/clear`; a turn resuming after that",
  "   `/clear`; a permission card under a NON-bypass permission mode, so",
  "   `canUseTool` actually gates instead of being skipped; and a",
  "   background/lingering turn with a mid-turn message injection. The 0.3.263",
  "   bump proved each of these is a distinct path through the SDK.",
  "",
];

function buildReport(
  { findings, aliasDrift, codexDefaultDrift, stale, entries, observed },
  pins,
  agyNote,
) {
  const lines = [];

  if (agyNote) lines.push(agyNote, "");

  if (findings.length) {
    lines.push(
      "## Aged out: the build is broken",
      "",
      "These upstreams serve only their newest version, so the pinned one is",
      "not old, it is GONE, and every uncached image build fails.",
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
      "## Behind: the build is fine, the feature may not be",
      "",
      "npm keeps old versions, so these still install. What goes wrong is",
      "behaviour: a new model can require a newer CLI, not just a catalog",
      "entry, so a pin this far back can make a shipped feature fail outright.",
      "The Agent SDK is the same problem one layer in, since it is the turn",
      "contract every Claude session runs through.",
      "",
      "| Pin | Where | Pinned | Latest | Why now |",
      "|-|-|-|-|-|",
    );
    for (const s of stale) {
      lines.push(
        `| ${s.pin} | ${s.where} | \`${s.pinned}\` | \`${s.upstream}\` | ${s.why} |`,
      );
    }
    lines.push(
      "",
      `Reported at ${MAX_PIN_AGE_DAYS} days old, ${MAX_MINORS_BEHIND} newer` +
        ` minors, or ${MAX_PATCHES_BEHIND} newer patches on the pinned minor` +
        " line, not on every release. A pin bumped to the newest version" +
        " clears all three, so this is at most one notice per pin per window.",
      "",
      ...BUMP_CHECKLIST,
    );
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
    "| Source | amd64 | arm64 |",
    "|-|-|-|",
    `| \`gh\` apt repo | \`${observed.gh.amd64}\` | \`${observed.gh.arm64}\` |`,
    `| agy manifest | \`${observed.agy.amd64.version}\` | \`${observed.agy.arm64.version}\` |`,
    "",
    "| Package | Latest | Pinned |",
    "|-|-|-|",
    ...entries.map(
      ({ pkg, pinLabel }) =>
        `| \`${pkg}\` | \`${observed.npm[pkg]}\` | \`${pinLabel}\` |`,
    ),
    "",
    `Dockerfile pins: \`gh=${pins.gh.value}\`, \`AGY_VERSION=${pins.agyVersion.value}\`.`,
    "",
    "After bumping, rebuild without the layer cache to confirm the new version",
    "actually installs (`docker build --no-cache .`, or run `Publish image`",
    "with the `no_cache` input set).",
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

/**
 * Replays a summary --update-agy already wrote, against whatever Dockerfile is
 * on disk now. No network and no decision of its own: the branch a bump is cut
 * on must carry the exact three values the check reported, not a second answer
 * from a manifest that may have moved in between.
 */
async function applySavedBump(opts) {
  const plan = JSON.parse(await readFile(opts.applyAgy, "utf8"));
  if (!plan.changed) {
    console.log("Nothing to apply: the summary records no bump.");
    return 0;
  }
  const source = await readFile(opts.dockerfile, "utf8");
  const applied = applyAgyPin(source, plan, opts.dockerfile);
  if (applied.changed) await writeFile(opts.dockerfile, applied.source, "utf8");
  console.log(
    applied.changed
      ? `Applied AGY_VERSION=${plan.version} and both SHA-512s to ${opts.dockerfile}.`
      : `${opts.dockerfile} already carries AGY_VERSION=${plan.version} and both SHA-512s.`,
  );
  return 0;
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
  const also = [
    packageApplied.changed && opts.packageJson,
    defaultApplied.changed && opts.codexEmbeddedDefault,
  ].filter(Boolean);
  console.log(
    `Applied npm CLI pins to ${opts.dockerfile}` +
      (also.length ? ` and ${also.join(" and ")}.` : "."),
  );
  return 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.applyAgy) return applySavedBump(opts);
  if (opts.applyNpm) return applySavedNpmBump(opts);
  let source = await readFile(opts.dockerfile, "utf8");
  let pins = extractPins(source, opts.dockerfile);
  const packagePins = extractPackagePins(
    await readFile(opts.packageJson, "utf8"),
    opts.packageJson,
  );
  const result = await collectFindings(pins, packagePins, {
    updateAgy: opts.updateAgy,
    updateNpm: opts.updateNpm,
    pinnedClaude: opts.pinnedClaude,
    latestClaude: opts.latestClaude,
    pinnedCodex: opts.pinnedCodex,
    latestCodex: opts.latestCodex,
  });

  if (opts.updateNpm && opts.npmSummary) {
    await writeFile(
      opts.npmSummary,
      `${JSON.stringify(result.npmBumps ?? {}, null, 2)}\n`,
      "utf8",
    );
  }

  let agyNote = null;
  if (opts.updateAgy) {
    // Throws on an upstream state no commit could be cut from, which exits 2
    // and goes red rather than writing half a bump.
    const plan = agyBumpPlan(pins, result.observed.agy);
    if (plan) {
      const applied = applyAgyPin(source, plan, opts.dockerfile);
      if (applied.changed) {
        await writeFile(opts.dockerfile, applied.source, "utf8");
        source = applied.source;
        // Re-read so the report's pin lines describe the file as it now
        // stands, not the version this run replaced.
        pins = extractPins(source, opts.dockerfile);
      }
      agyNote =
        plan.kind === "version"
          ? `The agent CLI bot PR moves agy from \`${plan.from}\` to \`${plan.version}\`.`
          : `The agent CLI bot PR refreshes the agy ${plan.version} digests.`;
      console.error(
        `Wrote AGY_VERSION=${plan.version} and both SHA-512s to ${opts.dockerfile}.`,
      );
    }
    if (opts.agySummary) {
      await writeFile(
        opts.agySummary,
        `${JSON.stringify(
          {
            changed: Boolean(plan),
            kind: plan?.kind ?? null,
            version: plan?.version ?? pins.agyVersion.value,
            from: plan?.from ?? pins.agyVersion.value,
            amd64: plan?.amd64 ?? pins.agySha.amd64.value,
            arm64: plan?.arm64 ?? pins.agySha.arm64.value,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
  }

  const total =
    result.findings.length +
    result.aliasDrift.length +
    result.codexDefaultDrift.length +
    result.stale.length;
  if (total === 0) {
    console.log(
      `Pins are current: gh=${pins.gh.value}, ` +
        `AGY_VERSION=${pins.agyVersion.value}, ` +
        `CLAUDE_CODE_VERSION=${pins.claudeCode.value}, ` +
        `CODEX_VERSION=${pins.codexVersion.value}, ` +
        PACKAGE_JSON_PINS.map(
          ({ pkg }) => `${pkg}=${packagePins[pkg].value}`,
        ).join(", ") +
        ".",
    );
    return 0;
  }

  const report = buildReport(result, pins, agyNote);
  if (opts.report) await writeFile(opts.report, report, "utf8");
  console.log(report);
  console.error(
    `\n${result.findings.length} pin(s) have aged out, ` +
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
