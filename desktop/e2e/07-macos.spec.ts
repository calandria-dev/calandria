/* The macOS half of the shell: `titleBarStyle: "hiddenInset"` and the menubar.
 *
 * Both are one line each in `desktop/main.js`. This file and its screenshot
 * artifact are the coverage for them on an actual Mac.
 *
 * What makes these macOS-only rather than just macOS-flavoured:
 *
 *   `hiddenInset` removes the native title bar strip and moves the traffic
 *   lights into the web content's coordinate space. On every other platform
 *   `main.js` asks for "default" and the OS draws a strip above the page, so
 *   the geometry assertion below (content box == window box) is false there
 *   by design and true here.
 *
 *   The menu roles are what wire Cmd+C/V/A. On Windows and Linux those come
 *   from Chromium's own key handling and an absent Edit menu is cosmetic; on
 *   macOS the application menu is the keyboard, so a missing role is a
 *   broken app. `01-shell.spec.ts` already asserts the top-level roles on
 *   every platform; this file goes one level down, into the submenus, since
 *   that is where the individual shortcuts live and where a role rename
 *   would land.
 *
 * The screenshot in the second test is evidence, not decoration: the traffic
 * lights sit over the app's own titlebar row and no assertion can say
 * whether that looks right, so this measures the overlap, attaches the
 * numbers, and attaches the picture for a human to check.
 *
 * One `launchShell()` for the file, as in 01-shell: every test here is a
 * read.
 */

import { expect, test } from "@playwright/test";
import { attachShellLog, launchShell, quitShell, type Shell } from "./fixtures";

test.describe.configure({ mode: "serial" });

test.skip(process.platform !== "darwin", "macOS-only: hiddenInset chrome and the real menubar");

let shell: Shell;

test.beforeAll(async () => {
  shell = await launchShell("macos");
});

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  await quitShell(shell);
});

test("hiddenInset gives the page the whole window, with the traffic lights intact", async () => {
  const chrome = await shell.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return {
      bounds: w.getBounds(),
      content: w.getContentBounds(),
      visible: w.isVisible(),
      resizable: w.isResizable(),
      // The three traffic lights: `hiddenInset` keeps them (that is what
      // separates it from `hidden`/frameless), and Electron exposes their
      // presence only as these three capability flags.
      closable: w.isClosable(),
      minimizable: w.isMinimizable(),
      maximizable: w.isMaximizable(),
    };
  });

  // The assertion for hiddenInset. Under "default" macOS draws a ~28pt strip
  // above the page and the content box is shorter than the window box by
  // exactly that; under hiddenInset they are the same rectangle, because the
  // page now owns the rows the strip would otherwise draw. If main.js's
  // ternary ever resolves to "default" on darwin, this is what catches it.
  expect(chrome.content, "the window still has a native title bar strip above the page").toEqual(
    chrome.bounds
  );

  expect(chrome.visible).toBe(true);
  expect(chrome.resizable).toBe(true);
  // Frameless would have taken these with it, and with them the only way to
  // close the window, since the app draws no window controls of its own.
  expect({
    closable: chrome.closable,
    minimizable: chrome.minimizable,
    maximizable: chrome.maximizable,
  }).toEqual({ closable: true, minimizable: true, maximizable: true });

  // Not an exact size: a runner's display can be smaller than main.js's
  // requested 1440x900 and macOS clamps to what fits. The floor is what
  // matters: minWidth/minHeight are 720x480, and a window below them would
  // mean the constraint was ignored.
  expect(chrome.bounds.width).toBeGreaterThanOrEqual(720);
  expect(chrome.bounds.height).toBeGreaterThanOrEqual(480);
});

test("the traffic lights land on the app's own titlebar row", async ({}, testInfo) => {
  // Where the buttons are, in window points: CSS pixels at the renderer's
  // default zoom. These are main.js's numbers, not a probe of AppKit,
  // because the page has to reserve room for them and cannot reserve room
  // for a position it does not know (`trafficLightPosition: { x: 18, y: 17 }`,
  // three 12px buttons on a 20px pitch, so centres at 24/44/64 and a cluster
  // ending at 70).
  const probes = [
    { name: "close", x: 24, y: 23 },
    { name: "minimise", x: 44, y: 23 },
    { name: "zoom", x: 64, y: 23 },
    { name: "past the lights", x: 100, y: 23 },
  ];

  const hits = await shell.win.evaluate((points) => {
    const describe = (el: Element) => {
      const testid = el.getAttribute("data-testid");
      const cls = typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 3).join(".") : "";
      return `${el.tagName.toLowerCase()}${testid ? `[${testid}]` : ""}${cls ? `.${cls}` : ""}`;
    };
    return points.map((p) => ({
      ...p,
      // Outermost first is html/body; anything beyond those is app chrome the
      // buttons are sitting on top of.
      stack: Array.from(document.elementsFromPoint(p.x, p.y)).map(describe),
    }));
  }, probes);

  // The measurement, for the human this test exists to inform. Attached rather
  // than asserted: whether the overlap is acceptable is a design call, and a
  // spec that guessed at it would either pin today's layout or fail on a
  // cosmetic change nobody asked about.
  await testInfo.attach("titlebar-probe.json", {
    body: JSON.stringify(hits, null, 2),
    contentType: "application/json",
  });

  const shot = await shell.win.screenshot();
  await testInfo.attach("hiddenInset.png", { body: shot, contentType: "image/png" });
  // A blank or truncated PNG is what a broken SwiftShader pass looks like, and
  // it is also what would make the human's one look worthless.
  expect(shot.byteLength).toBeGreaterThan(5000);

  // The one part that is a verdict, and a narrow one: the page's layout
  // reaches the rows the native strip would otherwise own. `elementsFromPoint`
  // returns the enclosing boxes as well as the painted leaf, so html + body is
  // what "nothing is laid out here" looks like, and anything more is the
  // app's own chrome extending to the top of the window. Whether that chrome
  // looks right under the traffic lights is the screenshot's business, not
  // this assertion's.
  const topRow = hits.find((h) => h.name === "past the lights")!;
  expect(
    topRow.stack.length,
    `nothing but html/body is laid out at (100, 23) — the window has a dead band across its top: ${JSON.stringify(topRow.stack)}`
  ).toBeGreaterThan(2);
});

