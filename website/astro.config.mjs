// @ts-check
import { defineConfig } from "astro/config";

// The placeholder site for calandria.dev (docs/design/WEBSITE.md phase 1).
// Deliberately dependency-light: one static page, no integrations, no
// framework. `site` is what makes the canonical/OG URLs absolute.
export default defineConfig({
  site: "https://calandria.dev",
  build: { inlineStylesheets: "always" },
});
