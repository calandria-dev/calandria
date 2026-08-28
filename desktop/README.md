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
| `CALANDRIA_REPO_ROOT` | Repo to launch (defaults to the parent of `desktop/`). |
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
