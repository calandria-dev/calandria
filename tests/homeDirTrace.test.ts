// Code the Next build bundles reads the home directory only through lib/homeDir.mjs.
//
// Next's file tracer evaluates `os.homedir()` at build time and globs the path
// expression around it, so one direct call makes `next build` walk the build
// machine's home directory. On a Windows runner that walk fails the build with
// EPERM on `C:\Users\<user>\Application Data`. The tracer cannot see through a call
// into another module, so lib/homeDir.mjs is the one place allowed to call it.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCANNED_DIRS = ["lib", "app"];
const EXTENSIONS = /\.(ts|tsx|mjs|js|cjs)$/;
const ALLOWED = new Set(["lib/homeDir.mjs"]);

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.test(entry.name)) out.push(full);
  }
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, "")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("home directory reads in bundled code", () => {
  it("go through lib/homeDir.mjs", () => {
    const files: string[] = [];
    for (const dir of SCANNED_DIRS) walk(path.join(ROOT, dir), files);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (/\bhomedir\s*\(/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, "call homeDir() from lib/homeDir.mjs instead of os.homedir()").toEqual([]);
  });
});
