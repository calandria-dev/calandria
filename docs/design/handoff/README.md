# Handoff: Calandria rebrand & UI revamp

## Overview
Complete visual identity and UI revamp for **Calandria**, a self-hosted web control room for coding agents (parallel Claude Code / Codex sessions, one git worktree per task). Replaces the inherited "Operator" identity (blue ring glyph, blue/purple accents, grey darks) with a new mark, wordmark, type system, color system, and full-surface mockups. Settled with the product owner over multiple review rounds — all decisions below are final.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, NOT production code to copy directly. The task is to **recreate these designs in the target codebase** (Next.js / React — see Pointers below) using its established patterns. `ui/chrome.js` and the inline mockup JS exist only to render the mockups; reimplement equivalents natively.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and copy are final. Recreate pixel-perfectly. The one deliberately-mocked area: session data is fake; wire to real state.

## Target codebase pointers (from the design brief)
- Wordmark markup: `app/Shell.tsx` (~line 400)
- Glyph + theme tokens: `app/globals.css` (`tb-logo` block; `--calandria` at lines 42 and 124)
- Onboarding lockup: `app/shell/OnboardingWizard.tsx`
- Page metadata / favicon: `app/layout.tsx`, `public/`

## Identity (brand/Identity.html)
- **Logomark**: `assets/logo.svg` — 3×3 isometric lattice of control rods, radial opacity fade from raised center rod (opacities 1 / .55 / .3), each rod standing in a thin open "channel ring". Single color via `currentColor`; tint with CSS. viewBox `4.78 6.6 14.45 17.23`. No raster.
- **Small sizes**: below 14px use `assets/favicon-small.svg` (center rod + ring only). `assets/favicon.svg` is the full mark with baked-in `#45cabb` for favicon use at 16px+.
- **Wordmark**: `Calandria` — Spectral 500, title case (never all-caps in the lockup), `letter-spacing:.005em`.
- **Lockup**: glyph height = **1.7× the wordmark cap height** (cap height ≈ 0.72 × font-size), optically centered on the text midline; gap = **0.3× font-size**. Titlebar: 14px wordmark + 17.5px glyph.
- The old ring/arc/core glyph (`tb-ring`, `tb-arc`, `tb-core`) and all Operator purples are removed entirely.

