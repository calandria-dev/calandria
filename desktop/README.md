# Calandria desktop shell (spike)

A minimal Electron shell that launches the local Calandria server and shows it in
a window, so the app starts by double-clicking an icon instead of by opening a
terminal, running `npm start`, and typing a URL.

**This is spike code**, kept because it is the cheapest way to answer the
questions in [`docs/DESKTOP_APP.md`](../docs/DESKTOP_APP.md) — which also carries
the recommendation, the measurements, and the reasons the architecture is what it
is. Nothing here is wired into `npm test`, CI, or the Docker image, and the repo
root gains no dependency: Electron installs into this directory only.

## Run it

```bash
npm ci && npm run build          # in the repo root — the shell serves a prod build
cd desktop && npm install        # Electron only, ~280 MB, ignored by git
npm start
```

The window shows a boot log until the server answers `/api/version`, then loads
the app. Quitting drains in-flight turns before exiting (SIGTERM →
`/api/instance/drain`), the same way stopping the server from a terminal does.

Env it understands:

| Var | Effect |
|-|-|
| `CALANDRIA_NODE` | Node binary the sidecars run under. Set this if `node` isn't on the GUI PATH. |
| `CALANDRIA_REPO_ROOT` | Repo to launch. Defaults to the parent of `desktop/` when run unpackaged, or to the bundled `app-payload` when packaged (see "Building a package" below) — this var wins over both, which is how a packaged binary gets pointed at a working checkout instead. |
| `CALANDRIA_READY_TIMEOUT_MS` | How long to wait for the first `/api/version` (default 90 s). |
| `PORT` / `PTY_PORT` | Preferred ports for the two sidecars. Taken ones are stepped past, not fought over — a preference, not a demand, so a second Calandria on a dev box still launches. |
| `CALANDRIA_DB_DIR` | Which database to open. The shell doesn't read it: it reaches the sidecars by ordinary env inheritance, like the rest of the app's config below. (Same for its legacy `ORCH_DB_DIR` alias.) |

Everything else is the app's own config (`.env`, `lib/config.ts`) and is
inherited unchanged.

## Layout

| File | What it is |
|-|-|
| `supervisor.js` | All the process management: PATH repair, Node resolution, port selection, spawn, readiness polling, drain-then-kill. **No `require("electron")`** — this is the part that survives a change of shell, and the part that can be tested headlessly. |
| `main.js` | Electron main: one window, an application menu, external links to the real browser, and quit-drains-first. No preload, no IPC, no `nodeIntegration`. |
| `loading.html` | Boot screen; `main.js` pushes sidecar log lines into it. |
| `test-supervisor.js` | 21 assertions over `supervisor.js` (plus one source check on `main.js`'s port wiring), against stub sidecars. No deps, no display. |
| `test-real-boot.js` | Boots the actual `server.js` + `pty-server.js` through the supervisor against a throwaway database. Needs a build. |
| `test-window.js` | The window layer, driven by Playwright's Electron driver under a virtual display — boot, title, menu, renderer hardening, screenshot, single-instance, quit-drains. Takes the dev shell or a packaged build (`CALANDRIA_TEST_BIN`). See [`docs/DESKTOP_E2E.md`](../docs/DESKTOP_E2E.md). |
| `stub-server.js`, `stub-pty.js` | Fake sidecars for the tests: readiness, drain-on-SIGTERM, and the unhappy paths (never ready, lock held, ignores SIGTERM). |

## Tests

```bash
node test-supervisor.js                                   # headless, ~8 s
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test-supervisor.js   # same, in Electron's runtime
node test-real-boot.js                                    # needs a repo-root build
xvfb-run -a node test-window.js                           # needs a build + a virtual display
CALANDRIA_TEST_BIN=dist/linux-unpacked/calandria-desktop \
  xvfb-run -a node test-window.js       # same assertions, once packaging exists
```

`test-window.js` resolves `playwright` from the repo root's `node_modules` (it is
already a dev dependency for the browser suite) and needs `xvfb` plus Chromium's
usual library set on a headless box.

Electron is a `devDependency`, so an `npm install` run with `NODE_ENV=production`
in the environment reports "up to date" and installs nothing — including in an
agent session, which exports it. Use `NODE_ENV=development npm install`, and if
`node_modules/electron/dist/` is still missing afterwards, `node
node_modules/electron/install.js` fetches the binary.

## Building a package

```bash
cd desktop
npm install
npm run dist:dir      # → dist/linux-unpacked/calandria-desktop
npm run dist:linux    # dist:dir, plus deb and AppImage targets
```

Electron and `electron-builder` are `devDependencies`, so if your shell exports
`NODE_ENV=production` (a Calandria task session does) `npm install` reports
"up to date", installs neither, and `dist:dir` then fails with
`electron-builder: not found`. Prefix it: `NODE_ENV=development npm install`.

`dist:dir` runs `scripts/build-payload.js` (the `payload` script) before handing
off to `electron-builder`. That build script:

1. Runs `npm run build` in the repo root if there is no `.next` there yet
   (`--no-build` refuses instead, for a CI step that built earlier).
