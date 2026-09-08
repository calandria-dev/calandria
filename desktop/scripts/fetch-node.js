/* Downloads an official Node runtime into desktop/vendor/node.
 *
 * supervisor.js runs the server under a real Node, never under Electron
 * (docs/DESKTOP_APP.md §2), and `resolveNode` prefers this vendored copy so a
 * double-clicked app does not depend on the user's PATH. It also pins the
 * ABI: better-sqlite3 ships per-`NODE_MODULE_VERSION` prebuilds, so the
 * vendored Node must match whatever installed the payload's node_modules.
 *
 * The version defaults to the host's own Node; CALANDRIA_DESKTOP_NODE_VERSION
 * overrides it for a reproducible CI build. Only the `node` binary is
 * fetched, never npm or the headers.
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

  // Verify before unpacking: this binary runs on the user's machine at every
  // launch of the packaged app, so an unverified download risks code execution.
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
