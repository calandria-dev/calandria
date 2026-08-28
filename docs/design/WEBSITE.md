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

Hosting recheck (2026-08-27, phase 0): Pages is **not** deprecated and still ships
changes (Aug 11, 2026 changelog), but Cloudflare's Pages "Get started" page now
opens with "Start new projects with Workers", and Workers static assets has had
per-PR/per-branch preview URLs since Jul 2025 — the one Pages feature this plan
picked it for. Plan left as-is per phase 0's scope; see **Cloudflare access** below
for the open decision.

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

## Cloudflare access

Phase 0 verification, 2026-08-27. **Phase 1 reads this first.** All of it is
resolved against the live Cloudflare API.

| Fact | Value |
|-|-|
| Plugin | `cloudflare@cloudflare` installed at user scope; skills `cloudflare:cloudflare` and `cloudflare:wrangler` load. |
| Account id | `365e44a751a27479fb20a7066ca874f7` ("Penmoid@gmail.com's Account"). This is the `CLOUDFLARE_ACCOUNT_ID` repo secret in Phase 1 step 7. |
| `calandria.dev` zone | **`active`** — id `64c3202908d17e59c49e0959c789d7cd`, type full, Free plan, activated 2026-08-28T01:54:45Z on `clyde.ns.cloudflare.com` / `mona.ns.cloudflare.com`. Phase 1 console steps 1–3 are **done**; start at step 4. |
| DNS records | **The zone is empty** — zero records on the Cloudflare side, and the outgoing DreamHost zone served nothing but SOA/NS (no A, MX, TXT, CAA, no `www`). So step 1's "note every existing record first" has nothing to preserve, and step 1's CAA hazard does not apply: there is no CAA record to block Cloudflare's issuance. `calandria.dev` currently resolves to nothing until Pages attaches the custom domain. |
| Pages project name | **`calandria-dev` is free** — the account has no Pages projects at all. |
| MCP servers authorized | `cloudflare-docs` (public, no OAuth) and `cloudflare-api` (OAuth, 2026-08-27). `cloudflare-bindings`, `cloudflare-builds`, `cloudflare-observability` are still unauthorized; none of them is needed for a static Pages deploy, so Phase 1 is not blocked on them. |
| GitHub secrets | `CLOUDFLARE_API_TOKEN` is set on `calandria-dev/calandria` (2026-08-28T02:04Z); its scopes are unverifiable from outside, so a 403 on the first `pages deploy` means Account → Cloudflare Pages → Edit is missing. **`CLOUDFLARE_ACCOUNT_ID` is not set yet** — it is not a secret, so a repo variable is fine, but the workflow must reference whichever one is used. |
| Local `wrangler` | Not installed on this host, so there are no local Cloudflare credentials to fall back on; the GitHub Actions deploy uses the repo credentials above as planned. |