2. Installs a **fresh, production-only** `node_modules` with `npm ci --omit=dev`
   into a staging dir (`desktop/payload`) — not copied from this checkout, whose
   `node_modules` carries the whole dev toolchain.
3. Copies `.next` (minus `.next/cache`, which is `next build` scratch nothing
   reads at runtime — its dropped size is logged, not silently absorbed into the
   artifact), plus `server.js`, `pty-server.js`, and every plain-Node `.mjs` the
   two entrypoints dynamic-import. That file list lives in
   [`payload-manifest.js`](payload-manifest.js) and is the SAME inventory the
   Dockerfile's runtime stage COPYs — `tests/desktopPayload.test.ts` fails the
   suite if the two drift, so a new `.mjs` import goes into both places.
4. Deletes the files that existed only to make step 2 work (`package-lock.json`,
   `.npmrc`, `scripts/fix-pty.js`). The lockfile is not inert: Next walks up
   looking for one to infer a workspace root and warns on every boot when it
   finds more than one.
5. Downloads and vendors a Node runtime (`scripts/fetch-node.js`) — see below.
6. Runs the vendored Node against the staged tree with `require('better-sqlite3');
   require('node-pty')`, so an ABI mismatch fails the build instead of the app's
   first query.

Packaged layout:

| Path | What it is |
|-|-|
| `resources/app.asar` | The Electron shell — `main.js`, `supervisor.js`, `loading.html`. |
| `resources/app-payload/` | The server payload from step 3 above. `extraResources`, **not** inside the asar: it holds native addons that `dlopen` from a real path and is spawned as a child process, and a child cannot read out of an archive. |
| `resources/node/bin/node` | The Node the sidecars are spawned under (see below). |

One `electron-builder` trap is worth knowing before editing the `build` block: a
single `{from: "payload", to: "app-payload"}` entry copies everything **except**
`node_modules`, silently — electron-builder manages app dependencies itself and
filters that name out of `extraResources`. The packaged app looks complete and
dies at first boot on an unresolved `next`. The second, explicit
`payload/node_modules` entry is what actually carries it.

### The bundled Node

`resolveNode()` in `supervisor.js` already preferred
`<resourcesPath>/node/bin/node` — the "bundled" branch was written before there
was anything to put there. It's live now, for two reasons: a double-clicked app
must not depend on the PATH it was launched with (on macOS that's launchd's stub
— see `docs/DESKTOP_APP.md` §2), and it pins the ABI — `better-sqlite3` ships
per-`NODE_MODULE_VERSION` prebuilds, so a payload installed under one Node major
and later run under whatever the user happens to have is a coin flip that lands
as "compiled against a different Node.js version" at the first query.

The vendored version defaults to the **host's own** `node --version` — the same
one that ran `npm ci` for the payload — so runtime and prebuild match by
construction. `CALANDRIA_DESKTOP_NODE_VERSION` overrides it for a reproducible,
pinned CI build. The download is verified against the official `SHASUMS256.txt`
before it is unpacked; only the `node` binary is taken, not `npm` or the
headers.

Native modules are never rebuilt against Electron's ABI — `npmRebuild: false`
and `nodeGypRebuild: false` stay set in `package.json`'s `build` block, because
the addons are only ever loaded by the bundled Node, never by Electron.

electron-builder 26.15.3 also warns on every Linux build that `desktopName` is
not set, and then rejects `desktopName` as an unknown configuration key if you
set it — the option its warning names is not in that version's schema. Don't
chase it; `syncDesktopName: true` is set and the warning is noise.

The Linux icon and `.desktop` entry come from the app's own PWA icon
(`public/icons/icon-512.png`), so there is no second icon asset to keep in step
with the first.

### Prerequisites

- `tar` and `xz` on PATH (Linux/macOS) to unpack the downloaded Node tarball —
  Windows uses `Expand-Archive` instead.
- Network access to `nodejs.org/dist` (or `CALANDRIA_DESKTOP_NODE_MIRROR`) the
  first time a given Node version is vendored; a version already present under
  `desktop/vendor/node` is reused.

`desktop/payload/`, `desktop/vendor/` and `desktop/dist/` are build
intermediates and gitignored — delete them freely, they're regenerated.

Signing, notarization and auto-update are **not** wired up by any of this — that
work, and its cost, is still future (`docs/DESKTOP_APP.md` §7).

## The one rule

**The server runs under a real `node`, never inside Electron.** Two reasons, both
measured in `docs/DESKTOP_APP.md`: `better-sqlite3`'s prebuild will not load into
Electron's V8 ABI, and `lib/agents/codex/driver.ts` spawns the MCP tool bridge as
`process.execPath scripts/calandria-mcp.mjs` with a closed env — under an
Electron-hosted server that would launch a GUI process on every Codex turn
instead of the bridge.

`supervisor.js` enforces this: it refuses an Electron binary as the runtime and
strips every `ELECTRON_*` variable out of the sidecar environment, so nothing the
server spawns downstream (agent CLIs, MCP bridges, your login shell in the
terminal panel) inherits Electron's runtime flags.
