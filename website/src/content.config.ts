import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

import { docEntryId } from "./plugins/docs-links.mjs";

// The docs are the repo's own `docs/*.md`, read where they live. Nothing is
// copied or generated into `website/` — the Markdown stays the source of truth,
// stays GitHub-renderable, and this site is a rendered mirror of it.
//
// `pattern` is deliberately top level only: `docs/design/` (decision records)
// and `docs/superpowers/` (agent tooling) are internal and must not publish.
// `CLAUDE.md` is excluded for the same reason — it is instructions to agents
// working in that directory, not a page.
//
// `generateId` is what mounts the collection under `/docs` — Starlight routes
// an entry at its id, so `SELF_HOSTING.md` -> `docs/self-hosting` ->
// `/docs/self-hosting/`, leaving `/` to the site's own landing page. The slug
// half is shared with the remark rewriter so the links it emits and the routes
// built here cannot drift.
export const collections = {
  docs: defineCollection({
    loader: glob({
      base: "../docs",
      pattern: ["*.md", "!CLAUDE.md"],
      generateId: ({ entry }) => docEntryId(entry),
    }),
    schema: docsSchema(),
  }),
};
