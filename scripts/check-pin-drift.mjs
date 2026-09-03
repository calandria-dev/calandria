#!/usr/bin/env node
// Advance notice for the Dockerfile's pinned CLIs, in two classes: the pin
// that is GONE, and the pin that is merely BEHIND.
//
// CLASS ONE, GONE. Most pins in the Dockerfile are safe to leave stale: npm
// keeps every published version, and Debian's own repos keep several, so a pin
// that has fallen behind still builds. Two do not have that property, and both
// have already broken the image build with no warning:
//
//   - `gh=<version>` — cli.github.com's apt repo carries ONLY its newest
//     release. Once gh publishes, the pinned version is not merely old, it is
//     gone, and `apt-get install gh=<old>` fails outright. This is the worse
//     of the two: publish-image.yml's `type=gha` layer cache means CI keeps
//     reusing the layer that installed the old version, so `Publish image`
//     stays green while every uncached build fails. Found only because PR #183
//     verified with a cold local build.
//   - `AGY_VERSION` — the Antigravity auto-updater manifest names exactly one
//     build. The Dockerfile fails loudly on a stale pin by design (it compares
//     the manifest URL to the ARG), so this one at least breaks visibly, but
//     it still breaks. Issue #182 was the second time it fired.
//
// The pins stay (issue #21, and the comments at both sites explain why); what
// this adds is the warning. Run by .github/workflows/pin-drift.yml on a daily
// cron, which files or updates one labeled issue when either upstream moves,
// and closes it once the Dockerfile catches up.
//
// CLASS TWO, BEHIND: CLAUDE_CODE_VERSION and CODEX_VERSION. Both are on npm,
// which keeps old versions, so a stale pin still BUILDS. What it breaks is
// behaviour, and the reasonable-sounding assumption that a model line is purely
// server-side — the CLI fetches its catalog per account at startup — is wrong.
// On 2026-09-03 `@openai/codex` was pinned at 0.146.0 while upstream was at
// 0.153.1, seven minors back, and GPT-6 Astra could not run on it at all: the
// CLI warned "Defaulting to fallback metadata; this can degrade performance and
// cause issues" and then failed outright with "model requires a newer version
// of codex". A new model can require a CLI bump, so a stale pin here is a
// shipped feature that does not work.
//
// The first version of this check skipped both, for a real reason:
// @anthropic-ai/claude-code published 25 releases in the 23 days to 2026-09-03,
// so "something newer exists" would file a notice every single day, which is
// exactly the noise .github/dependabot.yml excludes it for. These two are
// therefore reported on STALENESS rather than on difference — see
// MAX_PIN_AGE_DAYS and MAX_MINORS_BEHIND. Both triggers would have fired on
// 0.146.0 about two weeks before Astra shipped.
//
// The half no job can do is exercising the agent, which needs a real Claude or
// ChatGPT login. That stays a human step, spelled out in the issue body this
// writes (`BUMP_CHECKLIST`) rather than in a doc nobody opens at bump time.
//
// Usage:
//   node scripts/check-pin-drift.mjs [--dockerfile <path>] [--report <path>]
//
// Exit codes are the workflow's control flow, so keep them distinct:
//   0  every pin matches upstream
//   1  at least one pin has aged out (report written, if asked for)
//   2  the check itself could not run (bad args, unparseable Dockerfile,
//      upstream unreachable) — a red job rather than a wrong all-clear

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

// A class-two pin is reported once it is this OLD, not once something newer
// exists. Age is the only metric that survives claude-code's release rate (25
// in 23 days, all on one minor line): at three weeks each package can produce
// at most one notice per three weeks, and the issue closes itself on the bump.
const MAX_PIN_AGE_DAYS = 21;

// Second trigger, for a 0.x CLI where the wire protocol moves on the MINOR.
// @openai/codex went 0.146 → 0.153 in five weeks; a pin several minors back is
// a broken feature well before it is an old pin, so this fires independently of
// age. Counted as DISTINCT newer minors, since a package that ships four
// patches of one minor has not moved anywhere.
const MAX_MINORS_BEHIND = 3;

// Both arches are checked rather than just amd64: the image is built for both
// (publish-image.yml's matrix), each has its own apt index and its own agy
// tarball with its own SHA-512, and a pin only has to be missing on one of
// them to fail half the build.
const ARCHES = ["amd64", "arm64"];

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_ATTEMPTS = 3;

