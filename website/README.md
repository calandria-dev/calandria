# website/ — calandria.dev

The project's public site. Astro, static output, **no shared code with the
app**: its own `package.json`, its own lockfile, its own Node floor, and it is
in `.dockerignore` so it never enters the image. `test.yml` and
`publish-image.yml` ignore `website/**`; `.github/workflows/website.yml` builds
and deploys it to Cloudflare Pages (project `calandria-dev`, Direct Upload).

```bash
npm ci
npx playwright install --only-shell chromium   # once; build-time mermaid
npm run dev      # localhost:4321
npm run build    # -> dist/
```

Node **≥22.19** — above the repo's `.nvmrc` floor of 22 because Astro 7's
dependency tree requires it, and the repo's `.npmrc` sets `engine-strict`, so
an older 22.x fails `npm ci` outright rather than warning.

## What is here

- `/` — the phase-1 placeholder: brand lockup, one-line pitch, and two links
  (docs, GitHub). Phase 3 of `docs/design/WEBSITE.md` replaces it with the full
  landing page.
- `/docs` — Starlight, rendering the repo's `docs/*.md` **where they live**.

## The docs at /docs

The Markdown is not copied, generated or moved. `src/content.config.ts` points a
`glob()` loader at `../docs` with the pattern `["*.md", "!CLAUDE.md"]` — top
level only, so `docs/design/` (decision records) and `docs/superpowers/` (agent
tooling) stay internal — and `generateId` prefixes each entry with `docs/`, which
is what mounts the collection at `/docs/` and leaves `/` to the landing page.
`SELF_HOSTING.md` becomes `/docs/self-hosting/`: lowercased, underscores to
hyphens, because file names are a GitHub convention and URLs are not.

**The files stay GitHub-renderable, and that is the constraint everything else
bends around.** Two consequences, both stated for agents in `docs/CLAUDE.md`:

- Every `docs/*.md` carries a three-line front-matter `title`. Starlight
  requires it; GitHub renders it as a small table. The file's own `# H1` stays
  in place and is dropped from the render (it would otherwise print twice).
- Links stay relative and GitHub-correct.
  `src/plugins/docs-links.mjs` re-points them at build time: a sibling doc
  becomes `/docs/<slug>/`, anything that leaves `docs/` becomes a
  `github.com/…/blob/main/…` link. Images under `docs/images/` are left alone —
  Astro resolves and optimizes them from the Markdown file's own location.

`src/plugins/link-check.mjs` is the gate that keeps this honest: after the build
it walks `dist/`, collects every page's anchors, and fails if an internal link
points at a page or a fragment that isn't there. It is a local integration
rather than `starlight-links-validator` because that plugin identifies a page by
`path.relative(<srcDir>/content/docs, <file>)` — our Markdown is outside the
Astro project, so every doc came back as `../../../docs/…`, nothing matched, and
all 35 internal links were reported invalid. Checking `dist/` sidesteps the
assumption and covers more: rendered anchors, the hand-written `/docs/` index,
and anything else the build emits. External links are deliberately not checked —
a build that reaches the network fails for reasons unrelated to the commit.

Mermaid fences render at **build time** (`rehype-mermaid`, `inline-svg`), so a
diagram needs no JavaScript in the browser. That costs a headless Chromium in
CI; `website.yml` installs the shell only. There are no mermaid fences in
`docs/` today — the support is here so the first one works.

Search is Pagefind, Starlight's default, built from `dist/` at the end of every
build.

## Conventions

- **The brand handoff is the source of truth.** Colors, type and the lockup
  geometry come from `docs/design/handoff/` (`README.md` for the rules,
  `styles.css` for the tokens). Cherenkov dark is the default. The landing page
  takes light from `prefers-color-scheme` (`src/styles/tokens.css`); the docs
  take it from Starlight's picker, which writes `[data-theme]`, so
  `src/styles/starlight.css` maps the same palette onto Starlight's `--sl-*`
  ramp instead. `src/styles/fonts.css` holds the `@font-face` rules both import.
- **Fonts are self-hosted woff2 in `public/fonts/`, latin subsets only** — the
  handoff forbids the Google Fonts CDN in production. They are vendored from
  the Fontsource distributions rather than installed; `public/fonts/OFL.txt`
  records provenance and licence. Add a face by vendoring the subset and
  writing the `@font-face` beside the others in `src/styles/fonts.css`.
- **Assets are copied, not linked.** `public/favicon.svg` and `public/og.png`
  are copies of `docs/design/handoff/assets/favicon.svg` and
  `docs/design/og.png`; Astro's `public/` cannot reach outside the project
  root. Re-copy them when the originals change. The logomark is the exception:
  `src/components/Logomark.astro` inlines it so it tints with `currentColor`,
  which is also why `SiteTitle.astro` overrides Starlight's own logo slot rather
  than using the `logo` option (that renders an `<img>`).
- Keep it dependency-light. Every addition is something Dependabot will open a
  PR for and something the deploy has to install.
