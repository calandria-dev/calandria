---
title: "Desktop test runbook"
---

# Desktop test runbook

How to run, extend and debug the desktop shell's test suite: `desktop/test-supervisor.js`,
`desktop/test-real-boot.js`, and the Playwright `_electron` suite in `desktop/e2e/`. For why the
suite is shaped this way (Playwright over the alternatives, what a desktop lane should and should
not duplicate from the browser suite) see the design notes in `docs/DESKTOP_APP.md`; this file is
for someone running or debugging the suite, not deciding whether to build one.

## 1. Prerequisites

**Linux:**

```bash
apt install xvfb x11-utils xauth dbus-x11   # plus Chromium's usual shared-library set
```

Also needed for the window suite and native-integration specs: `dunst` (notification daemon) and
`dbus-monitor`, and `openbox` (a window manager, needed to reproduce viewport clamping locally;
see §4).

```bash
npm ci && npm run build      # repo root; the shell serves this production build
npm run desktop:install      # Electron only, ~280 MB, into desktop/node_modules
```

**Why a packaged macOS launch used to hang.** `safeStorage.isEncryptionAvailable()` is a
synchronous call into the macOS login keychain. An ad-hoc-signed build isn't on that
keychain item's access list, so macOS pops an authorization dialog instead of returning, and
with nobody there to click it the main process never comes back: not a crash, just a launch
that hangs forever. The credential store now treats keyring availability as a lazy,
process-cached getter, so nothing touches the keyring unless a credential actually needs to
be read or written; an install with nothing signed in never touches it at all.

**`CALANDRIA_DESKTOP_LOG_FILE`** is a diagnostic-only variable `desktop/e2e` sets for every
launched shell, pointing `main.js` at a path to append every console line to synchronously,
ahead of the async logger. That matters because a hung launch is otherwise invisible on both
of the usual channels: `_electron.launch()` hands back no process handle until it resolves,
and electron-log's file transport only flushes through an event loop a blocked main thread
has stopped turning. `01-shell.spec.ts` asserts a `[shell] boot complete` line arrives and
that no `[shell] keyring:` line appears for an instance with nothing signed in; that
assertion runs on the Linux desktop e2e lane on every pull request, not the macOS lane, which
only runs on the weekly schedule or an explicit `macos` label.

On macOS, Chromium launches with `--use-mock-keychain`, so `safeStorage` still genuinely
encrypts and decrypts through OSCrypt but keeps its key in memory instead of the shared
login-keychain item multiple parallel test shells would otherwise fight over.

`npm run desktop:install` runs `npm --prefix desktop install --include=dev --no-audit --no-fund`
then `node desktop/node_modules/electron/install.js`. If Electron's binary is still missing
afterwards (`desktop/node_modules/electron/dist/` empty), run
`node desktop/node_modules/electron/install.js` by hand.

**The `NODE_ENV=production` trap.** Electron is a `devDependency` of `desktop/`. An `npm install`
run with `NODE_ENV=production` in the environment reports "up to date" and installs nothing, with
no error and no warning. A Calandria agent task session exports `NODE_ENV=production` by default, so
this bites there too. Fix: `NODE_ENV=development npm install`.

**macOS / Windows:** no extra system packages beyond what building the app already needs. Both
have a real window station, so nothing here needs a virtual display.

## 2. Commands

**Headless + window suite, from the repo root** (this is what CI runs):

```bash
npm run test:desktop:supervisor   # node desktop/test-supervisor.js: headless, ~8s, no display
npm run test:desktop:boot         # node desktop/test-real-boot.js: boots the real server.js/pty-server.js
xvfb-run -a npm run test:desktop:window   # playwright test --config playwright.desktop.config.ts: needs a display
xvfb-run -a npm run test:desktop          # all three, in that order
```

`npm run test:desktop` is `npm run test:desktop:supervisor && npm run test:desktop:boot && npm run
test:desktop:window`. On Windows and macOS, drop the `xvfb-run` prefix: both have a real window
station and need no display server.

### Packaged-artifact recipes

The same window suite takes a package instead of the dev shell via `CALANDRIA_TEST_BIN` (env-var
reference: §3). Two rules apply to every packaged run: the artifact must sit **outside this
checkout** (`desktop/e2e/fixtures.ts` refuses to launch a binary under the repo), and
`CALANDRIA_REPO_ROOT` must be **absent** (the fixture also deletes an inherited one), so `main.js`
is forced to resolve `resources/app-payload` the way a real install would.

