// Self-hosted Google Fonts via next/font — downloaded once at build time and
// served from this instance, no runtime CDN request (see app/layout.tsx,
// which used to <link> fonts.googleapis.com directly). Each font exposes a
// CSS custom property (its `variable`) that the token layer in globals.css
// and the per-font metadata in shell/types.ts both point at.
import {
  Spectral,
  Source_Sans_3,
  JetBrains_Mono,
  Fira_Code,
  Red_Hat_Mono,
  Atkinson_Hyperlegible_Mono,
  Literata,
  Atkinson_Hyperlegible_Next,
  Cascadia_Code,
} from "next/font/google";

// Type system: display headings + dense body UI (brand/Type System.html).
export const spectral = Spectral({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--nf-spectral",
  display: "swap",
});
export const sourceSans = Source_Sans_3({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--nf-source-sans",
  display: "swap",
});
export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  style: ["normal", "italic"],
  variable: "--nf-jetbrains-mono",
  display: "swap",
});

// User-selectable code/terminal alternates (Settings → Appearance, once that
// picker lands — see shell/types.ts MonoFontId).
export const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--nf-fira-code",
  display: "swap",
});
export const redHatMono = Red_Hat_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--nf-red-hat-mono",
  display: "swap",
});
export const atkinsonMono = Atkinson_Hyperlegible_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--nf-atkinson-mono",
  display: "swap",
});
export const cascadiaCode = Cascadia_Code({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--nf-cascadia-code",
  display: "swap",
});

// User-selectable prompt-input alternates (shell/types.ts PromptFontId).
export const literata = Literata({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--nf-literata",
  display: "swap",
});
export const atkinsonNext = Atkinson_Hyperlegible_Next({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--nf-atkinson-next",
  display: "swap",
});

// All .variable classNames joined — applied together to <html> in layout.tsx
// so every --nf-* custom property is available globally regardless of which
// font is actually selected in Appearance.
export const fontVariables = [
  spectral.variable,
  sourceSans.variable,
  jetbrainsMono.variable,
  firaCode.variable,
  redHatMono.variable,
  atkinsonMono.variable,
  cascadiaCode.variable,
  literata.variable,
  atkinsonNext.variable,
].join(" ");
