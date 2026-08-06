// Boot-time guard against inherited billing credentials (GitHub issue #4).
//
// The Agent SDK's `claude` children (and the `codex` CLI, and every pty shell)
// inherit the server's environment. If ANTHROPIC_API_KEY leaked in from a shell
// profile / environment.d / a systemd unit, every turn silently bills that key
// per-token while the UI reports the subscription login. docker/entrypoint.sh
// strips these vars for containers; this module is the same guard for bare-node
// and dev deploys, called at boot by BOTH plain-Node entrypoints (server.js and
// pty-server.js — separate processes, each needs it).
//
// Post-strip invariant: an agent key in process.env is always deliberate —
// either re-applied from the persisted 0600 file (lib/anthropic-key.ts /
// lib/openai-key.ts at db init) or kept via the ORCH_ALLOW_API_KEY_ENV opt-in.
// Status surfaces (hasApiKey and friends) rely on this to report honestly.
//
// Plain .mjs on purpose: the CommonJS entrypoints dynamic-import it, vitest
// imports it directly, and the Dockerfile must COPY it into the runtime image
// (see the lib/*.mjs line there — Next's build output does not include these).

export const AGENT_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"];

/** @param {Record<string, string | undefined>} [env] */
export function allowApiKeyEnv(env = process.env) {
  const v = String(env.ORCH_ALLOW_API_KEY_ENV || "").toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/**
 * Delete inherited agent billing vars from `env` unless allowed. Returns the
 * names that were stripped so the caller can log a WARN naming them.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ allow?: boolean }} [opts]
 */
export function stripInheritedAgentKeys(env = process.env, { allow = allowApiKeyEnv(env) } = {}) {
  if (allow) return [];
  const stripped = [];
  for (const name of AGENT_KEY_VARS) {
    if (env[name]) {
      delete env[name];
      stripped.push(name);
    }
  }
  return stripped;
}