**Linux, unpacked (what the `desktop` CI job does: no SUID `chrome-sandbox`, so `--no-sandbox` is
still passed and the spec records that):**

```bash
cd desktop && npm run payload -- --no-build && npx electron-builder --linux dir
cd .. && mv desktop/dist/linux-unpacked /tmp/calandria-app
CALANDRIA_TEST_BIN=/tmp/calandria-app/calandria-desktop \
  xvfb-run -a npm run test:desktop:window
```

**Linux, installed `.deb` (what the bench lane does: a real install, a real session, no
`--no-sandbox`):**

```bash
sudo dpkg -i desktop/dist/calandria-desktop_*_amd64.deb
CALANDRIA_TEST_BIN=/opt/Calandria/calandria-desktop CALANDRIA_DESKTOP_SANDBOX=1 \
  DISPLAY=:1 npm run test:desktop:window
```

**macOS, unpacked `.app` (what the `macos-desktop` CI job does: ad-hoc signed via `mac.identity:
"-"`, which is what lets arm64 exec it at all; it is still unsigned in the Developer ID sense
unless `CALANDRIA_MAC_SIGN_IDENTITY` is set):**

```bash
cd desktop && npm run dist:mac
cd .. && mv desktop/dist/mac*/Calandria.app /tmp/calandria-app.app   # mac-arm64 or mac, by host arch
codesign --verify --deep --strict /tmp/calandria-app.app             # should pass; if not, nothing will launch
CALANDRIA_TEST_BIN=/tmp/calandria-app.app/Contents/MacOS/Calandria \
  CALANDRIA_TEST_APP_BUNDLE=/tmp/calandria-app.app \
  npm run test:desktop:window
```

**macOS, DMG-mounted (verifies what the installer actually contains: the app inside is a `ditto`
copy of the same bundle, so all the round trip can break is the signature and the launch; run just
`06-packaged`, not the whole suite):**

```bash
hdiutil attach desktop/dist/*.dmg -nobrowse -readonly -mountpoint /tmp/cal-dmg
ditto /tmp/cal-dmg/Calandria.app /tmp/calandria-dmg.app
hdiutil detach /tmp/cal-dmg
codesign --verify --deep --strict /tmp/calandria-dmg.app
CALANDRIA_TEST_BIN=/tmp/calandria-dmg.app/Contents/MacOS/Calandria \
  CALANDRIA_TEST_APP_BUNDLE=/tmp/calandria-dmg.app \
  npx playwright test --config playwright.desktop.config.ts 06-packaged
```

**Windows (the one platform where CI tests the installer, not the unpacked tree:
`perMachine: false` means a silent install needs no elevation; no move out of the checkout is
needed since an installed app is outside the source tree already):**

```powershell
cd desktop; npm run payload -- --no-build; npx electron-builder --win nsis; cd ..
Start-Process (Get-ChildItem desktop/dist -Filter '*.exe' -File)[0].FullName '/S' -Wait
Get-Process -Name Calandria -ErrorAction SilentlyContinue | Stop-Process -Force
$env:CALANDRIA_TEST_BIN = "$env:LOCALAPPDATA\Programs\Calandria\Calandria.exe"
npm run test:desktop:window

# and back out again, the way Settings -> Apps would
& "$env:LOCALAPPDATA\Programs\Calandria\Uninstall Calandria.exe" /S
```

The `Stop-Process` is not optional: electron-builder's nsis target defaults `runAfterFinish` to
true, so the installer's own post-install launch would already hold
`requestSingleInstanceLock()` and the database lock, wedging the suite before it starts.

**Bench (native-integration specs, real session, no `xvfb-run`):**

```bash
DISPLAY=:1 CALANDRIA_DESKTOP_BENCH=1 npm run test:desktop:window
```

## 3. What the suite covers

