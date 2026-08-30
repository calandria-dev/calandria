---
title: "Cross-platform desktop app (spike)"
---

# Cross-platform desktop app (spike)

**Question:** can Calandria be wrapped as a desktop app (Electron or similar), and what
would it cost?

**Answer:** yes, and the working prototype is in [`desktop/`](../desktop). The shell is
thin because the app is already a server: the wrapper starts it, waits for it, shows it,
and drains it on quit. It must not host the server inside Electron's runtime; that
decision is where the sharp edges are, and all of them were measured rather than reasoned
about (§2).

**Recommendation, in order:**

1. **Adopt the prototype as a developer launcher.** Run `cd desktop && npm start` against
   a checkout you already have. It needs no code signing, no CI lane, no auto-updater and
   no product decision, and delivers the whole "double-click instead of a terminal" win for
   people who have the repo. A packaged, self-contained build now also exists
   (`npm run dist:linux`, §6) — it carries its own server payload and Node runtime instead
   of pointing at a checkout, but needs none of the signing, CI or updater work below.
2. **Defer signed installers until someone asks.** That's where the entire cost lives
   (§7): ~$300/yr in certificates, a three-OS release lane, an update channel, and a
   standing obligation to ship Chromium security bumps. It doesn't buy a zero-prerequisite
   install; Calandria drives `git`, `claude` / `codex` and a real shell on the host, so
   its user needs a developer machine either way.
3. **Do not port anything.** No code moves, no abstraction changes, nothing in `lib/`
   learns about Electron. If that stops being true, the wrapper is becoming a fork of the
   app and needs re-arguing.

The other half of "cross platform," whether the server itself runs on Windows, is covered
in [`WINDOWS.md`](WINDOWS.md): it now does, natively. The two are independent. The shell in
`desktop/` runs on Windows today, and the server it starts has no platform gaps left under
it, only the shutdown-path difference noted below.

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
`sandbox: true`, `nodeIntegration: false`, no preload and no IPC. The app talks to its
server over HTTP/SSE/WebSocket already and gains nothing from a bridge, while a bridge
would hand any XSS in the transcript renderer the whole Node API. External links open in
the user's real browser.

`supervisor.js` contains no `require("electron")`. That makes the risky half testable on a
headless box (34 assertions, `node test-supervisor.js`, ~9s, no display), and means a later
swap to Tauri or a tray-only launcher can reuse it whole.

## 2. Measured findings

Every row was run on this machine (Linux x64, Node 22.18.0, Electron 44.0.0), not inferred.

| Finding | Measurement |
|-|-|
| Electron and Node are different V8 ABIs | Host `node` 22.18.0: `process.versions.modules` **127**. Electron 44: Node 24.18.1, modules **149**. |
| ~~`better-sqlite3` cannot be hosted in Electron unrebuilt~~, no longer true, re-measured | Was: the npm prebuild loaded under `node` and failed under `ELECTRON_RUN_AS_NODE=1 electron` with "was compiled against a different Node.js version," so hosting in-process would have needed `@electron/rebuild` on every Electron bump, per platform. `better-sqlite3` **13** is N-API, and the *same unrebuilt binary* now loads and opens a database under both: host `node` 22.18.0 (modules **127**) and Electron 44.0.0 (Node 24.18.1, modules **149**). Only the ABI objection is gone; the Codex row below is independent and still stands. |
| `node-pty` works either way | It is a `node-addon-api` (N-API) addon: it loaded and spawned a working pty under Electron's runtime. Only the SQLite half is ABI-bound. |
| An Electron binary is not a Node binary | `electron ./script.js` boots a Chromium app (here: aborts on the SUID sandbox check). `ELECTRON_RUN_AS_NODE=1 electron ./script.js` prints the script's output. |
| **Hosting the server in Electron would break Codex turns** | `lib/agents/codex/driver.ts:58,74` registers the MCP tool bridge as `command: process.execPath, args: [calandria-mcp.mjs]` with a closed four-key env (`CALANDRIA_TASK_ID`, `CALANDRIA_PROJECT_ID`, `CALANDRIA_BASE_URL`, `SERVICE_TOKEN`). Inside Electron, `execPath` is the Electron binary and the child inherits no `ELECTRON_RUN_AS_NODE`, so every Codex turn would launch a GUI process instead of the bridge. |
| Two independent port searches collide | With 3000 and 3001 both busy, the first draft of `pickPorts` gave both sidecars 3002. One lost the bind; the readiness probe talked to whichever won, since `pty-server.js` answers every path with a 200 banner, so `/api/version` "succeeded." Fixed with a shared claim set; the probe now insists on the app's JSON shape. Found by booting the real server, not the stubs. |
| macOS GUI apps get launchd's PATH | A `.app` opened from Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin`, not the user's shell PATH. `codex` (spawned bare, `lib/agents/codex/mcp.ts:38`), `gh` (probed on PATH, `lib/github.ts:35`) and an nvm-managed `node` are invisible to a double-clicked Calandria while working in the same user's terminal. The supervisor detects the stub PATH and re-reads it from the login shell. **This row is the one finding here that CI cannot re-measure** — a hosted `macos-latest` provisions its launchd domain with a wider PATH, so a GUI launch there is handed that instead (measured: run 33195354526, the app took the un-repaired branch). §5 has the manual check; the lane covers the repair rather than the inheritance. |
| The real server boots under the shell's supervisor | `node desktop/test-real-boot.js`: **919 ms** to `/api/version`, on ports 3002/3003 (stepped past the live instance), app HTML served, `/pty` proxied to the sidecar chosen, `CALANDRIA_DB_DIR` honored, both sidecars drained on SIGTERM with no SIGKILL. |
| Electron's size is not the dominant term | Electron 44 linux-x64 unpacks to **282 MB**. The payload it would wrap, `.next` (127 MB) plus a pruned `node_modules`, is larger; the container carrying the same payload with Debian, git, gh and both agent CLIs is **3.99 GB**. |
| **…and the packaged app confirms it** | `npm run dist:linux` (2026-08-27, this machine, before the payload trim below): `dist/linux-unpacked` **2.1 GB**, AppImage **653 MB**, deb **485 MB**. Electron is ~13% of it. The payload's `node_modules` is **1.6 GB** on its own. |
| What is actually big is the agent CLIs | Inside that 1.6 GB: `@openai/codex-linux-x64` **350 MB**, `@anthropic-ai/claude-agent-sdk-linux-x64` **230 MB** + its `-musl` twin **225 MB**, `@next/swc-linux-x64-gnu` **137 MB** + its `-musl` twin **137 MB**. npm already scoped these to linux-x64. The codex package is the one big item with nothing to trim — no twin, no `libc` field, one statically linked `x86_64-unknown-linux-musl` binary that runs on glibc anyway. |
| **`npm ci` cannot filter the libc duplicates, for a mechanical reason** | `package-lock.json` records `os` and `cpu` for every platform-specific optional dependency and records `libc` for **none** of them, and `npm ci` filters on the lockfile rather than re-reading the registry — so both twins install even though each declares its `libc` correctly on the registry. `npm ci --omit=dev --libc=glibc` was run to check whether the flag closes the gap: it installed all four musl packages anyway. `--omit=optional` is worse, dropping the variant we need. That leaves regenerating the app's root lockfile — changing what Docker, CI and every contributor installs to shrink one desktop artifact — so the prune is a **logged sweep of the staged tree** in `build-payload.js` instead, keyed to the target platform rather than the build host. |
| **`@next/swc` is build-time only — 273 MB of it** | Proved by deletion, not by reading: with `@next/swc-linux-x64-gnu` removed from a staged payload, `node server.js` came up on the vendored Node and served `/` (23,454 bytes), `/api/projects` and a `_next/static` chunk, all **200**, with a log identical to the run that had it. The mechanism agrees — outside `next/dist/build`, `next/dist/cli` and the dev bundler, the only consumer of the native bindings is `next/dist/server/config.js`, behind `experimental.useLightningcss`, which this app does not set. `build-payload.js` checks for that setting and keeps the compiler if it finds it. |
| **The two sweeps take a third of the payload** | `npm run dist:linux` with both in place: `@next/swc` **273 MB** (gnu 137 + musl 136) and three foreign-libc packages **242 MB** (`claude-agent-sdk-linux-x64-musl` 224, `sharp-libvips-linuxmusl-x64` 18, `sharp-linuxmusl-x64` <1) — **515 MB**, every package named in the build log. Staged payload **1564 MB → 1049 MB** (`node_modules` 999 MB, `.next` 49 MB); `dist/linux-unpacked` **2.1 GB → 1.4 GB**; AppImage **653 MB → 489 MB**; deb **485 MB → 364 MB**. The `sharp` pair is what a `-musl` name match would have missed — the sweep reads each package's own `libc` declaration, so it found them without anyone listing them. |
| `.next` and the bundled Node are minor terms | `.next` **55 MB** (`next build --turbopack` leaves `.next/cache` empty, so the drop in `build-payload.js` reclaims nothing here — it is insurance against a non-turbopack build). The vendored `node` binary is **116 MB**. |
| The packaged app boots on its own payload | `dist/linux-unpacked/calandria-desktop` under `xvfb-run`, with `CALANDRIA_REPO_ROOT` unset: `[shell] node: …/resources/node/bin/node v22.18.0 (bundled)` then `[shell] ready on http://127.0.0.1:4751 (version 0.3.0)`. The dead "bundled" branch of `resolveNode` is the one that fires. |
| **…and still does after the trim** | Same check, re-run against the pruned artifact: `[shell] node: …/resources/node/bin/node v22.18.0 (bundled)`, `[shell] ready on http://127.0.0.1:3002 (version 0.3.0)`, `/api/version` and `/` both served, with `@next/swc` and every musl package absent from `resources/app-payload/node_modules`. The ABI check at the end of `build-payload.js` passed unchanged (`native addons load under v22.18.0 (modules 127)`). One wrinkle worth writing down, since it is not the artifact's fault and will greet anyone repeating this: an unpacked `--dir` build aborts with `The SUID sandbox helper binary was found, but is not configured correctly` unless `chrome-sandbox` is root-owned mode 4755, which `--dir` output on a dev machine never is. `--no-sandbox` gets past it; `desktop/e2e/06-packaged.spec.ts` is the lane that cares about the difference. |

