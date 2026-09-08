// Decides whether a pull request can be squash-merged right now, and if not,
// why not.
//
// The button and the route it calls share this one predicate, evaluated
// against the real PR state each time, so the button's tooltip and the
// route's 409 body always give the same answer for the same state.
//
// Pure (types only, no DB, no gh, no SDK), so the client can bundle it. Pinned
// SDK-free in tests/importGraph.test.ts.
//
// This file does not decide who may click: that is the route's job, which
// requires a person, in a browser, on a task with no turn running. There is
// no agent tool and no scheduled path here.

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
 * Order matters: the first true thing is the one a human would act on. A
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
