// Issue #32: `npm start` ran through cross-env and concurrently, both
// devDependencies. (`concurrently` is gone from this script — scripts/start.mjs
// replaced it so Ctrl+C can reach server.js's drain on Windows, docs/WINDOWS.md
// §8 — but the rule it motivated outlives it, and `cross-env` still proves it.) Any install that omits dev deps — and NODE_ENV=production
// makes npm do exactly that, including a `npm install` an agent runs from a
// shell the app spawned — produced an instance that could not start, and said
// nothing about it until the next restart. Docker never noticed (its build
// stage installs everything and the runtime stage copies node_modules
// wholesale); bare-node deploys did. So: every binary the start script invokes
// must come from `dependencies`, and this stays true without anyone re-running
// a production-only install to find out.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

// The commands a script line runs: the first word of each `&&`/`;`/`||`
// segment, minus env assignments and the `node`/`npm` builtins, plus the
// commands inside quoted sub-invocations (concurrently takes its jobs as
// strings). `cross-env` is a wrapper — its own arguments are assignments and
// the command it then execs, which is a binary in its own right.
const WRAPPERS = new Set(["cross-env"]);
function binariesOf(script: string): string[] {
  const out = new Set<string>();
  const quoted = [...script.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const line of [script, ...quoted]) {
    for (const seg of line.split(/&&|\|\||;/)) {
      const words = seg.trim().split(/\s+/).filter((w) => w && !/^[A-Z_][A-Z0-9_]*=/.test(w));
      for (const cmd of words) {
        if (!["node", "npm", "npx"].includes(cmd)) out.add(cmd);
        if (!WRAPPERS.has(cmd)) break;
      }
    }
  }
  return [...out];
}

describe("npm start under a production-only install", () => {
  it("invokes only binaries that ship in `dependencies`", () => {
    const bins = binariesOf(pkg.scripts.start);
    // Canary: if the parser above ever stops finding anything, the loop below
    // passes vacuously and this test would stop testing anything at all.
    expect(bins).toEqual(expect.arrayContaining(["cross-env"]));
    for (const bin of bins) {
      expect(pkg.dependencies, `${bin} is used by \`npm start\` but is not a runtime dependency`).toHaveProperty(bin);
      expect(pkg.devDependencies).not.toHaveProperty(bin);
    }
  });
});