### The rule those findings add up to

**The server runs under a real `node`, never inside Electron.** `supervisor.js` enforces
this two ways: it refuses a runtime whose basename looks like Electron (`electron --version`
prints a convincing `v44.0.0`, so the version probe alone would pass and fail later as an
ABI error), and it strips every `ELECTRON_*` variable from the sidecar environment so
nothing downstream (agent CLIs, MCP bridges, the login shell in the terminal panel) inherits
Electron's runtime flags.

The rule now rests on one finding instead of two. `better-sqlite3` 13 removed the ABI
objection (row 2), but the Codex one didn't move: the driver registers the MCP bridge as
`command: process.execPath` with a closed env, so inside Electron every Codex turn launches
a GUI process instead of the bridge. That's a code fact, not a dependency version, so the
enforcement in `supervisor.js` stays even though the error it was first written against no
longer reproduces.

## 3. Shell options

| Option | Verdict |
|-|-|
| **Electron** (recommended) | Ships the same Chromium the app is developed and e2e-tested against, on all three platforms, with a mature packaging/signing/auto-update ecosystem. Costs ~280 MB and a Chromium-CVE patch cadence if we distribute binaries. |
| **Tauri / Wails** | Much smaller, but uses the *system* webview: WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux. This app is not a form (xterm.js, CodeMirror, mermaid, SSE, service worker, Web Push), so three engines means three rendering bug surfaces plus a Rust/Go toolchain in CI, to save disk the app payload dwarfs anyway (§2). `supervisor.js` is Electron-free, so this stays a cheap reversal if the calculus changes. |
| **Menubar/tray-only launcher** | Same supervisor, no `BrowserWindow`: start/stop the server, open the browser. Keeps the user's browser (GitHub session, devtools) and drops the renderer surface entirely. A reasonable variant of phase 1, ~60 lines on top of what exists. |
| **PWA ("Install app" in Chrome/Edge)** | Free, today, no code: a windowed, dock-able Calandria with notifications. Doesn't start the server, which is the actual complaint. Worth documenting either way. |
| **Just a browser tab** | The status quo. Costs nothing and works remotely, which the desktop app does not replace. |

## 4. What the prototype does, and what is unverified

Working and tested (`desktop/test-supervisor.js`, 34 assertions; `desktop/test-real-boot.js`, 8):

- Node resolution: `CALANDRIA_NODE` → bundled → `execPath` (only when not Electron) → PATH,
  with an actionable error naming everything it tried.
- macOS launchd-PATH detection and repair from the login shell, fenced against rc-file
  chatter, returning `null` rather than throwing on failure.
- Port selection that steps past a running instance and never hands both sidecars the same
  port, seeded from `PORT`/`PTY_PORT` when they are set (a preference — a busy one is still
  stepped past).
- Readiness polling that insists on the app's own `/api/version` shape.
- Quit → POST `/api/instance/drain` → SIGTERM → exit, with SIGKILL only as a backstop and a
  bounded wait so nothing outlives the window holding the db lock. The supervisor makes the
  drain request itself rather than relying on the server's own signal handler, so it works
  identically where SIGTERM is not deliverable.
- The db-lock exit (`server.js` exits 1 when another instance holds the database) reported
  as "another Calandria is already running," not as a crash.
- A boot screen that streams sidecar logs, because a cold first launch is otherwise
  indistinguishable from a hang.
- The notification and badge policy (§5.1): which events raise a toast, what the instance-wide "needs you" count adds up to, when a toast would be redundant, and a reconnecting subscription to `/api/events` driven against a stub server.

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
- The permission handler: everything refused, notifications now included — the main process owns that channel (§5.1), and both the request and the *check* have to say no or the renderer shows a duplicate.
- External links leave through `shell.openExternal` on both paths
  (`setWindowOpenHandler` and `will-navigate`) and the window stays on the app.
- A second launch is refused by the single-instance lock rather than racing for
  the database.
- The db-lock exit reaches the user as "another Calandria is already running".
- `app.quit()` drains a live turn — the row is settled in SQLite after the
  process is gone — and the server exits. Closing the WINDOW does not: it hides
  to the tray and leaves the server running, and the quit that follows brings
  the window back to carry the drain (§5.1).
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

**macOS** — the PATH repair above is mandatory, not polish, and the *repair* is
no longer taken on faith: the `macos-desktop` lane (`docs/DESKTOP_E2E.md` §4)
`open`s the packaged `.app` through LaunchServices, exactly as a double-click
does, and asserts that the supervisor met the stub PATH there and recovered a
real one from the login shell — a login-shell probe running inside a GUI process
with no controlling terminal, which is a claim no other spec can make. Every
`_electron` launch is a child of the test process and inherits its PATH, the
environment where the repair does nothing.

The **inheritance** half is not CI's to prove. A hosted `macos-latest` hands a
GUI app a launchd domain its image has already widened, so the lane plants the
stub with `launchctl setenv` and asserts what happens next; it records the
domain's own PATH on every run, so the day an image stops widening it is
visible. The premise itself — a `.app` double-clicked by a real user gets
`/usr/bin:/bin:/usr/sbin:/sbin` — is a **manual check on a real Mac**, and takes
one launch:

