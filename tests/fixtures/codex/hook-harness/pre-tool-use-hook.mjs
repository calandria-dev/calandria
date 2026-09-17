#!/usr/bin/env node
// The PreToolUse hook the Codex hook harness installs (docs/CODEX_HOOK_HARNESS.md).
//
// It records every invocation to CALANDRIA_HARNESS_HOOK_LOG, one JSON line per
// call holding the raw payload the CLI sent on stdin. That log is how the
// harness proves the hook ran, and it is the record of the stdin contract
// the CLI uses.
//
// The decision is a substring test against that raw payload:
// CALANDRIA_HARNESS_HOOK_DENY names a marker, and a payload containing it is
// denied. Anything else passes through by printing nothing, which is the
// CLI's "no opinion" answer and leaves the call to the ordinary approval path.
//
// The answer echoes the event name from the payload instead of spelling it
// here, so the hook cannot disagree with the CLI about it.

import fs from "node:fs";

const LOG = process.env.CALANDRIA_HARNESS_HOOK_LOG || "";
const DENY = process.env.CALANDRIA_HARNESS_HOOK_DENY || "";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8");

if (LOG) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Keep the raw text: an unparseable payload is itself the finding.
  }
  fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), raw, parsed })}\n`);
}

if (!DENY || !raw.includes(DENY)) process.exit(0);

let eventName = "preToolUse";
try {
  const parsed = JSON.parse(raw);
  if (typeof parsed?.hookEventName === "string") eventName = parsed.hookEventName;
  else if (typeof parsed?.hook_event_name === "string") eventName = parsed.hook_event_name;
} catch {
  // Fall back to the documented spelling.
}

process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision: "deny",
      permissionDecisionReason: `Calandria hook harness denied this call: payload matched ${JSON.stringify(DENY)}.`,
    },
  })}\n`,
);
process.exit(0);
