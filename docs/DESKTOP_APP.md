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
  process is gone — and the server exits. So does closing the WINDOW, which is
  the quit a Windows or Linux user actually performs, and which now keeps the
  window on screen while it waits (see below).
- Copy and paste: Ctrl/Cmd+C in the renderer reaches the OS clipboard and
  Ctrl/Cmd+V comes back. The menu test above asserts the Edit roles exist; this
  asserts they do something.
- One smoke path through the app inside the window, so SSE and the renderer are
  known to work under Electron's own network stack — plus the terminal panel,
  which is xterm over the `/pty` upgrade `server.js` proxies to the sidecar and
  is the only coverage that sidecar has in either suite.

### The first run with a display (2026-08-28)

The window had never been looked at — the spike box is headless — so this was
one session driven end to end and then run again by hand under a **window
manager and a notification daemon**: Xvfb with openbox, dbus and dunst on the
dev box. Not a physical desktop: no GPU, no compositor, no Wayland, no login
session. What it establishes is the class of thing a bare virtual display
hides, which is most of what was on this list; what it does not is anything
that needs a real seat, which stays the bench VM's job (§5, `DESKTOP_E2E.md`
§5).

What it found, in order of how much it mattered:

- **Closing the window drained invisibly.** The X button is the ordinary quit on
  Windows and Linux, and it reaches the drain by a different route than
  Cmd/Ctrl+Q does: `close` → `window-all-closed` → `quit()` → `before-quit`. The
  window was destroyed 15 ms in (measured) and everything after that — the POST
  to `/api/instance/drain`, settling the turns, stopping the sidecars — happened
  with nothing on screen. A fast drain hides it; a real turn mid-write does not,
  and a user who relaunches inside that window is told another Calandria is
  already running, which reads as a crash rather than as a shutdown still in
  progress. `main.js` now `preventDefault`s the close and routes it through
  `app.quit()`, so the window is still there to carry the drain state, and that
  state is now an overlay on the page as well as the window title — the title
  alone is invisible on a desktop that draws no title bar, and the page
  underneath is a live app whose server is being stopped out from under it.
  Pinned by the third test in `desktop/e2e/03-quit-drain.spec.ts`, which reads
  the state from inside the main process at `before-quit` rather than racing a
  200 ms drain from outside.
- **The window title belongs to the page, not to us.** It reads
  "Calandria - Welcome" under a WM, because `app/Shell.tsx` sets `document.title`
  per project and a page title outranks `BrowserWindow`'s. `setTitle()` still
  lands during the drain (nothing re-renders it in that window), but that is
  exactly why the drain overlay above is not optional.
- **`npm start` from a checkout needs `--no-sandbox` on Linux.** Electron
  unpacked by npm has a `chrome-sandbox` owned by the user, and Chromium refuses
  to run rather than run unsandboxed: `FATAL: The SUID sandbox helper binary was
  found, but is not configured correctly`, then SIGTRAP. Either pass the flag or
  `sudo chown root:root` + `chmod 4755` that file. Not a shell bug, and a
  packaged install does not have it — though not because the `.deb` sets that
  bit: electron-builder 26 leaves the helper 0755 and ships an AppArmor profile
  so the *namespace* sandbox works instead (§5, Linux). It is step one of the
  developer flow either way, so `desktop/README.md` now says so. The suite never
  hit it because `_electron.launch()` passes `--no-sandbox` on Linux itself.
- **Everything else in the window worked on first sight.** The boot screen with
  its streaming log, the handoff, a live turn arriving over SSE, the diff with
  its hunk, the terminal panel talking to the pty sidecar, external links
  leaving for the browser. Under openbox the window is reparented and decorated
  (`_NET_FRAME_EXTENTS` = 1,1,20,5); **F11 sent as a real X key** — the View
  menu's `togglefullscreen` accelerator, not a CDP call — takes it to
  `_NET_WM_STATE_FULLSCREEN` at the full 1600x1000 and back; Ctrl+plus and
  Ctrl+0 zoom and reset.
- **A native notification really reaches a daemon.** With dunst owning
  `org.freedesktop.Notifications`, a task parking on a permission card produced
  `Waiting for input` / `Notify me · WM Run`, appname `calandria-desktop`. This
  is the one thing the CI lanes structurally cannot show: they point libnotify
  at a dead bus on purpose, because without a daemon each notification blocks
  Electron's main process for GDBus's 25 s timeout (`DESKTOP_E2E.md` §1).
- **The native menu bar sits above the app's own header row** on Linux (and
  Windows), where Electron draws it inside the window. Two chrome rows, both
  legible; left alone deliberately rather than hidden behind
  `autoHideMenuBar`, since on those platforms the menu is the only discoverable
  home for Reload app, Open in browser and the zoom items. This is the same
  question `titleBarStyle: "hiddenInset"` answers on macOS, decided the other
  way because the surfaces are not the same. The Windows pass reached it from
  the other side and left the lever named for this task (§5): there it is
  *three* rows, since Windows keeps a native frame above the menu bar that
  macOS collapses — one row worse, same answer.