```bash
open -n -a /Applications/Calandria.app --stdout /tmp/calandria-gui.log \
  --stderr /tmp/calandria-gui.log
grep '^\[shell\] PATH' /tmp/calandria-gui.log
```

`PATH looked like launchd's stub — took the login shell's instead` is the
premise holding and the repair firing. `PATH is not launchd's stub, using it
as-is: …` prints what was inherited instead, which is either a `launchctl
setenv PATH` / `launchctl config user path` somebody set or the row in §2 having
gone stale on a newer macOS. Worth re-running on each macOS major.

`hiddenInset` is settled the
same way: the window's content box and its frame are asserted to be the same
rectangle (under `default` macOS steals a strip for the title bar, so they are
not), the traffic lights are asserted to survive, and the lane uploads a
screenshot on a green run so the one thing an assertion cannot judge — the
buttons sitting over the app's own titlebar row — is in front of a human rather
than in this paragraph. Menu roles run under a real menubar there too, which
matters more here than anywhere else: on macOS `{ role: "editMenu" }` *is*
Cmd+C/V/A, so a missing menu is a broken app rather than a cosmetic gap.

What remains open is distribution, not behaviour. Signing + notarization are
required for anything downloaded (Gatekeeper blocks unsigned apps by default);
§6.4 is the configuration for both, waiting on the credentials themselves. The
build ad-hoc signs the bundle
(`mac.identity: "-"`) for one narrow reason with no bearing on that: arm64 macOS
will not exec a Mach-O carrying no signature at all, and electron-builder
invalidates the one Electron's prebuilt arrived with. §6.2 has why that sits in
the build rather than in the lane, now that there are installer targets cut from
the bundle it signs.

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

### 5.1 Notifications, tray, and close vs quit

The one thing this shell does that a browser tab cannot, and the reason to have
it: an OS notification and a dock badge when a task needs you, with the server
still running when the window is not.

**The notifications are the app's own, rendered somewhere new.**
`lib/notifications/notify.ts` already composes them — it owns which kinds are
enabled, which rows stay quiet, how a repeat inside ten seconds is collapsed,
and the wording — and publishes the finished payload on `GET /api/events`,
which is also how the web UI receives it. So `desktop/notifier.js` subscribes to
that stream over loopback and `main.js` renders what it is handed. Re-deriving
"a task went `awaiting_input`" from the raw task events would have produced a
second, differently worded, differently gated channel out of the same facts, and
one that ignored the switches in Settings → Notifications. The Web Push half of
the same fan-out (service worker + VAPID, aimed at phones) is untouched: this is
a third consumer of one payload, not a rewiring of the second.

That makes the renderer's own channel a duplicate, so it is switched off — and
switching it off takes **two** handlers, which is the part that is easy to get
wrong. `setPermissionRequestHandler` no longer grants `notifications`, but
`app/shell/useNotifications.ts` never asks: it reads `Notification.permission`,
a permission *check*, and Electron answers checks with a hardcoded "granted"
when no check handler is set. Without `setPermissionCheckHandler` the hook sails
past its own guard and every event arrives twice. Only `notifications` is named
there; every other check keeps Electron's default, so the request handler stays
the single statement of the deny-by-default policy.

**Clicking a toast** raises the window and selects the task, through the app's
existing `calandria:goto-task` window event — the same one the browser channel
and the service worker dispatch. Evaluated into the page from the main process
rather than sent over IPC, for the reason the shell has no preload at all: a
bridge would exist on every page the window ever loads, to serve one call.

**One suppression, and it is the browser's**: don't interrupt someone about the
very task they are looking at. The shell can answer both halves of that without
a bridge. "Looking at" is the window being visible *and* focused — a stricter
test than a tab's `visibilityState`, and a fairer one, since a window sitting
behind the editor is not being looked at. *Which* task comes off
`webContents.getURL()`: the app mirrors its open project/task into
`?project=&task=` so a refresh lands back where you were, which makes the window
URL a synchronous, always-current read of the selection.

**The badge** is the instance-wide "N need you" count — the same number the
app's own titlebar pill shows, and computed the same way, because the wire
carries no instance-wide total: every task event carries `awaiting_count` for
the one project it belongs to, so the shell keeps the per-project figures and
sums them, skipping `deprecated` projects exactly as the pill does. It is seeded
from `/api/projects` before the first event, since a fresh launch usually has
work waiting from the last session, and reseeded on every reconnect, because
`/api/events` is a live tail and whatever was published while the shell was dark
is gone.

Three platforms, two APIs:

| | Badge | Tray icon |
|-|-|-|
| macOS | `app.setBadgeCount` — `dock.setBadge` underneath | `trayTemplate.png` + `@2x`, monochrome; AppKit inverts it for the dark menu bar |
| Windows | No numeric badge exists: the taskbar overlay is a 16×16 image, so the digits are pre-rendered PNGs (`badge-1` … `badge-9`, `badge-9plus`) and `setOverlayIcon` picks one | `tray.png`, in the brand colour |
| Linux | `app.setBadgeCount` — a Unity launcher entry, a no-op on desktops that have none, so it is called rather than probed | `tray.png`; a session with no status area logs and carries on, and the close button goes back to quitting (below) |

The assets are committed PNGs. `desktop/scripts/make-assets.py` regenerates them
from primitives (ImageMagick and a font, neither of which any CI lane needs) so
the mark can be changed without reverse-engineering a binary. The mark itself is
the app icon reduced to its single foreground rod and resting ellipse — the full
ten-rod logo turns to mush at 16 px, which is the size a tray actually gets.

**Close vs quit.** One rule on all three platforms: the X button and Cmd/Ctrl+W
**hide** the window; quitting is asked for by name, from the tray's Quit item or
the application menu.

| | Before | Now |
|-|-|-|
| macOS | Close destroys the window; app stays in the dock; `activate` builds a new one | Close hides it; `activate` shows the same one, with the SPA's state intact |
| Windows / Linux | Close quits: `window-all-closed` → `quit()` → drain → exit | Close hides to the tray; the server keeps running — unless the session is not drawing the tray icon, where it still quits |

Closing used to quit on Windows and Linux because "leaving turns running
invisibly with no window is worse than stopping them", and that was right while
the shell had no way to be present without a window. It has one now: the tray
icon is on screen, it carries the count, and Show is one click away, so a hidden
Calandria is no more invisible than a minimised one. Against that, close-to-quit
on a window whose job is supervising long agent turns means every absent-minded
X settles work in flight — and the drain that protects it makes the shutdown
slower, not less unwanted. macOS hides rather than closes for a second reason
that applies everywhere: hiding keeps the renderer alive, so the open
transcript, the scroll position and the SSE streams survive and reopening is
instant instead of a cold reload.

Three closes are still let through, all deliberate, and the first is the
load-bearing one: **hiding happens only where a status area is really drawing
the icon.** Hiding somewhere the user cannot retrieve the app from is the old
rationale, still correct in the one case that still matches it. So on a trayless
desktop, close quits, exactly as it used to. A close that arrives *before* the
server is up is let through for the same reason (no server to keep alive, no
tray yet) and `window-all-closed` turns it into a quit. And one that arrives
*during* a drain is honoured, because by then the user has seen the drain state
and asked twice.

