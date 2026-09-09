/* A stand-in for GitHub's releases feed, for the e2e suite.
 *
 * The update check runs in the SERVER process (lib/updates/check.ts), so a
 * page.route stub cannot reach it: the request never leaves Node. The suite
 * points CALANDRIA_UPDATE_FEED_URL at this process instead, which keeps the
 * whole run off github.com, including the six-hourly ticker every spec's
 * server starts at boot.
 *
 * The versions are derived from the running package.json, so this stays newer
 * than the product forever and no release bump breaks the spec. The bodies
 * carry the artifacts marker and table a real release-please release carries,
 * so 28-updates.spec.ts can assert the table is cut off before the popover.
 *
 * Plain .mjs with no imports from lib/: Playwright starts it as its own
 * process through the webServer array in playwright.config.ts.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.CALANDRIA_E2E_FEED_PORT || 4713);

const current = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const [major, minor] = current.split(".").map(Number);
const bump = (n) => `${major}.${minor + n}.0`;

function body(version) {
  return [
    `## [${version}](https://github.com/calandria-dev/calandria/compare/v${current}...v${version}) (2026-09-15)`,
    "",
    "### Features",
    "",
    `* **updates:** a titlebar pill for ${version} ([abc1234](https://github.com/calandria-dev/calandria/commit/abc1234))`,
    "",
    "### Bug Fixes",
    "",
    `* **runner:** settle a parked follow-up ([def5678](https://github.com/calandria-dev/calandria/commit/def5678))`,
    "",
    "<!-- desktop-artifacts -->",
    "",
    "| Installer | Signed |",
    "|-|-|",
    "| macOS (arm64) | yes |",
    "| Windows | no |",
  ].join("\n");
}

function entry(version, extra = {}) {
  return {
    tag_name: `v${version}`,
    name: version,
    body: body(version),
    draft: false,
    prerelease: false,
    html_url: `https://github.com/calandria-dev/calandria/releases/tag/v${version}`,
    published_at: "2026-09-15T10:02:11Z",
    ...extra,
  };
}

const FEED = [
  entry(bump(3)),
  entry(bump(2)),
  entry(bump(1)),
  entry(bump(4), { draft: true }),
  entry(`${major}.${minor + 3}.1-rc.1`, { prerelease: true }),
];

http
  .createServer((req, res) => {
    if (!req.url?.startsWith("/releases")) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(FEED));
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`releases fixture on http://127.0.0.1:${PORT}/releases`);
  });
