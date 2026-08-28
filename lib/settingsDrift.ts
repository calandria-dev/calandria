// The pre-turn settings gate: does this task's agent configuration still say
// what it said the last time a turn was allowed to run under it? (issue #43)
//
// The Claude CLI loads `<worktree>/.claude/settings.json` on EVERY turn, from
// disk, and none of what that file can carry is inert: `hooks` are literal
// shell commands run on tool and session events with no canUseTool call at all,
// `permissions.allow` auto-approves tool calls before the gate is consulted,
// and `env` reaches every subprocess a tool spawns. The file also sits inside
// the worktree, which is exactly where the agent's own writes land.
//
// So the escalation path is: turn N writes `.claude/settings.json` (trivial
// under an auto-accept edit policy, or under bypassPermissions where the gate
// is skipped outright), turn N+1 loads it and the hook runs. Nothing in between
// asks anybody. The same door opens without an agent at all — a base-branch
// commit the worktree fast-forwards onto before a turn (lib/runner.ts's
// catch-up) can plant the same file.
//
// The defense that was claimed for keeping 'project' in SETTING_SOURCES is that
// the file is TRACKED, so a human reviewing the diff before the merge would see
// it. True, and it doesn't help: nothing forces that review to happen before
// the NEXT TURN, which is where the hook runs.
//
// The fix is drift detection rather than dropping the source, because a repo
// shipping its own settings is a legitimate thing to do. Hash each watched file
// before the turn starts, compare against the copy this task last ran under,
// and hold the turn on an ordinary permission card when it moved. Approving
// adopts the new version as the baseline (so a repo that legitimately changes
// its settings asks once, not every turn); declining ends the turn before the
// agent ever loads it.
//
// Two shapes of "nobody said yes" and one of them is not a card:
//
//   - the FIRST time a file is seen, there is no older version a turn ran
//     under, so there is nothing to have drifted from. Recorded silently. A
//     task inherits its repo's settings the way it inherits its repo's code.
//   - an unattended or scheduled run REFUSES. Adopting new agent settings is
//     not a decision the absence of a human can make, and lib/permissions.ts's
//     waitForPermission already encodes both halves of that (a declared-
//     unattended run settles at once; an unwatched one gets the short grace),
//     so this reuses it rather than inventing a second policy.
//
// Which files count is the DRIVER's answer (AgentDriver.watchedSettingsFiles),
// never a list here: this module must not know that Claude reads
// `.claude/settings.json` and Codex reads nothing from the worktree, or the two
// facts drift apart the first time a driver changes what it loads.
//
// No agent SDK — pinned by tests/importGraph.test.ts.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { diffLines } from "./agents/shared";
import { promptDeadline } from "./permissions";
import { getSettingsSnapshot, recordSettingsSnapshot } from "./store";
import type { DiffLine, PermissionRequest } from "./types";

/**
 * How much of a watched file is kept as the acknowledged copy. The HASH is
 * always over the whole file, so comparison is exact regardless; this cap only
 * governs whether we can still show a diff. A settings file past 200k is not a
 * settings file, and storing one per task would put it in every snapshot.
 */
const CONTENT_CAP = 200_000;

/** Diff lines kept on the card (and therefore in the persisted transcript row). */
const DIFF_MAX = 300;

/** One watched file that changed since the turn this task last ran. */
export interface SettingsChange {
  /** Worktree-relative, as the driver named it. */
  file: string;
  kind: "added" | "changed" | "removed";
  /** sha256 of the file as it is NOW; "" when it is absent or unreadable. */
  hash: string;
  /** The file as it is now, up to CONTENT_CAP; "" when absent or oversize. */
  content: string;
  /** True when the file is too big to keep a copy of, so there is no diff. */
  oversize: boolean;
  /** Bytes on disk now, for the oversize message. */
  size: number;
  /** The acknowledged copy this is compared against; "" when there wasn't one. */
  before: string;
  /**
   * True when the acknowledged copy was itself oversize, so `before` is ""
   * because we never kept it rather than because the file was empty — the
   * difference between "the whole file is new" and "we can't show you a diff".
   */
  beforeOversize: boolean;
}

interface OnDisk {
  hash: string;
  content: string;
  oversize: boolean;
  size: number;
}

/**
 * Read one watched file. An unreadable file (a directory in its place, a
 * permission error) is reported as ABSENT rather than thrown: the gate must
 * never be the reason a turn can't start, and "we couldn't read the file the
 * CLI is about to read" resolves to a card either way — which is the outcome
 * that asks a human, not the one that assumes.
 */
function readWatched(root: string, file: string): OnDisk {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(path.join(root, file));
  } catch {
    return { hash: "", content: "", oversize: false, size: 0 };
  }
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const oversize = buf.byteLength > CONTENT_CAP;
  return { hash, content: oversize ? "" : buf.toString("utf8"), oversize, size: buf.byteLength };
}

/**
 * Compare every watched file against what this task last ran under, and return
 * only the ones that moved.
 *
 * SIDE EFFECT, deliberately: a file with no recorded baseline is recorded here
 * and never reported. That is the first-turn case, and it has to be written
 * before the turn runs — recording it afterwards would mean a turn that
 * crashed, or was stopped, left the task with no baseline and the agent's own
 * write from that turn would become one.
 */