## Type system (brand/Type System.html)
- `--font-display`: **Spectral** (Georgia fallback), weight 500, tracking −0.005em — page titles + section headers ONLY, never below 18px.
- `--font-body`: **Source Sans 3** (system-ui fallback) — all dense UI: rows, chips, labels, controls, card titles.
- `--font-mono`: **JetBrains Mono** (ui-monospace fallback) — code, terminal, diffs, metadata. Default.
- **User-selectable code/terminal fonts** (Settings → Appearance): JetBrains Mono (default), Fira Code, Cascadia Code, Red Hat Mono, Atkinson Hyperlegible Mono.
- **User-selectable prompt-input fonts**: Source Sans 3 (default), Literata, Spectral, Atkinson Hyperlegible Next.
- **Ship fonts self-hosted as woff2** — do not use the Google Fonts CDN in production (the mockups' `@import` is preview-only).

## Design tokens (styles.css — copy verbatim)
Four themes, each dark + light, switched via `[data-theme]`; **cherenkov-dark is the `:root` default**. Per theme: `--bg --panel --line --ink --dim --accent --calandria --term --run-bg --run --rev-bg --rev --err --warn --s1..--s5`.

Cherenkov dark (default): bg `#081217` · panel `#0d1b22` · line `#1a2f39` · ink `#d5e4ea` · dim `#7e9aa6` · accent/calandria `#45cabb` · term `#060e12` · run `#4ecfb2` on `#0e2e2b` · rev `#d3b054` on `#33290f` · err `#e0687a` · warn `#d3b054` · series `#5f8dff #e0b64b #e0687a #9d7bff #7e97a3`.
Cherenkov light: bg `#f2f7f7` · panel `#ffffff` · line `#d7e4e4` · ink `#1a3038` · dim `#5d7d87` · accent `#0e8a7d` · err `#b83a52` · warn `#7d621a` · series `#2f66c9 #8a6a12 #b83a52 #6e46c9 #5d7d87`.
Also in styles.css: heavywater, denoche, basic (dark+light each). `--calandria` is the chart hue labelling Calandria's own work; it must stay distinguishable from `--s1..--s5`.

Spacing/radii used throughout: cards `border-radius:10px` (12px onboarding, 11px mobile), pills `99px`, buttons `6–8px`; card padding `13px 15px`; page gutter `20–24px`; grid gaps `10–16px`. Type scale: 34/24/20/15/14/13/12.5/11.5/11/10.5px (dashboard floor ~10.5px, mono metadata 11px).

## Screens (ui/)
Every screen: shared titlebar (glyph + wordmark + tabs Board/Diffs/Terminals/Insights + right meta + accent "New session" button); active tab gets `--panel` bg + `inset 0 -2px 0 var(--accent)`.

- **Board.html / Board Light.html** — 3 columns (Running / Needs review / Idle-queued), `grid gap:16px`. Cards: name, agent pill (mono 10.5px, 99px border pill), worktree branch (mono 11px dim), current activity line, footer (diff +/− in mono, elapsed, sparkline for running / action buttons otherwise). Running cards get an accent inner border at 35% opacity + 6px glowing pulse dot. Column headers: 11.5px uppercase, letterspaced, colored dot per status.
- **Diffs.html** — 250px file rail (active file: panel bg + `inset 2px 0 0 var(--accent)`) + main pane. Header: session name (Spectral 20px), meta (mono), Unified/Split segmented toggle (working in mockup), "Request changes" (err-tinted outline) + "Merge session" (accent primary). Diff: mono 12px/1.75, add rows `color-mix(var(--run) 12%)`, del rows `color-mix(#e0687a 12%)`, dual line-number gutters. Comment box posts to the agent ("Send to agent" primary / "Comment only" ghost).
- **Terminals.html** — 2×2 pane grid; focused pane: accent border + `0 0 22px -8px` accent glow, and only it receives keys. Pane bar: session, agent pill, live status. Output styling: prompt/tool bullets accent, success `--run`, errors `--err`, dim context. Input row with blinking 7×15px accent caret (honor reduced-motion).
- **Insights.html** — stacked bars (merged/day by agent), token lines, per-session table (uppercase 11px th, mono numerals). Chart series MUST read tokens `--s1..--s5` + `--calandria`; calandria series is bold in legends with ink-colored label.
- **Onboarding.html** — centered 520px wizard; brand block: 68.5px glyph + 56px wordmark + tagline "One vessel, many channels — your agent fleet, from any browser."; step progress = 3px bars; inputs mono on `--term` bg.
- **Settings.html** — 210px section nav (same active treatment as file rail); Appearance: theme cards (swatch preview + active accent ring), radio rows for code/terminal font and prompt input font, each row previews in its own typeface. Labels say **font**, not face.
- **Mobile Board.html** — 390px, **M1 chosen**: bottom tab bar (4 items, ≥44px targets, active = accent), single scrolling list grouped by status headers, same card anatomy compressed. All mobile hit targets ≥44px.
- **States.html** — Empty board: dashed-border panel, 56px dim glyph, Spectral "No sessions yet", primary CTA + `n` shortcut hint. Errored card: err-mixed border, "errored" chip, mono error log excerpt, Retry turn / Open terminal / Discard. Conflict card: warn-mixed border, "conflict" chip, Ask agent to rebase / Resolve manually. Focus: `outline:2px solid var(--accent); outline-offset:2px` on ALL interactive elements incl. cards — never `outline:none`. Keyboard: `j/k` move, `enter` open, `t` terminal, `d` diff, `n` new.

## Interactions & behavior
- Tabs navigate the four surfaces; links use accent color (define `a`/`a:hover`).
- Pulse dots: 6px, accent, `box-shadow 0 0 6-7px accent`; caret blink `1.1s steps(1)`; both disabled under `prefers-reduced-motion` (global rule already in styles.css).
- Theme follows OS unless pinned in Settings; every theme has matched light variant.
- Diff unified/split is a client toggle; review comments are sent to the agent as feedback for its next turn.

## Assets
- `assets/logo.svg` (currentColor mark), `assets/favicon.svg` (teal, 16px+), `assets/favicon-small.svg` (sub-14px). Generate PNG/ico sizes from these at build time.
- `brand/OG Header.html` — 1200×630 README/social image direction (render to PNG).

## Files
- `styles.css` — tokens (copy into app theme layer)
- `brand/` — Identity, Type System, OG Header
- `ui/` — Board, Board Light, Diffs, Terminals, Insights, Onboarding, Settings, Mobile Board, States (+ chrome.js, mockup-only)
- `assets/` — logo + favicons
Open any HTML file in a browser; ui pages cross-link via the titlebar.
