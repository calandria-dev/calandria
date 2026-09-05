// Plain JS, not .ts: the production container prunes dev deps, and Next needs
// the `typescript` package at runtime to load a next.config.ts. Without it the
// server tries to install typescript on boot and crashes (read-only /app in
// the image). JS config loads dependency-free in dev and prod alike.

/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 and node-pty are native modules, and the agent SDKs spawn
  // their CLIs (`claude` / `codex`); none should be bundled by Next's server
  // compiler.
  serverExternalPackages: ["better-sqlite3", "node-pty", "@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"],

  // The dev-mode floating indicator renders inside a shadow DOM with an inline
  // `position:fixed` and max z-index, so no app CSS can reposition it, and
  // Next offers only one global corner. The app's own top titlebar and mobile
  // bottom tab bar are both full-width, so every corner collides with real UI;
  // disabling the indicator (its documented off-switch) avoids the collision.
  // Dev-only; stripped from prod.
  devIndicators: false,
};

export default nextConfig;
