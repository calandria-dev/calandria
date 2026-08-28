# Cross-platform desktop app — spike

**Question:** can Calandria be wrapped as a desktop app (Electron or similar), and
what would it cost?

**Answer:** yes, and the working prototype is in [`desktop/`](../desktop). The
shell is thin because the app already is a server — the wrapper starts it, waits
for it, shows it, and drains it on quit. What it must *not* do is host the server
inside Electron's runtime; that one decision is where the sharp edges are, and
all of them were measured rather than reasoned about (§2).

**Recommendation, in order:**

1. **Adopt the prototype as a developer launcher** — `cd desktop && npm start`
   against a checkout the user already has. It needs no code signing, no CI lane,
   no auto-updater and no product decision. It is the whole "double-click instead
   of a terminal" win, for the people who have the repo. A packaged,
   self-contained build now also exists (`npm run dist:linux`, §6) — it carries
   its own server payload and Node runtime instead of pointing at a checkout, but
   it still needs none of the signing, CI or updater work below.
2. **Defer signed installers** until someone asks. That is where the entire cost
   lives (§7): ~$300/yr in certificates, a three-OS release lane, an update
   channel, and a standing obligation to ship Chromium security bumps. It does
   **not** buy a zero-prerequisite install — Calandria drives `git`, `claude` /
   `codex` and a real shell on the host, so its user has a developer machine
   either way.
3. **Do not port anything.** No code moved, no abstraction changed, nothing in
   `lib/` learned about Electron. If that stops being true, the wrapper is
   growing into a fork of the app and should be re-argued.

The other half of "cross platform" — whether the server itself runs on Windows —
is [`WINDOWS.md`](WINDOWS.md), and it now does, natively. The two remain
independent: the shell in `desktop/` runs on Windows today, and the server it
would start no longer has platform gaps under it, only the shutdown-path
difference noted below.

---

## 1. Architecture

```
┌─ Electron main (desktop/main.js) ──────────────────────────────┐
│  window · menu · single-instance lock · quit drains first      │
│                                                                 │
│  supervisor.js  ── spawn ──►  node server.js     (:3000+)      │
│  (no electron)  ── spawn ──►  node pty-server.js (:3001+)      │
│                                                                 │
│  BrowserWindow ──── http/SSE/WS ───► http://127.0.0.1:<port>   │
└─────────────────────────────────────────────────────────────────┘
```

The renderer is an ordinary hardened browser tab: `contextIsolation: true`,
`sandbox: true`, `nodeIntegration: false`, **no preload and no IPC**. The app
talks to its server over HTTP/SSE/WebSocket already and gains nothing from a
bridge, while a bridge would hand any XSS in the transcript renderer the whole
Node API. External links open in the user's real browser.

`supervisor.js` contains no `require("electron")`. That is not tidiness: it makes
the risky half testable on a headless box (25 assertions, `node
test-supervisor.js`, ~9 s, no display), and it means a later swap to Tauri or a
tray-only launcher reuses it whole.

## 2. Measured findings

Every row was run on this machine (Linux x64, Node 22.18.0, Electron 44.0.0),
not inferred.

