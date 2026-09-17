#!/usr/bin/env node
// The `Audit (npm)` job's command, wrapped so that a registry failure reads as
// "could not check" and an advisory still reds the job (issue #207).
//
// `npm audit` exits 1 for both cases, so the exit code alone cannot separate
// them and the job's check mark ends up meaning either "no advisories at or
// above the threshold" or "the registry answered 400". `--json` is the
// discriminator: a real run prints a report object carrying
// `auditReportVersion`, and the endpoint failing prints
// `{ message, error }` with no report in it. Verified against npm 10.9.3 with
// the registry pointed at a closed port and at a stub returning 400.
//
// `--audit-level` is honored under `--json` (checked both ways against a
// lockfile whose worst advisory is `high`), so the threshold this passes to npm
// is the only place the policy lives.
//
// `continue-on-error` on the workflow step is the shape to avoid here: it
// swallows a real advisory, which is the one thing the job exists to catch.

import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const LEVEL = process.env.AUDIT_LEVEL || "high";

// A retry covers a transient endpoint failure, which is the common case and
// clears on its own. It does not replace the classifier: the notice npm prints
// with the error ("This endpoint is being retired") describes a failure that
// will not clear on a second attempt.
const ATTEMPTS = Number(process.env.AUDIT_ATTEMPTS || "3");
const RETRY_MS = (process.env.AUDIT_RETRY_MS || "5000,15000").split(",").map(Number);

const ARGS = ["audit", "--package-lock-only", "--omit=dev", `--audit-level=${LEVEL}`, "--json"];

/**
 * Sort one `npm audit --json` invocation into the three outcomes that matter.
 *
 * `code === 0` is clean whatever was printed: the endpoint failing always exits
 * nonzero, so there is nothing to fail on. A nonzero exit is an advisory only
 * when the output parses and contains a report; everything else (unparseable,
 * empty, or a bare `{ message }`) is the registry rather than this repo's
 * dependencies.
 */
export function classifyAudit({ code, stdout }) {
  let report = null;
  try {
    const text = (stdout || "").trim();
    if (text) report = JSON.parse(text);
  } catch {
    report = null;
  }
  const hasReport = !!report && typeof report === "object" && "auditReportVersion" in report;

  if (code === 0) return { kind: "clean", report: hasReport ? report : null };
  if (hasReport) return { kind: "advisory", report };
  return {
    kind: "registry-error",
    report: null,
    reason: (report && typeof report.message === "string" && report.message) || "npm audit printed no report",
  };
}

/** The advisory lines a maintainer needs, read off the report rather than reprinted by a second registry call. */
export function formatAdvisories(report) {
  const counts = report?.metadata?.vulnerabilities || {};
  const lines = [];
  for (const [name, v] of Object.entries(report?.vulnerabilities || {})) {
    const via = (v.via || []).filter((x) => typeof x === "object");
    lines.push(`${name} (${v.severity}) ${v.range || ""}`.trim());
    for (const a of via) lines.push(`    ${`${a.severity}: ${a.title} ${a.url || ""}`.trim()}`);
  }
  const summary = Object.entries(counts)
    .filter(([key, n]) => key !== "total" && n > 0)
    .map(([key, n]) => `${n} ${key}`)
    .join(", ");
  return { lines, summary: summary || "none" };
}

function run() {
  return new Promise((resolve) => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npm, ARGS, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: 1, stdout: "", stderr: String(err) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const result = await run();
    if (result.stderr.trim()) process.stderr.write(result.stderr);
    last = classifyAudit(result);

    if (last.kind === "clean") {
      const { summary } = formatAdvisories(last.report || {});
      console.log(`npm audit: no advisories at or above "${LEVEL}" (reported: ${summary}).`);
      return 0;
    }

    if (last.kind === "advisory") {
      const { lines, summary } = formatAdvisories(last.report);
      console.log(`npm audit found advisories at or above "${LEVEL}": ${summary}`);
      for (const line of lines) console.log(`  ${line}`);
      console.log(`::error title=npm audit::${summary} at or above "${LEVEL}". Run \`npm audit --package-lock-only --omit=dev\` for the full report.`);
      return 1;
    }

    console.log(`npm audit attempt ${attempt}/${ATTEMPTS} did not reach the advisory endpoint: ${last.reason}`);
    if (attempt < ATTEMPTS) {
      const wait = RETRY_MS[attempt - 1] ?? RETRY_MS[RETRY_MS.length - 1] ?? 5000;
      await sleep(wait);
    }
  }

  // The advisory set could not be read, so the job has no finding to report
  // either way. A red check here would be indistinguishable from a real
  // advisory, and the job's subject is this repo's dependencies, not registry
  // uptime.
  console.log(`::warning title=npm audit unavailable::The npm advisory endpoint failed on all ${ATTEMPTS} attempts (${last.reason}). Dependencies were not checked on this run.`);
  return 0;
}

// Skip the run when imported (tests exercise the classifier directly).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
