# website/ — calandria.dev

The project's public site. Astro, static output, **no shared code with the
app**: its own `package.json`, its own lockfile, its own Node floor, and it is
in `.dockerignore` so it never enters the image. `test.yml` and
`publish-image.yml` ignore `website/**`; `.github/workflows/website.yml` builds
and deploys it to Cloudflare Pages (project `calandria-dev`, Direct Upload).

```bash
npm ci
npm run dev      # localhost:4321
npm run build    # -> dist/
```

Node **≥22.19** — above the repo's `.nvmrc` floor of 22 because Astro 7's
dependency tree requires it, and the repo's `.npmrc` sets `engine-strict`, so
an older 22.x fails `npm ci` outright rather than warning.

## What is here

Today: one page (phase 1 of `docs/design/WEBSITE.md`) — the brand lockup, the
one-line pitch, and links to GitHub. Phase 2 adds Starlight docs at `/docs`
reading `../docs/*.md` in place; phase 3 replaces the page with the full
landing page from `docs/design/handoff/`.

## Conventions

- **The brand handoff is the source of truth.** Colors, type and the lockup
  geometry come from `docs/design/handoff/` (`README.md` for the rules,
  `styles.css` for the tokens). Cherenkov dark is the default; light arrives
  through `prefers-color-scheme`, not a picker.
- **Fonts are self-hosted woff2 in `public/fonts/`, latin subsets only** — the
  handoff forbids the Google Fonts CDN in production. They are vendored from
  the Fontsource distributions rather than installed, so the site's only npm
  dependency stays Astro; `public/fonts/OFL.txt` records provenance and
  licence. Add a face by vendoring the subset and writing the `@font-face`
  beside the others in `src/styles/tokens.css`.
- **Assets are copied, not linked.** `public/favicon.svg` and `public/og.png`
  are copies of `docs/design/handoff/assets/favicon.svg` and
  `docs/design/og.png`; Astro's `public/` cannot reach outside the project
  root. Re-copy them when the originals change.
- Keep it dependency-light. Every addition is something Dependabot will open a
  PR for and something the deploy has to install.
