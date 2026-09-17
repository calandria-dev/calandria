// The desktop package's user-facing installer strings.
//
// Windows shows desktop/package.json's `description` verbatim as the program
// name in the UAC elevation prompt, because app-builder-lib writes that field
// into the NSIS installer exe's FileDescription version key
// (out/targets/nsis/NsisTarget.js). The same string is the Start Menu and
// desktop shortcut tooltip and the uninstall entry's Comments value
// (templates/nsis/include/installer.nsh), and the deb package description
// (out/targets/LinuxTargetHelper.js). The app exe itself gets `productName`
// instead (out/winPackager.js, signAndEditResources).
//
// Nothing in desktop/electron-builder.cjs overrides `description`, so a note
// about how the package is built left in that field ships to every Windows
// user as the text they read before granting admin rights, and signing the
// installer makes that prompt more prominent, not less. Notes about the build
// belong in desktop/README.md.
//
// tests/desktopRelease.test.ts pins where the artifacts land;
// tests/desktopSigning.test.ts pins that they are signed.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const DESKTOP = path.join(ROOT, "desktop");

const require = createRequire(import.meta.url);

const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8")) as {
  description?: string;
};

const config = require(path.join(DESKTOP, "electron-builder.cjs")) as {
  productName?: string;
  extraMetadata?: { description?: string };
};

// What app-builder-lib resolves `appInfo.description` to: package.json's
// field, with `extraMetadata` deep-assigned over it (out/packager.js).
const description = config.extraMetadata?.description ?? pkg.description ?? "";

// Vocabulary that only makes sense to someone building this package. Any of it
// in the UAC prompt is the bug this file guards.
const BUILD_NOTES = /\b(spike|node_modules|docker|CI|npm|electron|unpacked|package|wrapper|shell)\b/i;

describe("desktop installer metadata", () => {
  it("names the product in the UAC prompt", () => {
    expect(config.productName).toBe("Calandria");
    expect(description.startsWith("Calandria")).toBe(true);
  });

  it("keeps the description to one short line, so the prompt is readable", () => {
    expect(description).not.toBe("");
    expect(description).not.toContain("\n");
    expect(description.length).toBeLessThanOrEqual(90);
  });

  it("keeps build notes out of the description", () => {
    expect(BUILD_NOTES.test(description)).toBe(false);
  });
});