| Spec | Covers |
|-|-|
| `01-shell.spec.ts` | Application menu roles, renderer hardening, the permission handler, external-link policy, and the single-instance lock, all via `app.evaluate()` into `desktop/main.js`: reach a browser suite doesn't have. Also asserts the boot-trace log carries `[shell] boot complete` and no `[shell] keyring:` line for an instance with nothing signed in |
| `02-smoke.spec.ts` | The only spec that touches product behaviour: one onboarding → project → task pass, proving a renderer with `contextIsolation`+`sandbox` on, no preload, still gets an EventSource transcript stream out of the server the shell booted |
| `03-quit-drain.spec.ts` | Quit drains in-flight turns (`/api/instance/drain` → SIGTERM/kill); the database assertion holds on every platform since `supervisor.stop()` POSTs the drain itself before it ever sends a kill |
| `04-db-lock.spec.ts` | The db-lock collision reads as "Another Calandria instance is already running against this database", not a crash dump |
| `05-windows-quit.spec.ts` | win32-only, skips elsewhere. A plain `taskkill` is a `WM_CLOSE` (close-to-tray hides the window, sidecars survive; a following `app.quit()` reaps them); `taskkill /F` without `/T` is a `TerminateProcess` that orphans the sidecars |
| `06-packaged.spec.ts` | The payload the app booted from, the bundled Node the sidecars ran under, and how `chrome-sandbox` is packaged/live. Skips itself when `CALANDRIA_TEST_BIN` is unset. **The only spec that cannot run against the dev shell** |
| `07-macos.spec.ts` | darwin-only, skips elsewhere. `titleBarStyle: "hiddenInset"` (content bounds equal window bounds only under `hiddenInset`), traffic-light behavior, and menubar submenu roles (Edit undo/redo/cut/copy/paste/select; app menu about/hide/quit; File close; Window minimize) |
| `08-macos-launchd.spec.ts` | darwin **and** packaged only, gated on `CALANDRIA_TEST_APP_BUNDLE`. **The only spec that does not use `_electron`.** It `open`s the bundle through LaunchServices instead of spawning the binary directly (a spawned binary inherits the caller's PATH, which is exactly the case where the launchd PATH repair is a no-op), captures stdout via `open --stdout`, and asserts `supervisor.js` recovered a real PATH from the login shell |
| `09-bench-notifications.spec.ts` | Bench-only (`CALANDRIA_DESKTOP_BENCH=1`). A parked turn's notification reaches a real notification daemon over D-Bus, which accepts it and hands back an id |
| `10-bench-tray.spec.ts` | Bench-only. The tray icon is registered with the panel (`org.kde.StatusNotifierWatcher`), and its menu (read over `com.canonical.dbusmenu`, since `Tray` has no getter) carries the "N need you" count |
| `11-bench-window.spec.ts` | Bench-only. Minimize/restore, close-hides-without-quitting, and a second launch focusing the existing window, each paired with the window manager's own `_NET_*` properties |
| `12-remote-instance.spec.ts` | Attaching the shell to a **second** production server by URL |
| `13-ssh-instance.spec.ts` | Attaching through a real `ssh localhost` forward; skipped where key-based ssh to localhost isn't already set up |
| `14-multi-instance-badge.spec.ts` | A task parked on each of two servers proves the dock badge is their sum |

### Env vars the suite reads

| Var | Effect |
|-|-|
| `CALANDRIA_TEST_BIN` | Path to a packaged binary; when set, the suite launches that instead of the dev shell |
| `CALANDRIA_REPO_ROOT` | Must be **absent** for a valid packaged-build test: `fixtures.ts` deletes an inherited one so `main.js` is forced to resolve `resources/app-payload` like a real install would, instead of quietly still reading the source repo |
| `CALANDRIA_DESKTOP_SANDBOX` | Set to `1` for an installed-package run. Sets two things: the `--no-sandbox` CLI arg is withheld, **and** `chromiumSandbox: true` is passed to `electron.launch()`. On Linux, Playwright unshifts `--no-sandbox` onto the argument list itself unless that option is given (playwright-core 1.61.1), so omitting just the flag is not enough |
| `CALANDRIA_TEST_APP_BUNDLE` | macOS-only. Points at the `.app` bundle itself (not the binary inside it), which is what `08-macos-launchd.spec.ts` needs to `open` it through LaunchServices |
| `CALANDRIA_DESKTOP_E2E_PORT` | Port base for the suite's own hermetic servers, default 4741, kept clear of the browser e2e suite's 4711 |
| `CALANDRIA_DB_DIR` / `CALANDRIA_WORKTREES_DIR` | Hermetic temp directories, forwarded to both sidecars via `sidecarEnv()` |
| `CALANDRIA_E2E_MOCK_AGENT=1` | Deterministic mock agent instead of a real login, same as the browser suite |
| `CALANDRIA_DESKTOP_BENCH=1` | Gates the three bench-only specs (`09`, `10`, `11`); only meaningful on a machine with a real desktop session |
| `CALANDRIA_DESKTOP_LOG_FILE` | Diagnostic-only, not in `.env.example`. Points `main.js` at a boot-trace log it appends to synchronously, ahead of the async logger. `desktop/e2e` sets it for every launched shell |
| `DBUS_SESSION_BUS_ADDRESS` | The suite points this at a socket that does not exist, so on a session bus with no notification daemon owning it, libnotify fails immediately instead of blocking the Electron main process for GDBus's ~25s timeout |

## 4. CI lanes

| Job | Runner | Trigger |
|-|-|-|
| `desktop` | `ubuntu-24.04` (`.github/workflows/test.yml`) | Same as `e2e`: main, dispatch, or the `e2e` label |
| `windows-desktop` | `windows-latest` (`.github/workflows/test.yml`) | Same as `e2e`: main, dispatch, or the `e2e` label |
| `macos-desktop` | `macos-latest` (`.github/workflows/test.yml`) | Weekly cron, dispatch, or the `macos` label; does **not** ride the shared `e2e` label |
| bench | self-hosted, labels `self-hosted, linux, x64, desktop-bench` (`.github/workflows/desktop-bench.yml`) | `workflow_dispatch` + nightly cron `37 3 * * *`; **no `pull_request` trigger** |

**Viewport clamping on hosted runners.** The hosted macOS and Windows runners have a 1024x768
virtual display and clamp the app's requested 1440x900 window down to fit it; `xvfb-run`'s screen
is larger with no window manager to clamp anything, so the Linux lane really gets 1440x900. A spec
that fails on the windowed lanes and passes under Xvfb is a size question first. Consequence for
writing specs: navigate by URL (`?project=&task=`) instead of clicking sidebar columns, since
`AUTO_COLLAPSE_BELOW` can shed a column to a 30px spine at the smaller size.

Reproduce the clamp locally instead of pushing to find out:

```bash
xvfb-run -a -s "-screen 0 1024x768x24"   # with openbox running inside it
```

## 5. The bench VM

| | |
|-|-|
| Host | `calandria-desktop-bench`, 192.168.3.70 (VLAN 3), VMID 3050 |
| Spec | Ubuntu 24.04, 4 vCPU / 8 GiB / 60 GiB on `ceph-ssd` |
| Placement | HA-enabled with no placement rule; floats across all four Orion nodes |
| Session | Xfce on `:1`: xfwm4, xfce4-panel with an explicit `systray` plugin, dunst |
| Rendering | llvmpipe, `LIBGL_ALWAYS_SOFTWARE=1` |
| Installed | node v22.23.2, npm 10.9.8, gh 2.98.0, Docker 29.7.2, xvfb, Chromium's shared-library set |
| Rebuilt by | The `desktop_bench` role in `ansible-orion`. Fix drift by re-running the playbook, not by hand |
| Runner | Not registered as a GitHub Actions runner. `desktop-bench.yml`'s `workflow_dispatch` and nightly cron both queue and time out after 24h with no runner to claim them; run the suite on the VM by hand instead (§2 recipes, over the Access connection below) |
| Backups | Excluded from the nightly vzdump job |

### Access

```bash
ssh -L 5901:localhost:5901 penmoid@192.168.3.70
vncviewer localhost:5901
```

`desktop-bench-check` asserts the session is real, not a bare X server. It exits non-zero if any
of four things is missing, and runs in every spec file's `beforeAll` via `assertBenchSession()`
(`desktop/e2e/bench.ts`):

```
$ desktop-bench-check
display        :1
ok    X server reachable
ok    window manager running
ok    notification daemon
ok    status notifier host
window manager Xfwm4
gl renderer    llvmpipe (LLVM 20.1.2, 256 bits)
node           v22.23.2
```

Each spec file asks only for the checks it uses, so a dead status area (see §6) fails just the
tray spec, not the notification and window specs too.

### Gotchas

**`require` is not in scope inside `app.evaluate()`.** Playwright evaluates the callback body in
the main process with no CommonJS module wrapper, so `require` is simply undefined. Reach the main
process's own `require` instead:

```js
const fs = process.mainModule.require("node:fs");
```

**The session bus is not the systemd user bus.** Over SSH, `pam_systemd` has already exported
`DBUS_SESSION_BUS_ADDRESS` pointing at `$XDG_RUNTIME_DIR/bus`, a real bus but with none of the
session's daemons on it. Read the address the session actually publishes to
`~/.vnc/session-bus` instead, and ignore the inherited value.

**Tray-panel recovery**, when xfce4-panel's systray plugin has crashed (see §6):

```bash
# NOT `pkill -f xfce4-panel`: the pattern matches the ssh command line running it
pkill -9 -x xfce4-panel; pkill -9 -x wrapper-2.0
sleep 2; (setsid nohup xfce4-panel >/dev/null 2>&1 &)
```

**Egress.** VLAN 3 egress to the public internet is open, subnet-wide. If a CI job on the bench
sees an intermittent dropped connection, check Suricata/IPS alerts (VLAN 3 runs IPS in active
blocking mode) before assuming a config problem.

## 6. Known issues

**xfce4-panel's systray plugin can crash when Electron registers a status icon.** This is
deterministic on the bench, not a flaky pass/fail: the crash takes
`org.kde.StatusNotifierWatcher` off the bus with it, so `desktop-bench-check` reports `FAIL status
notifier host` and the tray spec cannot find the icon it's looking for. `11-bench-window.spec.ts`
and `10-bench-tray.spec.ts` branch on the session's own answer: they check whether a tray is
present instead of assuming one. Recovery: the pkill/relaunch recipe in §5. A permanent host fix
(a status-notifier host
that survives a Chromium-shaped item) is not done yet.

**Windows: `before-quit`/`will-quit` are never emitted on a real shutdown or logout.** No test
covers this: there is no `session-end` listener yet, so nothing drains on that path. The suite's
Windows coverage (`05-windows-quit.spec.ts`) only exercises app-initiated quit and external
`taskkill`, which do fire the events.

**Viewport clamping on hosted runners is not a regression.** See §4: it's the runner's display
size, not flakiness. Reproduce with the `xvfb-run -a -s "-screen 0 1024x768x24"` + `openbox`
recipe before treating a red windowed-lane spec as a real bug.

## 7. Reading logs

`attachShellLog()` appends the window's content bounds and the display's size to every failure it
attaches. Check this first when a desktop spec is red on a windowed lane (Windows/macOS) but
green under Xvfb.

`08-macos-launchd.spec.ts`'s PATH-repair diagnostic goes to **stdout only** as well as to an
attachment: a green run uploads no `test-results/` artifact (`if-no-files-found: ignore`). Grep
the job log for the literal string `[08-macos-launchd]`.

`07-macos.spec.ts` uploads a screenshot (`hiddenInset.png`) plus a JSON probe of the traffic-light
area on `if: always()`. It is the only spec that attaches evidence on a **green** run, since "does
the titlebar overlap look right" is a question no assertion can answer.

Packaged-app runs keep screenshots-on-failure and log capture only, not traces or video:
Playwright's trace/video capture against a packaged Electron app is unreliable
([microsoft/playwright#13180](https://github.com/microsoft/playwright/issues/13180)).

**Runtime app log paths**, for a failing packaged run (via `electron-log`):

| Platform | Path |
|-|-|
| macOS | `~/Library/Logs/Calandria/main.log` |
| Linux | `~/.config/Calandria/logs/main.log` |
| Windows | `%APPDATA%\Calandria\logs\main.log` |

## Tooling note

Playwright's `_electron` driver is what this suite uses; the fixtures, assertions and CI habits
already exist in this repo and `_electron.launch()` reuses all of them, plus `evaluate()` into the
**main process** where most shell-only facts live. `@wdio/electron-service` (WebdriverIO) and
nut.js/xdotool are kept in reserve for cases neither CDP nor the Electron API can observe (mocking
a native API class, real OS-level input); not needed today.
