#!/usr/bin/env node
// Advance notice for the two Dockerfile pins whose upstreams serve exactly one
// version.
//
// Most pins in the Dockerfile are safe to leave stale: npm keeps every
// published version, and Debian's own repos keep several, so a pin that has
// fallen behind still builds. Two do not have that property, and both have
// already broken the image build with no warning:
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
// DELIBERATELY NOT CHECKED: CLAUDE_CODE_VERSION and CODEX_VERSION. Both are on
// npm, which keeps old versions, so a stale pin builds fine — and
// @anthropic-ai/claude-code ships ~21 stable releases a month, so reporting it
// daily would recreate exactly the noise .github/dependabot.yml excludes it
// for. Those two are behavioural decisions, not build breaks.
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

  return { findings, observed: { gh, agy } };
}

function buildReport({ findings, observed }, pins) {
  const lines = [
    "Two of the Dockerfile's pinned CLIs are served by upstreams that offer",
    "only their newest version, so an upstream release breaks every uncached",
    `image build. ${findings.length === 1 ? "One pin has" : `${findings.length} pins have`} aged out:`,
    "",
    "| Pin | Where | Pinned | Upstream |",
    "|-|-|-|-|",
  ];
  for (const f of findings) {
    lines.push(`| ${f.pin} | ${f.where} | \`${f.pinned}\` | \`${f.upstream}\` |`);
  }
  lines.push("");
  for (const f of findings) {
    lines.push(`### ${f.pin}`, "", f.fix, "");
  }
  lines.push(
    "### Currently observed upstream",
    "",
    "| Source | amd64 | arm64 |",
    "|-|-|-|",
    `| \`gh\` apt repo | \`${observed.gh.amd64}\` | \`${observed.gh.arm64}\` |`,
    `| agy manifest | \`${observed.agy.amd64.version}\` | \`${observed.agy.arm64.version}\` |`,
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

  if (result.findings.length === 0) {
    console.log(
      `Pins are current: gh=${pins.gh.value}, AGY_VERSION=${pins.agyVersion.value}.`,
    );
    return 0;
  }

  const report = buildReport(result, pins);
  if (opts.report) await writeFile(opts.report, report, "utf8");
  console.log(report);
  console.error(`\n${result.findings.length} pin(s) have aged out.`);
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
