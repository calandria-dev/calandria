// @ts-check
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import rehypeMermaid from "rehype-mermaid";

import { remarkDocsLinks } from "./src/plugins/docs-links.mjs";
import { linkCheck } from "./src/plugins/link-check.mjs";

// calandria.dev. Two things in one build (docs/design/WEBSITE.md):
//   /      the site's own page (phase 1 placeholder; phase 3 replaces it)
//   /docs  Starlight, rendering the repo's `docs/*.md` where they live
//
// One Astro build means one Pages project, one certificate and no subpath
// proxying, which is why the docs are at /docs rather than docs.calandria.dev.
export default defineConfig({
  site: "https://calandria.dev",
  build: { inlineStylesheets: "always" },

  markdown: {
    // Astro 7 takes the Markdown pipeline through `unified({...})`; the
    // top-level `markdown.remarkPlugins` / `rehypePlugins` keys are deprecated.
    processor: unified({
      // Runs over every Markdown file; the plugin itself is scoped to the ones
      // under the repo's `docs/`.
      remarkPlugins: [remarkDocsLinks],
      rehypePlugins: [
        // Diagrams are rendered here, at build time (headless Chromium via
        // playwright), so a page needs no JavaScript to show one, nothing
        // reflows after paint, and mermaid never reaches the browser.
        //
        // One palette for both themes rather than two renders: rehype-mermaid's
        // `dark` option only exists for the `<img>` strategies, and it switches
        // on `prefers-color-scheme`, which is not what Starlight's theme picker
        // sets. So the diagram is drawn once in the brand's light palette and
        // CSS gives it a light card in both themes (`starlight.css`).
        [
          rehypeMermaid,
          {
            strategy: "inline-svg",
            mermaidConfig: {
              theme: "base",
              themeVariables: {
                // cherenkov-light, from docs/design/handoff/styles.css
                background: "#ffffff",
                primaryColor: "#e4f4f1",
                primaryBorderColor: "#0e8a7d",
                primaryTextColor: "#1a3038",
                lineColor: "#5d7d87",
                secondaryColor: "#f2f7f7",
                tertiaryColor: "#ffffff",
                fontFamily: '"Source Sans 3 Variable", system-ui, sans-serif',
              },
            },
          },
        ],
      ],
    }),
  },

  integrations: [
    starlight({
      title: "Calandria",
      description:
        "Run Claude Code and Codex in parallel across every project, from any browser.",
      favicon: "/favicon.svg",
      // `cron` and `promql` are fence languages the docs use for readability on
      // GitHub; no Shiki grammar exists for either, and without an alias every
      // build warns twice about something no doc author can fix.
      expressiveCode: {
        shiki: { langAlias: { cron: "plaintext", promql: "plaintext" } },
      },
      customCss: ["./src/styles/starlight.css"],
      components: {
        // Reuses the phase-1 logomark so the lockup tints with the theme
        // instead of shipping a second, differently-coloured copy of the SVG.
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/calandria-dev/calandria",
        },
      ],
      // "Edit page" points at the Markdown in the repo. The URL is built in
      // the route middleware rather than from `editLink.baseUrl` — see
      // src/starlightRouteData.ts for why the configured form gets it wrong.
      routeMiddleware: "./src/starlightRouteData.ts",
      // Hand-ordered: reading order, not alphabetical. Install and run it,
      // then what it does, then the reference material, then the internals.
      sidebar: [
        { label: "Overview", link: "/docs/" },
        { label: "Installation", slug: "docs/installation" },
        { label: "Self-hosting", slug: "docs/self-hosting" },
        { label: "Features", slug: "docs/features" },
        { label: "Agents", slug: "docs/agents" },
        { label: "Services", slug: "docs/services" },
        { label: "Insights", slug: "docs/insights" },
        { label: "Document collaboration", slug: "docs/document-collaboration" },
        { label: "Desktop app", slug: "docs/desktop-app" },
        { label: "Windows", slug: "docs/windows" },
        { label: "Troubleshooting", slug: "docs/troubleshooting" },
        { label: "Architecture", slug: "docs/architecture" },
        { label: "Community", slug: "docs/community" },
        { label: "Context budget", slug: "docs/context-budget" },
      ],
    }),

    // The PR gate for `docs/CLAUDE.md`'s link rule. See
    // src/plugins/link-check.mjs for why this is a local integration over
    // `dist/` rather than starlight-links-validator. The other rule,
    // front-matter `title`, is caught earlier by Starlight's content schema.
    linkCheck(),
  ],
});
