// Fonts are declared in two places that can drift silently, and both failure
// directions have already happened here:
//
//   - USED BUT NOT LOADED — rename the family in --sans without touching the
//     <link> and every glyph quietly falls back to system-ui. Nothing errors;
//     the app just stops looking like itself on the machines that lack it.
//   - LOADED BUT NOT USED — the app shipped five weights of Hanken Grotesk
//     referenced by no rule at all, a pure download for no pixels.
//
// Neither is visible in a typecheck, a unit test, or a Chromium e2e (which has
// the fallback installed and renders something plausible). So pin the two lists
// against each other.
//
// The third assertion is the one this file was actually written for. --sans was
// Space Grotesk, whose U+0027/U+0022 are composite glyphs built from the SAME
// component at the SAME identity transform as U+2019/U+201D — the CLOSING curly
// marks. A typed 'foo' therefore rendered as two closing curly quotes in the
// composer and read as prompt corruption. The characters were always plain
// ASCII, but "the quote glyph is a different character than the one you typed"
// is a genuinely expensive illusion in a box people type shell commands into,
// so Space Grotesk must not come back as the UI face by accident.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const css = readFileSync(path.join(root, "app/globals.css"), "utf8");
const layout = readFileSync(path.join(root, "app/layout.tsx"), "utf8");

/** Families named in a `--sans:` / `--mono:` custom property, quoted ones only. */
function familiesInVar(name: string): string[] {
  const decl = new RegExp(`--${name}\\s*:([^;]+);`).exec(css);
  if (!decl) throw new Error(`--${name} is not declared in app/globals.css`);
  return [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Families requested from the Google Fonts stylesheet in app/layout.tsx. */
function familiesLoaded(): string[] {
  const href = /fonts\.googleapis\.com\/css2\?([^"]+)/.exec(layout);
  if (!href) throw new Error("no Google Fonts <link> found in app/layout.tsx");
  return [...href[1].matchAll(/family=([^:&]+)/g)].map((m) => decodeURIComponent(m[1]).replace(/\+/g, " "));
}

describe("web fonts", () => {
  const loaded = familiesLoaded();
  const used = [...familiesInVar("sans"), ...familiesInVar("mono")];

  it("loads every family the CSS variables name", () => {
    for (const family of used) expect(loaded).toContain(family);
  });

  it("uses every family it loads — no paid-for-but-unrendered downloads", () => {
    for (const family of loaded) expect(used).toContain(family);
  });

  it("does not use Space Grotesk as the UI face — its ASCII quotes are the closing curly glyphs", () => {
    expect(familiesInVar("sans")).not.toContain("Space Grotesk");
  });
});
