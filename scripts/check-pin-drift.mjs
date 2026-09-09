#!/usr/bin/env node
// Checks the Dockerfile's pinned CLI versions against upstream. A pin that's
// GONE (`gh=`, `AGY_VERSION`: their upstreams serve only the newest build)
// fails the image build outright; a pin that's merely BEHIND
// (CLAUDE_CODE_VERSION, CODEX_VERSION, and the exactly pinned
// `@anthropic-ai/claude-agent-sdk` in package.json) still builds but can ship a
// model the CLI is too old to run, so it's reported on staleness instead. Run
// daily by .github/workflows/pin-drift.yml, which files or updates one labeled
// issue.
//
// Usage: node scripts/check-pin-drift.mjs [--dockerfile <path>]
//        [--package-json <path>] [--report <path>]
// Exit codes: 0 = current, 1 = drift found (report written), 2 = check itself failed.

import { readFile, writeFile } from "node:fs/promises";
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
// Only age can fire for this one. The SDK moves on the PATCH inside a single
// 0.3.x minor (0.3.159 to 0.3.263 is 104 patches and zero minors), so
// MAX_MINORS_BEHIND never counts anything. This check adds no patch-distance
// trigger: a threshold low enough to catch a real gap fires every few days on
// this cadence, which is the noise MAX_MINORS_BEHIND is shaped to avoid, and
// there is no measured number to set one at. Age is
// bounded to one notice per package per MAX_PIN_AGE_DAYS and the issue closes
// itself on the bump, so a stalled pin still surfaces within three weeks.
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

// Both arches are checked, not just amd64: the image is built for both
// (publish-image.yml's matrix), each has its own apt index and its own agy
// tarball with its own SHA-512, and a pin only has to be missing on one of
// them to fail half the build.
const ARCHES = ["amd64", "arm64"];

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_ATTEMPTS = 3;

function parseArgs(argv) {
  const opts = {
    dockerfile: "Dockerfile",
    packageJson: "package.json",
    report: null,
  };
  const paths = {
    "--dockerfile": "dockerfile",
    "--package-json": "packageJson",
    "--report": "report",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (paths[arg]) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a path`);
      opts[paths[arg]] = value;
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
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

  const reasons = [];
  if (ageDays !== null && ageDays >= MAX_PIN_AGE_DAYS) {
    reasons.push(`pinned ${ageDays} days ago`);
  }
  if (minorsAhead >= MAX_MINORS_BEHIND) {
    reasons.push(
      `${minorsAhead} newer minor${minorsAhead === 1 ? "" : "s"} published`,
    );
  }
  return reasons.length ? { ageDays, minorsAhead, reasons } : null;
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

async function collectFindings(pins, packagePins) {
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
  for (const { value: upstream, label } of byUpstreamValue(agyVersions)) {
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
  for (const arch of ARCHES) {
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

  return { findings, stale, entries, observed: { gh, agy, npm } };
}

// The step no job can take. Exercising an agent CLI needs a real Claude or
// ChatGPT login, which CI does not have and should not be handed. So this is
// a documented manual step, carried in the issue body itself instead of a
// doc that would go stale unopened.
const BUMP_CHECKLIST = [
  "### Before merging a CLI bump",
  "",
  "No job can do this part: exercising an agent CLI needs a real Claude or",
  "ChatGPT login. Do it by hand on the bump PR.",
  "",
  "1. Move the Dockerfile ARG. For Codex, move `@openai/codex-sdk` in the same",
  "   commit (`npm install --save-exact @openai/codex-sdk@<version>`): the SDK",
  "   exact-depends on `@openai/codex`, and outside the image, where",
  "   `CODEX_CLI_PATH` is empty, that vendored copy is the binary that runs.",
  "   `tests/cliPins.test.ts` fails if the two disagree. Any `npm install` here",
  "   rewrites the lockfile, so the `gypfile` step below applies to this bump",
  "   too.",
  "2. `npm run typecheck && npm test`.",
  "3. Build the image and run one real turn per bumped agent against a live",
  "   login: a plain prompt, one tool call, one `/clear`. A CLI too old for a",
  "   model the driver offers says so on the first turn: 0.146.0 answered",
  "   GPT-6 Astra with `model requires a newer version of codex`.",
  "4. Check the driver's model catalog against what the new CLI actually",
  "   offers, and add anything it has gained.",
  "",
  "### Before merging an `@anthropic-ai/claude-agent-sdk` bump",
  "",
  "Different work from the CLI above. The CLI is a subprocess; the SDK is the",
  "turn contract, so a bump can change how any turn behaves without changing a",
  "line of this repo. Bump it with",
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

function buildReport({ findings, stale, entries, observed }, pins) {
  const lines = [];

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
      `Reported at ${MAX_PIN_AGE_DAYS} days old or ${MAX_MINORS_BEHIND} newer minors,` +
        " not on every release, so this is at most one notice per pin per three weeks.",
      "",
      ...BUMP_CHECKLIST,
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const source = await readFile(opts.dockerfile, "utf8");
  const pins = extractPins(source, opts.dockerfile);
  const packagePins = extractPackagePins(
    await readFile(opts.packageJson, "utf8"),
    opts.packageJson,
  );
  const result = await collectFindings(pins, packagePins);

  const total = result.findings.length + result.stale.length;
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

  const report = buildReport(result, pins);
  if (opts.report) await writeFile(opts.report, report, "utf8");
  console.log(report);
  console.error(
    `\n${result.findings.length} pin(s) have aged out, ` +
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