| Finding | Measurement |
|-|-|
| Electron and Node are different V8 ABIs | Host `node` 22.18.0 → `process.versions.modules` **127**. Electron 44 → Node 24.18.1, modules **149**. |
| `better-sqlite3` cannot be hosted in Electron unrebuilt | The npm prebuild loads under `node`; under `ELECTRON_RUN_AS_NODE=1 electron` it fails with the "was compiled against a different Node.js version" error. Hosting the server in-process therefore requires `@electron/rebuild` on every Electron bump, per platform. |
| `node-pty` is fine either way | It is a `node-addon-api` (N-API) addon: it loaded **and spawned a working pty** under Electron's runtime. Only the SQLite half is ABI-bound. |
| An Electron binary is not a Node binary | `electron ./script.js` boots a Chromium app (here: aborts on the SUID sandbox check). `ELECTRON_RUN_AS_NODE=1 electron ./script.js` prints the script's output. |
| **Hosting the server in Electron would break Codex turns** | `lib/agents/codex/driver.ts:58,74` registers the MCP tool bridge as `command: process.execPath, args: [calandria-mcp.mjs]` with a **closed four-key env** (`CALANDRIA_TASK_ID`, `CALANDRIA_PROJECT_ID`, `CALANDRIA_BASE_URL`, `SERVICE_TOKEN`). Inside Electron that `execPath` is the Electron binary and the child inherits no `ELECTRON_RUN_AS_NODE`, so every Codex turn would silently launch a GUI process instead of the bridge. |
| Two independent port searches collide | With 3000 and 3001 both busy (a live instance), the first draft of `pickPorts` gave **both** sidecars 3002; one lost the bind, and the readiness probe happily talked to whichever won — `pty-server.js` answers every path with a 200 banner, so `/api/version` "succeeded". Fixed by a shared claim set, and the readiness probe now insists on the app's JSON shape. Found by booting the real server, not by the stubs. |
| macOS GUI apps get launchd's PATH | A `.app` opened from Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin` — not the user's shell PATH. `codex` (spawned bare, `lib/agents/codex/mcp.ts:38`), `gh` (probed on PATH, `lib/github.ts:35`) and an nvm-managed `node` are all invisible to a double-clicked Calandria while working in the same user's terminal. The supervisor detects the stub PATH and re-reads it from the login shell. |
| The real server boots under the shell's supervisor | `node desktop/test-real-boot.js`: **919 ms** to `/api/version`, on ports 3002/3003 (stepped past the live instance), app HTML served, `/pty` proxied to the sidecar we chose, `CALANDRIA_DB_DIR` honoured, both sidecars drained and reaped with no SIGKILL. |
| Electron's size is not the dominant term | Electron 44 linux-x64 unpacks to **282 MB**. The payload it would wrap — `.next` (127 MB) plus a pruned `node_modules` — is larger; the container carrying the same payload with Debian, git, gh and both agent CLIs is **3.99 GB**. |
| **…and the packaged app confirms it** | `npm run dist:linux` (2026-08-27, this machine): `dist/linux-unpacked` **2.1 GB**, AppImage **653 MB**, deb **485 MB**. Electron is ~13% of it. The payload's `node_modules` is **1.6 GB** on its own. |
| What is actually big is the agent CLIs | Inside that 1.6 GB: `@openai/codex-linux-x64` **350 MB**, `@anthropic-ai/claude-agent-sdk-linux-x64` **230 MB** + its `-musl` twin **225 MB**, `@next/swc-linux-x64-gnu` **137 MB** + its `-musl` twin **137 MB**. npm already scoped these to linux-x64; the ~380 MB of glibc/musl duplication is what a desktop build could still drop. |
| `.next` and the bundled Node are minor terms | `.next` **55 MB** (`next build --turbopack` leaves `.next/cache` empty, so the drop in `build-payload.js` reclaims nothing here — it is insurance against a non-turbopack build). The vendored `node` binary is **116 MB**. |
| The packaged app boots on its own payload | `dist/linux-unpacked/calandria-desktop` under `xvfb-run`, with `CALANDRIA_REPO_ROOT` unset: `[shell] node: …/resources/node/bin/node v22.18.0 (bundled)` then `[shell] ready on http://127.0.0.1:4751 (version 0.3.0)`. The dead "bundled" branch of `resolveNode` is the one that fires. |

### The rule those findings add up to

**The server runs under a real `node`, never inside Electron.** `supervisor.js`
enforces it from both ends: it refuses a runtime whose basename looks like
Electron (`electron --version` prints a convincing `v44.0.0`, so the version
probe alone would pass and fail later as an ABI error), and it strips every
`ELECTRON_*` variable from the sidecar environment so nothing downstream — agent
CLIs, MCP bridges, the user's login shell in the terminal panel — inherits
Electron's runtime flags.

## 3. Shell options