**"Is there a tray?" is a question for the session, not for Electron**, and
getting that wrong is how this shell lost a window. The gate used to be `new
Tray()` not throwing, which on Linux says nothing: the constructor builds a
Chromium `StatusIconLinuxDbus`, registers a `StatusNotifierItem` on the session
bus and never reports back, so it succeeds whether or not an icon ever appears —
and Electron documents no callback for a host that later goes away. Measured on
the desktop bench 2026-08-28 (Ubuntu 24.04, Xfce, Electron 44): xfce4-panel
4.18.4's `systray` plugin crashes when Electron registers its item and takes
`org.kde.StatusNotifierWatcher` off the bus with it, so no icon is drawn — while
`tray` was a live object, the close hid the window, and the "open it again from
the tray icon" toast named an icon that did not exist. The window was then
reachable only by launching the app again (`second-instance` → `showWindow()`),
which is not what the toast said to do. One panel bug, but the class is every
session with no status-notifier host — GNOME without the AppIndicator extension,
a bare window manager, a headless X server — and Chromium has no XEmbed fallback
left to catch them.

So `desktop/tray-residency.js` asks the session, over `gdbus` (falling back to
`dbus-send`; Electron ships no D-Bus binding and this spike is not adding a
native dependency for one question). Both halves of the answer are on the
watcher: `IsStatusNotifierHostRegistered` says somebody is drawing icons at all,
and `RegisteredStatusNotifierItems` says whether OURS is among them — matched by
the owner of the D-Bus connection, since Electron's item is
`org.kde.StatusNotifierItem-<pid>-<n>` on some hosts and a bare unique name on
others. The same read `desktop/e2e/bench.ts` makes from outside. On Windows and
macOS there is nothing to ask: a notification area and a menu bar are part of
the platform.

Three rules make that safe to act on:

- **The verdict is three-valued.** "The session says no" and "the session could
  not be asked" are different answers, and `main.js` moves its flag only on the
  first. A missing `gdbus` or a timed-out call is not evidence that a working
  tray vanished — collapsing them would turn every X on a healthy desktop into a
  quit. An *unreachable* bus is a definite no, though: Electron had nowhere to
  register the icon either.
- **It is re-asked on every close**, not trusted from boot, because the way this
  shell loses a window is a host that goes away *mid-session*. That is also why
  there is no `NameOwnerChanged` subscription: it would mean a long-lived `gdbus
  monitor` child for a fact nothing consults in between, and the close is the
  only moment the answer decides anything. Budgeted at 1.5 s and retried inside
  it, so a panel that is restarting is waited through rather than read as gone.
- **Unconfirmed means quit.** The fallback is the behaviour the shell had before
  the tray landed, and still the right one when there is nowhere to be present.

The close handler is therefore asynchronous: it prevents the close
unconditionally and decides afterwards, since a close that has been allowed
through cannot be taken back.

Because quit can now be asked for with nothing on screen, `showDraining()`
un-hides the window first — the drain overlay and title were always addressed to
someone who could see them. The first hide of each launch also raises a one-time
notification saying the app is still running, since hiding is the one action
here with no visible result and, on Windows and Linux, a change from what the
button used to do. It is gated on the same confirmed tray rather than on
`Tray` having been constructed, and that gate matters more here than anywhere
else: it is the one message that tells the user where the window went, so
raising it on a session with no icon sends them looking for something that is
not there.

One thing this leaves owing, recorded rather than fixed. On Linux an
Electron notification is a libnotify call on the UI thread, and with a session
bus present but no daemon owning `org.freedesktop.Notifications` each one blocks
the whole main process for GDBus's 25-second timeout — measured, and the reason
the e2e suite points `DBUS_SESSION_BUS_ADDRESS` at a dead socket
([`DESKTOP_E2E.md`](DESKTOP_E2E.md) §2). Denying the renderer's channel takes
the page out of that path; it does not take the shell out of it, and a desktop
with no notification daemon is a configuration nobody here has.

**Telling the page it is inside the shell.** Denying the check handler left one
wart: Settings → Notifications reads the same `Notification.permission`, so it
reported the browser channel as *blocked* — literally true, and completely
misleading, since the user is getting OS notifications the whole time from a
channel the page cannot see. Anyone reading that card would go looking for a
browser site setting this window has no way to open. So `announceShell()`
appends `Calandria-Desktop/<version>` to `app.userAgentFallback` before the
first load, and `isDesktopShell()` in `app/shell/useNotifications.ts` matches it
(with bare `Electron/` as a fallback, so a packaged build predating the token
still reads right); the card then says the desktop app handles these itself and
keeps the test-send button live. The renderer's channel still stands down — the
classifier reports `desktop_shell`, which is not `granted`, so the hook returns
before constructing anything. Re-granting the permission to fix the copy is the
one thing that must not happen: that is the duplicate toast this whole section
exists to avoid, and on Linux it is also what puts the page back in front of
that 25-second GDBus block.

The user agent is the wire because the question is about the **client**, not the
instance. The same server can be open in this window and in an ordinary browser
tab at the same moment, so `CALANDRIA_DESKTOP_SHELL=1` on the sidecars or a flag
in the per-instance `window.__FEATURES` bundle would answer one of them with the
other's truth. UA sniffing normally rots because it reads somebody else's
string; the token that carries the decision here is ours, and the cost of it
ever being wrong is a sentence of help text, not a lost notification.

What is **not** yet verified: none of this has run in front of a human or under
an assertion that a notification actually reached the OS. The headless tests
cover the policy and `desktop/e2e` covers the permission handler and the
close-then-quit sequence; the notification, tray and badge calls themselves are
what the desktop bench's native-integration specs are for.

## 6. Packaging

The prototype now produces a real artifact, not just a `desktop/` checkout:

```bash
cd desktop && npm install
npm run dist:dir      # → dist/linux-unpacked/calandria-desktop
npm run dist:linux    # dist:dir, plus deb and AppImage targets
npm run dist:win      # → dist/Calandria Setup <version>.exe, plus a zip  (Windows host)
npm run dist:mac      # → dist/mac-arm64/Calandria.app, plus .dmg and .zip
```

Signing with a real identity and notarization are wired up but switched off by
default; §6.4 is how to turn them on and what they cost. Auto-update is still
phase 2 (§7).

The electron-builder configuration lives in **`desktop/electron-builder.cjs`**,
not in `desktop/package.json`'s `build` field. It moved because signing has to be
decided at build time and JSON cannot decide anything. Two traps come with that,
both silent:

- `app-builder-lib`'s loader reads package.json's `build` field **first** and only
  scans for a standalone config when that field is absent. It does not merge them
  and it does not warn. Putting a `build` key back would shadow the whole file.
- The filenames it scans for are `electron-builder` + `.yml/.yaml/.json/.json5/.toml/.js/.cjs/.ts`.
  `electron-builder.config.cjs`, the name most projects use, is **not** on that
  list and would be ignored just as quietly.

`tests/desktopSigning.test.ts` pins both.

### 6.1 The macOS targets, and which one matters

`dist:mac` builds `dir`, `dmg` and `zip`. The unpacked `dir` bundle is what the
CI lanes launch and the only form the launchd spec can `open`, so it stays. The
other two are what a person would actually receive, and of those **the `.zip` is
the load-bearing one** even though nothing consumes it yet. Squirrel.Mac — what
`electron-updater` drives on macOS — updates from the `.zip`, not the `.dmg`, and
a dmg-only build emits no `latest-mac.yml` at all, which means no macOS update
feed exists. The `.dmg` is the download people expect; the `.zip` is the one the
updater cannot work without. The feed itself arrives with the `publish` block in
the auto-update work, not here.

The dmg keeps electron-builder's default layout — app icon, `/Applications`
symlink, no `dmg` block in `desktop/electron-builder.cjs`. There is nothing to
brand until there is something to distribute.

**Measured on the `macos-desktop` lane, 2026-08-29** (macos-latest, arm64), so
the sizes here are observations rather than estimates:

| Artifact | Size |
|-|-|
| `Calandria-0.3.0-arm64.dmg` | 464 MB |
| `Calandria-0.3.0-arm64-mac.zip` | 480 MB |

