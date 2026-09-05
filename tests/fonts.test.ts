// Fonts are declared in two places that can drift: a --nf-* variable used in
// globals.css or the font picker (shell/types.ts) but never declared in
// app/fonts.ts falls back to system-ui with no error, and a family declared in
// app/fonts.ts but never referenced by a --nf-* variable downloads for no
// pixels. Neither shows up in a typecheck, a unit test, or a Chromium e2e, so
// this file pins the two lists against each other.
//
// Fonts load via next/font/google: downloaded once at build time and served
// from this instance, with no runtime Google Fonts CDN link.
//
// Space Grotesk's U+0027/U+0022 are composite glyphs built from the same
// component and identity transform as U+2019/U+201D, the closing curly quote
// marks. A typed 'foo' renders as two closing curly quotes, which is
// misleading in a box people type shell commands into. Space Grotesk must not
// be the body/UI face.
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
