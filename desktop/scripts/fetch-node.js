/* Download an official Node runtime into desktop/vendor/node.
 *
 * WHY the app ships its own Node at all: supervisor.js runs the server under a
 * real Node, never under Electron (docs/DESKTOP_APP.md §2), and `resolveNode`
 * already prefers `<resourcesPath>/node/bin/node` — the "bundled" source. That
 * branch exists precisely so a double-clicked app does not depend on the user's
 * PATH, which on macOS is launchd's stub and on a fresh Linux box may have no
 * Node at all. It is also the only way to PIN THE ABI: better-sqlite3 ships
 * per-`NODE_MODULE_VERSION` prebuilds, so a payload installed against one major
 * and then run under whatever `node` the user happens to have is a coin flip
 * that lands as "was compiled against a different Node.js version" at first
 * query. Bundling makes the runtime and the prebuild one decision.
 *
 * WHICH version: whatever installed the payload's node_modules, i.e. the host's
 * own Node, unless CALANDRIA_DESKTOP_NODE_VERSION overrides it. Pinning a
 * constant here would fail the ABI check on every machine that isn't on that
 * major, which is a worse default than "matches by construction". CI pins the
 * env var when it wants reproducibility.
 *
 * Only the `node` binary is taken — not npm, not the headers. The payload is
 * already installed; nothing in a running Calandria shells out to npm.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const DIST = process.env.CALANDRIA_DESKTOP_NODE_MIRROR || "https://nodejs.org/dist";

function distArch(arch = process.arch) {
  if (arch === "x64" || arch === "arm64" || arch === "armv7l" || arch === "ppc64" || arch === "s390x") return arch;
  throw new Error(`no official Node build for arch ${arch}`);
}

function distPlatform(platform = process.platform) {
  if (platform === "linux" || platform === "darwin" || platform === "win32") {
    return platform === "win32" ? "win" : platform;
  }
  throw new Error(`no official Node build for platform ${platform}`);
}

/** Where resolveNode() looks, relative to the vendored `node` dir. */
function binPathIn(dir, platform = process.platform) {
  return platform === "win32" ? path.join(dir, "node.exe") : path.join(dir, "bin", "node");
}

function versionOf(bin) {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * @returns {Promise<{path: string, version: string, cached: boolean}>}
 */
async function fetchNode({
  version = process.env.CALANDRIA_DESKTOP_NODE_VERSION || process.versions.node,
  platform = process.platform,
  arch = process.arch,
  dest,
  log = console.log,
} = {}) {
  const v = version.startsWith("v") ? version : `v${version}`;
  const out = binPathIn(dest, platform);

  const have = versionOf(out);
  if (have === v) {
    log(`[node] ${out} is already ${v}`);
    return { path: out, version: v, cached: true };
  }

  const name = `node-${v}-${distPlatform(platform)}-${distArch(arch)}`;
  const ext = platform === "win32" ? "zip" : "tar.xz";
  const archive = `${name}.${ext}`;

  log(`[node] fetching ${archive} from ${DIST}`);
  const [blob, sums] = await Promise.all([
    download(`${DIST}/${v}/${archive}`),
    download(`${DIST}/${v}/SHASUMS256.txt`).then((b) => b.toString("utf8")),
  ]);

  // Verify before unpacking. This binary is executed on the user's machine by
  // every launch of the packaged app; an unverified download is the one place
  // in this build where a bad byte becomes code execution.
  const want = sums
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, f]) => f === archive)?.[0];
  if (!want) throw new Error(`${archive} is not listed in SHASUMS256.txt for ${v}`);
  const got = crypto.createHash("sha256").update(blob).digest("hex");
  if (got !== want) throw new Error(`checksum mismatch for ${archive}: got ${got}, expected ${want}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-node-"));
  try {
    const archivePath = path.join(tmp, archive);
    fs.writeFileSync(archivePath, blob);
    const inner = platform === "win32" ? `${name}/node.exe` : `${name}/bin/node`;
    if (platform === "win32") {
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${tmp}' -Force`],
        { stdio: "inherit" }
      );
    } else {
      // xz, so GNU tar needs the `xz` binary on PATH; bsdtar (macOS) is fine.
      execFileSync("tar", ["-xJf", archivePath, "-C", tmp, inner], { stdio: "inherit" });
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(path.join(tmp, inner), out);
    if (platform !== "win32") fs.chmodSync(out, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Only meaningful when building for the host; a cross-build can't run it.
  if (platform === process.platform && arch === process.arch) {
    const check = versionOf(out);
    if (check !== v) throw new Error(`vendored node reports ${check ?? "nothing"}, expected ${v}`);
  }
  log(`[node] vendored ${v} → ${out}`);
  return { path: out, version: v, cached: false };
}

module.exports = { fetchNode, binPathIn };

if (require.main === module) {
  fetchNode({ dest: path.join(__dirname, "..", "vendor", "node") }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
