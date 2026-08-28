# Calandria desktop shell (spike)

A minimal Electron shell that launches the local Calandria server and shows it in
a window, so the app starts by double-clicking an icon instead of by opening a
terminal, running `npm start`, and typing a URL.

**This is spike code**, kept because it is the cheapest way to answer the
questions in [`docs/DESKTOP_APP.md`](../docs/DESKTOP_APP.md) — which also carries
the recommendation, the measurements, and the reasons the architecture is what it
is. It is wired into no runtime and into `npm test` and the Docker image not at
all; the one thing that does run it is the label-gated `desktop` job in
`.github/workflows/test.yml` (see [`docs/DESKTOP_E2E.md`](../docs/DESKTOP_E2E.md)).
The repo root gains no dependency either way: Electron installs into this
directory only.

## Run it

```bash
npm ci && npm run build          # in the repo root — the shell serves a prod build
cd desktop && npm install        # Electron only, ~280 MB, ignored by git
npm start
```

The window shows a boot log until the server answers `/api/version`, then loads
the app. Quitting drains in-flight turns before exiting (`/api/instance/drain` →
SIGTERM), the same way stopping the server from a terminal does — and closing
the window is that same quit, so it stays on screen with a "finishing in-flight
turns…" overlay until the drain is done rather than vanishing while the process
is still working.

**On Linux, `npm start` needs `-- --no-sandbox`** — or a one-time
`sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod
4755` on the same file. npm unpacks Electron as you, so its setuid sandbox
helper is not root-owned, and Chromium aborts (`FATAL: The SUID sandbox helper
binary was found, but is not configured correctly`, then SIGTRAP) rather than
run unsandboxed. A packaged install has none of this: the `.deb`'s postinst
sets the bit. The e2e suite does not hit it either — Playwright's
`_electron.launch()` adds `--no-sandbox` on Linux itself (`e2e/fixtures.ts`).

Env it understands:

| Var | Effect |
|-|-|
| `CALANDRIA_NODE` | Node binary the sidecars run under. Set this if `node` isn't on the GUI PATH. |
| `CALANDRIA_REPO_ROOT` | Repo to launch. Defaults to the parent of `desktop/` when run unpackaged, or to the bundled `app-payload` when packaged (see "Building a package" below) — this var wins over both, which is how a packaged binary gets pointed at a working checkout instead. |
| `CALANDRIA_READY_TIMEOUT_MS` | How long to wait for the first `/api/version` (default 90 s). Only ever paid by a sidecar that is *alive* and silent — one that exits during boot fails `start()` immediately instead. |
| `PORT` / `PTY_PORT` | Preferred ports for the two sidecars. Taken ones are stepped past, not fought over — a preference, not a demand, so a second Calandria on a dev box still launches. |
| `CALANDRIA_DB_DIR` | Which database to open. The shell doesn't read it: it reaches the sidecars by ordinary env inheritance, like the rest of the app's config below. (Same for its legacy `ORCH_DB_DIR` alias.) |

Everything else is the app's own config (`.env`, `lib/config.ts`) and is
inherited unchanged.

## Layout

| File | What it is |
|-|-|
| `supervisor.js` | All the process management: PATH repair, Node resolution, port selection, spawn, readiness polling (raced against the sidecars' own exits, so a boot that has already failed rejects in the first second with the child's reason rather than at the timeout with `fetch failed`), drain-then-kill. **No `require("electron")`** — this is the part that survives a change of shell, and the part that can be tested headlessly. |
| `main.js` | Electron main: one window, an application menu, external links to the real browser, and quit-drains-first — including the window's own close button, which is held open (with a title and an on-page overlay) until the drain finishes. No preload, no IPC, no `nodeIntegration`. |
| `loading.html` | Boot screen; `main.js` pushes sidecar log lines into it. |
| `test-supervisor.js` | 24 assertions over `supervisor.js` (plus one source check on `main.js`'s port wiring), against stub sidecars. No deps, no display. |
| `test-real-boot.js` | Boots the actual `server.js` + `pty-server.js` through the supervisor against a throwaway database. Needs a build. |
| `e2e/` | The window layer, driven by Playwright's Electron driver under a virtual display: boot + boot-screen handoff, menu roles, renderer hardening, the permission handler, external links, the single-instance refusal, the db-lock collision, clipboard copy/paste, quit-drains-in-flight-work by both routes (`app.quit()` and closing the window), and one smoke path through the app inside the window — transcript over SSE, the diff, and the terminal panel over `/pty`. Run through its own config (`playwright.desktop.config.ts`, **not** the browser suite's — that one boots `npm start`, and the point here is that the shell boots the server itself). Takes the dev shell or a packaged build (`CALANDRIA_TEST_BIN`). See [`docs/DESKTOP_E2E.md`](../docs/DESKTOP_E2E.md). |
| `stub-server.js`, `stub-pty.js` | Fake sidecars for the tests: readiness, drain-on-SIGTERM, a `POST /api/instance/drain` route that appends to `STUB_DRAIN_LOG` (with a `drain-hang` mode that never answers), and the unhappy paths (never ready, lock held, ignores SIGTERM). The stub server also echoes the env it was handed — `NODE_ENV`, `SHELL`, `argv[0]`, its ppid — which is how the supervisor tests assert a bare `node <script>` spawn with no shell in between. |

