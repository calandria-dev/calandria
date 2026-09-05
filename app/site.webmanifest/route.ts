import type { MetadataRoute } from "next";

// PWA manifest, served as a hand-rolled route instead of the `app/manifest.ts`
// convention because that convention's auto-injected <link rel="manifest">
// fetches without credentials, and middleware.ts 403s an uncredentialed
// manifest fetch under Cloudflare Access. The credentialed link lives in
// app/layout.tsx's manual <head>; keep the two in sync.
//
// Colors match the cherenkov-dark default theme (globals.css --bg). Icons are
// pre-rendered PNGs of app/icon.svg; regenerate them if the branding changes.
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