| Option | Verdict |
|-|-|
| **Electron** (recommended) | Ships the same Chromium the app is developed and e2e-tested against, on all three platforms. Mature packaging/signing/auto-update ecosystem. Costs ~280 MB and a Chromium-CVE patch cadence *if* we distribute binaries. |
| **Tauri / Wails** | Much smaller, but uses the *system* webview — WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux. This app is not a form: xterm.js, CodeMirror, mermaid, SSE, service worker, Web Push. Three engines means three rendering bug surfaces and a Rust/Go toolchain in CI, to save disk that the app payload dwarfs anyway (§2). Because `supervisor.js` is Electron-free, this stays a cheap reversal if the calculus changes. |
| **Menubar/tray-only launcher** | Same supervisor, no `BrowserWindow`: start/stop the server, open the browser. Keeps the user's browser (where their GitHub session and devtools live) and drops the renderer surface entirely. Genuinely attractive as a *variant* of phase 1, and ~60 lines on top of what exists. |
| **PWA ("Install app" in Chrome/Edge)** | Free, today, no code: a windowed, dock-able Calandria with notifications. It does not start the server, which is the actual complaint. Worth documenting either way. |
| **Just a browser tab** | The status quo. Costs nothing and works remotely, which the desktop app does not replace. |

## 4. What the prototype does — and what is unverified

Working and tested (`desktop/test-supervisor.js`, 25 assertions; `desktop/test-real-boot.js`, 8):

- Node resolution — `CALANDRIA_NODE` → bundled → `execPath` (only when not Electron) → PATH, with an actionable error naming everything it tried.
- macOS launchd-PATH detection and repair from the login shell, fenced against rc-file chatter, `null` rather than a throw on failure.
- Port selection that steps past a running instance and never hands both sidecars the same port, seeded from `PORT`/`PTY_PORT` when they are set (a preference — a busy one is still stepped past).
- Readiness polling that insists on the app's own `/api/version` shape.
- Quit → POST `/api/instance/drain` → SIGTERM → exit, with SIGKILL only as a backstop and a bounded wait so nothing outlives the window holding the db lock. The supervisor makes the drain request itself rather than relying on the server's own signal handler, so it works identically where SIGTERM is not deliverable.
- The db-lock exit (`server.js` exits 1 when another instance holds the database) reported as "another Calandria is already running", not as a crash.
- A boot screen that streams sidecar logs, because a cold first launch is otherwise indistinguishable from a hang.

Also working and tested, since 2026-08-27, by the Playwright `_electron` suite in
`desktop/e2e/` under a virtual display — the `desktop` job in
`.github/workflows/test.yml` runs it on every push to main and on any PR
carrying the `e2e` label ([`DESKTOP_E2E.md`](DESKTOP_E2E.md)):

- The window appears on the boot screen, the boot screen streams the supervisor's
  log, and the window swaps to the app's own origin. (It did not stream anything
  before this suite existed: `loading.html`'s CSP blocked its own inline script,
  silently. Fixed.)
- The application menu and its roles, and the two items the View menu owns.
- The renderer is still a hardened browser tab — `contextIsolation`, `sandbox`,
  no `nodeIntegration`, no preload.
- The permission handler: notifications granted, everything else refused.
- External links leave through `shell.openExternal` on both paths
  (`setWindowOpenHandler` and `will-navigate`) and the window stays on the app.
- A second launch is refused by the single-instance lock rather than racing for
  the database.
- The db-lock exit reaches the user as "another Calandria is already running".
- `app.quit()` drains a live turn — the row is settled in SQLite after the
  process is gone — and the server exits.
- One smoke path through the app inside the window, so SSE and the renderer are
  known to work under Electron's own network stack.

**Still unverified:** everything that needs a *real* session rather than a
virtual display — the macOS `hiddenInset` title bar, a window manager that
reparents, a tray with an AppIndicator host, and a notification that actually
reaches a daemon. (The suite has to point libnotify at a dead bus to run at all:
without a notification daemon each native notification blocks Electron's main
process for 25 s. See `DESKTOP_E2E.md` §1.) First run on a desktop machine is
still a step worth taking, and is likely to find small things.

Packaging (`electron-builder`) is no longer on this list — see §6. Still not
attempted: tray/menubar, deep links (`calandria://`), dock badge for the "N need
you" count, window-bounds persistence, auto-update.

## 5. Per-platform gaps

**macOS** — the PATH repair above is mandatory, not polish. Signing +
notarization are required for anything distributed (Gatekeeper blocks unsigned
apps by default). `hiddenInset` overlaps the app's own titlebar row; needs a look
on a real screen.

