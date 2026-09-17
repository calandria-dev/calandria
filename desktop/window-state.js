/* Where the window was last left, and whether that place still exists.
 *
 * Electron fixes a BrowserWindow's size and position at construction and
 * remembers nothing between them, so a window built from literals opens at
 * those literals every time. The shell rebuilds its window on every instance
 * switch that crosses a session partition (`applyActiveInstance` in main.js)
 * and the whole process restarts after an update installs, which made both
 * look like the app resizing itself.
 *
 * One geometry for the app, not one per instance: the window is the same
 * window whichever server it is pointed at, and a size that changed when the
 * server did is the bug this file exists to fix.
 *
 * No `require("electron")` here, the same rule instances.js follows, so the
 * geometry math is testable under plain node (`node desktop/test-supervisor.js`).
 * main.js passes the display work areas in.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** The size a first launch opens at, and the floor `createWindow` also sets
 *  as the window's `minWidth`/`minHeight`. Kept here so the restore path and
 *  the constructor cannot drift apart. */
const DEFAULT_SIZE = { width: 1440, height: 900 };
const MIN_SIZE = { width: 720, height: 480 };

/**
 * `~/.config/calandria/window-state.json` on every platform.
 *
 * Beside `instances.json` and the env file, for the same reason those two sit
 * together: the desktop app's config is in one directory the user can find,
 * back up, or delete to start over.
 */
function windowStateFilePath(env = process.env) {
  if (env.CALANDRIA_WINDOW_STATE_FILE) return env.CALANDRIA_WINDOW_STATE_FILE;
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "calandria", "window-state.json");
}

function int(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  // `Math.round(-0.4)` is -0, which JSON writes as 0 and every later
  // comparison then reads as a change. Collapse it here instead.
  return rounded === 0 ? 0 : rounded;
}

/**
 * Coerce anything into a state this module's other functions accept.
 *
 * A size is always present, since a window has to be built with one. A
 * position is optional and stays absent when it cannot be read, which is what
 * tells `createWindow` to let the platform place the window instead.
 */
function normalizeWindowState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const width = int(src.width);
  const height = int(src.height);
  const x = int(src.x);
  const y = int(src.y);
  const state = {
    width: Math.max(width && width > 0 ? width : DEFAULT_SIZE.width, MIN_SIZE.width),
    height: Math.max(height && height > 0 ? height : DEFAULT_SIZE.height, MIN_SIZE.height),
    maximized: src.maximized === true,
    fullScreen: src.fullScreen === true,
  };
  // Both or neither: half a position places a window nowhere useful.
  if (x !== null && y !== null) {
    state.x = x;
    state.y = y;
  }
  return state;
}

function isRect(r) {
  return (
    !!r &&
    typeof r === "object" &&
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    r.width > 0 &&
    r.height > 0
  );
}

/** Width and height of the intersection, negative when they do not touch. */
function overlap(a, b) {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/**
 * Fit a saved state to the displays attached right now.
 *
 * The saved rectangle can name a monitor that has since been unplugged, a
 * laptop screen that was docked to something larger, or a resolution that
 * changed underneath it. Restoring it unchecked opens the window off-screen,
 * where the only ways back are the OS window menu or deleting the state file.
 *
 * `workAreas` is `screen.getAllDisplays().map((d) => d.workArea)`, the usable
 * part of each display with the menu bar and taskbar already taken out. An
 * empty list means the caller could not ask, and the saved state is returned
 * untouched.
 */
function fitToWorkAreas(state, workAreas, min = MIN_SIZE) {
  const fitted = normalizeWindowState(state);
  const areas = (Array.isArray(workAreas) ? workAreas : []).filter(isRect);
  if (!areas.length) return fitted;

  // The display the window mostly sat on, by overlapping area. Falls back to
  // the first, which is the primary display in Electron's ordering.
  let target = areas[0];
  if (fitted.x !== undefined) {
    const rect = { x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height };
    let best = 0;
    for (const area of areas) {
      const o = overlap(rect, area);
      const covered = Math.max(0, o.width) * Math.max(0, o.height);
      if (covered > best) {
        best = covered;
        target = area;
      }
    }
    // Not one pixel of the window is on a screen that exists: the display it
    // was saved on has been unplugged, or the desktop it sat on has been
    // rearranged around it. There is no display to clamp it toward, so drop
    // the position and let the platform place the window. The size is kept,
    // since it is still the size the user chose. Any overlap at all is enough
    // to keep the position, because the clamp below then pulls the window
    // fully back onto that display.
    if (best === 0) {
      delete fitted.x;
      delete fitted.y;
      target = areas[0];
    }
  }

  // Never larger than the display it lands on. The floor is applied second on
  // purpose: on a display smaller than the minimum, Electron's own
  // `minWidth`/`minHeight` would enforce it anyway, and agreeing with that
  // here keeps the saved state and the real window the same shape.
  fitted.width = Math.max(Math.min(fitted.width, target.width), min.width);
  fitted.height = Math.max(Math.min(fitted.height, target.height), min.height);

  if (fitted.x !== undefined) {
    fitted.x = clamp(fitted.x, target.x, Math.max(target.x, target.x + target.width - fitted.width));
    fitted.y = clamp(fitted.y, target.y, Math.max(target.y, target.y + target.height - fitted.height));
  }
  return fitted;
}

/**
 * Read the saved geometry. Never throws: no file is the first launch, and an
 * unreadable one is worth a default window, never a refusal to open one.
 */
function loadWindowState({ env = process.env, file = null } = {}) {
  const p = file || windowStateFilePath(env);
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return { path: p, found: true, state: normalizeWindowState(raw) };
  } catch (err) {
    return {
      path: p,
      found: false,
      state: normalizeWindowState({}),
      error: err?.code === "ENOENT" ? null : err,
    };
  }
}

/**
 * Write it, atomically, normalized on the way out so the file on disk is
 * always something `loadWindowState` would accept unchanged.
 */
function saveWindowState(state, { env = process.env, file = null } = {}) {
  const p = file || windowStateFilePath(env);
  const normalized = normalizeWindowState(state);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, p);
  return { path: p, state: normalized };
}

/** True when the two describe the same window, so an idle app writes nothing. */
function sameWindowState(a, b) {
  if (!a || !b) return false;
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.x === b.x &&
    a.y === b.y &&
    a.maximized === b.maximized &&
    a.fullScreen === b.fullScreen
  );
}

module.exports = {
  DEFAULT_SIZE,
  MIN_SIZE,
  fitToWorkAreas,
  loadWindowState,
  normalizeWindowState,
  sameWindowState,
  saveWindowState,
  windowStateFilePath,
};
