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
| `e2e/` | The window layer, driven by Playwright's Electron driver under a virtual display: boot + boot-screen handoff, menu roles, renderer hardening, the permission handler, external links, the single-instance refusal, the db-lock collision, quit-drains-in-flight-work, and one smoke path through the app inside the window. Run through its own config (`playwright.desktop.config.ts`, **not** the browser suite's — that one boots `npm start`, and the point here is that the shell boots the server itself). Takes the dev shell or a packaged build (`CALANDRIA_TEST_BIN`). See [`docs/DESKTOP_E2E.md`](../docs/DESKTOP_E2E.md). |
| `stub-server.js`, `stub-pty.js` | Fake sidecars for the tests: readiness, drain-on-SIGTERM, and the unhappy paths (never ready, lock held, ignores SIGTERM). |

## Tests

All three run from the **repo root**, and CI runs exactly these (the `desktop`
job in `.github/workflows/test.yml`):

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

Once packaging exists, the same window suite runs against the artifact:

```bash
CALANDRIA_TEST_BIN=dist/linux-unpacked/calandria-desktop \
  CALANDRIA_DESKTOP_SANDBOX=1 xvfb-run -a npm run test:desktop:window
```

The suite resolves `playwright` from the repo root's `node_modules` (already a
dev dependency for the browser suite) and needs `xvfb` plus Chromium's usual
library set on a headless box. It passes `--no-sandbox` because an unpacked
Electron has no SUID `chrome-sandbox`; a packaged install does, which is what
`CALANDRIA_DESKTOP_SANDBOX=1` is for.

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