**Windows** — the server's own gaps are closed ([`WINDOWS.md`](WINDOWS.md)):
the pty sidecar probes a real Windows shell, managed services are killed as a
`taskkill /T` tree, and path identity is case-folded. The gap that was the
supervisor's, not the app's — `.kill()` on Windows is `TerminateProcess`, so a
quit from the shell had no signal to carry a graceful shutdown — is closed:
`stop()` POSTs `/api/instance/drain` itself and waits for it, bounded by
`CALANDRIA_SHUTDOWN_GRACE_MS`, before it ever sends the kill. The signal path is
now the backstop rather than the mechanism, so it degrades the same way on every
platform instead of only where SIGTERM is deliverable. `npm start` solves the
same problem for the console with `scripts/start.mjs`, which relies on the
console broadcasting Ctrl+C — a path a GUI supervisor doesn't have, which is why
the drain still has to be requested rather than signalled. (`npm start` used to
carry a POSIX-only inline `NODE_ENV=production` prefix; it now goes through
`cross-env`, and the supervisor spawns `node` directly with an env regardless.)
One gap remains, and no test covers it: on a real shutdown or logout Electron
emits neither `before-quit` nor `will-quit` (the session ends through
`WM_QUERYENDSESSION`/`WM_ENDSESSION` instead), so nothing drains — a
`session-end` listener does not exist yet. `desktop/e2e/05-windows-quit.spec.ts`'s
header is the existing statement of that gap.

**Linux** — works as-is under X11/Wayland. Running from a plain directory means
no sandbox unless `chrome-sandbox` is root-owned/4755; packaged builds handle it,
though not the way that sentence implies — electron-builder 26's deb `postinst`
leaves the helper 0755 wherever user namespaces work and ships
`/etc/apparmor.d/calandria-desktop` instead, which is what lets the namespace
sandbox survive Ubuntu 24.04's `kernel.apparmor_restrict_unprivileged_userns=1`
(measured on the bench, `docs/DESKTOP_E2E.md` §1). AppImage/deb/rpm are all
electron-builder targets.

## 6. Packaging

The prototype now produces a real artifact, not just a `desktop/` checkout:

```bash
cd desktop && npm install
npm run dist:dir      # → dist/linux-unpacked/calandria-desktop
npm run dist:linux    # dist:dir, plus deb and AppImage targets
```

Signing, notarization and auto-update are deliberately **not** wired into this —
that is still phase 2 (§7).

**Layout of the packaged app:**

| Path | What it is |
|-|-|
| `resources/app.asar` | The Electron shell (`main.js`, `supervisor.js`, `loading.html`). |
| `resources/app-payload/` | The server payload — everything `node server.js` needs. |
| `resources/node/bin/node` | The Node runtime the sidecars are spawned under. |

The payload is `extraResources` and deliberately **not inside the asar**: it
holds native addons (`better-sqlite3`, `node-pty`) that `dlopen` from a real
path on disk, and it is spawned as a child process — neither can reach into an
archive.

**What the payload is built from** (`desktop/scripts/build-payload.js`): `.next`
(minus `.next/cache`, which is `next build`'s own scratch and is dropped, with
the dropped size logged rather than silently shipped or silently omitted from
the report), a pruned production `node_modules` **installed** with `npm ci
--omit=dev` into the staging dir — not copied from this dev checkout, whose
`node_modules` carries the whole dev toolchain — plus `server.js`,
`pty-server.js`, `next.config.mjs`, `package.json`, and every plain-Node `.mjs`
the two entrypoints dynamic-import. That last file list is the **same
inventory** the Dockerfile's runtime stage `COPY`s, and it is kept from drifting
by `desktop/payload-manifest.js` plus `tests/desktopPayload.test.ts`, which
fails the suite when the Dockerfile's COPY list and the manifest disagree — a
new `.mjs` import has to be added to both or the build ships an app that boots
into an unresolved import.