The dmg mounted, the app inside it verified (`valid on disk`, `satisfies its
Designated Requirement`) and booted; the zip extracted to a bundle that verified
the same way. Both are large for the reason §2's table gives: the payload, not
Electron.

### 6.2 The ad-hoc signature runs in the build, not in CI

arm64 macOS will not exec a Mach-O carrying **no** signature at all — the kernel
kills it — and electron-builder rewrites the binary and its resources, which
invalidates the signature Electron's prebuilt arrived with. So every macOS
artifact needs *a* signature before it will start, quite apart from the
Developer ID question.

That used to be a CI step: the `macos-desktop` lane packaged `--mac dir`, moved
the `.app` out of the checkout and ran `codesign --force --deep --sign -` on it.
**Adding installer targets made that placement wrong**, and the reason is
ordering rather than taste. electron-builder cuts the `.dmg` and the `.zip` from
the `.app` *during* packaging. A signature applied afterwards — to a bundle that
has by then been moved out of `desktop/dist` — reaches the copy CI tests and
nothing else. Both installers would ship an app the kernel refuses to launch,
while every step in the lane stayed green.

So it moved into the build, as `mac.identity: "-"` in
`desktop/electron-builder.cjs`.
That is electron-builder's own ad-hoc path (`MacTargetHelper.findSigningIdentity`
special-cases `"-"` and hands `@electron/osx-sign` an identity-less signature),
it runs before the targets are cut, and it means `npm run dist:mac` on a Mac
produces artifacts that are launchable on the machine that built them without a
second manual command. The lane now *verifies* the signature instead of applying
it — a second signing path would paper over a build that quietly stopped signing
and leave the installers broken behind a green run.

It is also better coverage than the `--deep` it replaced, which mattered enough
to check rather than assume. `@electron/osx-sign` walks the whole of
`Contents/`, Mach-O-detects every file and signs them deepest-first, so it
reaches the `extraResources` the payload lives in — `resources/node/bin/node`
and the `.node` addons under `resources/app-payload/node_modules` — and not just
the app and its frameworks. That matters more than tidiness: the vendored Node
arrives from nodejs.org carrying Apple's own notarized, hardened-runtime
signature, and hardened runtime means library validation, which would refuse to
`dlopen` an unsigned `better-sqlite3`. Re-signing it ad-hoc is what clears that,
and it is what `--deep` was quietly doing before. `--deep` is deprecated by
Apple; deepest-first is the order Apple actually documents.

One trap that placement inherits, recorded because it is invisible and its
symptom is a signal kill rather than an error: **electron-builder skips macOS
signing outright on pull-request builds.** `isSignAllowed()` in `app-builder-lib`
treats a set `GITHUB_BASE_REF` as "this is a PR" and returns false before
`identity` is even read. Since this lane's usual trigger is a labelled PR, the
ad-hoc signature would silently not happen there.

`CSC_FOR_PULL_REQUEST: "true"` used to be what re-enabled it, and it is gone.
That flag means *sign pull requests with the real certificate*, and its documented
hazard is exposing a signing identity to a fork build — inapplicable while no
certificate existed anywhere, and no longer inapplicable now that the release
lane holds one. What the packaging step does instead is `unset GITHUB_BASE_REF`.
`isPullRequest()` in `builder-util` tests each variable with `isSet`, which is
falsy for the empty string, so an unset `GITHUB_BASE_REF` is not a different pull
request but no pull request, and signing proceeds as it does on a cron run.

**It has to be unset in the shell, not in the step's `env:` map**, and the
difference is invisible until you read the packaging output. GitHub Actions
reserves the `GITHUB_` prefix and drops any assignment to it when it builds the
process environment — while still echoing the declared value in the log's env
group. So `GITHUB_BASE_REF: ""` under `env:` renders as configured, and
electron-builder still logs *"Current build is a part of pull request, code
signing will be skipped"*, and the next step fails with
`code has no resources but signature indicates they must be present` on a bundle
that was never signed. Measured on this lane, 2026-08-30.

That re-enables **signing**, not **signing with a certificate**, and the
difference is what makes it safe. `macCodeSign.findIdentity` takes the configured
qualifier ahead of anything a `CSC_LINK` import put in the keychain, so
`mac.identity: "-"` wins: a certificate reaching this job's environment could not
be used by it. The lane checks that rather than asserting it — its `spctl` step
is a gate that fails if Gatekeeper **accepts** the bundle, which is the one
symptom a signing identity leaking into a PR-triggered build would produce.

#### 6.2.1 Hardened runtime is on in the ad-hoc build too

`mac.hardenedRuntime` was `false`, against electron-builder's own default of
`true`. It is now on in both branches, and the branch lives in the entitlements
instead — `desktop/build/entitlements.mac.plist` for a Developer ID build,
`desktop/build/entitlements.mac.adhoc.plist` for the ad-hoc one.

The two files differ in exactly one key, and that key is the whole story.
Hardened runtime turns on **library validation**, which admits only libraries
signed by the loading binary's own Team ID or by Apple. The bundle ships a
vendored Node (`resources/node/bin/node`) that runs the server and `dlopen`s
`better-sqlite3` and `node-pty` out of `resources/app-payload/node_modules`. An
ad-hoc signature carries no Team ID at all, so those loads cannot satisfy library
validation and the ad-hoc entitlements carry
`com.apple.security.cs.disable-library-validation` to switch it off.

The Developer ID entitlements deliberately do **not**. `@electron/osx-sign` walks
the whole of `Contents/` and signs every Mach-O deepest-first with the same
identity, so the vendored Node and the addons beside it carry our Team ID and the
load should succeed on that alone. **If a signed build ever needs that
entitlement to start, something in the payload was signed by a different identity
and the entitlement would be hiding it rather than fixing it.**
`tests/desktopSigning.test.ts` fails if it appears in the Developer ID list.

Hardening the ad-hoc build buys real but partial verification, and the partiality
is worth stating: the `macos-desktop` lane now boots and exercises a bundle under
a hardened runtime, so JIT, writable-executable memory and anything else the
runtime forbids are covered on every run. Library validation is the one thing it
cannot cover, because it is the one thing the ad-hoc entitlements switch off.
That half is only provable on a Developer ID build, and the failure mode there is
a `dlopen` refusal at the first database query rather than anything visible at
launch — so it is verified by opening the app and letting it serve a page, not by
watching it start.

### 6.3 What this does not achieve

An ad-hoc signature does not survive distribution. It carries no identity,
satisfies no Gatekeeper policy and notarizes nothing; it is what makes the file
runnable, not what makes it distributable.

A `.app` downloaded from the internet is tagged `com.apple.quarantine`, and
without a Developer ID plus notarization Gatekeeper refuses it — usually as
**"Calandria is damaged and can't be opened. You should move it to the Trash"**,
which reads like a corrupt download and is not one. The `macos-desktop` lane
asserts that refusal on every run (§6.2), and on 2026-08-29 it printed
`Calandria.app: rejected` for a bundle whose signature
`codesign --verify --deep --strict` had just accepted. That pair is the whole
distinction: internally valid, and refused anyway.

So an ad-hoc build — a local `npm run dist:mac`, or an artifact pulled off a CI
run — carries a cost at every install on a machine that did not build it:

```bash
# after dragging Calandria.app to /Applications
xattr -dr com.apple.quarantine /Applications/Calandria.app
```

or right-click → Open and confirm the dialog. Either way it is **every install**,
not once per machine.

**This is not the install instruction for a release.** A published build is
Developer ID signed, notarized and stapled (§6.4) and needs none of it; the
paragraph above describes what you get when you build it yourself. It stays here
until the release lane exists and has published a notarized artifact, at which
point it and its counterpart in `desktop/README.md` should go, because keeping
them would teach people to strip quarantine off downloads as a habit.

