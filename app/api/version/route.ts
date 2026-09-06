import pkg from "@/package.json";
import { INSTANCE_NAME } from "@/lib/config";
import { readEnv } from "@/lib/env.mjs";

export const dynamic = "force-dynamic";

/**
 * Build provenance, for confirming which commit is actually live without ssh.
 * sha/builtAt are baked into the image at build time (Dockerfile ARGs, fed by
 * the deploy host's build tooling from its git tree); they read "unknown" on
 * a plain `docker build .`. Also the Docker HEALTHCHECK target: this is
 * exempted from the origin auth gate for callers presenting SERVICE_TOKEN, see
 * middleware.ts.
 *
 * `instanceName` rides along because this route is also the desktop shell's
 * handshake (desktop/main.js `probeVersion`), which runs before the window is
 * pointed at the origin. That makes it the one request a client is guaranteed
 * to make against every instance it attaches to, so an instance that has named
 * itself gets to say so without a second route. Null when
 * CALANDRIA_INSTANCE_NAME is unset, which is the default and the
 * single-instance case.
 */
export async function GET() {
  return Response.json({
    sha: readEnv("CALANDRIA_GIT_SHA") ?? "unknown",
    builtAt: readEnv("CALANDRIA_BUILT_AT") ?? "unknown",
    version: pkg.version,
    instanceName: INSTANCE_NAME || null,
  });
}
