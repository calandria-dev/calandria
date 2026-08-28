# calandria.dev — website and docs plan

Decision record for how `calandria.dev` is served and how the docs are published.
Both live in this repo. Research basis: a 27-project survey of self-hosted OSS
sites, a docs-generator comparison against our actual `docs/` tree, the hosting /
DNS / TLS mechanics for a `.dev` domain parked at DreamHost, and monorepo-vs-
separate-repo deploy patterns (August 2026; sources at the end).

## Decisions

| Question | Decision | Why |
|-|-|-|
| DNS | Keep registration at DreamHost; delegate nameservers to Cloudflare | Documented DreamHost path, no "DNS Only" dance, free CNAME flattening at the apex, redirect rules, CAA handling. Registrar transfer is optional and separate (ICANN 60-day lock may apply). |
| Hosting | Cloudflare Pages, one project | Apex needs the zone on Cloudflare anyway; free PR-preview URLs (GitHub Pages has none, and its cert issuance can take a day); no vendor builder needed. |
| Deploy | GitHub Actions → `cloudflare/wrangler-action` (`pages deploy`) | Keeps the deploy a workflow in this repo like every other release step, and lets `paths:` filters decide when it runs. Cloudflare's own Git builder is the fallback if the token setup annoys. |
| Repo layout | `website/` in this repo; docs stay in `docs/` | Docs are edited by agents inside feature PRs; keeping them here keeps that atomic (Immich, Supabase, Authentik, Zitadel, Karakeep all do this). A separate site repo would have to check out this one at build time and be poked by cross-repo dispatch on every docs change. |
| Site framework | Astro | Brand handoff (`docs/design/handoff/`) is a bespoke high-fidelity design; Astro renders it as static HTML with no framework tax. Coolify, Dify, Karakeep, Gitea use it. |
| Docs generator | Astro **Starlight**, mounted at `calandria.dev/docs`, reading `../docs/*.md` in place | Same build as the marketing site — one Pages project, one cert, no subpath proxying (Pages can't mount a second project under a path). `.md` stays CommonMark (no MDX brace hazard; `docs/` has 10 `{…}`-in-code cases that would break Docusaurus/Nextra defaults). Pagefind search built in, no third-party account. |
| Docs URL shape | Subpath `/docs`, not `docs.calandria.dev` | Falls out of the single build. Survey split 12 subdomain / 9 subpath — no convention to follow, so the simpler ops win. |
| Versioning | None; docs track `main` | One rolling image, no LTS branches. Per-release snapshots (Docusaurus-style) mean back-porting every typo fix. Revisit only if a v1/v2 split ever happens. |

Runner-up for docs: **VitePress**. It handles GitHub-flavoured Markdown slightly
better out of the box (no mandatory front-matter, rewrites relative `.md` links,
renders `> [!NOTE]` alerts), but it is a second framework and a second build, which
forces `docs.calandria.dev`. Switch to it if Starlight's Markdown friction (below)
turns out to be more than the two items listed.

Rejected: Docusaurus (MDX-by-default for `.md`; opt-out exists but every agent has
to know it; Infima look fights the brand), Mintlify/GitBook (hosted-only, wrong
fit for a self-hosted product; Coolify reports leaving Mintlify over a surprise
bill), MkDocs Material/Zensical (Python in the build loop), Fumadocs/Nextra
(Next.js-native is not a reason to run Next for a static site; MDX default).

## Phase 1 — placeholder with a valid certificate

`.dev` is on the Chromium HSTS preload list as a whole TLD: browsers refuse plain
HTTP for it, always. There is no "HTTP while the cert is pending" interim — DNS
must not point at anything that lacks a trusted cert. Today's parked page is
already the failure mode.

Console steps (user; nothing here is agent-doable):

1. DreamHost → Manage Domains → calandria.dev → note every existing DNS record
   (MX/TXT/CAA especially) before touching anything. If a CAA record exists, add
   `issue` entries for `letsencrypt.org`, `pki.goog`, `ssl.com` or Cloudflare's
   issuance silently fails.
2. Cloudflare → Add site → `calandria.dev` (Free plan). Accept the scanned
   records, re-add any it missed from step 1.
3. DreamHost → Nameservers → "I'll use my own" → the two Cloudflare nameservers.
   Propagation: DreamHost says hours; usually under one.
4. Cloudflare → Workers & Pages → create the Pages project (Direct Upload; the
   workflow in this repo deploys into it). Custom domains: `calandria.dev` and
   `www.calandria.dev` — Cloudflare writes the flattened CNAMEs itself.
5. Cloudflare → Rules → Redirect Rules: `www.calandria.dev/*` → `https://calandria.dev/$1`, 301.
6. Cloudflare → SSL/TLS: Full (strict) and HSTS on (`.dev` is preloaded anyway,
   the header just makes the intent explicit).
7. GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (Account → Cloudflare Pages →
   Edit) and `CLOUDFLARE_ACCOUNT_ID`.
8. GitHub → repo → About → Website: `https://calandria.dev`.

Repo side (task): `website/` Astro project whose only page is the brand lockup,
one-line pitch, and links to GitHub and the README, plus
`.github/workflows/website.yml` (deploy on `main` when `website/**` or `docs/**`
change; preview deploy on PRs). Registrar transfer to Cloudflare is a later,
optional step: check the registration date first (60-day ICANN lock), and wait
45 days after any DreamHost renewal or the transfer year is forfeited.

## Phase 2 — docs site

- Starlight content collection with a custom `glob()` loader over `../docs/*.md`
  (top level only — `docs/design/` and `docs/superpowers/` are internal and stay
  unpublished). `README.md` becomes the docs landing page or is linked, not
  duplicated.
- Two Markdown frictions to absorb, both enforced by the site build running in PR
  CI so an agent finds out in the same PR:
  - Starlight requires a `title` in front-matter on every page. Add a three-line
    front-matter block to each `docs/*.md`; GitHub renders it as a small table and
    otherwise ignores it.
  - Relative links: `SELF_HOSTING.md#run-locally` must become `/docs/self_hosting#run-locally`
    and links that leave `docs/` (`../.env.example`, `../scripts/backup.mjs`, …)
    must become `https://github.com/calandria-dev/calandria/blob/main/…`. One
    small remark plugin in `website/` does both; the source files keep their
    GitHub-correct relative links.
- Mermaid: three fenced blocks today (`FEATURES.md`, `DOCUMENT_COLLABORATION.md`) —
  a remark-mermaid plugin, rendered at build time.
- Theme Starlight with the handoff tokens: Spectral / Source Sans 3 / JetBrains
  Mono (self-hosted woff2, per the handoff), cherenkov dark as default, light
  variant, `#45cabb` accent. Logomark from `docs/design/handoff/assets/`.
- A short `docs/CLAUDE.md` telling agents the two rules (front-matter title, keep
  links relative) so they don't learn them from a red build.
- README links (`docs/SELF_HOSTING.md` etc.) keep pointing at the repo; the site
  is the rendered mirror, GitHub stays a first-class reader.

## Phase 3 — full marketing site

Skeleton common to Coolify / Dokploy / Homarr / Docmost / Open WebUI landing
pages, in order: hero with one-line pitch + subhead framed against what it
replaces; two CTAs (Get started → docs install page, GitHub); product screenshot
(`docs/images/workspace.png` to start; the handoff `ui/` mockups are the design
reference); a copy-able install snippet (`docker run …` from the README); feature
grid of 6–9 cards; a stats/social-proof line (stars, image pulls) rendered as
text, not a live badge; footer with Docs / GitHub / Discussions / Security.
OG image already exists (`docs/design/og.png`).

## Repo hygiene the site adds

- `release-please-config.json`: `"exclude-paths": ["website"]` on the root package
  so site-only commits don't land in the release PR. Known quirks
  (release-please #2301) — verify against the next real release PR rather than
  trusting the config.
- `test.yml` and friends: `paths-ignore: [website/**]` so a site-only PR doesn't
  spend the full e2e matrix; `website.yml` runs the site build instead.
- Dependabot/Renovate: group the `website/` ecosystem so its `package.json`
  doesn't double the PR queue.
- `Dockerfile` / `.dockerignore`: exclude `website/` from the image context.

## Sources

Survey and mechanics were gathered by research agents in Aug 2026; the
load-bearing ones:

- HSTS preload: https://hstspreload.org/
- DreamHost DNS records and the "DNS Only" prerequisite: https://help.dreamhost.com/hc/en-us/articles/360035516812
- DreamHost nameserver change: https://help.dreamhost.com/hc/en-us/articles/360038897151
- Cloudflare Registrar FAQ (60-day lock, own nameservers required): https://developers.cloudflare.com/registrar/faq/
- Cloudflare Pages custom domains + CAA: https://developers.cloudflare.com/pages/configuration/custom-domains/
- Pages vs Workers static assets matrix (Pages lacks non-root routes): https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/
- Pages deploy from CI: https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/
- GitHub Pages custom domains (org-site inheritance, 24h HTTPS): https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages
- Starlight config / front-matter (`title` required): https://starlight.astro.build/reference/frontmatter/
- Astro `glob()` loader with an external `base`: https://docs.astro.build/en/reference/content-loader-reference/
- Docusaurus `.md` parsed as MDX by default: https://docusaurus.io/docs/markdown-features
- VitePress markdown handling: https://vitepress.dev/guide/markdown
- Immich docs-in-monorepo workflow: https://github.com/immich-app/immich/blob/main/.github/workflows/docs-build.yml
- release-please `exclude-paths` quirk: https://github.com/googleapis/release-please/issues/2301
- Starlight versioning discussion (Arcjet went branch-based): https://github.com/withastro/starlight/discussions/957