**Windows builds two targets, and neither is signed by default.** `nsis` is the installer
proper: `oneClick: false` so it opens a wizard rather than installing wherever it
likes the moment it is double-clicked, `allowToChangeInstallationDirectory: true`
so that wizard is worth having, and `perMachine: false` so it installs under the
user's own profile and never raises a UAC prompt. `zip` is the escape hatch for
anyone who would rather unpack a folder than run an installer, and for the case
where an installer is what the machine's policy objects to. `win.azureSignOptions`
is present only when all four `AZURE_CODE_SIGNING_*` variables are set (§6.4);
without them electron-builder finds nothing to sign with and produces an unsigned
artifact rather than failing, which is what every CI lane here does.

**The `windows-desktop` CI lane installs that installer rather than trusting it.**
It builds `--win nsis`, runs the result with `/S`, and points the window suite at
the installed `Calandria.exe` — which also satisfies `desktop/e2e/fixtures.ts`'s
refusal to launch a binary from inside the checkout without any relocation step,
since an installed app is outside the source tree by construction. Around that
pass it asserts the four things only a real install can show: that a
`perMachine: false` build lands in `%LOCALAPPDATA%\Programs\Calandria` (read back
from the uninstall registry entry, not dictated with `/D=`), that the payload and
the vendored Node arrived under `resources\`, that both shortcuts were laid down,
and that the uninstaller — invoked through the registry's own
`QuietUninstallString`, exactly as Settings → Apps would — removes all of it. That
is possible on a hosted runner only because the install is per-user and needs no
elevation; the Linux equivalent has to be the bench lane's `.deb`, because only a
real install there runs the postinst that sets up the sandbox.

The cost of that is **Microsoft Defender SmartScreen**, and it is worth stating
plainly because the first person to download a release will meet it. Windows
attaches a `Zone.Identifier` alternate data stream — the Mark of the Web — to
anything a browser downloads. Running a MotW-marked executable that carries no
recognized signature raises a full-screen *"Windows protected your PC"* dialog
whose only obvious button is **Don't run**; getting past it means clicking **More
info** and then **Run anyway**. The `zip` target is not a way around this: Explorer
propagates the mark to the files it extracts, so `Calandria.exe` out of the zip
warns the same way the installer does.

Two properties of that make it a recurring cost rather than a one-off. SmartScreen
reputation attaches to a *file* when there is no publisher to attach it to, so
every release re-earns the warning from zero, forever, as long as the artifacts are
unsigned. And a locally built installer will never show it — a file that was never
downloaded has no MotW — so neither a developer's own `dist:win` nor the CI lane
can observe the thing a user hits first. The lane installing the installer does
not change that: it runs an `.exe` it built itself seconds earlier, which no
browser ever touched. Everything else about the installer is tested now; this is
the one part that cannot be. Signing is what removes it; §7 prices that, and the
March 2024 change to what EV buys is the important half.

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
is launchd's stub (§2) and on a fresh box may have no Node at all; and it fixes
the runtime version, so the payload runs under the Node it was installed for
rather than under whatever the user happens to have — which may be older than
the repo's floor, or new enough that a dependency has not been tested there.
That second reason used to be an ABI argument as well: under `better-sqlite3`
12 the prebuilds were per-`NODE_MODULE_VERSION`, so a mismatched Node landed as
"compiled against a different Node.js version" at the first query. Version 13
is N-API (§2) and that failure mode is gone; the version pin is now about
having one known runtime rather than about loading the addon at all. The
vendored version defaults to the **host's own** Node version — the same one
that ran `npm ci` for the payload — so the pair matches by construction; `CALANDRIA_DESKTOP_NODE_VERSION` overrides
it for a reproducible, pinned CI build. The download (`scripts/fetch-node.js`)
is sha256-verified against the official `SHASUMS256.txt` before it is unpacked;
only the `node` binary is taken, not `npm` or the headers.

**Native modules follow the bundled Node, not Electron.** `npmRebuild: false`
and `nodeGypRebuild: false` stay set in the `electron-builder` config
(`desktop/electron-builder.cjs`) so nothing rebuilds the addons against Electron's
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
`desktop/electron-builder.cjs` is what actually carries it.

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

### 6.4 Turning signing on

Signing is **opt-in by name**, never by the presence of a secret, and a
half-configured request is an error rather than a downgrade to unsigned. Both
rules exist because the failure they prevent is invisible: a build that quietly
skips signing goes green and produces an artifact that only misbehaves once it is
on somebody else's machine. `desktop/signing.js` holds the policy and
`tests/desktopSigning.test.ts` drives every branch of it, which is the only part
of this that can be tested without a Mac, a Windows box and two paid identities.

**macOS.** Set `CALANDRIA_MAC_SIGN_IDENTITY` to the full certificate name
(`Developer ID Application: Name (TEAMID)`), plus a certificate for
electron-builder to import (`CSC_LINK`, a base64 `.p12`, and `CSC_KEY_PASSWORD`)
and one complete set of notarization credentials:

| Variable | What it is |
|-|-|
| `CALANDRIA_MAC_SIGN_IDENTITY` | The Developer ID Application certificate name. Unset or `-` means ad-hoc; this is the only switch. |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | The `.p12` electron-builder imports into a temporary keychain, base64-encoded, and its password. |
| `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | An App Store Connect API key — the preferred credential, being revocable on its own and not tied to the account password. **`APPLE_API_KEY` is a FILE PATH**, not the key: `notarytool --key` takes a path and `@electron/notarize` passes it straight through. A CI secret therefore holds the `.p8`'s contents and the lane writes them to a file outside the checkout before setting this. |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | The alternative, if a key is not available. |
| `CALANDRIA_MAC_SKIP_NOTARIZE=1` | Sign without notarizing. For testing signing on its own; the result must not be published. |

**Getting the certificate**, since the portal offers seven kinds and only one is
right. It is **Developer ID Application** — under *Certificates, Identifiers &
Profiles → Certificates → + → Software*. Not *Developer ID Installer*, which
signs `.pkg` and this app does not ship one; not *Apple Development* or *Apple
Distribution*, which are for Xcode and the App Store and which Gatekeeper will
not accept for a direct download.

**No Mac is required to obtain it.** Every guide says to use Keychain Access, and
that is convenience rather than a requirement: a CSR is a PKCS#10 request and the
portal does not care what produced it. OpenSSL on Linux or Windows does the whole
round trip, which also keeps a signing identity off a machine you do not own.

```bash
# 1. Key and CSR. Apple requires RSA 2048; the email should be the Apple ID.
openssl genrsa -out devid.key 2048
openssl req -new -key devid.key -out devid.certSigningRequest \
  -subj "/emailAddress=you@example.com/CN=Your Name/C=US"

# 2. Upload devid.certSigningRequest, pick Developer ID Application, download
#    the .cer. It contains only the certificate — the private key never left here.
openssl x509 -inform DER -in developerID_application.cer -out devid.pem

# 3. The intermediates, WITHOUT WHICH THIS SILENTLY FAILS. See below.
#    Both, not one: Apple runs two Developer ID CAs and you should not have to
#    know which signed yours.
curl -O https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer   # G2, to 2031
curl -O https://www.apple.com/certificateauthority/DeveloperIDCA.cer     # G1, to 2027
openssl x509 -inform DER -in DeveloperIDG2CA.cer  > apple-intermediates.pem
openssl x509 -inform DER -in DeveloperIDCA.cer   >> apple-intermediates.pem

# 4. Bundle key + leaf + intermediates. -legacy is not optional on OpenSSL 3.
#    It prompts twice for an export password: that is CSC_KEY_PASSWORD, and it
#    should not be blank — see below.
openssl pkcs12 -export -legacy -out devid.p12 \
  -inkey devid.key -in devid.pem -certfile apple-intermediates.pem

# 5. CSC_LINK, and the identity string.
base64 -w0 devid.p12 > devid.p12.base64
openssl x509 -in devid.pem -noout -subject   # CN= is CALANDRIA_MAC_SIGN_IDENTITY
```

