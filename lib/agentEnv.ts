import type { Project } from "./types";

/**
 * The environment a main-turn agent process runs with (issue #102).
 *
 * Three facts make this a whole-env builder rather than a two-key patch:
 *
 * 1. Both agent SDKs REPLACE the child's environment when `env` is set, rather
 *    than merging it. The Claude Agent SDK's `Options.env` says so outright —
 *    "this value REPLACES the subprocess environment entirely" —
 *    (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1367-1385`), and the
 *    Codex SDK's `CodexOptions.env` documents the same thing the other way
 *    round: "the SDK will not inherit variables from process.env". So this
 *    starts from the server's own environment and edits two keys, rather than
 *    building a small object from scratch — a partial object would otherwise
 *    silently strip PATH, HOME and everything else a spawned CLI needs to run.
 *
 * 2. NODE_ENV is dropped. `npm start` (package.json), the Dockerfile and the
 *    desktop supervisor all set NODE_ENV=production for Next's own benefit, and
 *    a turn spawned from that process inherits it. Inside a user's project that
 *    makes `npm install` skip devDependencies and still exit 0, so test runners
 *    and linters silently vanish from a session working in that checkout
 *    (issue #102 §2) — Next is not involved in anything a turn spawns.
 *
 * 3. PORT is replaced. The server's own PORT is Calandria's listening port, but
 *    `buildProjectContext()` (`lib/agents/shared.ts:207-208`) tells every agent
 *    to bind its dev server to `$PORT` — inherited unchanged, that pointed a
 *    task's dev server straight at Calandria itself. The project's own
 *    deterministic port is the one `lib/services.ts:348` and `pty-server.js:193`
 *    already inject into managed services and the terminal, so setting it here
 *    makes that guidance true instead of false. A project with no port (0, or
 *    no project at all) gets PORT deleted rather than left pointing at the app.
 */
export function agentTurnEnv(
  project: Pick<Project, "port"> | null | undefined,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) out[k] = v;
  }
  delete out.NODE_ENV;
  if (project?.port) out.PORT = String(project.port);
  else delete out.PORT;
  return out;
}
