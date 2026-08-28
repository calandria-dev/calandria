// May this pull request be squash-merged from here, and if not, why not?
//
// One predicate, shared by the button and the route it calls, for the usual
// reason two copies of a policy are one too many: the button is enabled off
// REAL PR state rather than optimistically, and the route re-screens against a
// freshly refreshed row before it shells out — so a snapshot that went stale
// while the rail was on screen is refused with the same sentence the tooltip
// would have shown, instead of being merged on the strength of a five-minute-old
// answer.
//
// Pure (types only, no DB, no gh, no SDK), so the client bundles it the way it
// bundles lib/contextWindow.ts and lib/usageReset.ts. Pinned SDK-free in
// tests/importGraph.test.ts.
//
// What this file does NOT do is decide WHO may click. That is the route's job,
// and the answer is: a person, in a browser, on a task with no turn running.
// `.github/CLAUDE.md` sets out the standard for this repo's own release merges
// — an agent may merge only on an explicit human answer through its ask tool,
// never on its own initiative and never unattended — and a merge button is the
// same act with the human already in the loop. There is deliberately no agent
// tool and no scheduled path here; adding one would be that gate's back door.

/** The PR facts the decision reads. Satisfied by lib/types' Task and by the client's TaskRow alike. */
export interface PrMergeFacts {
  pr_url: string;
  pr_number: number;
  pr_state: string;
  pr_checks: string;
  pr_draft: number;
  pr_merge_state: string;
  pr_synced_at: number;
}

/**
 * The reason this PR can't be squash-merged right now, or null when it can.
 *
 * The sentence is the whole return value: it is the button's tooltip, the
 * disabled-state explanation and the route's 409 body, so there is exactly one
 * wording per refusal and no chance of the UI and the server disagreeing about
 * what is wrong.
 *
 * Order matters — the first true thing is the one a human would act on. A
 * closed PR is worth saying before its checks, and "we haven't asked GitHub
 * yet" outranks everything, because every field below it is still "".
 */
export function prMergeBlocker(pr: PrMergeFacts): string | null {
  if (!pr.pr_url || !pr.pr_number) return "This task has no pull request to merge.";
  if (!pr.pr_synced_at) return "GitHub hasn't answered about this pull request yet.";
  if (pr.pr_state === "merged") return "This pull request is already merged.";
  if (pr.pr_state === "closed") return "This pull request was closed without merging.";
  if (pr.pr_state !== "open") return "This pull request isn't open.";
  if (pr.pr_draft) return "This pull request is still a draft. Mark it ready for review first.";
  // A red build is the one state auto-merge cannot rescue: queueing would park
  // the merge behind a check that has already failed.
  if (pr.pr_checks === "failing") return "This pull request's checks are failing.";
  // DIRTY is gh's word for "conflicts with the base branch". Every other
  // mergeStateStatus (BLOCKED on a required review, BEHIND, UNSTABLE, UNKNOWN)
  // is exactly what --auto exists to wait out, so none of them blocks the click.
  if (pr.pr_merge_state.toUpperCase() === "DIRTY")
    return "This pull request conflicts with its base branch. Resolve the conflicts first.";
  return null;
}