**Still unverified:** a tray icon with an AppIndicator host (there is no tray
yet), a real compositor — Wayland, a GPU, a login session, a dock — and the
install paths that put a `.desktop` entry and an icon in front of a user. The
macOS `hiddenInset` title bar is the `macos-desktop` lane's: a hosted runner has
a real WindowServer, so nothing there needs a virtual display (§5).

Windows had its own first run, on real hardware, and it found two more things
(§5): a `SHELL` the shell used to invent for the pty sidecar, which had turned
from a mitigation into a downgrade pinning every terminal tab to PowerShell 5.1,
and a `waitForReady` that sat out its full 90 s timeout on a sidecar that had
already exited (both fixed). What no first run on any platform covers is a real shutdown or
logout, where Electron emits neither `before-quit` nor `will-quit` — so the
drain this section is largely about does not run at all (§5).

Packaging (`electron-builder`) is no longer on this list — see §6. Still not
attempted: tray/menubar, deep links (`calandria://`), dock badge for the "N need
you" count, window-bounds persistence, auto-update.

## 5. Per-platform gaps

**macOS** — the PATH repair above is mandatory, not polish, and it is no longer
taken on faith: the `macos-desktop` lane (`docs/DESKTOP_E2E.md` §4) `open`s the
packaged `.app` through LaunchServices, exactly as a double-click does, and
asserts that the supervisor was handed launchd's stub PATH and recovered a real
one from the login shell. That is a claim no other spec can make — every
`_electron` launch is a child of the test process and inherits its PATH, which
is the environment where the repair does nothing. `hiddenInset` is settled the
same way: the window's content box and its frame are asserted to be the same
rectangle (under `default` macOS steals a strip for the title bar, so they are
not), the traffic lights are asserted to survive, and the lane uploads a
screenshot on a green run so the one thing an assertion cannot judge — the
buttons sitting over the app's own titlebar row — is in front of a human rather
than in this paragraph. Menu roles run under a real menubar there too, which
matters more here than anywhere else: on macOS `{ role: "editMenu" }` *is*
Cmd+C/V/A, so a missing menu is a broken app rather than a cosmetic gap.

What remains open is distribution, not behaviour. Signing + notarization are
required for anything downloaded (Gatekeeper blocks unsigned apps by default),
and that stays §6's decision. The lane ad-hoc signs its artifact
(`codesign --sign -`) for one narrow reason with no bearing on that: arm64 macOS
will not exec a Mach-O carrying no signature at all, and electron-builder
invalidates the one Electron's prebuilt arrived with.

**Windows** — **verified on real hardware**, not just on a runner: Windows 11 Pro
26200, a logged-in console session, Defender real-time protection on. Native is the
supported configuration and the one to start from.

What the box did, in order. `desktop/test-supervisor.js` passes whole (25/25) — including
the two cases that only ever execute here, `needsPathRepair` returning false and the
`sidecarEnv` shell handling below. `desktop/test-real-boot.js` passes whole: the real
`server.js` and `pty-server.js` come up under a plain `node <script>` spawn in 1.4s on
3000/3001, and `stop()` reaps both without reaching the `SIGKILL` backstop. `resolveNode`
finds `node.exe` on `PATH`, and takes a `CALANDRIA_NODE` pointed either at nvm-windows'
`C:\nvm4w\nodejs\node.exe` symlink or at a versioned root directly — nvm-windows swaps a
directory symlink rather than interposing a shim executable, so there is nothing here for
the `execFileSync(bin, ["--version"])` probe to trip over. `pickPorts` steps 3000/3001 →
3002/3003 with the defaults held, and 3003/3004 with 3002 held too. Launched from the
console session, Electron opens a real framed window titled by the app itself, the
single-instance lock refuses a second launch (exit 0 in ~1s, one window still on screen),
and closing that window tears the whole thing down in 384ms with zero stray `node.exe` —
`[shell] drained in-flight turns (status 200)` in the log, so the HTTP drain is doing the
work a signal cannot do here. The terminal panel gets a genuine interactive PowerShell
7.6.5 in the requested cwd. Nothing was blocked: npm's extraction leaves no
`Zone.Identifier` stream on `electron.exe`, so SmartScreen never fires for a run out of a
directory, and Defender logged no detection. (Signing is still required for anything
*distributed* — see §6 — but it is not what stands between a developer and a first run.)

Two things the shell had wrong, one fixed here and one left as a finding.

- `sidecarEnv()` used to invent a `SHELL` on win32, from back when `pty-server.js`'s
  unset-`$SHELL` default was a hardcoded `/bin/zsh`. That default is now a probe
  (`CALANDRIA_PTY_SHELL` → `$SHELL` → `pwsh.exe` → `powershell.exe` → `COMSPEC`), and
  `$SHELL` is consulted *before* it — so the mitigation had become a downgrade. Worse than
  it reads: the fallback was `out.COMSPEC || "powershell.exe"`, and `out` is a plain object
  copied out of `process.env`, which drops Windows' case-insensitive env lookup — the real
  key is spelled `ComSpec`, so `out.COMSPEC` was always `undefined` and every desktop
  terminal tab would have been pinned to Windows PowerShell 5.1. Measured: with the
  injection gone, the pty sidecar spawns pwsh 7.6.5. The injection is removed; an inherited
  `SHELL` is still passed through untouched.
