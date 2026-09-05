// Is Codex's own sandbox actually able to run anything on this host?
//
// On Linux, Codex sandboxes `workspace-write` and `read-only` turns with
// bubblewrap, which needs to create an unprivileged user namespace. Ubuntu
// 24.04 denies exactly that by default
// (`kernel.apparmor_restrict_unprivileged_userns=1`), and the failure is as
// quiet as it is total: the turn starts, the model works, and every single
// command it runs fails. Nothing in the transcript says why. The one signal is
// a `configWarning` notification the `codex app-server` pushes when it starts —
// "Codex's Linux sandbox uses bubblewrap and needs access to create user
// namespaces." — which lib/agents/codex/appServerEvents.ts already surfaces as
// a transcript notice, once, mid-turn, after the user has already spent a turn
// finding out.
//
// So the warning is promoted to a piece of instance state, recorded next to the
// dead-login flag (`agent_sandbox_broken_codex`, lib/agents/connections.ts) and
// read in two places: the Settings → Agents card, which shows it with the fix,
// and the driver, which REFUSES a sandboxed turn instead of running one that
// cannot work. Refusing is the point — a turn that fails every command still
// bills, still writes a transcript, and still looks to the model like a repo
// that mysteriously rejects every edit.
//
// Three warnings, three verdicts:
//
//   "…needs access to create user namespaces."        broken (this host)
//   "…not supported on WSL1 because WSL1 cannot        broken (use WSL2)
//    create the required user namespaces…"
//   "Codex could not find bubblewrap on PATH…         fine: the CLI says in
//    Codex will use the bundled bubblewrap…"          the same breath that it
//                                                     has a working fallback
//
// Verified against codex-cli 0.153.0: all three strings are in the shipped
// binary, and `externalSandbox` is a real app-server SandboxPolicy variant.

import { CODEX_EXTERNAL_SANDBOX } from "../../config";
import { getAgentSandboxBroken, markAgentSandboxBroken, clearAgentSandboxBroken } from "../connections";
import { readConfigWarnings } from "./appServer";
import type { CodexSandboxMode } from "./policy";

/** The agent whose sandbox this module is about. */
export const CODEX_AGENT = "codex";

// A warning is about the sandbox at all…
const SANDBOX_SUBJECT = /\b(sandbox|bubblewrap|bwrap)\b/i;
// …and specifically about the namespace it could not create.
const NAMESPACE_FAILURE = /user namespaces?/i;
// …unless it is the one that names its own fallback in the same sentence.
const BENIGN = /could not find bubblewrap on PATH/i;

/**
 * The reason text to record for a `configWarning` summary, or null when the
 * warning says nothing about the sandbox being unable to start. Deliberately
 * returns the CLI's own words: the card pairs them with our fix, and a
 * paraphrase would go stale the next time the CLI rewords its warning.
 */
export function sandboxWarningReason(summary: string): string | null {
  const s = summary.trim();
  if (!s || BENIGN.test(s)) return null;
  if (!SANDBOX_SUBJECT.test(s) || !NAMESPACE_FAILURE.test(s)) return null;
  return s;
}

/** The first sandbox-breaking warning in a probe's output, if any. */
export function firstSandboxWarning(warnings: string[]): string | null {
  for (const w of warnings) {
    const reason = sandboxWarningReason(w);
    if (reason) return reason;
  }
  return null;
}

/** What to do about it, in the order of least damage. Shown on the card and in the refusal. */
export const SANDBOX_FIX_HINT =
  "Allow unprivileged user namespaces (sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0, " +
  "persisted in /etc/sysctl.d/), or install an AppArmor profile for bwrap, or run the task in " +
  "bypassPermissions, which uses no sandbox at all. In a container, where the container is already the " +
  "boundary, set CODEX_EXTERNAL_SANDBOX=1.";

export interface CodexSandboxHealth {
  /** False only when a sandboxed turn is known to be unable to run a command. */
  ok: boolean;
  /** The CLI's warning, when it isn't ok. */
  reason: string | null;
  /** The probe could not reach the CLI at all — neither healthy nor broken. */
  error: string | null;
}

/**
 * Ask a throwaway `codex app-server` whether its sandbox works, and record the
 * answer. Run at connect time (the verify route) and from the card's re-check
 * button, never on a page load: it spawns a process.
 *
 * A probe that could not run leaves the flag exactly as it was. "We couldn't
 * ask" is not evidence either way, and clearing on it would let a missing CLI
 * silently retract a warning that is still true.
 */
export async function probeCodexSandbox(): Promise<CodexSandboxHealth> {
  const { warnings, error } = await readConfigWarnings();
  if (error) return { ok: !getAgentSandboxBroken(CODEX_AGENT), reason: null, error };
  const reason = firstSandboxWarning(warnings);
  if (reason) {
    markAgentSandboxBroken(CODEX_AGENT, reason, Date.now());
    return { ok: false, reason, error: null };
  }
  clearAgentSandboxBroken(CODEX_AGENT);
  return { ok: true, reason: null, error: null };
}

/**
 * Record a `configWarning` seen mid-turn. Returns whether it was a sandbox
 * failure, so the driver can tell "this turn saw one" from "this turn saw
 * none" and clear the flag on the latter.
 */
export function noteCodexSandboxWarning(summary: string): boolean {
  const reason = sandboxWarningReason(summary);
  if (!reason) return false;
  markAgentSandboxBroken(CODEX_AGENT, reason, Date.now());
  return true;
}

/**
 * A turn ran to completion on the app-server transport and no sandbox warning
 * came with it. That process was freshly spawned, so its silence is proof, and
 * a user who has just fixed their sysctl gets the flag cleared without having
 * to find the button.
 *
 * Only the app-server transport may call this: `codex exec` never delivers
 * configWarnings, so its silence proves nothing.
 */
export function noteCodexSandboxHealthy(): void {
  clearAgentSandboxBroken(CODEX_AGENT);
}

/**
 * Whether this sandbox mode is one the container already provides, so Codex
 * should be told not to build its own (`externalSandbox`).
 *
 * `workspace-write` only. Under `externalSandbox` Codex applies no isolation of
 * its own, which is a true description of a container for the write case — the
 * image is the boundary and the worktree is inside it — and a false one for
 * `read-only`, where the whole guarantee IS that nothing is writable. Mapping
 * plan mode to it would quietly turn "propose without editing" into "may edit",
 * which is the same class of silent breakage this module exists to stop. A
 * read-only turn on a host with no working sandbox is refused instead.
 */
export function usesExternalSandbox(sandbox: CodexSandboxMode): boolean {
  return CODEX_EXTERNAL_SANDBOX && sandbox === "workspace-write";
}

/**
 * The message to fail a turn with, or null to let it run. `danger-full-access`
 * never uses the sandbox and external-sandbox modes never build one, so both
 * run on a host where bubblewrap is dead — which is exactly what the hint
 * offers as the escape.
 */
export function sandboxRefusal(sandbox: CodexSandboxMode): string | null {
  if (sandbox === "danger-full-access" || usesExternalSandbox(sandbox)) return null;
  const broken = getAgentSandboxBroken(CODEX_AGENT);
  if (!broken) return null;
  return (
    `Codex's sandbox can't start on this host, so every command in a ${sandbox} turn would fail. ` +
    `Codex reported: ${broken.reason} ${SANDBOX_FIX_HINT}`
  );
}
