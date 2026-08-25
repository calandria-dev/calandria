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
| `PORT` / `PTY_PORT` | Preferred ports. Taken ones are stepped past, not fought over. |

Everything else is the app's own config (`.env`, `lib/config.ts`) and is
inherited unchanged.

## Layout

| File | What it is |
|-|-|
| `supervisor.js` | All the process management: PATH repair, Node resolution, port selection, spawn, readiness polling, drain-then-kill. **No `require("electron")`** — this is the part that survives a change of shell, and the part that can be tested headlessly. |
| `main.js` | Electron main: one window, an application menu, external links to the real browser, and quit-drains-first. No preload, no IPC, no `nodeIntegration`. |
| `loading.html` | Boot screen; `main.js` pushes sidecar log lines into it. |
| `test-supervisor.js` | 18 assertions over `supervisor.js`, against stub sidecars. No deps, no display. |
| `test-real-boot.js` | Boots the actual `server.js` + `pty-server.js` through the supervisor against a throwaway database. Needs a build. |
| `stub-server.js`, `stub-pty.js` | Fake sidecars for the tests: readiness, drain-on-SIGTERM, and the unhappy paths (never ready, lock held, ignores SIGTERM). |

## Tests

```bash
node test-supervisor.js                                   # headless, ~8 s
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test-supervisor.js   # same, in Electron's runtime
node test-real-boot.js                                    # needs a repo-root build
```

## The one rule

**The server runs under a real `node`, never inside Electron.** Two reasons, both
measured in `docs/DESKTOP_APP.md`: `better-sqlite3`'s prebuild will not load into
Electron's V8 ABI, and `lib/agents/codex/driver.ts` spawns the MCP tool bridge as
`process.execPath scripts/orch-mcp.mjs` with a closed env — under an
Electron-hosted server that would launch a GUI process on every Codex turn
instead of the bridge.

`supervisor.js` enforces this: it refuses an Electron binary as the runtime and
strips every `ELECTRON_*` variable out of the sidecar environment, so nothing the
server spawns downstream (agent CLIs, MCP bridges, your login shell in the
terminal panel) inherits Electron's runtime flags.
