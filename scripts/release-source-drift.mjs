#!/usr/bin/env node
// Lists the packaged-app inputs that differ between two commits, one path per
// line. The desktop release promotes installers built from the release PR head
// only when this list is empty between that head and the release tag.
//
// Paths that cannot enter the packaged app (CI, tests, agent instructions) are
// excluded. The Dockerfile counts as a packaged input only through its COPY and
// ADD instructions, the file inventory desktop/payload-manifest.js mirrors, so
// a change to CLI pins or RUN steps alone is not drift.
//
// Usage: node scripts/release-source-drift.mjs <from-rev> <to-rev>
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const NON_PACKAGED_PATHSPECS = [
  ":(exclude).github/**",
  ":(exclude)CLAUDE.md",
  ":(exclude)tests/**",
];

/**
 * Returns every COPY and ADD instruction in a Dockerfile, continuation lines
 * joined and whitespace collapsed, in file order. Any heredoc makes the whole
 * file the inventory, since a heredoc body can hold file content.
 */
export function dockerCopyInventory(text) {
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => /^\s*(COPY|ADD)\b[^\n]*<</i.test(line))) {
    return lines;
  }
  const instructions = [];
  let pending = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    const instruction = `${pending}${line}`.trim().replace(/\s+/g, " ");
    pending = "";
    if (/^(COPY|ADD)\s/i.test(instruction)) instructions.push(instruction);
  }
  const tail = pending.trim().replace(/\s+/g, " ");
  if (/^(COPY|ADD)\s/i.test(tail)) instructions.push(tail);
  return instructions;
}

/**
 * Filters a changed-path list down to packaged-app drift. `readDockerfile`
 * returns the Dockerfile text at "from" or "to", or null when absent.
 */
export function packagedInputDrift(changedPaths, readDockerfile) {
  return changedPaths.filter((file) => {
    if (file !== "Dockerfile") return true;
    const before = readDockerfile("from");
    const after = readDockerfile("to");
    if (before === null || after === null) return true;
    const a = dockerCopyInventory(before);
    const b = dockerCopyInventory(after);
    return a.length !== b.length || a.some((instruction, i) => instruction !== b[i]);
  });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function releaseSourceDrift(from, to, cwd = process.cwd()) {
  const changed = git(cwd, ["diff", "--name-only", "-z", from, to, "--", ".", ...NON_PACKAGED_PATHSPECS])
    .split("\0")
    .filter(Boolean);
  const revs = { from, to };
  return packagedInputDrift(changed, (side) => {
    try {
      return git(cwd, ["show", `${revs[side]}:Dockerfile`]);
    } catch {
      return null;
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error("usage: node scripts/release-source-drift.mjs <from-rev> <to-rev>");
    process.exit(2);
  }
  const drift = releaseSourceDrift(from, to);
  if (drift.length) process.stdout.write(`${drift.join("\n")}\n`);
}