- `waitForReady` did not short-circuit on a sidecar that had already exited — **fixed**.
  Two supervisors against one `CALANDRIA_DB_DIR` reproduced it: the second one's `app`
  child exits 1 immediately with the db-lock message, `onExit` fires correctly with
  `dbLockHeld: true`, and then `start()` sat out the full 90s readiness timeout before
  rejecting with a misleading `fetch failed`. `main.js` hid this — it shows the "another
  Calandria is already running" box from `onExit` and calls `app.exit(1)` at once — so it
  was latent rather than user-visible, but any non-Electron caller of `Supervisor`
  (`test-real-boot.js`, the e2e fixtures, a future service wrapper) waited 90 seconds for
  a failure that was known in the first second. `start()` now races the readiness wait
  against a promise that resolves on the first sidecar exit, aborts the losing poll, and
  rejects with the child's own last log line (`the app sidecar exited with code 1:
  [server] another Calandria process already holds this database …`, `code:
  "ESIDECAREXIT"`). The timeout stays the backstop for the other failure — a sidecar that
  is alive and simply never answers, where a still-running process is no evidence at all.
  Both cases are pinned in `test-supervisor.js`; the dying-sidecar one asserts it fails in
  under 5s against a 30s timeout, so a merely-faster `start()` cannot pass it.

**Windows + WSL2** — `docs/WINDOWS.md` supports the server either way and this does not
change that; what it settles is that the *shell* wraps the native server only. Running the
server under WSL2 is a browser-and-`localhost` arrangement, not a wrapped one. The
mechanics were measured, and the plumbing is genuinely fine — a listener inside the distro
is reachable from the Windows host on arbitrary stepped-past ports, bound to either
`0.0.0.0` or `127.0.0.1`, and a WebSocket upgrade completes and delivers frames across the
relay, so `/pty` would work. `wslpath` translates both directions, and a `child.kill()` on
a `wsl.exe` wrapper really does take the Linux process down with it. What makes it the
wrong job for `supervisor.js` is everything above that line:

- `resolveNode` would resolve `node.exe` and hand a Windows binary to a Linux script. It
  would need a distro-side probe answering an entirely different question.
- `pickPorts` probes from the Windows side, so it sees the relay's ports and not the
  distro's. A port already held *inside* WSL is invisible to it.
- `repoRoot`, `CALANDRIA_DB_DIR` and `CALANDRIA_WORKTREES_DIR` all become Linux paths, and
  the last two carry a correctness rule the shell would have to enforce rather than
  document: `/` is ext4 but `/mnt/c` is 9p, and SQLite WAL over 9p corrupts.
- A packaged Windows app has no `wsl.exe -d <distro>` to choose, and picking one is
  configuration the shell has no UI for.

So: the shell is native-only, and that is a stated scope rather than a gap. A WSL2 user
runs `npm start` in the distro and opens `http://127.0.0.1:3000` in a Windows browser,
which the relay makes work unchanged. Option 3 — Electron inside WSLg as a Linux app — is
the Linux entry below, with the Linux caveats, and needs nothing from this file.

One cosmetic note, raised here for the display task and answered there (§4): on Windows the
window stacks three rows of chrome — the native frame, Electron's `File/Edit/View/Window`
menu bar, and the app's own titlebar row. macOS collapses the first two; Windows does not,
and `autoHideMenuBar` is the obvious lever. It was left unpulled: on Windows and Linux the
menu is the only discoverable home the app has for Reload app, Open in browser and zoom.

One gap remains, and no test covers it: on a real shutdown or logout Electron emits
neither `before-quit` nor `will-quit` (the session ends through
`WM_QUERYENDSESSION`/`WM_ENDSESSION` instead), so nothing drains — a `session-end` listener
does not exist yet. `desktop/e2e/05-windows-quit.spec.ts`'s header is the existing
statement of that gap.

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
npm run dist:mac      # → dist/mac-arm64/Calandria.app  (macOS host only)
```

Signing, notarization and auto-update are deliberately **not** wired into this —
that is still phase 2 (§7). `dist:mac` is `--dir` for the same reason the CI
lanes are: an unpacked bundle is everything a test can launch, and the installer
targets are where the signing decision would have to be made rather than
deferred. The one signature it does need is not that decision: arm64 macOS
refuses to exec a Mach-O with no signature at all, and electron-builder
invalidates the one Electron's prebuilt binary arrived with, so an artifact
built this way must be ad-hoc signed (`codesign --force --deep --sign - Calandria.app`)
before it will start. That carries no identity and satisfies no Gatekeeper
policy — it is what makes the file runnable on the machine that built it.

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
