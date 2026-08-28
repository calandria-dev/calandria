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
   people who have the repo.
2. **Defer signed installers until someone asks.** That's where the entire cost lives
   (§6): ~$300/yr in certificates, a three-OS release lane, an update channel, and a
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
headless box (18 assertions, `node test-supervisor.js`, ~9s, no display), and means a later
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
| macOS GUI apps get launchd's PATH | A `.app` opened from Finder inherits `/usr/bin:/bin:/usr/sbin:/sbin`, not the user's shell PATH. `codex` (spawned bare, `lib/agents/codex/mcp.ts:38`), `gh` (probed on PATH, `lib/github.ts:35`) and an nvm-managed `node` are invisible to a double-clicked Calandria while working in the same user's terminal. The supervisor detects the stub PATH and re-reads it from the login shell. |
| The real server boots under the shell's supervisor | `node desktop/test-real-boot.js`: **919 ms** to `/api/version`, on ports 3002/3003 (stepped past the live instance), app HTML served, `/pty` proxied to the sidecar chosen, `CALANDRIA_DB_DIR` honored, both sidecars drained on SIGTERM with no SIGKILL. |
| Electron's size is not the dominant term | Electron 44 linux-x64 unpacks to **282 MB**. The payload it would wrap, `.next` (127 MB) plus a pruned `node_modules`, is larger; the container carrying the same payload with Debian, git, gh and both agent CLIs is **3.99 GB**. |

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

Working and tested (`desktop/test-supervisor.js`, 18 assertions; `desktop/test-real-boot.js`, 8):

- Node resolution: `CALANDRIA_NODE` → bundled → `execPath` (only when not Electron) →
  PATH, with an actionable error naming everything it tried.
- macOS launchd-PATH detection and repair from the login shell, fenced against rc-file
  chatter, returning `null` rather than throwing on failure.
- Port selection that steps past a running instance and never hands both sidecars the same
  port.
- Readiness polling that insists on the app's own `/api/version` shape.
- Quit → SIGTERM → the server's own `/api/instance/drain` → exit, with SIGKILL only as a
  backstop and a bounded wait so nothing outlives the window holding the db lock.
- The db-lock exit (`server.js` exits 1 when another instance holds the database) reported
  as "another Calandria is already running," not as a crash.
- A boot screen that streams sidecar logs, because a cold first launch is otherwise
  indistinguishable from a hang.

**Unverified:** everything that needs a display. This machine is headless (no X, no
Wayland, no Xvfb), so `main.js` has never rendered a window. Window lifecycle, the macOS
`hiddenInset` title bar, menu roles, the notification permission handler and external-link
handling are written but untested. Running it on a desktop machine is the next step.

Also not attempted: packaging (`electron-builder`), tray/menubar, deep links
(`calandria://`), dock badge for the "N need you" count, window-bounds persistence,
auto-update.

## 5. Per-platform gaps

**macOS**: the PATH repair above is mandatory, not polish. Signing and notarization are
required for anything distributed (Gatekeeper blocks unsigned apps by default).
`hiddenInset` overlaps the app's own titlebar row and needs a look on a real screen.

**Windows**: the server's own gaps are closed ([`WINDOWS.md`](WINDOWS.md)). The pty
sidecar probes a real Windows shell, managed services are killed as a `taskkill /T` tree,
and path identity is case-folded. One gap remains in the supervisor: `.kill()` on Windows is
`TerminateProcess`, so a quit from the shell degrades to a hard stop and an in-flight turn
is interrupted rather than settled. `npm start` solves this for the console via
`scripts/start.mjs`, which relies on the console broadcasting Ctrl+C, a path a GUI
supervisor doesn't have. The supervisor needs a graceful-shutdown channel that isn't a
signal: POST `/api/instance/drain` and wait for it before killing. (`npm start` used to
carry a POSIX-only inline `NODE_ENV=production` prefix; it now goes through `cross-env`,
and the supervisor spawns `node` directly with an env regardless.)

**Linux**: works as-is under X11/Wayland. `chrome-sandbox` must be root-owned/4755 when
running from a plain directory (packaged builds handle it); AppImage/deb/rpm are all
electron-builder targets.

## 6. Cost of going further (phase 2)

| Item | Cost |
|-|-|
| Apple Developer Program + notarization | $99/yr, plus a signing lane in CI |
| Windows code signing (OV/EV) | ~$200-400/yr; unsigned means a SmartScreen warning on every install |
| Three-OS build matrix | New CI lane; native modules must be built per platform (the payload's `better-sqlite3` follows the *bundled* Node, not Electron, under this architecture) |
| Auto-update | `electron-updater` + a release channel; interacts with release-please and the existing edge/latest image publishing |
| Security cadence | Chromium CVEs become our shipping obligation once binaries carry our name |
| Support surface | "It won't start" reports from machines whose PATH, Node, or antivirus we cannot see |

Against that: the wrapper removes a terminal and a URL from the daily loop, and adds
reliable OS notifications. That's a real improvement for a daily driver and a thin one for
an occasional user, so the recommendation is to ship the free half now and let demand pay
for the rest.

## 7. Next steps

1. Run `desktop/` on a machine with a display; fix what the window layer gets wrong.
2. Decide between window-first and tray-first for phase 1 (both use the same supervisor).
3. Native notifications and a dock/taskbar badge wired to the existing "needs you" count:
   the highest-value thing the shell can add that a browser tab cannot.
4. Only then: packaging, signing, updates.