On Windows the OpenSSL that ships with Git Bash or WSL runs all of that
unchanged, with one substitution: there is no `base64 -w0`, and `certutil
-encode` is the wrong reach because it emits a PEM-wrapped block with headers and
line breaks rather than the bare string `CSC_LINK` wants. Use PowerShell —
`[Convert]::ToBase64String([IO.File]::ReadAllBytes('devid.p12'))`. On a Mac it is
`base64 -i devid.p12`.

Two failure modes are worth naming because both produce a build that imports the
certificate happily and then reports no identity at all:

- **A `.p12` without the issuing intermediate.** electron-builder imports it into
  a temporary keychain and then runs `security find-identity -v`, and the `-v`
  means *valid* — an identity whose chain cannot be built to a trusted root is not
  listed. A hosted macOS runner has Apple's roots and not necessarily the
  Developer ID intermediate, so the leaf alone verifies on the machine that made
  it and vanishes in CI.

  Apple publishes **two** Developer ID CAs and they are not distinguishable by
  name — both are `CN=Developer ID Certification Authority`, differing only in
  `OU`. **G2** (`DeveloperIDG2CA.cer`, `OU=G2`) runs to 2031-09-17 and is the
  current one; **G1** (`DeveloperIDCA.cer`, `OU=Apple Certification Authority`)
  runs to 2027-02-01 and is the older. A certificate issued today should chain
  through G2, but bundling both costs nothing, imports harmlessly — only the leaf
  carries a private key, so only one identity is ever created — and removes a
  guess from a step whose failure mode is silent. To see which one actually signed
  yours, read the `OU` rather than the `CN`:
  `openssl x509 -in devid.pem -noout -issuer`.
- **OpenSSL 3's default PKCS#12 encryption.** It writes AES-256-CBC with PBKDF2,
  which macOS's `security import` does not read; the import appears to succeed and
  yields nothing. `-legacy` restores the SHA1/3DES encoding it expects.

On a Mac the equivalent is Keychain Access (*Certificate Assistant → Request a
Certificate From a Certificate Authority*, saved to disk), then exporting the
certificate **together with its private key** — an export without the key has the
same symptom as the two above. `security find-identity -v -p codesigning` prints
the identity string.

**Do not leave the export password blank.** OpenSSL accepts an empty one, and the
`.p12` then lives base64-encoded in a GitHub secret as a bare private key: anyone
who obtains that one secret holds the signing identity outright. With a password
they need `CSC_LINK` *and* `CSC_KEY_PASSWORD`, which are separate secrets with
separate exposure. Let OpenSSL prompt rather than passing `-passout` — a password
given on the command line lands in shell history and in the process list.

**The App Store Connect API key** is a pure web flow and needs no Mac either,
but it has one trap that is easy to walk into because the wrong answer sits next
to the right one in the UI.

**It must be a TEAM key, not an Individual key.** Apple's own documentation says
it outright: *"Individual keys aren't able to use Provisioning endpoints, access
Sales and Finance, or `notaryTool`."* They are created in different places, so
this is a wrong turn rather than a wrong checkbox — team keys are under *Users
and Access → Integrations → App Store Connect API → **Team Keys***, while an
individual key is generated from your own profile menu.

1. *App Store Connect → Users and Access → **Integrations** tab* (this is what
   used to be called "Keys") *→ App Store Connect API → Team Keys*.
2. First time only, **Request Access** and accept the terms. This is
   **Account Holder**-gated, which on an Individual membership is you by
   definition — the enrolling person is the Account Holder.
3. **Generate API Key**, name it, and give it the **Developer** role. Generating
   a team key needs Account Holder or Admin, which again you are.
4. The **Issuer ID** is a UUID shown at the top of the Team Keys page. It belongs
   to the account, not to the key, so every key you make shares it →
   `APPLE_API_ISSUER`.
5. **Download the `.p8`. You get exactly one chance** — Apple keeps no copy, and
   a lost key can only be revoked and replaced, never re-downloaded. The file
   arrives named `AuthKey_<KEYID>.p8`, so the Key ID is in the filename →
   `APPLE_API_KEY_ID`. Its *contents* are the secret; `APPLE_API_KEY` is the path
   the lane writes them to.

Role is the one thing here not confirmed from Apple's own text. Apple's
permissions matrix does grade "Notarize software" by role, but does not spell out
the minimum in prose; **Developer** is the consistent community answer and is the
least privilege that plausibly works. If notarization ever fails with an
authorization error rather than a validation one, regenerate the key as *App
Manager* or *Admin* — the key is a CI secret, so start narrow and widen only on
evidence.

**If the API key route is blocked**, the fallback is an app-specific password
(`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`), generated at
**account.apple.com** → *Sign-In and Security → App-Specific Passwords*. Note the
domain: most guides still say `appleid.apple.com`, and Apple moved it. It is the
worse option — the password is tied to the account rather than revocable on its
own, and it is invalidated wholesale whenever you change your Apple Account
password.

**What genuinely needs a Mac is the verification, not the credentials.** Signing
and notarizing happen on CI's `macos-latest` runner. The one step that cannot be
delegated is opening a browser-downloaded artifact on a machine that has never
seen it — and that involves no credentials, so a work machine, a borrowed one or
a rented one all serve.

Setting the identity with no notarization credentials **fails the build**. A
Developer ID signature without notarization is still refused on a downloaded copy,
so that combination looks signed and behaves unsigned, and it is the single most
plausible way to ship a broken release from a green run.

Notarization then happens twice, on two different artifacts, and both are needed:

- electron-builder notarizes and staples **the `.app`** from inside
  `MacPackager.sign()`, which is awaited before `packageInDistributableFormat()`.
  So the `.dmg` and the `.zip` are cut from an already-stapled bundle — the same
  ordering argument as §6.2, and the reason the `.zip` Squirrel.Mac consumes
  contains a stapled app without anything extra being done to it.
- `desktop/scripts/notarize-dmg.js`, wired in as **`artifactBuildCompleted`**,
  notarizes and staples **the `.dmg` itself**. A disk image is its own notarizable
  container and is what the browser tags with `com.apple.quarantine`; Apple's
  guidance is to submit what you distribute, and a stapled ticket is what lets
  Gatekeeper clear it with no network round trip on a machine that has never seen
  it. The `.zip` is left alone — a zip has nowhere to hold a ticket, and the app
  inside it is stapled.

  The hook choice is load-bearing and is **not** `afterAllArtifactBuild`, which
  is the obvious one. `PublishManager` schedules an upload from the
  `artifactCreated` event, and `emitArtifactBuildCompleted` awaits this hook and
  *then* emits it; `afterAllArtifactBuild` runs after `packager.build()` has
  resolved, by which point a `--publish` run has already begun sending the
  un-stapled bytes. Known and accepted alongside it: `DmgTarget.build()` computes
  the dmg's blockmap and sha512 just before the hook runs, so both describe the
  pre-staple file. That is inert — `electron-updater` uses the `.zip` on macOS,
  never the `.dmg` — but it is why the dmg's entry in `latest-mac.yml` must not
  become load-bearing for updates.

Verification is `spctl --assess --type execute -vvv` **and** a download through a
browser on a machine that has never seen the app. Only the second produces the
quarantine attribute, so only the second reproduces what a user gets; a `curl` or
an artifact copied over `scp` does not.

