// Detection + recovery constants for the "this task could not be given an
// isolated worktree" failure mode.
//
// `ensureWorktree` fails CLOSED (lib/git.ts, lib/runner.ts, lib/autoStart.ts,
// lib/dispatch.ts): a throw never degrades into running the turn in the user's
// real checkout. That is right, but on its own it swaps a silent wrong-checkout
// run for a dead end — a bare "Could not prepare an isolated worktree: fatal:
// …" with nothing to click, and a scheduled run that settles `failed` the same
// way every morning until someone goes digging (issue #44).
//
// So a prep failure is classified here the way lib/promptLimits.ts,
// lib/authFailure.ts and lib/approvalFailure.ts classify theirs: from the git
// error text (agent-agnostic, and the same text whether it arrived as a
// WorktreePrepError or as a plain string through publishTurnError), into a
// `kind`, a `recoverable` hint and one sentence saying what happened. The
// recoverable kinds get WORKTREE_REPAIR_NOTICE appended, which the UI
// (app/shell/Transcript.tsx) matches verbatim to render one "Repair worktree"
// button; the rest get the explanation alone, and anything unrecognised gets
// the raw error text unchanged. Kept dependency-free so both server and client
// bundles can import it (same rule as lib/promptLimits.ts).

/** What went wrong while preparing a task's worktree. */
export type WorktreePrepKind =
  /** A crashed git left an `index.lock`/`HEAD.lock` behind; nothing else is running. */
  | "stale_lock"
  /** The worktree is registered with git but its directory is gone — `prune` clears it. */
  | "stale_registration"
  /** The volume holding the repo or CALANDRIA_WORKTREES_DIR is full. */
  | "disk_full"
  /** The project repo is on a detached HEAD, so there is no branch to cut from. */
  | "detached_head"
  /** Not one we recognise — the raw error is all we can honestly say. */
  | "unknown";

export interface WorktreePrepDiagnosis {
  kind: WorktreePrepKind;
  /** True when a "Repair worktree" pass (clear the lock, prune, re-cut) can plausibly fix it. */
  recoverable: boolean;
  /** One or two sentences: what happened, and what to do about it. Empty for "unknown". */
  hint: string;
}

// Order matters. A full disk fails INSIDE the lock-file write git was about to
// do ("fatal: Unable to create '…/index.lock': No space left on device"), so it
// must be recognised first or it would read as a stale lock and offer a Repair
// button that deletes a lock nothing left behind and then fails identically.
const DISK_FULL_RES = [
  /\bENOSPC\b/,
  /no space left on device/i,
  /disk quota exceeded/i,
  /\bout of (?:disk )?space\b/i,
];

// git's own wording for a leftover lock, both halves quoted so a message that
// merely mentions a lock path can't trip it:
//   fatal: Unable to create '/repo/.git/index.lock': File exists.
//   Another git process seems to be running in this repository …
const STALE_LOCK_RES = [
  /unable to create '[^']*\.lock': file exists/i,
  /another git process seems to be running/i,
  /\.lock['"]?: file exists/i,
];

// The worktree is in git's registry but not on disk:
//   fatal: '<path>' is a missing but already registered worktree;
//          use 'add -f' to override, or 'prune' or 'remove' to clear
//   fatal: '<branch>' is already checked out at '<path>'
const STALE_REGISTRATION_RES = [
  /missing but (?:already registered|locked) worktree/i,
  /is already (?:checked out|used) (?:at|by worktree)/i,
  /already registered worktree/i,
];

const DETACHED_HEAD_RES = [
  /detached head/i,
  /\bHEAD\b[^\n]{0,40}not a symbolic ref/i,
  /does not point to a branch/i,
];

const HINTS: Record<Exclude<WorktreePrepKind, "unknown">, string> = {
  stale_lock:
    "A git process crashed in this repository earlier and left a lock file behind, so git refuses " +
    "to touch the index. No work was lost — the lock is an empty file, not a change.",
  stale_registration:
    "This task's worktree is still in git's registry but its directory is gone, so git won't cut it " +
    "again until the stale registration is pruned. The task's branch — and every commit on it — is untouched.",
  disk_full:
    "There is no room left on the volume holding the repository or the worktrees directory, so git " +
    "could not write the checkout. Free some space (or point CALANDRIA_WORKTREES_DIR at a bigger volume) and send this again.",
  detached_head:
    "The project's repository is on a detached HEAD, so there is no branch for this task to be cut " +
    "from. Check out a branch there — or set the project's base branch in its settings — and send this again.",
};

