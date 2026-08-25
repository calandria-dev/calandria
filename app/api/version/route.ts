import pkg from "@/package.json";
import { readEnv } from "@/lib/env.mjs";

export const dynamic = "force-dynamic";

/**
 * Build provenance, for confirming which commit is actually live without ssh.
 * sha/builtAt are baked into the image at build time (Dockerfile ARGs, fed by
 * scripts/orch-user.sh from the deploy host's git tree); they read "unknown" on
 * a plain `docker build .`. Also the Docker HEALTHCHECK target: this is exempted
 * from the origin auth gate for callers presenting SERVICE_TOKEN — see
 * middleware.ts.
 */
export async function GET() {
  return Response.json({
    sha: readEnv("CALANDRIA_GIT_SHA") ?? "unknown",
    builtAt: readEnv("CALANDRIA_BUILT_AT") ?? "unknown",
    version: pkg.version,
  });
}
