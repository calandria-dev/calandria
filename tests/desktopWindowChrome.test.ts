// The macOS window chrome, one layout split across two files.
//
// `titleBarStyle: "hiddenInset"` takes the native title bar away, and what
// replaces it is the app's own titlebar: a web page. That makes two facts
// shared between desktop/main.js and app/globals.css rather than owned by
// either, and both fail silently when they drift:
//
//   1. Where the traffic lights sit. They float over the page's top-left
//      corner, so the page has to reserve room for them; too little and the
//      Calandria logo renders underneath the close button.
//   2. That the titlebar is a drag region. With no native bar there is nothing
//      else to move the window by, and a window that cannot be moved is not a
//      cosmetic defect. Every control inside it has to opt back out, or a
//      click on Terminal drags the window instead of opening it.
//
// Neither can be caught by typecheck, and the desktop e2e suite runs on Linux
// (see desktop/e2e/README.md), where this whole branch is inert. So it is
// pinned here, from the source of both files, the way tests/desktopUpdater.test.ts
// pins the quit path.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

// desktop/main.js is heavily commented and the comment above trafficLightPosition
// names the very CSS selector asserted on below, so read the code, not the prose:
// the same strip tests/desktopUpdater.test.ts uses, and for the same reason.
const mainSource = fs
  .readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const css = fs.readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");

// The rule the shell's class turns on. Matched by its selector rather than by
// position, so moving the block around globals.css doesn't fail the test.
const macTitlebarRule = /\.app\.mac-chrome[^{]*\.titlebar[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? "";

// macOS draws three 12px buttons on a 20px pitch: 12 + 20 + 20 = 52px from the
// left edge of the cluster to the right edge of the last button.
const TRAFFIC_LIGHT_CLUSTER_PX = 52;

describe("the page's titlebar stands in for the native one macOS took away", () => {
  it("pins the traffic lights instead of inheriting hiddenInset's default", () => {
    // Inheriting the default would work until it changed, and the page has no
    // way to read it, so the position is stated, and stated only for darwin,
    // since Windows and Linux keep the native frame that owns their controls.
    expect(mainSource).toMatch(/titleBarStyle:\s*process\.platform === "darwin" \? "hiddenInset"/);
    expect(mainSource).toMatch(/process\.platform === "darwin"[\s\S]{0,80}trafficLightPosition/);
  });

  it("reserves at least the room the buttons occupy, so the logo clears them", () => {
    const x = Number(/trafficLightPosition:\s*\{\s*x:\s*(\d+)/.exec(mainSource)?.[1]);
    const padding = Number(/padding-left:\s*(\d+)px/.exec(macTitlebarRule)?.[1]);

    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(padding)).toBe(true);
    // The failure this catches is content starting before x + 52: content
    // underneath the window controls.
    expect(padding).toBeGreaterThanOrEqual(x + TRAFFIC_LIGHT_CLUSTER_PX);
  });

  it("makes the bar the drag handle and lets every control out of it", () => {
    expect(macTitlebarRule).toContain("-webkit-app-region:drag");

    // Buttons are all the titlebar contains that is clickable today, but the
    // list is what stops the next one being added inside a dead region.
    const noDrag = css.split("}").find((block) => block.includes("no-drag")) ?? "";
    for (const el of ["button", "a", "input"]) {
      expect(noDrag).toContain(`.app.mac-chrome .titlebar ${el}`);
    }
  });

  it("survives the phone layout, which overrides padding-left later in the file", () => {
    // A Mac window's minWidth is 720, below the 760px the mobile titlebar takes
    // over at, so a narrow-but-real window hits both rules. Equal specificity
    // would hand it to whichever came last; .mobile on the same element wins
    // outright. Without this the traffic lights re-collide on a dragged-narrow
    // window and nothing else in the suite would notice.
    expect(css).toMatch(/\.app\.mac-chrome\.mobile \.titlebar\s*\{[^}]*padding-left/);
  });
});
