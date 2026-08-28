/* Assemble the server payload a packaged desktop app carries.
 *
 * The shell in desktop/ is only half an app: main.js + supervisor.js know how
 * to *run* `node server.js`, but until now the thing they ran had to be a
 * checkout the user already had (CALANDRIA_REPO_ROOT). This script builds the
 * other half — a self-contained production tree, staged at desktop/payload,
 * which electron-builder ships as extraResources and main.js points REPO_ROOT at.
 *
 * Output layout inside the packaged app:
 *
 *   resources/app.asar        the Electron shell (main.js, supervisor.js, …)
 *   resources/app-payload/    THIS — .next, node_modules, server.js, the .mjs set
 *   resources/node/bin/node   the runtime the sidecars are spawned under
 *
 * The payload is extraResources and NOT inside the asar on purpose: it holds
 * native addons (better-sqlite3, node-pty) that dlopen from a real path, and it
 * is spawned as a child process, which cannot see into an archive at all.
 *
 * One electron-builder trap is worth knowing before you edit the config: a
 * single `{from: "payload", to: "app-payload"}` entry copies everything EXCEPT
 * node_modules, silently — electron-builder manages app dependencies itself and
 * filters that name out of extraResources. The packaged app then looks complete
 * and dies at first boot on an unresolved `next`. The second, explicit
 * `payload/node_modules` entry in package.json is what actually carries it.
 *
 * Usage: node scripts/build-payload.js [--no-build] [--platform=…] [--arch=…]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { COPY_DIRS, COPY_FILES, BUILD_ONLY } = require("../payload-manifest");
const { fetchNode } = require("./fetch-node");

const DESKTOP = path.resolve(__dirname, "..");
const REPO = path.resolve(DESKTOP, "..");
const STAGE = path.join(DESKTOP, "payload");
const VENDOR_NODE = path.join(DESKTOP, "vendor", "node");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const log = (msg) => console.log(msg);

function run(cmd, cmdArgs, cwd) {
  execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
}

function bytes(target) {
  let total = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    else total += st.size;
  };
  walk(target);
  return total;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;

async function main() {
  // 1. The app's own production build. Reused when present: `next build` is the
  //    slowest step here by far and a packaging loop should not pay for it twice.
  const buildId = path.join(REPO, ".next", "BUILD_ID");
  if (flag("no-build")) {
    if (!fs.existsSync(buildId)) throw new Error(`--no-build, but there is no build at ${path.dirname(buildId)}`);
    log(`[payload] reusing existing .next (--no-build)`);
  } else if (fs.existsSync(buildId)) {
    log(`[payload] reusing existing .next — delete it or run \`npm run build\` to refresh`);
  } else {
    log(`[payload] no .next — running \`npm run build\` in ${REPO}`);
    run("npm", ["run", "build"], REPO);
  }

  // 2. Fresh stage every time. A payload that accumulates files across builds
  //    is how a deleted module keeps shipping.
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  // 3. Production dependencies, installed rather than copied — the checkout's
  //    node_modules has the whole dev toolchain (Next, vitest, Playwright) in it.
  for (const rel of BUILD_ONLY) {
    fs.mkdirSync(path.dirname(path.join(STAGE, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(STAGE, rel));
  }
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(STAGE, "package.json"));
  log(`[payload] npm ci --omit=dev`);
  // Install scripts stay ON: prebuild-install is how better-sqlite3 and node-pty
  // get their binaries at all, and the root postinstall (scripts/fix-pty.js,
  // copied above) fixes node-pty's exec bit.
  run("npm", ["ci", "--omit=dev", "--no-audit", "--fund=false"], STAGE);

  // BUILD_ONLY earns its name here: these existed to make `npm ci` work and
  // are not runtime files. package-lock.json in particular is not inert —
  // Next walks up looking for lockfiles to infer a workspace root and warns
  // (loudly, on every boot) when it finds more than one.
  for (const rel of BUILD_ONLY) fs.rmSync(path.join(STAGE, rel), { force: true });

  // 4. The runtime files. Same inventory as the Dockerfile's runtime stage —
  //    see payload-manifest.js.
  for (const rel of COPY_FILES) {
    fs.mkdirSync(path.dirname(path.join(STAGE, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(STAGE, rel));
  }
  for (const rel of COPY_DIRS) {
    fs.cpSync(path.join(REPO, rel), path.join(STAGE, rel), { recursive: true });
  }

  // `.next/cache` is `next build`'s incremental-compilation scratch: nothing
  // reads it at runtime, and it is routinely larger than the build output it
  // sits beside. The Dockerfile keeps it because its layer is thrown away by
  // the runtime stage's own COPY boundary; here it would be shipped. Say what
  // was dropped rather than silently shrinking the artifact.
  const cache = path.join(STAGE, ".next", "cache");
  if (fs.existsSync(cache)) {
    const dropped = bytes(cache);
    fs.rmSync(cache, { recursive: true, force: true });
    log(`[payload] dropped .next/cache (${mb(dropped)}) — build scratch, not runtime`);
  }

  // 5. The Node the sidecars run under.
  const node = await fetchNode({
    dest: VENDOR_NODE,
    platform: opt("platform", process.platform),
    arch: opt("arch", process.arch),
    log,
  });

  // 6. Prove the pair actually fits before an artifact is built around it. This
  //    is the failure the whole bundled-Node decision exists to prevent: an
  //    ABI-mismatched better-sqlite3 is invisible until the first query.
  if (opt("platform", process.platform) === process.platform && opt("arch", process.arch) === process.arch) {
    log(`[payload] ABI check: ${node.version} vs the staged native addons`);
    execFileSync(node.path, ["-e", "require('better-sqlite3'); require('node-pty'); console.log('[payload] native addons load under ' + process.version + ' (modules ' + process.versions.modules + ')')"], {
      cwd: STAGE,
      stdio: "inherit",
    });
  } else {
    log(`[payload] WARN: cross-build — skipping the native-addon ABI check`);
  }

  log(`[payload] staged ${mb(bytes(STAGE))} at ${STAGE}`);
}

main().catch((err) => {
  console.error(`[payload] ${err?.message || err}`);
  process.exit(1);
});
