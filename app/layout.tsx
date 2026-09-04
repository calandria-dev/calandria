import type { Metadata, Viewport } from "next";
import "./globals.css";
import { INSTANCE_NAME, LITELLM_BASE_URL, MAX_UPLOAD_MB, PUBLIC_BASE_URL } from "@/lib/config";
import { resolveFeatures } from "@/lib/features";
import { fontVariables } from "./fonts";

export const metadata: Metadata = {
  // Empty PUBLIC_BASE_URL (the default — same-origin deployments) can't build a
  // URL; leave metadataBase unset rather than hardcoding a domain this instance
  // may not own. Only set for instances that configured a public origin.
  metadataBase: PUBLIC_BASE_URL ? new URL(PUBLIC_BASE_URL) : undefined,
  // Named instances put their name first, because the document title is what a
  // browser puts in the tab — and a row of tabs all reading "Calandria" is the
  // one thing someone running two instances cannot work around client-side.
  // Unnamed (the default, and every single-instance deployment) is unchanged.
  title: INSTANCE_NAME ? `${INSTANCE_NAME} · Calandria` : "Calandria",
  description: "Run Claude Code and Codex in parallel across every project, from any browser. Self-hosted, one git worktree per task, no API key.",
  applicationName: "Calandria",
  // iOS has no manifest-driven install; these metas are what make "Add to Home
  // Screen" open a standalone window. black-translucent lets the page extend
  // under the status bar, which the titlebar already handles via
  // viewport-fit=cover + safe-area-inset padding (globals.css).
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Calandria",
  },
};

// viewport-fit=cover lets the app paint under the notch / home indicator so the
// titlebar and composer can claim that space with safe-area insets; the phone
// layout (single-column nav) lives behind a max-width media query in globals.css.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Colors the standalone window frame / Android status bar. Static on the
  // cherenkov-dark default (globals.css --bg): the theme picker is client
  // state, and a mismatched frame beats a flash of the wrong one on launch.
  themeColor: "#081217",
};

// Render per request so PUBLIC_BASE_URL is read from the runtime environment,
// not baked in at build time — a prebuilt image stays relocatable via env only.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="cherenkov-dark" data-mode="dark" className={fontVariables}>
      <head>
        {/* Critical CSS, inlined so it applies on first parse — before the external
            stylesheets finish loading. The app is a fixed-shell UI (and the landing
            scrolls inside its own fixed `.cp` container), so the document itself must
            never scroll. Without this, a slow stylesheet load lets the browser paint
            the full-height body once and flash a document scrollbar that vanishes the
            moment the real CSS lands. */}
        <style dangerouslySetInnerHTML={{ __html: "html,body{height:100%;margin:0;overflow:hidden}" }} />
        {/* PWA manifest. Manual link, NOT the app/manifest.ts convention: the
            manifest fetch only carries cookies when the link says use-credentials
            (which Next's auto-injected link can't be told to say), and middleware
            gates every route — so under Cloudflare Access a bare link 403s and
            the app is not installable. Served by app/site.webmanifest/route.ts. */}
        <link rel="manifest" href="/site.webmanifest" crossOrigin="use-credentials" />
        {/* Hand the instance's public origin to client code (Terminal builds its
            ws(s):// URL from it). Empty = same-origin via window.location.
            __MAX_UPLOAD_MB rides along so the composer can refuse an oversized
            attachment before uploading it; the route is still the authority.
            __GATEWAY_BASE_URL is the LiteLLM address `describeProvider` compares
            a stored override against (lib/agentEnv.ts): the client has to
            classify an override the same way the server does, and the address is
            not a secret — the key that goes with it never leaves the server.
            Whether per-task keys are available (CALANDRIA_LITELLM_ADMIN_KEY set)
            rides GET /api/agents' gateway_keys_enabled instead of a window
            global — it's a project-settings-form concern, not an early-paint one,
            and describeProvider() has no need of it. */}
        <script
          dangerouslySetInnerHTML={{ __html: `window.__PUBLIC_BASE_URL=${JSON.stringify(PUBLIC_BASE_URL)};window.__FEATURES=${JSON.stringify(resolveFeatures())};window.__MAX_UPLOAD_MB=${JSON.stringify(MAX_UPLOAD_MB)};window.__GATEWAY_BASE_URL=${JSON.stringify(LITELLM_BASE_URL ?? "")};` }}
        />
        {/* Fonts are self-hosted via next/font (app/fonts.ts) — no Google Fonts
            CDN request at runtime. Their CSS variables land on <html> via the
            fontVariables class above; globals.css tokens point at them. */}
      </head>
      <body>{children}</body>
    </html>
  );
}
