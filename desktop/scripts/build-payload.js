/* Assemble the server payload a packaged desktop app carries.
 *
 * The shell in desktop/ is only half an app: main.js + supervisor.js know how
 * to run `node server.js`, but the thing they run has to be a self-contained
 * production tree, staged at desktop/payload, which electron-builder ships as
 * extraResources and main.js points REPO_ROOT at.
 *
 * Output layout inside the packaged app:
 *
 *   resources/app.asar        the Electron shell (main.js, supervisor.js, …)
 *   resources/app-payload/    this: .next, node_modules, server.js, the .mjs set
 *   resources/node/bin/node   the runtime the sidecars are spawned under
 *
 * The payload is extraResources, not inside the asar: it holds native addons
 * (better-sqlite3, node-pty) that dlopen from a real path, and it is spawned
 * as a child process, which cannot see into an archive at all.
 *
 * One electron-builder trap to know before editing the config: a single
 * `{from: "payload", to: "app-payload"}` entry copies everything except
 * node_modules, with no warning, since electron-builder manages app
 * dependencies itself and filters that name out of extraResources. The
 * packaged app then looks complete and dies at first boot on an unresolved
 * `next`. The second, explicit `payload/node_modules` entry in package.json
 * is what actually carries it.
 *
 * Usage: node scripts/build-payload.js [--no-build] [--platform=…] [--arch=…] [--libc=…]
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
  execFileSync(cmd, cmdArgs, {
    cwd,
    stdio: "inherit",
    // On Windows `npm` is a `.cmd` shim and `CreateProcess` cannot execute one,
    // so a bare execFileSync dies `spawnSync npm ENOENT` (the same problem
    // lib/binPath.ts handles on the app side). Naming `npm.cmd` explicitly is
    // not the fix either: Node's CVE-2024-27980 patch refuses to spawn .cmd or
    // .bat without a shell, so that path fails EINVAL instead. Going through
    // cmd.exe is what remains, and it is safe here because every argument this
    // helper is ever passed is a fixed literal, so there is nothing to quote.
    shell: process.platform === "win32",
    env: { ...process.env, NODE_ENV: "production" },
  });
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

/**
 * npm's own `libc` matching rules, applied to one package's declaration.
 *
 * Same shape as `os`/`cpu`: a list of allowed values, where a leading `!` is a
 * negation. An empty or absent list means "any libc", the overwhelmingly
 * common case and the reason this sweep is a no-op for almost every package.
 */
function libcAllows(list, target) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (list.some((v) => v === `!${target}`)) return false;
  if (list.every((v) => v.startsWith("!"))) return true;
  return list.includes(target);
}

/**
 * Drop `@next/swc`, a compiler the payload never compiles anything with.
 *
 * The payload is a finished `next build` served by `next start`; the only place
 * outside `next/dist/build`, `next/dist/cli` and the dev bundler that reaches
 * for the native bindings at all is `next/dist/server/config.js`, behind
 * `experimental.useLightningcss`. Confirmed by deleting
 * `@next/swc-linux-x64-gnu` from a staged payload and checking that
 * `node server.js` still came up on the vendored Node and served `/`,
 * `/api/projects` and a `_next/static` chunk, all 200.
 *
 * `npm ci --omit=optional` would drop this too, along with `better-sqlite3`'s
 * and `sharp`'s platform binaries, so the sweep lives here instead.
 *
 * The one config that would make this wrong names itself, so check for it
 * instead of shipping an artifact that dies at first boot. Skipping is the
 * right response, not failing: an app that wants lightningcss should keep its
 * compiler and its 137 MB.
 */
function pruneBuildOnlySwc(stage) {
  const scope = path.join(stage, "node_modules", "@next");
  if (!fs.existsSync(scope)) return null;

  // Read from the repo, not the stage: this sweep runs before step 4 copies
  // the runtime files in, and the stage's copy is a verbatim copy of this one.
  const config = path.join(REPO, "next.config.mjs");
  if (fs.existsSync(config) && fs.readFileSync(config, "utf8").includes("useLightningcss")) {
    return { skipped: "next.config.mjs sets experimental.useLightningcss, which loads the SWC bindings at boot" };
  }

  const dropped = [];
  for (const entry of fs.readdirSync(scope)) {
    if (!entry.startsWith("swc-")) continue;
    const pkgDir = path.join(scope, entry);
    const size = bytes(pkgDir);
    fs.rmSync(pkgDir, { recursive: true, force: true });
    dropped.push({ name: `@next/${entry}`, size });
  }
  return { dropped };
}