**A Node binary is bundled, not borrowed.** `supervisor.js`'s `resolveNode`
already preferred `<resourcesPath>/node/bin/node` (the "bundled" source); that
branch was dead until this build made it live. Two reasons it exists at all: a
double-clicked app must not depend on the PATH it launched with, which on macOS
is launchd's stub (§2) and on a fresh box may have no Node at all; and it pins
the ABI — `better-sqlite3` ships per-`NODE_MODULE_VERSION` prebuilds, so a
payload installed under one Node major and then run under whatever `node` the
user happens to have is a coin flip that lands as "compiled against a different
Node.js version" at the first query. The vendored version defaults to the
**host's own** Node version — the same one that ran `npm ci` for the payload —
so the pair matches by construction; `CALANDRIA_DESKTOP_NODE_VERSION` overrides
it for a reproducible, pinned CI build. The download (`scripts/fetch-node.js`)
is sha256-verified against the official `SHASUMS256.txt` before it is unpacked;
only the `node` binary is taken, not `npm` or the headers.

**Native modules follow the bundled Node, not Electron.** `npmRebuild: false`
and `nodeGypRebuild: false` stay set in the `electron-builder` config
(`desktop/package.json`) so nothing rebuilds the addons against Electron's
ABI — the addons are never loaded by Electron, only by the vendored Node the
sidecars run under. `build-payload.js` ends with a real check rather than an
assumption: it runs the vendored `node` with `require('better-sqlite3');
require('node-pty')` against the staged tree, so an ABI mismatch fails the build
instead of the app's first query.

One `electron-builder` trap is recorded here because it fails silently and
looks like a payload bug: a single `{from: "payload", to: "app-payload"}` entry
copies everything **except** `node_modules`. electron-builder manages app
dependencies itself and filters that name out of `extraResources`, so the
packaged app looks complete on disk and dies at first boot on an unresolved
`next`. The second, explicit `payload/node_modules` entry in
`desktop/package.json` is what actually carries it.

**`CALANDRIA_REPO_ROOT` still wins** over both the packaged payload and an
unpackaged checkout — that is how a packaged binary gets pointed at a working
tree instead of its own bundled payload, which is exactly what the window test
harness does with `CALANDRIA_TEST_BIN` ([`DESKTOP_E2E.md`](DESKTOP_E2E.md)).

A second trap costs nothing but time: electron-builder 26.15.3 warns on every
Linux build that `desktopName` is not set — and then **rejects** `desktopName`
as an unknown key if you set it, in `linux` or anywhere else its schema reaches.
The option the warning names does not exist in this version. `syncDesktopName`
does and is set; the warning is noise.

Sizes are in §2's table rather than here, because they are measurements. The
short version: the artifact is large and Electron is not why.

**Isolation is unchanged by any of this.** Electron and `electron-builder` live
only in `desktop/package.json`'s `devDependencies` — not in the root
`package.json`, not in the Docker image, not in the app's CI. `desktop/payload/`
(the staging dir above), `desktop/vendor/` (the vendored Node) and
`desktop/dist/` (electron-builder's output) are build intermediates and stay
gitignored.

## 7. Cost of going further (phase 2)

| Item | Cost |
|-|-|
| Apple Developer Program + notarization | $99/yr, plus a signing lane in CI |
| Windows code signing (OV/EV) | ~$200–400/yr; unsigned means a SmartScreen warning on every install |
| Three-OS build matrix | New CI lane; native modules must be built per platform (the payload's `better-sqlite3` follows the *bundled* Node, not Electron, under this architecture) |
| Auto-update | `electron-updater` + a release channel; interacts with release-please and the existing edge/latest image publishing |
| Security cadence | Chromium CVEs become our shipping obligation once binaries carry our name |
| Support surface | "It won't start" reports from machines whose PATH, Node, or antivirus we cannot see |

Against that: the wrapper removes a terminal and a URL from the daily loop, and
adds reliable OS notifications. That is a real improvement for a daily driver and
a thin one for an occasional user — which is why the recommendation is to ship
the free half now and let demand pay for the rest.

## 8. Next steps

1. Run `desktop/` on a machine with a display; fix what the window layer gets wrong.
2. Decide between window-first and tray-first for phase 1 (both are the same supervisor).
3. Native notifications + dock/taskbar badge wired to the existing "needs you" count — the highest-value thing the shell can add that a browser tab cannot.
4. Only then: signing, auto-update (packaging itself is done — §6).
