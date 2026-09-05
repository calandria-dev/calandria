import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Optional second setup layer, absent from a clean checkout. See setupFiles below.
const localSetup = path.resolve(__dirname, "tests/setup.local.ts");

export default defineConfig({
  // Mirror tsconfig's "@/*" -> "./*" path alias so modules that import via
  // "@/lib/..." resolve under vitest the same way they do under Next. Most of
  // lib/ and app/, and the tests themselves, import that way, so without this
  // the suite throws at collect.
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // tests/setup.ts owns the hermetic defaults every run needs.
    // tests/setup.local.ts is an optional layer on top, for env a fork or a
    // local experiment must set before the module graph loads. It's
    // gitignored, so a clean checkout has none and nobody commits their
    // machine's overrides by accident (a downstream repo that wants to track
    // one can `git add -f` it, since ignore rules only cover untracked
    // files). The local layer runs second and wins.
    setupFiles: ["tests/setup.ts", ...(fs.existsSync(localSetup) ? [localSetup] : [])],
    // Each test spawns several real git subprocesses; the default 5s is too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run files sequentially: every test shells out to many git subprocesses,
    // and four files in parallel spawn enough concurrent `git` to thrash the
    // machine, driving per-test time past the timeout. Serial is stable and
    // plenty fast here.
    fileParallelism: false,
  },
});