## Tests

All three run from the **repo root**, and CI runs exactly these (the `desktop`
job in `.github/workflows/test.yml`, and `windows-desktop` on `windows-latest`):

```bash
npm run desktop:install         # Electron, once (see the NODE_ENV note below)
npm run build                   # the shell serves a production build

npm run test:desktop:supervisor # headless, ~8 s, no display
npm run test:desktop:boot       # boots the real server.js/pty-server.js
xvfb-run -a npm run test:desktop:window   # the window suite; needs a display
xvfb-run -a npm run test:desktop          # all three, in that order
```

In Electron's own runtime, from this directory:

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test-supervisor.js
```

### Against the packaged artifact

The same window suite takes a package instead of the dev shell — that is what
`CALANDRIA_TEST_BIN` is for, and the CI lane runs both halves. Two rules make
the second run mean something, and the suite enforces both:

- **The artifact must sit outside this checkout.** `fixtures.ts` refuses to
  launch a binary under the repo. An installed app never is, and one that is
  can satisfy an upward path lookup — a module, a lockfile, a relative path —
  from the tree it was built in.
- **No `CALANDRIA_REPO_ROOT`.** The fixture drops it (and deletes an inherited
  one) for a packaged run, so `main.js` has to resolve
  `resources/app-payload`. During the research spike the packaged shell passed
  every assertion while still reading the repo, because the harness handed it
  that variable; a real download would have died on the first boot.

`e2e/06-packaged.spec.ts` is the only packaged-only spec — it asserts the
payload the app booted from, the bundled Node the sidecars ran under, and how
`chrome-sandbox` is packaged. It skips itself when `CALANDRIA_TEST_BIN` is unset.

```bash
# unpacked: what CI does (electron-builder --dir has no SUID chrome-sandbox,
# so --no-sandbox is still passed and the spec records that)
cd desktop && npm run payload -- --no-build && npx electron-builder --linux dir
cd .. && mv desktop/dist/linux-unpacked /tmp/calandria-app
CALANDRIA_TEST_BIN=/tmp/calandria-app/calandria-desktop \
  xvfb-run -a npm run test:desktop:window

# installed: what the bench does — a real `.deb`, a real session, no --no-sandbox
sudo dpkg -i desktop/dist/calandria-desktop_*_amd64.deb
CALANDRIA_TEST_BIN=/opt/Calandria/calandria-desktop CALANDRIA_DESKTOP_SANDBOX=1 \
  DISPLAY=:1 npm run test:desktop:window

# macOS: what the macos-desktop CI job does (--mac dir is the only target
# wired up — see "Building a package" below — and unsigned in the Developer
# ID sense, so an ad-hoc signature is what lets arm64 exec it at all)
cd desktop && npm run dist:mac
cd .. && mv desktop/dist/mac*/Calandria.app /tmp/calandria-app.app   # mac-arm64 or mac, by host arch
codesign --force --deep --sign - /tmp/calandria-app.app
CALANDRIA_TEST_BIN=/tmp/calandria-app.app/Contents/MacOS/Calandria \
  CALANDRIA_TEST_APP_BUNDLE=/tmp/calandria-app.app \
  npm run test:desktop:window
