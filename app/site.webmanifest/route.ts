import type { MetadataRoute } from "next";

// PWA manifest, served as a hand-rolled route instead of the `app/manifest.ts`
// file convention on purpose: the convention auto-injects a bare
// <link rel="manifest">, and a bare link makes the browser fetch the manifest
// WITHOUT credentials (the manifest spec omits cookies unless the link says
// crossorigin="use-credentials" — Next only adds that on Vercel previews).
// middleware.ts gates every route, so under Cloudflare Access an uncredentialed
// manifest fetch is a flat 403 and the app is not installable. The credentialed
// link lives in app/layout.tsx's manual <head>; keep the two paths in sync.
//
// Colors match the cherenkov-dark default theme (globals.css --bg). Icons are
// pre-rendered PNGs of app/icon.svg on that background (the maskable pair pads
// the glyph into the 80% safe zone); regenerate them from app/icon.svg if the
// branding changes.
const manifest: MetadataRoute.Manifest = {
  name: "Calandria",
  short_name: "Calandria",
  description:
    "Run parallel agent sessions across every project, host each app live under your own domain, and verify changes from any device.",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#081217",
  theme_color: "#081217",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

export function GET() {
  return new Response(JSON.stringify(manifest), {
    headers: { "content-type": "application/manifest+json" },
  });
}
