// Fonts are declared in two places that can drift silently, and both failure
// directions have already happened here:
//
//   - USED BUT NOT LOADED — reference a --nf-* variable in globals.css or the
//     font picker (shell/types.ts) without declaring it in app/fonts.ts
//     and every glyph quietly falls back to system-ui. Nothing errors; the app
//     just stops looking like itself on the machines that lack it.
//   - LOADED BUT NOT USED — app/fonts.ts ships a next/font/google family that
//     no --nf-* reference ever points at, a pure download for no pixels.
//
// Neither is visible in a typecheck, a unit test, or a Chromium e2e (which has
// the fallback installed and renders something plausible). So pin the two lists
// against each other.
//
// The rebrand also replaced the runtime Google Fonts CDN
// <link> with next/font/google, which downloads once at build time and serves
// the fonts from this instance — no CDN request at runtime.
//
// The last assertion is the one this file was actually written for. --sans was
// Space Grotesk, whose U+0027/U+0022 are composite glyphs built from the SAME
// component at the SAME identity transform as U+2019/U+201D — the CLOSING curly
// marks. A typed 'foo' therefore rendered as two closing curly quotes in the
// composer and read as prompt corruption. The characters were always plain
// ASCII, but "the quote glyph is a different character than the one you typed"
// is a genuinely expensive illusion in a box people type shell commands into,
// so Space Grotesk must not come back as the body/UI face by accident.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const css = readFileSync(path.join(root, "app/globals.css"), "utf8");
const layout = readFileSync(path.join(root, "app/layout.tsx"), "utf8");
const fontsSrc = readFileSync(path.join(root, "app/fonts.ts"), "utf8");
const fontPicker = readFileSync(path.join(root, "app/shell/types.ts"), "utf8");

/** Every `--nf-*` custom property declared via next/font's `variable:` option. */
function declaredFonts(): { importName: string; cssVar: string }[] {
  return [...fontsSrc.matchAll(/export const \w+\s*=\s*(\w+)\(\{[^}]*variable:\s*"(--nf-[a-z0-9-]+)"/g)].map((m) => ({
    importName: m[1],
    cssVar: m[2],
  }));
}

/** Every `--nf-*` custom property actually referenced, from CSS tokens or the font picker. */
function usedFontVars(): string[] {
  const haystack = css + fontPicker;
  return [...new Set([...haystack.matchAll(/var\((--nf-[a-z0-9-]+)/g)].map((m) => m[1]))];
}

describe("web fonts", () => {
  const loaded = declaredFonts().map((f) => f.cssVar);
  const used = usedFontVars();

  it("does not load fonts from the Google Fonts CDN at runtime", () => {
    expect(layout).not.toMatch(/fonts\.googleapis\.com/);
    expect(fontsSrc).toMatch(/from\s+"next\/font\/google"/);
  });

  it("loads every --nf-* variable referenced by CSS tokens or the font picker", () => {
    for (const cssVar of used) expect(loaded).toContain(cssVar);
  });

  it("uses every font it loads — no paid-for-but-unrendered downloads", () => {
    for (const cssVar of loaded) expect(used).toContain(cssVar);
  });

  it("does not use Space Grotesk as the body face — its ASCII quotes are the closing curly glyphs", () => {
    const bodyVarMatch = /--font-body:\s*var\((--nf-[a-z0-9-]+)/.exec(css);
    expect(bodyVarMatch, "--font-body is not declared in app/globals.css").not.toBeNull();
    const bodyFont = declaredFonts().find((f) => f.cssVar === bodyVarMatch![1]);
    expect(bodyFont?.importName).not.toBe("Space_Grotesk");
  });
});