/**
 * Classify a worktree-preparation failure from its error text. Works on a raw
 * git message, on a WorktreePrepError's message, and on the persisted
 * transcript line, so the same policy serves the route, the runner and the UI.
 */
export function classifyWorktreePrep(msg: string | null | undefined): WorktreePrepDiagnosis {
  const text = msg ?? "";
  const kind: WorktreePrepKind = !text
    ? "unknown"
    : DISK_FULL_RES.some((re) => re.test(text))
      ? "disk_full"
      : STALE_LOCK_RES.some((re) => re.test(text))
        ? "stale_lock"
        : STALE_REGISTRATION_RES.some((re) => re.test(text))
          ? "stale_registration"
          : DETACHED_HEAD_RES.some((re) => re.test(text))
            ? "detached_head"
            : "unknown";
  // Only the two "something is stale in git's bookkeeping" kinds are things a
  // repair pass can act on. A full disk and a detached HEAD are real states of
  // the machine and the repo: clearing locks and pruning would report success
  // and fail again on the next turn, which is worse than saying what's wrong.
  const recoverable = kind === "stale_lock" || kind === "stale_registration";
  return { kind, recoverable, hint: kind === "unknown" ? "" : HINTS[kind] };
}

/** The prefix every worktree-prep failure carries, so one wording reaches the
 *  transcript whether the throw was caught by the POST route, the runner's
 *  queue drain, an auto-start or a scheduled dispatch. */
export const WORKTREE_PREP_PREFIX = "Could not prepare an isolated worktree";

/** Appended to the persisted error line when the failure is one a repair pass
 *  can fix. The UI (app/shell/Transcript.tsx) matches this exact string to
 *  render the "Repair worktree" button, so it must stay agent-neutral and
 *  self-contained. Persisted message content is the durable channel — it
 *  survives SSE reconnects because the snapshot replays from SQLite. */
export const WORKTREE_REPAIR_NOTICE =
  "Repair worktree clears the leftover lock, prunes the stale registration and cuts the checkout " +
  "again, then sends this message for you.";

/**
 * The recovery hint to append to a failed-turn line, or null when the failure
 * isn't a worktree-prep one we recognise (the raw error text then stands alone,
 * unchanged). Recoverable kinds carry WORKTREE_REPAIR_NOTICE, which is what the
 * UI turns into the one button.
 *
 * Gated on WORKTREE_PREP_PREFIX rather than classifying any error text that
 * mentions a lock or a full disk: a turn dies with the agent's OWN git output
 * in it all the time ("Another git process seems to be running" from a Bash
 * call inside the worktree), and that failure has nothing to do with preparing
 * the checkout — offering to re-cut it would be the wrong advice on the one
 * line the user reads. Every prep failure carries the prefix, because
 * WorktreePrepError is the only thing that raises one.
 */
export function worktreePrepNotice(msg: string | null | undefined): string | null {
  if (!msg || !msg.includes(WORKTREE_PREP_PREFIX)) return null;
  const d = classifyWorktreePrep(msg);
  if (d.kind === "unknown") return null;
  return d.recoverable ? `${d.hint}\n\n${WORKTREE_REPAIR_NOTICE}` : d.hint;
}

/**
 * A worktree preparation failure, carrying its classification. `ensureWorktree`
 * wraps every throw in one of these so callers don't have to re-derive the
 * `recoverable` answer — but they still can, from the message alone, which is
 * what the runner does for failures that reach it as persisted text.
 */
export class WorktreePrepError extends Error {
  readonly kind: WorktreePrepKind;
  readonly recoverable: boolean;
  readonly hint: string;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${WORKTREE_PREP_PREFIX}: ${detail}`);
    this.name = "WorktreePrepError";
    this.cause = cause;
    const d = classifyWorktreePrep(detail);
    this.kind = d.kind;
    this.recoverable = d.recoverable;
    this.hint = d.hint;
  }
}

/** True when `err` is a wrapped worktree-prep failure (as opposed to any other
 *  throw that happened to reach the same catch). */
export function isWorktreePrepError(err: unknown): err is WorktreePrepError {
  return err instanceof WorktreePrepError;
}