// The two jobs the page inherited when hiddenInset took the native bar away.
// Neither is visible from anywhere else: tests/desktopWindowChrome.test.ts
// pins the numbers agreeing across main.js and globals.css, but only a real
// packaged launch can say whether the class that applies them ever reached
// the page, since it hangs off a user-agent read and the token behind it is
// set by main.js.
test("the page reserves the traffic lights' corner and is draggable", async () => {
  const chrome = await shell.win.evaluate(() => {
    const app = document.querySelector(".app");
    const bar = document.querySelector(".titlebar");
    const logo = document.querySelector(".tb-logo");
    const button = document.querySelector(".titlebar button");
    // Chromium exposes the prefixed property through getPropertyValue (it is
    // how the Window Controls Overlay API is read in an ordinary tab too), so
    // this is the real computed cascade rather than a re-reading of the source.
    const region = (el: Element | null) =>
      el ? getComputedStyle(el).getPropertyValue("-webkit-app-region") : null;
    return {
      macChrome: !!app?.classList.contains("mac-chrome"),
      barTop: bar?.getBoundingClientRect().top ?? null,
      logoLeft: logo?.getBoundingClientRect().left ?? null,
      barRegion: region(bar),
      buttonRegion: region(button),
      sawButton: !!button,
    };
  });

  // The whole feature hangs off this one class, so it is asserted before
  // anything it turns on: without it every check below reads as "no padding,
  // no drag region" and the diagnosis would be the CSS rather than the UA.
  expect(chrome.macChrome, "the shell's own UA token never reached the page — isMacDesktopShell() said no").toBe(true);

  // The bar starts at the very top of the window (hiddenInset gave it those
  // rows) and its content starts clear of the buttons: 18 + 52 = 70 is the
  // right edge of the zoom button, and anything left of that is underneath it.
  expect(chrome.barTop).toBe(0);
  expect(
    chrome.logoLeft,
    "the Calandria logo is underneath the traffic lights — the titlebar's left inset is too small"
  ).toBeGreaterThanOrEqual(70);

  // And the bar moves the window, because nothing else can. A button inside a
  // drag region does not fire, so the opt-out is half of the same fact.
  expect(chrome.barRegion).toBe("drag");
  expect(chrome.sawButton).toBe(true);
  expect(chrome.buttonRegion, "a titlebar button sits inside the drag region and would move the window instead of firing").toBe("no-drag");
});

test("the menubar's submenus carry the roles the system shortcuts come from", async () => {
  // Electron's own types live under desktop/node_modules, so everything the
  // main process hands back arrives as `any`, hence the annotations.
  const menus: Record<string, string[]> = await shell.app.evaluate(async ({ Menu }) => {
    const items = (Menu.getApplicationMenu()?.items || []) as any[];
    const out: Record<string, string[]> = {};
    for (const item of items) {
      const key = String(item.role || item.label || "?").toLowerCase();
      out[key] = ((item.submenu?.items || []) as any[]).map((sub: any) =>
        String(sub.role || sub.label || sub.type || "?").toLowerCase()
      );
    }
    return out;
  });

  // Substring, not equality: an item built from a role reads back with that
  // role, but a few of macOS's expansions are plain labelled items ("About
  // Calandria", "Hide Others"), and which is which is Electron's business
  // rather than a fact worth pinning. What must hold is that the entry is
  // there under a recognisable name.
  const missing = (menu: string[] | undefined, wanted: string[]) =>
    wanted.filter((w) => !(menu || []).some((entry) => entry.includes(w)));

  // Cmd+C / Cmd+V / Cmd+A are not ours and are not Chromium's here: on macOS
  // they are the Edit menu's roles, and an app without them cannot copy
  // text, which is why `{ role: "editMenu" }` is in main.js.
  expect(
    missing(menus.editmenu, ["undo", "redo", "cut", "copy", "paste", "select"]),
    `Edit menu is incomplete — Cmd+C/V/A come from these roles. Menu was ${JSON.stringify(menus.editmenu)}`
  ).toEqual([]);

  // The application menu is macOS's own: Cmd+Q, Cmd+H and About live nowhere
  // else, and `{ role: "appMenu" }` is added only on darwin.
  expect(
    missing(menus.appmenu, ["about", "hide", "quit"]),
    `application menu is incomplete — Cmd+Q and Cmd+H have nowhere to come from. Menu was ${JSON.stringify(menus.appmenu)}`
  ).toEqual([]);

  // Cmd+M. `close` is checked against the file menu instead: on darwin
  // Electron's fileMenu expands to a lone `close` (Cmd+W) while `quit` moves
  // to the app menu, which is the opposite of every other platform.
  expect(missing(menus.windowmenu, ["minimize"])).toEqual([]);
  expect(missing(menus.filemenu, ["close"])).toEqual([]);
});