Operationally, Apple documents a guideline of **75 notarizations per day** and
states that notarization completes within 5 minutes for most software and 15 for
98% of it. Reports through 2026 of Electron bundles sitting `In Progress` for
hours are common enough that a release lane should treat the round trip as
minutes-to-hours rather than seconds, and should not be retried impatiently.

**Windows.** Azure Artifact Signing, configured by four variables, none of which
is a secret:

| Variable | What it is |
|-|-|
| `AZURE_CODE_SIGNING_ENDPOINT` | Regional endpoint, e.g. `https://eus.codesigning.azure.net/`. |
| `AZURE_CODE_SIGNING_ACCOUNT_NAME` | The signing account. |
| `AZURE_CODE_SIGNING_CERT_PROFILE_NAME` | The certificate profile inside it. |
| `AZURE_CODE_SIGNING_PUBLISHER_NAME` | The subject the signature must match, e.g. `CN=…, O=…, C=US`. |

All four or none; three of four throws. electron-builder switches from `signtool`
to `WindowsSignAzureManager` on the presence of `win.azureSignOptions` alone.
Authentication is Entra ID's ambient credential chain, which on GitHub Actions is
OIDC workload-identity federation — `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and the
token file `azure/login` writes. electron-builder reads none of those itself and
neither does `desktop/signing.js`; the Azure signing library does. **There is no
certificate and no secret to store**, which is most of why §7 recommends this
route.

**Where this runs.** In the release lane's *build*, not after it — for macOS the
same ordering constraint as the ad-hoc signature (§6.2), and for Windows because
the NSIS installer embeds the signed binaries. No CI lane in `test.yml` sets any
of these variables and none should; `macos-desktop` asserts that Gatekeeper
refuses what it built, precisely so that a certificate reaching the test lane is
noticed.

## 7. Cost of going further (phase 2)

Prices below were re-checked on 2026-08-29, when the signing work was wired up.
The Windows recommendation changed on that pass and the eligibility gate that had
been the reason to hesitate turned out no longer to exist.

| Item | Cost |
|-|-|
| Apple Developer Program + notarization | $99/yr, **paid**. An **individual** membership is enough — D-U-N-S and organization enrolment are only for Organization accounts — and it grants up to five Developer ID Application certificates, which is the one thing this depends on. Notarization is included. |
| Windows code signing | **Azure Artifact Signing, $9.99/month** (Basic, 5,000 signatures/month). Not yet purchased — see below. **Not EV, and not a traditional OV certificate either.** |
| Three-OS build matrix | New CI lane; the payload's native addons are installed per platform (they follow the *bundled* Node, not Electron, under this architecture) |
| Auto-update | `electron-updater` + a release channel; interacts with release-please and the existing edge/latest image publishing |
| Security cadence | Chromium CVEs become our shipping obligation once binaries carry our name |
| Support surface | "It won't start" reports from machines whose PATH, Node, or antivirus we cannot see |

**EV is no longer worth its premium on Windows.** It used to buy immediate
SmartScreen reputation where OV had to earn it by download volume. Microsoft's
Trusted Root Program removed that in March 2024 and its own documentation now
says paying extra for EV solely to avoid SmartScreen warnings is not justified.
The only thing EV still buys is kernel-mode driver signing, which this app will
never do.

**Take Azure Artifact Signing.** The two Windows routes were supposed to differ
on eligibility rather than price, and on 2026-08-29 the eligibility gate turned
out not to apply, which leaves price and operability — and Azure wins both by a
wide margin.

- **Azure Artifact Signing** (the service formerly called Azure Trusted Signing)
  went **generally available on 2026-01-12** and the individual enrolment path
  survived GA. The "three or more years of verifiable business history" rule that
  made this look closed was an **organization-only, preview-only capacity gate**
  from April 2025; it never applied to individuals, and a Microsoft moderator
  confirmed on 2026-08-17 that post-GA there is no minimum organisation age
  either. What remains for an individual is a **geographic** limit — United
  States or Canada — plus identity verification against a government photo ID
  through Microsoft Authenticator / Verified ID, taking 1–20 business days. The
  Azure billing account's type is what selects individual validation, so it must
  be an Individual account.

  $9.99/month is $120/yr, and there is **no certificate and no secret**:
  authentication from GitHub Actions is OIDC workload-identity federation. §6.4
  has the four variables.

- **A traditional OV certificate** is now the expensive option, not the fallback.
  SSL.com's Individual Validated tier — the one that needs no registered business
  — is $129/yr for one year, dropping to $96.75/yr on a five-year term. But since
  the CA/Browser Forum's June 2023 rule the private key must live in FIPS 140-2
  Level 2 hardware, and a physical USB token is close to unusable from CI, so the
  real comparison includes a cloud HSM subscription: SSL.com's eSigner starts at
  **$20/month** on top. That is roughly $369/yr against Azure's $120, for a
  worse CI story and a certificate to guard. (A second 2026 change worth knowing:
  from 2026-03-01 the CA/Browser Forum caps code-signing certificate validity at
  458 days, so multi-year purchases now mean more reissues within the term.)

Both routes produce the same SmartScreen outcome, which is the whole reason the
cheap one is not a compromise: Microsoft's current documentation is explicit that
a valid OV or EV certificate gets identical first-download treatment and that
reputation accrues through download volume either way. Azure Artifact Signing is
itself non-EV, and Microsoft's own page recommends it for non-Store distribution.

Until it is bought, **the Windows targets in §6 ship unsigned**, and the
SmartScreen interstitial in the row above is not a hypothetical cost — it is what
every downloader of every release gets, since with no publisher identity the
reputation that would eventually silence it accrues to nothing. §6 has what the
dialog says, how to get past it, why the `zip` target does not dodge it, and why
neither a local build nor a CI run can reproduce it.

**On macOS the $99 is not a premium, it is the price of the feature.** An
unsigned or ad-hoc-signed app cannot auto-update at all: Squirrel.Mac, which
`electron-updater` uses there, verifies the signature on the downloaded bundle
before installing, and Electron's own documentation states that `autoUpdater`
requires a signed app to work. Windows and Linux degrade — a SmartScreen
warning, an unverified package — while macOS simply does not function.

Linux costs nothing and has nothing to enrol with. Publishing SHA-256 checksums
beside the artifacts, and optionally a detached GPG signature, is the whole
convention.

**What is bought, and what is still owed.** The Apple Developer Program
membership is active. Azure Artifact Signing is not yet enrolled, and its
identity verification is a person with a phone and a passport rather than
anything a build can do. Neither identity is in CI: the repository holds no
`CALANDRIA_MAC_SIGN_IDENTITY`, no `CSC_LINK`, no `APPLE_API_KEY` and no Azure
federated credential, so every artifact any lane produces today is ad-hoc on
macOS and unsigned on Windows. §6.4 is the configuration those credentials drop
into; the release lane is what will hold them.

Against all of that: the wrapper removes a terminal and a URL from the daily loop, and
adds reliable OS notifications. That's a real improvement for a daily driver and a thin
one for an occasional user.

## 8. Next steps

1. Run `desktop/` on a machine with a display; fix what the window layer gets wrong.
2. Decide between window-first and tray-first for phase 1 (both use the same supervisor).
3. ~~Native notifications + dock/taskbar badge wired to the existing "needs you" count~~ — done (§5.1), and with it the tray that lets the server outlive the window. Still to prove on a real desktop: that a toast reaches the OS, that the tray menu works under each status-area implementation, and that the badge renders — the bench's native-integration specs.
4. Enrol in Azure Artifact Signing and put the Apple Developer ID and App Store
   Connect key into CI (§6.4, §7) — the last two things that are a person with a
   phone and a passport rather than a build.
5. Only then: the release lane, then auto-update (packaging and the signing
   configuration are done — §6).
