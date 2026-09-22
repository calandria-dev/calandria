// The three default fonts are vendored in the repository and loaded with
// next/font/local. Optional picker fonts use system fallbacks so production
// builds do not depend on a Google Fonts response being available.
import localFont from "next/font/local";

// Type system: display headings + dense body UI (brand/Type System.html).
export const spectral = localFont({
  src: [{
    path: "./fonts/spectral-500-latin.woff2",
    weight: "500",
    style: "normal",
  }],
  variable: "--nf-spectral",
  display: "swap",
});
export const sourceSans = localFont({
  src: [{
    path: "./fonts/source-sans-3-variable-latin.woff2",
    weight: "200 900",
    style: "normal",
  }],
  variable: "--nf-source-sans",
  display: "swap",
});
export const jetbrainsMono = localFont({
  src: [{
    path: "./fonts/jetbrains-mono-variable-latin.woff2",
    weight: "100 800",
    style: "normal",
  }],
  variable: "--nf-jetbrains-mono",
  display: "swap",
});

// User-selectable code/terminal alternates (Settings → Appearance, once that
// picker lands; see shell/types.ts MonoFontId).
export const firaCode = { variable: "--nf-fira-code" } as const;
export const redHatMono = { variable: "--nf-red-hat-mono" } as const;
export const atkinsonMono = { variable: "--nf-atkinson-mono" } as const;
export const cascadiaCode = { variable: "--nf-cascadia-code" } as const;

// User-selectable prompt-input alternates (shell/types.ts PromptFontId).
export const literata = { variable: "--nf-literata" } as const;
export const atkinsonNext = { variable: "--nf-atkinson-next" } as const;

// Local font classNames joined, applied together to <html> in layout.tsx.
// Optional fallback variables are declared globally in globals.css.
export const fontVariables = [
  spectral.variable,
  sourceSans.variable,
  jetbrainsMono.variable,
].join(" ");
