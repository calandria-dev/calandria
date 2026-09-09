import fs from "node:fs";
import { readEnv } from "@/lib/env.mjs";
import type { InstallMethod } from "./types";

/**
 * How the server that serves this page was installed, which decides what the
 * update popover can offer: a container and a source checkout each get
 * instructions, and a bundled server is inside the desktop app, which updates
 * itself.
 *
 * Signals, checked in this order:
 *
 * - container: CALANDRIA_CONTAINER=1, set by the Dockerfile, or `/.dockerenv`,
 *   which every Docker runtime creates. Container wins over source, since an
 *   image built from a checkout could carry both.
 * - source: `.git` at the server root. Packaged desktop payloads and images
 *   omit it, so a checkout run with `npm start` or `npm run dev` is the only
 *   case that has one. Tested for existence, not directory-ness: in a git
 *   worktree `.git` is a file.
 * - bundled: neither. The server the desktop supervisor spawns from its
 *   payload.
 */
export function detectInstallMethod({
  env,
  exists,
  root,
}: {
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
  root: string;
}): InstallMethod {
  if (env.CALANDRIA_CONTAINER === "1" || exists("/.dockerenv")) return "container";
  if (exists(`${root.replace(/[\\/]$/, "")}/.git`)) return "source";
  return "bundled";
}

/** The bound form the server uses: real env, real filesystem, real cwd. */
export default function installMethod(): InstallMethod {
  return detectInstallMethod({
    // Through readEnv, so the flag answers to the legacy ORCH_ spelling like
    // every other name in lib/env.mjs's alias table.
    env: { CALANDRIA_CONTAINER: readEnv("CALANDRIA_CONTAINER") },
    exists: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
    root: process.cwd(),
  });
}
