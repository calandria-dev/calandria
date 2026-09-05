// Detection and recovery constants for the "Codex's approval policy blocked
// the turn" failure mode. Calandria runs Codex non-interactively via `codex
// exec`, requesting `approval_policy=never`. Enterprise-managed requirements,
// or a user's ~/.codex/config.toml with CODEX_APPROVAL_POLICY=inherit, can
// force an approval-requiring policy instead, and exec mode then has no way
// to service the resulting approval prompts (every non-allowlisted command
// fails with "approval request failed"). The Codex driver matches the
// downgrade warning as a StreamEvent error and switches future turns to the
// exec-compatible "on-request" policy. This module classifies the failure
// for lib/runner.ts, which appends APPROVAL_BLOCKED_NOTICE so the UI can
// render a Retry button. Kept dependency-free so both server and client
// bundles can import it.

/** The CLI's managed-requirements downgrade warning: the approval policy
 *  Calandria asked for was rejected and a stricter one applies. Matched by
 *  the Codex driver to trigger auto-negotiation. */
const APPROVAL_DOWNGRADE_RES = [
  /approval_policy[^\n]{0,80}disallowed by requirements/i,
  /disallowed by requirements[^\n]{0,120}approval_policy/i,
  /invalid value for [`'"]?approval_policy[`'"]?[^\n]{0,80}not in the allowed set/i,
];

/** True when an error is the CLI's "your approval_policy was rejected by
 *  managed requirements, falling back to a stricter value" warning. */
export function isApprovalDowngrade(msg: string | null | undefined): boolean {
  return !!msg && APPROVAL_DOWNGRADE_RES.some((re) => re.test(msg));
}

// The rejections codex_core emits when an approval-requiring policy meets
// exec mode, which cannot ask anyone to approve a command mid-turn:
//   - "command execution approval is not supported in exec mode for thread …"
//   - "exec_command failed …: Rejected(\"approval request failed\")"
//   - "approval policy is UnlessTrusted; reject command: you cannot ask for
//     escalated permissions if the approval policy is UnlessTrusted"
const APPROVAL_BLOCKED_RES = [
  ...APPROVAL_DOWNGRADE_RES,
  /approval request failed/i,
  /approval policy is \w+; reject/i,
  /(?:command execution )?approval is not supported in exec mode/i,
  /cannot ask for escalated permissions/i,
];

/** True when a turn's error text is an approval-policy rejection (the managed
 *  downgrade warning, or exec mode failing to service an approval) and not
 *  a work failure. */
export function isApprovalBlocked(msg: string | null | undefined): boolean {
  return !!msg && APPROVAL_BLOCKED_RES.some((re) => re.test(msg));
}

/** Appended to the persisted error line when a turn is blocked by the approval
 *  policy. The UI (app/shell/Transcript.tsx) matches this exact string
 *  to render the "Retry" button: the driver has already switched future turns
 *  to the exec-compatible "on-request" policy by the time anyone reads this, so
 *  resending the same message is the recovery. Persisted message content is the
 *  durable channel, since it survives SSE reconnects by replaying the snapshot
 *  from SQLite. */
export const APPROVAL_BLOCKED_NOTICE =
  "The agent's approval policy blocked this turn: it requires interactive command approval, which " +
  "Calandria's unattended sessions can't provide. Calandria now requests the compatible 'on-request' " +
  "policy for its Codex sessions, so retrying the message should go through. (Running with " +
  "CODEX_APPROVAL_POLICY=inherit? Set an exec-compatible approval_policy, e.g. \"on-request\", in " +
  "~/.codex/config.toml instead.)";