export function checkSettingsDrift(taskId: string, root: string, files: string[]): SettingsChange[] {
  const changes: SettingsChange[] = [];
  for (const file of files) {
    const now = readWatched(root, file);
    const seen = getSettingsSnapshot(taskId, file);
    if (!seen) {
      recordSettingsSnapshot(taskId, file, now.hash, now.content);
      continue;
    }
    if (seen.hash === now.hash) continue;
    changes.push({
      file,
      kind: !now.hash ? "removed" : !seen.hash ? "added" : "changed",
      hash: now.hash,
      content: now.content,
      oversize: now.oversize,
      size: now.size,
      before: seen.content,
      beforeOversize: Boolean(seen.hash) && !seen.content,
    });
  }
  return changes;
}

/**
 * Adopt what is on disk now as what this task runs under — the approval half.
 * Only ever called after somebody said yes: a declined change keeps the old
 * baseline, so the next turn asks again instead of quietly inheriting the
 * version that was just refused.
 */
export function acceptSettingsChanges(taskId: string, changes: SettingsChange[]): void {
  for (const c of changes) recordSettingsSnapshot(taskId, c.file, c.hash, c.content);
}

const verb = (c: SettingsChange): string =>
  c.kind === "added" ? "was created" : c.kind === "removed" ? "was deleted" : "changed";

const listFiles = (changes: SettingsChange[]): string =>
  changes.map((c) => `${c.file} ${verb(c)}`).join(", ");

/** The transcript line that says what happened, before the card that asks about it. */
export function settingsDriftNotice(changes: SettingsChange[]): string {
  const one = changes.length === 1;
  return (
    `⚠ This task's agent settings changed since its last turn: ${listFiles(changes)}. ` +
    `${one ? "That file is" : "Those files are"} re-read from disk at the start of every turn — ` +
    `hooks in ${one ? "it" : "them"} run shell commands outside the permission gate, ` +
    `permissions.allow entries approve tool calls without one, and env reaches every subprocess a ` +
    `tool spawns — so this turn is held until you approve the change.`
  );
}

/**
 * The diff the card shows: the acknowledged copy against what is on disk now,
 * per file, with a header line when there is more than one so the hunks can't
 * be read as one file's. Diffed from the change itself rather than by re-reading
 * the snapshot row, so it can't depend on being called before the approval
 * writes the new baseline over it. Empty when nothing can be diffed (either
 * side oversize), which is what the detail line below is for.
 */
function driftDiff(changes: SettingsChange[]): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const c of changes) {
    if (c.oversize || c.beforeOversize) continue;
    if (changes.length > 1) lines.push({ sign: " ", text: `--- ${c.file}` });
    lines.push(...diffLines(c.before, c.content));
  }
  return lines.length <= DIFF_MAX
    ? lines
    : [...lines.slice(0, DIFF_MAX), { sign: " ", text: `… (${lines.length - DIFF_MAX} more lines)` }];
}

/**
 * The card. Deliberately an ordinary PermissionRequest: it parks in the same
 * ask registry, is answered by the same POST /answer route with the same
 * decisions, and settles onto the same transcript row a tool prompt does. Only
 * `kind` differs, and only so the UI can say what declining actually does here.
 *
 * No `scope` offer: "always allow" for this would be a standing grant to
 * whatever the file says next, which is the exact thing being gated.
 */
export function settingsDriftRequest(
  id: string,
  taskId: string,
  changes: SettingsChange[],
  attendedMs: number,
  unattendedMs: number
): PermissionRequest {
  const oversize = changes.filter((c) => c.oversize || c.beforeOversize);
  return {
    id,
    tool: "Settings",
    kind: "settings",
    title:
      changes.length === 1
        ? `${changes[0].file} ${verb(changes[0])} in this task's worktree`
        : `${changes.length} agent setting files changed in this task's worktree`,
    description:
      "The agent loads this at the start of every turn: hooks run shell commands with no permission " +
      "check, permissions.allow approves tool calls without one, and env reaches every subprocess.",
    // Only ever non-empty when a diff could not be produced: everything else the
    // card needs to say is in the diff itself.
    detail: oversize
      .map((c) =>
        c.oversize
          ? `${c.file} is ${c.size.toLocaleString()} bytes — too large to diff here. Read it in the Changes tab before approving.`
          : `${c.file} can't be diffed: the version this task last ran under was too large to keep a copy of. Read the file in the Changes tab before approving.`
      )
      .join("\n"),
    diff: driftDiff(changes),
    expiresAt: promptDeadline(attendedMs, unattendedMs, taskId),
  };
}

/** Why a turn didn't run, for the transcript and for a schedule run's detail. */
export function settingsBlockedError(
  changes: SettingsChange[],
  reason: "declined" | "unattended" | "timeout"
): string {
  const what = `This turn did not run: ${listFiles(changes)} in this task's worktree`;
  if (reason === "declined")
    return (
      `${what}, and you declined the change. The agent never loaded it. Revert the file in the ` +
      `worktree, or send again and approve the card, to carry on.`
    );
  if (reason === "timeout")
    return `${what}, and the approval card expired unanswered. Send again to be asked once more.`;
  return (
    `${what}, and nobody was watching to approve it. An unattended run never adopts new agent ` +
    `settings on its own — hooks and permission-allow rules in that file would run outside the ` +
    `permission gate. Review the change and start this one by hand.`
  );
}

/**
 * The settled card's note when nobody was there. Not lib/permissions.ts's
 * DENIED_UNATTENDED, which is written FOR THE MODEL ("stop here and summarize
 * what you were about to do") and would be addressed to an agent that never
 * started.
 */
export const SETTINGS_DENIED_UNATTENDED =
  "Nobody was watching this run, so the change was declined automatically and the turn did not run.";
