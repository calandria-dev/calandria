#!/usr/bin/env node
// CLI entry for the naming, comment-style and prose guards. Runs all three
// against the tracked file list and exits non-zero on any violation. Depends
// on Node built-ins only, so it works with no node_modules installed, which
// is the environment a git pre-commit hook runs in.

import * as naming from "./naming.mjs";
import * as commentStyle from "./commentStyle.mjs";
import * as prose from "./prose.mjs";
import { trackedFiles } from "./files.mjs";

function section(title, lines) {
  if (lines.length === 0) return "";
  return `${title}:\n  ${lines.join("\n  ")}\n`;
}

function main() {
  if (trackedFiles() === null) {
    console.log("guards: git ls-files unavailable, skipping (cannot scan without a tracked-file list)");
    process.exit(0);
  }

  const sections = [];

  const namingFiles = naming.trackedTextFiles();
  if (namingFiles) {
    const strays = naming.scan(namingFiles);
    sections.push(section("naming guard: unallowed rename-residue reference(s)", strays));
  }

  const styleFiles = commentStyle.trackedTargetFiles();
  if (styleFiles) {
    const { emDashHits, phraseHits } = commentStyle.scan(styleFiles);
    sections.push(section("comment style guard: em dash found", emDashHits));
    sections.push(section("comment style guard: work-log-style comment found", phraseHits));
  }

  const mdFiles = prose.trackedMarkdownFiles();
  if (mdFiles) {
    const hits = mdFiles.flatMap(prose.scanMarkdownFile);
    const strays = prose.reportHits(hits);
    sections.push(section("prose guard: em dash, banned phrase, or work-log line start", strays));
  }

  const output = sections.filter(Boolean).join("\n");
  if (output) {
    console.log(output.trimEnd());
    process.exit(1);
  }

  console.log("guards: no violations");
  process.exit(0);
}

main();
