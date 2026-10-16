#!/usr/bin/env node
// Decides whether the open release-please PR may merge itself. It may only
// when every commit on main since the last `v*` tag is a dependency bump made
// by a dependency bot:
//
// - pin-drift.yml: PR opened by `github-actions[bot]` from `bot/agent-cli-pins`,
//   squash subject `build(deps): ...`.
// - Dependabot: PR opened by `dependabot[bot]`, squash subject
//   `build(deps): ...`, `build(deps-dev): ...` or `ci(deps): ...`.
//
// Anything else (a human PR, a feature, a fix, a direct commit with no PR, an
// empty range) leaves the release PR for a person, per .github/CLAUDE.md.
// release-please.yml and release-automerge.yml both run this, so the rule has
// one copy. tests/releaseAutomerge.test.ts covers the pure half.
//
// The second question is whether the release PR head is ready: every check on
// that exact commit has finished, none failed, and the lanes the ruleset does
// not require but an unattended release must have (`End-to-end (Playwright)`,
// `Desktop release artifacts`) succeeded. Auto-merge waits only for required
// checks, and this readiness check gates e2e on the unattended path alone.
//
// Usage: node scripts/release-automerge-eligible.mjs [--base <ref>] [--repo <owner/name>]
//        node scripts/release-automerge-eligible.mjs --ready <sha> [--repo <owner/name>]
//   --base defaults to origin/main. Prints a JSON verdict and exits 0 when
//   eligible (or ready), 1 when not, 2 when the check itself failed.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PIN_DRIFT_BRANCH = "bot/agent-cli-pins";

const PIN_DRIFT_SUBJECT = /^build\(deps\): \S/;
const DEPENDABOT_SUBJECT = /^(build\(deps(-dev)?\)|ci\(deps\)): \S/;

/**
 * Why one commit disqualifies the release, or null when it is a bot
 * dependency bump. `pr` is the PR the commit was merged from, or null.
 *
 * @param {{ sha: string, subject: string, pr: { author: string, head: string } | null }} commit
 */
export function disqualifier({ sha, subject, pr }) {
  const short = sha.slice(0, 7);
  if (!pr) return `${short} reached main without a pull request`;
  if (pr.author === "github-actions[bot]") {
    if (pr.head !== PIN_DRIFT_BRANCH) {
      return `${short} came from github-actions[bot] on ${pr.head}, not ${PIN_DRIFT_BRANCH}`;
    }
    return PIN_DRIFT_SUBJECT.test(subject) ? null : `${short} is not a build(deps) commit: ${subject}`;
  }
  if (pr.author === "dependabot[bot]") {
    return DEPENDABOT_SUBJECT.test(subject)
      ? null
      : `${short} is a Dependabot commit without a deps scope: ${subject}`;
  }
  return `${short} was authored by ${pr.author}: ${subject}`;
}

/** The verdict over a whole range. An empty range is never eligible. */
export function releaseEligibility(commits) {
  if (!commits.length) return { eligible: false, reasons: ["no commits since the last release"] };
  const reasons = commits.map(disqualifier).filter((r) => r !== null);
  return { eligible: reasons.length === 0, reasons };
}

/** Checks the unattended path requires on the release PR head. */
export const READY_REQUIRED = [
  "End-to-end (Playwright)",
  "Desktop release artifacts",
  "Image build",
  "Unit (vitest)",
];

const PASSING = new Set(["success", "skipped", "neutral"]);

/**
 * Whether a release PR head may merge unattended, from its check runs and its
 * commit statuses (newest first, as the API returns them). Only the newest
 * check run per name counts, by id: `filter=latest` is per check suite, so a
 * run that concurrency cancelled still appears beside its replacement.
 *
 * @param {{ id: number, name: string, status: string, conclusion: string | null }[]} checkRuns
 * @param {{ context: string, state: string }[]} statuses
 */
export function headReadiness(checkRuns, statuses) {
  const pending = [];
  const failed = [];
  const byName = new Map();
  for (const run of checkRuns) {
    if ((byName.get(run.name)?.id ?? -1) < run.id) byName.set(run.name, run);
  }
  for (const run of byName.values()) {
    if (run.status !== "completed") pending.push(run.name);
    else if (!PASSING.has(run.conclusion ?? "")) failed.push(`${run.name} (${run.conclusion})`);
  }
  const seen = new Set();
  for (const { context, state } of statuses) {
    if (seen.has(context)) continue;
    seen.add(context);
    if (state === "pending") pending.push(context);
    else if (state !== "success") failed.push(`${context} (${state})`);
  }
  const missing = READY_REQUIRED.filter((name) => byName.get(name)?.conclusion !== "success");
  return {
    ready: !pending.length && !failed.length && !missing.length,
    pending,
    failed,
    missing: missing.filter((name) => !pending.includes(name) && !failed.some((f) => f.startsWith(`${name} (`))),
  };
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function collect(base, repo) {
  const tag = run("git", ["describe", "--tags", "--abbrev=0", "--match", "v*", base]);
  const log = run("git", ["log", "--format=%H%x09%s", `${tag}..${base}`]);
  const commits = log
    ? log.split("\n").map((line) => {
        const [sha, ...rest] = line.split("\t");
        const pulls = JSON.parse(run("gh", ["api", `repos/${repo}/commits/${sha}/pulls`]));
        const merged = pulls.find((p) => p.merged_at && p.base?.ref === "main") ?? null;
        return {
          sha,
          subject: rest.join("\t"),
          pr: merged ? { author: merged.user.login, head: merged.head.ref, number: merged.number } : null,
        };
      })
    : [];
  return { tag, commits };
}

function readiness(sha, repo) {
  const checkRuns = JSON.parse(
    run("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`,
    ]),
  ).flatMap((page) => page.check_runs);
  const statuses = JSON.parse(
    run("gh", ["api", "--paginate", "--slurp", `repos/${repo}/commits/${sha}/statuses?per_page=100`]),
  ).flat();
  return headReadiness(checkRuns, statuses);
}

function main(argv) {
  let base = "origin/main";
  let repo = process.env.GITHUB_REPOSITORY ?? "calandria-dev/calandria";
  let ready = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") base = argv[++i];
    else if (argv[i] === "--repo") repo = argv[++i];
    else if (argv[i] === "--ready") ready = argv[++i];
    else throw new Error(`unrecognized argument: ${argv[i]}`);
  }
  if (ready) {
    const verdict = readiness(ready, repo);
    console.log(JSON.stringify({ sha: ready, ...verdict }, null, 2));
    return verdict.ready ? 0 : 1;
  }
  const { tag, commits } = collect(base, repo);
  const verdict = releaseEligibility(commits);
  console.log(JSON.stringify({ tag, base, ...verdict, commits }, null, 2));
  return verdict.eligible ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`release auto-merge check failed: ${err?.message ?? err}`);
    process.exit(2);
  }
}
