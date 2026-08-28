/* The macOS half of the shell: `titleBarStyle: "hiddenInset"` and the menubar.
 *
 * Both are one line each in `desktop/main.js` and neither has ever run on a Mac
 * in CI — docs/DESKTOP_APP.md §5 listed the title bar as "needs a look on a real
 * screen", which is what this file plus its screenshot artifact settles.
 *
 * WHAT MAKES THESE macOS-ONLY RATHER THAN JUST macOS-FLAVOURED.
 *
 *   `hiddenInset` removes the native title bar strip and moves the traffic
 *   lights INTO the web content's coordinate space. On every other platform
 *   `main.js` asks for "default" and the OS draws a strip above the page, so the
 *   geometry assertion below (content box == window box) is false there by
 *   design and true here — it is the observable difference, not a preference.
 *
 *   The menu roles are what wire Cmd+C/V/A. On Windows and Linux those come
 *   from Chromium's own key handling and an absent Edit menu is cosmetic; on
 *   macOS the application menu IS the keyboard, so a missing role is a broken
 *   app. `01-shell.spec.ts` already asserts the top-level roles on every
 *   platform; this file goes one level down, into the submenus, because that is
 *   where the individual shortcuts live and where a role rename would land.
 *
 * The screenshot is the point of the second test, not decoration: the traffic
 * lights sit over the app's own titlebar row and no assertion can say whether
 * that looks right. So this measures the overlap, attaches the numbers, and
 * attaches the picture — a human looks once and the answer goes in
 * docs/DESKTOP_APP.md §5.
 *
 * One `launchShell()` for the file, as in 01-shell: every test here is a read.
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

  // THE assertion for hiddenInset. Under "default" macOS draws a ~28pt strip
  // above the page and the content box is shorter than the window box by
  // exactly that; under hiddenInset they are the same rectangle, because the
  // page now owns the rows the strip used to. If main.js's ternary ever
  // resolves to "default" on darwin, this is what says so.
  expect(chrome.content, "the window still has a native title bar strip above the page").toEqual(
    chrome.bounds
  );

  expect(chrome.visible).toBe(true);
  expect(chrome.resizable).toBe(true);
  // Frameless would have taken these with it, and with them the only way to
  // close the window — the app draws no window controls of its own.
  expect({
    closable: chrome.closable,
    minimizable: chrome.minimizable,
    maximizable: chrome.maximizable,
  }).toEqual({ closable: true, minimizable: true, maximizable: true });

  // Not an exact size: a runner's display can be smaller than main.js's
  // requested 1440x900 and macOS clamps to what fits. The floor is what
  // matters — minWidth/minHeight are 720x480 and a window below them would
  // mean the constraint was ignored.
  expect(chrome.bounds.width).toBeGreaterThanOrEqual(720);
  expect(chrome.bounds.height).toBeGreaterThanOrEqual(480);
});

test("the traffic lights land on the app's own titlebar row", async ({}, testInfo) => {
  // Where macOS puts the buttons under `hiddenInset`: inset from the top-left,
  // in window points, which are CSS pixels at the renderer's default zoom. The
  // numbers are AppKit's, not ours — nothing in this repo can move them — so
  // they are a probe, not a contract. What the probe answers is whether the
  // app painted anything underneath them.
  const probes = [
    { name: "close", x: 20, y: 24 },
    { name: "minimise", x: 40, y: 24 },
    { name: "zoom", x: 60, y: 24 },
    { name: "past the lights", x: 100, y: 24 },
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

  // The one part that IS a verdict, and a deliberately narrow one: the page's
  // layout reaches the rows the native strip used to own. `elementsFromPoint`
  // returns the enclosing boxes as well as the painted leaf, so html + body is
  // what "nothing is laid out here" looks like and anything more is the app's
  // own chrome extending to the top of the window. Whether that chrome *looks*
  // right under the traffic lights is the screenshot's business, not this
  // assertion's.
  const topRow = hits.find((h) => h.name === "past the lights")!;
  expect(
    topRow.stack.length,
    `nothing but html/body is laid out at (100, 24) — the window has a dead band across its top: ${JSON.stringify(topRow.stack)}`
  ).toBeGreaterThan(2);
});

test("the menubar's submenus carry the roles the system shortcuts come from", async () => {
  // Electron's own types live under desktop/node_modules, so everything the
  // main process hands back arrives as `any` — hence the annotations.
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
  // they are the Edit menu's roles, and an app without them cannot copy text.
  // That is the whole reason `{ role: "editMenu" }` is in main.js.
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

  // Cmd+M. `close` is deliberately checked against the FILE menu instead: on
  // darwin Electron's fileMenu expands to a lone `close` (Cmd+W) while `quit`
  // moves to the app menu, which is the opposite of every other platform.
  expect(missing(menus.windowmenu, ["minimize"])).toEqual([]);
  expect(missing(menus.filemenu, ["close"])).toEqual([]);
});
