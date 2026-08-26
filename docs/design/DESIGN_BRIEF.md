# Calandria — Identity Design Brief

Packet for a Claude design study. Successor to the Operator-era "Operator — Board View" study credited in `app/globals.css`. The product has been renamed; this brief commissions the visual identity for the new name. Style direction is deliberately left open: bring a proposal, don't inherit one.

## The product

Calandria is a self-hosted web control room for coding agents. It runs many Claude Code and Codex sessions in parallel, one isolated git worktree per task, and lets one person direct all of them from a browser on any device. The interface is a dense, live dashboard: a board of running sessions, diffs to review, terminals, insight charts. It is used daily, often on mobile, often in dark rooms.

Audience: developers self-hosting their own agent fleet. They chose this over hosted products; the identity can assume technical taste and doesn't need to sell.

## The name

Pronounced kah-LAHN-dree-ah. Three real meanings, all fair game as design material:

1. **The reactor vessel.** In a CANDU reactor, the calandria is the vessel through which hundreds of parallel fuel channels run. One vessel, many channels, each doing its work in isolation, all of it one coordinated machine. This is the meaning that earned the name: it is literally what the software does.
2. **The songbird.** In Spanish, a calandria is a calandra lark.
3. **The carriage.** In Guadalajara, calandrias are the traditional horse-drawn carriages.

The reactor meaning is the load-bearing one. The others are available as texture or counterpoint, or can be ignored.

## Surfaces to design

| Surface | Current state | Notes |
|---|---|---|
| Logomark / glyph | CSS-drawn ring (`tb-ring`, `tb-core`, `tb-arc` in `app/globals.css`), tinted `var(--accent)` | Renders at ~20px in the titlebar; must survive that size |
| Wordmark | Plain text `CALANDRIA` (`tb-word`, 15px, weight 700, letterspaced) | Type treatment open |
| Onboarding brand block | `wiz-brand` in `OnboardingWizard.tsx` | Larger-format lockup of the same identity |
| Favicon / app icon | None exists (Next.js boilerplate only in `public/`) | Greenfield |
| Accent color system | `var(--accent)` plus chart token `--calandria` (`#a978ff` light / `#7c3fc4` dark, inherited Operator purples) | Both themes required; the `--calandria` hue labels "Calandria's own work" in insight charts and must read against 5-6 other series hues |
| README header / social image | Screenshot only | Optional deliverable |

## Constraints (hard)

- Works in both light and dark themes; dark is the primary lived-in mode.
- Glyph must be legible at 20px and as a 16px favicon.
- Glyph should be expressible as compact SVG or pure CSS; no raster dependencies in the app shell.
- The identity must not read as a continuation of the Operator brand. Clean break.
- Dense-dashboard legibility beats expressiveness wherever they conflict.

## Deliberately open

Palette, typography, glyph concept, tone, degree of literalism toward any of the name's meanings. Multiple directions welcome; a strong single proposal equally welcome.

## Deliverables

1. Logomark (SVG, plus CSS-feasible construction notes if the mark suits it)
2. Wordmark treatment for the titlebar and the onboarding lockup
3. Favicon / app icon
4. Accent color pair and a replacement `--calandria` chart hue, light and dark
5. Optional: README header / OG image direction

## Pointers

- Wordmark markup: `app/Shell.tsx` (~line 400)
- Glyph + theme tokens: `app/globals.css` (`tb-logo` block; `--calandria` at lines 42 and 124)
- Onboarding lockup: `app/shell/OnboardingWizard.tsx`
- Page metadata: `app/layout.tsx`
- Lineage and naming story: `README.md` (Lineage section), `NOTICE`