```

`CALANDRIA_TEST_APP_BUNDLE` is the macOS-only third variable, alongside
`CALANDRIA_TEST_BIN` and `CALANDRIA_DESKTOP_SANDBOX` above: it points at the
`.app` itself rather than the binary inside it, which is what
`08-macos-launchd.spec.ts` below needs to `open` the bundle through
LaunchServices instead of spawning the executable directly.

`CALANDRIA_DESKTOP_SANDBOX=1` is what stops the suite disabling the sandbox, so
the flag cannot be what makes an installed app pass. It sets two things, and the
second is not obvious: the `--no-sandbox` argument, **and**
`chromiumSandbox: true` on `electron.launch()` — on Linux Playwright unshifts
`--no-sandbox` onto the argument list itself unless that option is given
(playwright-core 1.61.1). Omitting the flag was not enough; the packaged-install
run was unsandboxed anyway until the option went in.

In that mode `06-packaged.spec.ts` asserts the sandbox is **running** rather
than that a mode bit is set, because the bit no longer decides it:
electron-builder 26's `postinst` chmods `chrome-sandbox` to 0755 when
unprivileged user namespaces work and installs
`/etc/apparmor.d/calandria-desktop` instead, which is what keeps the namespace
sandbox alive under Ubuntu 24.04's
`kernel.apparmor_restrict_unprivileged_userns=1`. The SUID bit only appears on a
kernel without user namespaces. What both mechanisms produce — and
`--no-sandbox` cannot — is a descendant process in its own user namespace, which
is what the spec reads out of `/proc`. That difference only reproduces on a
machine where the package was actually installed (docs/DESKTOP_E2E.md §4).

Traces are off for this suite (`playwright.desktop.config.ts`): Playwright's
trace/video capture against a packaged Electron app is unreliable
([microsoft/playwright#13180](https://github.com/microsoft/playwright/issues/13180)),
so both lanes keep screenshots-on-failure plus the shell log
`attachShellLog()` writes beside each instance's database.

The suite resolves `playwright` from the repo root's `node_modules` (already a
dev dependency for the browser suite) and needs `xvfb` plus Chromium's usual
library set on a headless box. It disables the sandbox because an unpacked
Electron has neither a SUID `chrome-sandbox` nor an AppArmor profile permitting
its user namespace; an install has one of the two, which is what
`CALANDRIA_DESKTOP_SANDBOX=1` is for (see "Against the packaged artifact").

**On Windows and macOS drop the `xvfb-run` prefix** — both have a real window
station and need no display to be installed, which is why the `windows-desktop`
CI job has no display step in it at all. `--no-sandbox` is not passed there
either (`e2e/fixtures.ts` gates it on Linux): neither platform has a setuid
helper to be missing, so the flag would only weaken what those lanes test.

`e2e/05-windows-quit.spec.ts` is win32-only and skips itself elsewhere. It
covers what happens when something *outside* the app ends it — a plain
`taskkill` runs `before-quit` and the sidecars go with the shell; `taskkill /F`
without `/T` is a `TerminateProcess` that orphans them. `03-quit-drain.spec.ts`'s
database assertion no longer needs a Windows exception: `supervisor.stop()`
POSTs `/api/instance/drain` itself and waits for it before it ever sends the
kill, so the turn is settled whether or not the platform can deliver a signal,
and the assertion holds everywhere. What no test here covers is a real Windows
shutdown or logout, where `before-quit`/`will-quit` are not emitted at all — a
`session-end` listener does not exist yet, and nothing drains until it does.

`e2e/07-macos.spec.ts` is darwin-only and skips itself elsewhere.
`titleBarStyle: "hiddenInset"` is the whole point of it — plain `"default"`
reserves a strip the renderer never draws into, and `getContentBounds()` only
comes back equal to `getBounds()` under `hiddenInset` — so the spec pins that
equality, that the traffic lights stay closable/minimizable/maximizable, that
the app paints into the rows the native title bar used to own, and that the
menubar's submenus still carry the roles macOS reads its keyboard shortcuts
off (Edit: undo/redo/cut/copy/paste/select; the app menu: about/hide/quit;
File: close, Cmd+W; Window: minimize) — a hand-rolled menu can drop a role
while still looking right. It attaches a screenshot (`hiddenInset.png`) and a
JSON probe of what sits under the traffic lights anyway, since that is
exactly what an assertion can't answer and a human should look once on a
green run. `e2e/08-macos-launchd.spec.ts` is darwin **and** packaged only,
gated on `CALANDRIA_TEST_APP_BUNDLE`: a binary spawned directly, the way
every other packaged spec launches it, inherits the spawning shell's PATH,
but a `.app` opened by LaunchServices gets launchd's stub instead,
`/usr/bin:/bin:/usr/sbin:/sbin`, with none of the user's own tooling on it — the reason
`supervisor.js` repairs PATH from the login shell in the first place
(`docs/DESKTOP_APP.md` §2). So the spec `open`s the bundle instead of
spawning it, captures its stdout with `open --stdout`, and asserts the repair
ran. It stays hermetic the way the other packaged specs do, `launchctl
setenv`-ing `instanceEnv()`'s keys — PATH pointedly left out, since that's
the variable under test — and unsets them in `afterAll`.

One environment gotcha it handles for you, worth knowing if you run the shell by
hand on a headless box: `Notification.permission` is `granted` in Electron
without anything asking, so the app posts real native notifications, and on
Linux with a session bus but **no** notification daemon each one blocks the
Electron main process for GDBus's 25-second timeout. The suite points
`DBUS_SESSION_BUS_ADDRESS` at a socket that does not exist so libnotify fails
immediately instead.

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
npm run dist:mac      # → dist/mac(-arm64)/Calandria.app
```

`dist:mac` is `--dir` only — no `dmg`/`zip` target is wired up yet, since
there's nowhere to publish one to without Developer ID signing and
notarization, which stay a separate later decision (see the closing note
below). `mac.identity: null` tells electron-builder not to sign at all
rather than search the keychain for an identity that isn't there, so the
`.app` it produces is unsigned in the Developer ID sense — which is fine for a
bundle you built yourself, since Gatekeeper's assessment is triggered by the
quarantine attribute a *download* carries, and matters the moment anyone
distributes one. Unlike Linux, though, that's not optional to work around:
arm64 macOS refuses to `exec` a Mach-O carrying no signature whatsoever, so
the `.app` needs at least an ad-hoc signature (`codesign --force --deep
--sign -`) before anything, including the test suite below, can launch it.

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
