// Drift guard between two hand-maintained inventories: the Dockerfile's
// runtime-stage COPY list and desktop/payload-manifest.js's DOCKER_PARITY set.
// Both describe the same thing, everything `node server.js` needs beyond the
// Next build output, and this test fails the suite the moment they diverge.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

// desktop/payload-manifest.js is dependency-free CommonJS so it can be
// required here without pulling in desktop/node_modules (Electron is never
// installed in the app's own tree). Load it by absolute path rather than a
// relative import so this doesn't depend on module resolution rules for a
// file outside the "@/*" root.
const require = createRequire(import.meta.url);
const manifest = require(path.join(process.cwd(), "desktop/payload-manifest.js")) as {
  NODE_MODULES: string;
  COPY_DIRS: string[];
  COPY_FILES: string[];
  DOCKER_PARITY: string[];
  BUILD_ONLY: string[];
};

/**
 * Every source path named by a `COPY --from=build` line in the Dockerfile,
 * normalized to a repo-relative path (the `/app/` prefix stripped).
 *
 * These lines never wrap across multiple lines in this Dockerfile, so a
 * simple per-line scan is sufficient. Flags (`--from=…`, `--chown=…`) are
 * skipped, and the final token, the destination, always starting with
 * `./`, is dropped; everything else that starts with `/app/` is a source.
 */
function dockerCopySources(): Set<string> {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const sources = new Set<string>();
  for (const line of dockerfile.split("\n")) {
    if (!line.startsWith("COPY --from=build")) continue;
    const tokens = line.trim().split(/\s+/).filter((t) => !t.startsWith("--"));
    // Last token is the destination (starts with "./"); everything before it
    // that starts with "/app/" is a source.
    const sourceTokens = tokens.slice(0, -1);
    for (const token of sourceTokens) {
      if (token.startsWith("/app/")) sources.add(token.slice("/app/".length));
    }
  }
  return sources;
}

describe("desktop payload manifest matches the Dockerfile's runtime COPY list", () => {
  it("DOCKER_PARITY is exactly the Dockerfile's COPY --from=build sources", () => {
    const dockerSources = dockerCopySources();
    const manifestSources = new Set(manifest.DOCKER_PARITY);

    const inDockerOnly = [...dockerSources].filter((s) => !manifestSources.has(s));
    const inManifestOnly = [...manifestSources].filter((s) => !dockerSources.has(s));

    expect(
      inDockerOnly.length === 0 && inManifestOnly.length === 0,
      `Dockerfile and desktop/payload-manifest.js have drifted.\n` +
        `in the Dockerfile but not desktop/payload-manifest.js: ${JSON.stringify(inDockerOnly)}\n` +
        `in desktop/payload-manifest.js but not the Dockerfile: ${JSON.stringify(inManifestOnly)}\n` +
        `Add the missing entry to BOTH the Dockerfile's runtime-stage COPY lines and DOCKER_PARITY.`
    ).toBe(true);
  });

  it("every checked-in DOCKER_PARITY and BUILD_ONLY path exists in the repo", () => {
    // Two entries in the parity set are produced rather than checked in, so a
    // clean tree does not have them and this check would fail the unit lane,
    // which never runs `next build`: node_modules is installed (by the
    // Dockerfile's build stage, and by build-payload.js into its own staging
    // dir) and .next is the build output the payload wraps. Everything else is
    // a real file, and "the manifest names something that no longer exists" is
    // the failure worth catching: a rename that only touched the Dockerfile.
    const produced = new Set([manifest.NODE_MODULES, ".next"]);
    const paths = [
      ...manifest.DOCKER_PARITY.filter((p) => !produced.has(p)),
      ...manifest.BUILD_ONLY,
    ];
    for (const p of paths) {
      expect(fs.existsSync(path.join(ROOT, p)), `${p} does not exist in the repo`).toBe(true);
    }
  });
});