function parseArgs(argv) {
  const opts = { dockerfile: "Dockerfile", report: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dockerfile" || arg === "--report") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a path`);
      opts[arg === "--dockerfile" ? "dockerfile" : "report"] = value;
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
        `could not find ${label} in ${dockerfilePath} — the pin moved or was ` +
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
    // Matches the `gh=2.99.0` inside the apt-get install line. Anchored on the
    // word boundary so it cannot pick up a longer package name ending in "gh".
    gh: find(/\bgh=(\d[^\s\\]*)/, "the `gh=` apt pin"),
    claudeCode: find(
      /^ARG CLAUDE_CODE_VERSION=(\S+)/m,
      "`ARG CLAUDE_CODE_VERSION`",
    ),
    codexVersion: find(/^ARG CODEX_VERSION=(\S+)/m, "`ARG CODEX_VERSION`"),
  };
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
 * Newest `gh` in the apt repo, per architecture. The index is a Debian control
 * file: stanzas separated by blank lines, one field per line. It currently
 * holds a single stanza, but parse it as the format rather than the instance.
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
 * The full registry packument, which is the only document carrying publish
 * TIMES — the abbreviated (`application/vnd.npm.install-v1+json`) form drops
 * `time`, and there is no lighter endpoint for it. Costs ~1.3 MiB gzipped for
 * @openai/codex, which is nothing on a daily cron.
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
 * Pure, and exported, so tests/pinDrift.test.ts can pin both thresholds and the
 * prerelease handling without reaching the registry.
 *
 * Returns null when the pin is current enough to stay quiet — being merely
 * behind is the normal state of these two and is not worth an issue.
 */
export function npmStaleness({ pinned, latest, pinnedAt, versions, now }) {
  if (pinned === latest) return null;
  const at = pinnedAt ? Date.parse(pinnedAt) : NaN;
  const ageDays = Number.isNaN(at)
    ? null
    : Math.floor(((now ?? Date.now()) - at) / 86_400_000);
  // Distinct minor lines published ABOVE the pinned one. Two exclusions, both
  // so the number means what its label says: prereleases are never what the
  // Dockerfile installs, and later patches of the pin's OWN minor are not a
  // newer minor (0.146.1 would otherwise make 0.146 count as one).
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

async function collectFindings(pins) {
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
  for (const { pkg, pin, arg } of NPM_PINS) {
    const up = await upstreamNpm(pkg);
    npm[pkg] = up.latest;
    const verdict = npmStaleness({
      pinned: pins[pin].value,
      latest: up.latest,
      pinnedAt: up.time[pins[pin].value],
      versions: up.versions,
    });
    if (!verdict) continue;
    stale.push({
      pin: `\`${arg}\``,
      pkg,
      where: pins[pin].where,
      pinned: pins[pin].value,
      upstream: up.latest,
      why: verdict.reasons.join(", "),
    });
  }

  return { findings, stale, observed: { gh, agy, npm } };
}

// The step no job can take. Exercising an agent CLI needs a real Claude or
// ChatGPT login, which CI does not have and should not be handed. So the honest
// answer to "exercise the agent" is a documented manual step, and it is carried
// in the issue body — read at the moment somebody acts on it — rather than in a
// doc that would go stale unopened.
const BUMP_CHECKLIST = [
  "### Before merging a bump",
  "",
  "No job can do this part: exercising an agent CLI needs a real Claude or",
  "ChatGPT login. Do it by hand on the bump PR.",
  "",
  "1. Move the Dockerfile ARG. For Codex, move `@openai/codex-sdk` in the same",
  "   commit (`npm install --save-exact @openai/codex-sdk@<version>`): the SDK",
  "   exact-depends on `@openai/codex`, and outside the image — where",
  "   `CODEX_CLI_PATH` is empty — that vendored copy is the binary that runs.",
  "   `tests/cliPins.test.ts` fails if the two disagree.",
  "2. `npm run typecheck && npm test`.",
  "3. Build the image and run one real turn per bumped agent against a live",
  "   login: a plain prompt, one tool call, one `/clear`. A CLI too old for a",
  "   model the driver offers says so on the first turn — 0.146.0 answered",
  "   GPT-6 Astra with `model requires a newer version of codex`.",
  "4. Check the driver's model catalog against what the new CLI actually",
  "   offers, and add anything it has gained.",
  "",
];

function buildReport({ findings, stale, observed }, pins) {
  const lines = [];

  if (findings.length) {
    lines.push(
      "## Aged out — the build is broken",
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
      "## Behind — the build is fine, the feature may not be",
      "",
      "npm keeps old versions, so these still install. What goes wrong is",
      "behaviour: a new model can require a newer CLI, not just a catalog",
      "entry, so a pin this far back can make a shipped feature fail outright.",
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
    ...NPM_PINS.map(
      ({ pkg, pin, arg }) =>
        `| \`${pkg}\` | \`${observed.npm[pkg]}\` | \`${arg}=${pins[pin].value}\` |`,
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
  const result = await collectFindings(pins);

  const total = result.findings.length + result.stale.length;
  if (total === 0) {
    console.log(
      `Pins are current: gh=${pins.gh.value}, ` +
        `AGY_VERSION=${pins.agyVersion.value}, ` +
        `CLAUDE_CODE_VERSION=${pins.claudeCode.value}, ` +
        `CODEX_VERSION=${pins.codexVersion.value}.`,
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
