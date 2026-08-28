/* Calandria desktop shell — Electron main process.
 *
 * SPIKE CODE. See ./README.md and docs/DESKTOP_APP.md.
 *
 * Intentionally thin. Everything that can be tested without a display lives in
 * supervisor.js; this file is window + menu + lifecycle, and it holds exactly
 * one piece of policy: the renderer is a hardened browser tab pointed at
 * 127.0.0.1, not a privileged page. No preload, no nodeIntegration, no IPC —
 * the app already talks to its server over HTTP/SSE/WS and gains nothing from
 * a bridge, while a bridge would hand any XSS in the transcript renderer the
 * whole Node API.
 */
"use strict";

const { app, BrowserWindow, Menu, shell, dialog, session } = require("electron");
const path = require("node:path");
const { Supervisor, preferredPorts } = require("./supervisor");

// Where the server payload lives — the thing supervisor.js runs `node server.js`
// out of. Packaged, it is extraResources sitting NEXT TO the asar, not inside
// it: it holds native addons that dlopen from a real path and it is spawned as
// a child process, neither of which can see into an archive (staged by
// scripts/build-payload.js, mapped to resources/app-payload by the
// electron-builder config in package.json). Unpackaged, it is the checkout this
// file sits in, so `cd desktop && npm start` against a repo stays the developer
// flow. CALANDRIA_REPO_ROOT overrides both, which is how a packaged binary gets
// pointed at a working tree.
const REPO_ROOT =
  process.env.CALANDRIA_REPO_ROOT ||
  (app.isPackaged ? path.join(process.resourcesPath, "app-payload") : path.resolve(__dirname, ".."));
const LOADING_PAGE = `file://${path.join(__dirname, "loading.html")}`;

let win = null;
let supervisor = null;
let appUrl = null;
let quitting = false;

// One shell per machine. This mirrors, at the UI layer, the single-process rule
// lib/db-lock.mjs enforces at the database layer: a second launch would spawn a
// second server, lose the lock race, and exit(1) with an error the user reads as
// a crash. Focusing the existing window is what they meant anyway.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  main();
}

function main() {
  app.on("window-all-closed", () => {
    // macOS convention is to stay in the dock; everywhere else, closing the
    // window means "stop the server too" — leaving turns running invisibly with
    // no window is worse than stopping them.
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Quit is the only place in-flight turns can be drained: server.js's SIGTERM
  // handler POSTs /api/instance/drain and exits when they settle. Hold the quit
  // open for exactly as long as that takes.
  app.on("before-quit", async (event) => {
    if (quitting || !supervisor) return;
    quitting = true;
    event.preventDefault();
    win?.setTitle("Calandria — finishing in-flight turns…");
    try {
      await supervisor.stop();
    } finally {
      app.exit(0);
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(buildMenu());
    hardenSession();
    createWindow();
    await boot();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0b0d10",
    show: true,
    title: "Calandria",
    // A dark, borderless-ish title bar on macOS matches the app's own titlebar;
    // on Windows/Linux the native frame stays, since the app has no custom
    // window controls of its own to replace it with.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.loadURL(LOADING_PAGE);

  // Anything that isn't our own loopback origin opens in the user's real
  // browser: GitHub PR links, docs, a task's exposed service. A new
  // BrowserWindow for those would be a browser we then have to maintain.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url) || url.startsWith("file://")) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  win.on("closed", () => {
    win = null;
  });
}

function isAppUrl(url) {
  if (!appUrl) return false;
  try {
    const u = new URL(url);
    return u.origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

function hardenSession() {
  // The renderer is a local web app, not a document from the internet: grant
  // notifications (turn-finished pings are the point of a desktop shell) and
  // deny the hardware permissions nothing in the app asks for. Default-deny,
  // so a future dependency can't quietly acquire the camera.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "notifications" || permission === "clipboard-sanitized-write");
  });
}

async function boot() {
  supervisor = new Supervisor({
    repoRoot: REPO_ROOT,
    // PORT/PTY_PORT are documented as env the shell understands, so read them
    // here — the Supervisor's own 3000/3001 are the fallback, not the policy.
    // Still preferences: a busy one is stepped past (see pickPorts).
    ...preferredPorts(process.env),
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    onLog: (line) => {
      // Two consumers: the terminal a developer launched us from, and the
      // loading screen (so a slow first boot shows progress instead of a spinner).
      console.log(line);
      // executeJavaScript rather than IPC: the boot screen is the only consumer
      // and adding a preload for it would mean shipping a bridge into every
      // page the window later loads, including the app itself.
      win?.webContents.executeJavaScript(`window.__log && window.__log(${JSON.stringify(line)})`).catch(() => {});
    },
    onExit: ({ name, code, dbLockHeld }) => {
      if (quitting) return;
      // A sidecar dying while the app is up is not recoverable in place: the
      // renderer's SSE streams are already broken and the db lock may be gone.
      const detail = dbLockHeld
        ? "Another Calandria instance is already running against this database.\n\nQuit that one first, or open it in your browser."
        : `The ${name} process exited unexpectedly (code ${code}).\n\n${supervisor.recentLog(15)}`;
      dialog.showErrorBox("Calandria stopped", detail);
      app.exit(1);
    },
  });

  try {
    const { url } = await supervisor.start();
    appUrl = url;
    await win?.loadURL(url);
    win?.setTitle("Calandria");
  } catch (err) {
    dialog.showErrorBox("Calandria could not start", `${err?.message || err}\n\n${supervisor?.recentLog(20) || ""}`);
    app.exit(1);
  }
}

function buildMenu() {
  // Without an application menu, macOS loses Cmd+C/V/A entirely — the roles
  // below are what wire the system shortcuts, not decoration.
  const isMac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Reload app", accelerator: "CmdOrCtrl+R", click: () => appUrl && win?.loadURL(appUrl) },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        {
          label: "Open in browser",
          click: () => appUrl && shell.openExternal(appUrl),
        },
      ],
    },
    { role: "windowMenu" },
  ]);
}