Authorizing an OAuth MCP server from an agent session on this headless host: run
`script -qefc "claude mcp login '<server>'" /tmp/x.log` (the PTY is what the CLI
requires; without it the flow aborts on "stdin isn't a terminal"), read the
authorization URL out of the log, then open it in a browser on another machine with
`ssh -N -L 3118:localhost:3118 <host>` forwarding the callback port. No code is ever
pasted back. Credentials land in `~/.claude`, so later task sessions inherit them —
but a session that was already running when the grant landed will not have the
server's tools; reach them through a one-shot `claude -p --allowedTools
"mcp__plugin_cloudflare_cloudflare-api"` subprocess instead, which is how the values
in this table were read.

**Pages vs Workers static assets** (asked of `cloudflare-docs`, 2026-08-27): Pages is
alive and still shipping features, but Cloudflare now steers new static projects to
Workers — `/pages/get-started/` (updated Aug 21, 2026) carries "Workers supports most
Pages use cases and offers a broader feature set… Start new projects with Workers",
and the Workers best-practices page says the same. The plan's stated reason for Pages
(free per-PR preview URLs) is no longer a differentiator: Workers has branch and
commit preview URLs, and Workers custom domains want the zone on Cloudflare, which
this plan does anyway. Nothing here forces a change and the phase-1 plan is unchanged,
but if the decision is revisited it should be **before** phase 1 creates the project —
a later switch is a migration (`wrangler.jsonc` with `assets.directory`, plus the
`pages deploy` step in `website.yml` becoming `wrangler deploy`).

## Phase 1 — placeholder with a valid certificate

`.dev` is on the Chromium HSTS preload list as a whole TLD: browsers refuse plain
HTTP for it, always. There is no "HTTP while the cert is pending" interim — DNS
must not point at anything that lacks a trusted cert. Today's parked page is
already the failure mode.

Console steps (user). **Steps 1–3 are done as of 2026-08-28T01:54Z — the zone is
active; start at step 4.** They are kept for the record.

1. DreamHost → Manage Domains → calandria.dev → note every existing DNS record
   (MX/TXT/CAA especially) before touching anything. If a CAA record exists, add
   `issue` entries for `letsencrypt.org`, `pki.goog`, `ssl.com` or Cloudflare's
   issuance silently fails. — Moot: the domain was parked with an empty zone.
2. Cloudflare → Add site → `calandria.dev` (Free plan). Accept the scanned
   records, re-add any it missed from step 1. **Already done** — the zone exists and
   is `pending`; see Cloudflare access above.
3. DreamHost → Nameservers → "I'll use my own" → the two Cloudflare nameservers
   (`clyde.ns.cloudflare.com`, `mona.ns.cloudflare.com`). This is the step the zone
   is waiting on. Propagation: DreamHost says hours; usually under one.
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

### Phase 1 outcome (2026-08-28)

**Repo side: done.** `website/` (Astro 7, one page, one dependency),
`.github/workflows/website.yml`, and the hygiene items below. `website/README.md`
is the working doc for phases 2 and 3.

**Cloudflare side: still steps 4–6 above, unchanged.** The phase-1 session had
the `cloudflare-api` MCP server and could read the account freely, but every
WRITE was refused by the Claude Code auto-mode classifier (creating a Pages
project, attaching a domain, editing a ruleset are all outward-facing changes to
a live account). Nothing was created. State read from the API at the time, so
the console steps can be checked against it:

| Fact | Value |
|-|-|
| Pages projects on the account | **none** — `calandria-dev` is still free |
| `calandria.dev` zone | `active`, Free plan |
| DNS records in the zone | **zero** — the apex still resolves to nothing |
| SSL/TLS mode | **`full`, not `full` (strict)** — step 6 is a real change, not a confirmation |

Because no Pages project exists yet, the **Pages vs Workers static assets**
decision recorded above is still open — the "revisit it before phase 1 creates
the project" window has not closed. Switching now costs a `wrangler.jsonc` and
one line of `website.yml`; switching after costs a migration.

What phase 1 learned, beyond the plan:

- **Node floor.** Astro 7 needs Node ≥22.12 and its dependency tree (undici 8)
  needs ≥22.19, so `website/package.json` declares `>=22.19` — above `.nvmrc`'s
  `22`, which is fine in CI (`setup-node` resolves the latest 22.x) but means a
  host on an older 22.x cannot `npm ci` the site. The repo's `.npmrc` sets
  `engine-strict` and **applies to `website/` too**, so that is a hard failure
  with a clear message rather than a warning.
- **Fonts are vendored, not depended on.** `@fontsource/*` would have been two
  npm dependencies and a Vite-emitted asset graph to get two woff2 files; the
  latin subsets are copied into `website/public/fonts/` instead, with
  provenance and the OFL notice in `public/fonts/OFL.txt`. Site dependency
  count: one (Astro).
- **`public/` cannot reach outside the project root**, so `favicon.svg` and
  `og.png` are copies of the handoff originals, not links. Re-copy on change.
- **`wrangler-action` is pinned to v4.0.0, not the v3 the plan named.** v4's
  only change is defaulting the installed Wrangler to v4; staying on v3 would
  have meant pinning `wranglerVersion` by hand — a second version to rot.
- **`tsconfig.json` had to exclude `website`.** Its `include` is `**/*.ts`, and
  its `exclude` is relative to the repo root, so `website/node_modules` would
  otherwise have been dragged into `npm run typecheck`.
- **`.dev` HSTS, restated as an ordering rule**: attach the custom domains
  (step 4) and let Cloudflare issue the cert BEFORE anyone links to the site.
  Pages serves a valid certificate from the moment the domain is attached, even
  with no deployment behind it, so the order in this plan is safe — what is not
  safe is any DNS record pointing anywhere else.

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

All of these landed in phase 1.

- `release-please-config.json`: `"exclude-paths": ["website"]` on the root package
  so site-only commits don't land in the release PR. Known quirks
  (release-please #2301) — verify against the next real release PR rather than
  trusting the config.
- `test.yml` and `publish-image.yml`: `paths-ignore: [website/**]` on their
  `push`/`pull_request` triggers, so a site-only PR spends neither the Windows
  lanes nor a multi-arch container build; `website.yml` runs the site build
  instead. Note the filter skips only when EVERY changed file is under
  `website/`, so a mixed PR still runs the full gate. `test-shuffle.yml` and
  `security-scan.yml` need nothing — both are `schedule`-only, and a path filter
  has no meaning on a cron trigger.
- Dependabot: `/website` is added as the file's one npm ecosystem, grouped into
  a single weekly PR. This is a deliberate exception to that file's blanket npm
  exclusion, because nothing else watches the site — both `npm audit` runs are
  against the root lockfile, and `test.yml` now ignores `website/**` outright.
- `.dockerignore`: `website` excluded from the image context.
- `tsconfig.json`: `website` added to `exclude` (see the phase-1 outcome above).

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