/**
 * Drop the staged packages built for a libc the target system does not have.
 *
 * npm scopes the platform-specific optional dependencies to the target os/cpu,
 * but not to a libc, because `package-lock.json` records `os` and `cpu` for
 * each of those packages but no `libc`, and `npm ci` filters on what the
 * lockfile says instead of re-reading the registry. So a glibc host installs
 * `@anthropic-ai/claude-agent-sdk-linux-x64-musl` and two musl `sharp`
 * packages right beside their glibc twins: code that cannot execute on the
 * system a `.deb` or an AppImage targets. (`@next/swc`'s pair would be here
 * too, but the sweep above has already taken both halves of it.)
 *
 * A sweep of the staged tree, not a change to the `npm ci` invocation above:
 * `--omit=optional` drops the variant we need along with the one we don't,
 * `--libc=glibc` cannot help either since the lockfile it reads has no libc to
 * compare against, and regenerating the app's root lockfile to carry `libc`
 * would change what every install produces (Docker, CI, contributors) just to
 * shrink one desktop artifact.
 *
 * Keyed off each package's own declaration, not a `-musl` name suffix, so a
 * newly added dependency is covered without anyone remembering to list it.
 */
function pruneForeignLibc(root, targetLibc) {
  const dropped = [];

  const scan = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const pkgDir = path.join(dir, entry.name);
      // A scope directory (@next, @anthropic-ai) holds packages, not a package.
      if (entry.name.startsWith("@")) {
        scan(pkgDir);
        continue;
      }
      if (entry.name === ".bin") continue;

      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      } catch {
        continue;
      }
      if (!libcAllows(manifest.libc, targetLibc)) {
        const size = bytes(pkgDir);
        fs.rmSync(pkgDir, { recursive: true, force: true });
        dropped.push({ name: manifest.name || path.relative(root, pkgDir), libc: manifest.libc, size });
        continue;
      }
      scan(path.join(pkgDir, "node_modules"));
    }
  };

  scan(root);
  return dropped;
}

async function main() {
  // What the artifact will RUN on, which is not necessarily what is building
  // it. Every platform-conditional decision below reads these, never
  // `process.platform` directly.
  const targetPlatform = opt("platform", process.platform);
  const targetArch = opt("arch", process.arch);
  // Both Linux targets electron-builder produces here (`.deb` and AppImage)
  // are glibc artifacts. `--libc=musl` is for an Alpine-targeted build; on
  // macOS and Windows there is no libc axis and nothing declares one.
  const targetLibc = targetPlatform === "linux" ? opt("libc", "glibc") : null;

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

  // 3. Production dependencies, installed instead of copied: the checkout's
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
  // are not runtime files. package-lock.json in particular is not inert:
  // Next walks up looking for lockfiles to infer a workspace root and warns
  // on every boot when it finds more than one.
  for (const rel of BUILD_ONLY) fs.rmSync(path.join(STAGE, rel), { force: true });

  // 3b. Two sweeps of the tree `npm ci` just produced, both naming what they
  //     delete for the same reason the `.next/cache` drop below does: a build
  //     that shrinks its own artifact with no record of it is a build nobody
  //     can audit, and these delete whole dependencies.
  const swc = pruneBuildOnlySwc(STAGE);
  if (swc?.skipped) {
    log(`[payload] keeping @next/swc — ${swc.skipped}`);
  } else if (swc?.dropped?.length) {
    const total = swc.dropped.reduce((sum, d) => sum + d.size, 0);
    log(`[payload] dropped @next/swc (${mb(total)}) — a build-time compiler; \`next start\` never loads it`);
    for (const d of swc.dropped) log(`[payload]   - ${d.name} (${mb(d.size)})`);
  }

  if (targetLibc) {
    const dropped = pruneForeignLibc(path.join(STAGE, "node_modules"), targetLibc);
    if (dropped.length === 0) {
      log(`[payload] no foreign-libc packages staged (target libc: ${targetLibc})`);
    } else {
      const total = dropped.reduce((sum, d) => sum + d.size, 0);
      log(`[payload] dropped ${dropped.length} package(s) built for another libc (target: ${targetLibc}), ${mb(total)}:`);
      for (const d of dropped) log(`[payload]   - ${d.name} (${mb(d.size)}, libc: ${JSON.stringify(d.libc)})`);
    }
  }

  // 4. The runtime files: same inventory as the Dockerfile's runtime stage,
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
  // the runtime stage's own COPY boundary; here it would be shipped. Log the
  // drop instead of shrinking the artifact with no record of it.
  const cache = path.join(STAGE, ".next", "cache");
  if (fs.existsSync(cache)) {
    const dropped = bytes(cache);
    fs.rmSync(cache, { recursive: true, force: true });
    log(`[payload] dropped .next/cache (${mb(dropped)}) — build scratch, not runtime`);
  }

  // 5. The Node the sidecars run under.
  const node = await fetchNode({
    dest: VENDOR_NODE,
    platform: targetPlatform,
    arch: targetArch,
    log,
  });

  // 6. Prove the pair actually fits before an artifact is built around it. This
  //    is the failure the whole bundled-Node decision exists to prevent: an
  //    ABI-mismatched better-sqlite3 is invisible until the first query.
  if (targetPlatform === process.platform && targetArch === process.arch) {
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
