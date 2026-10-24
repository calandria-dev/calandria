---
title: "Review submissions"
---

# Review submissions

A review submission is an explicit request from an agent for a person to look at one output: the task's code changes, or one Markdown document. The Work Center lists a pending review as a "decide review" item. This page covers what the server stores, how creation is switched on, what the read endpoints return, and what to do about backups and rollback.

Review submissions ship disabled. The stored history, the read endpoints and the Work Center item are always active. Only opening a new review request is gated.

## Turn it on

Set `CALANDRIA_REVIEW_REQUESTS=1` (see `.env.example`). With it unset, an agent that tries to open a review gets `403 creation_disabled`. These keep working with the flag off:

- Reading reviews and artifacts.
- Resubmitting an existing request, which is how a pending or changes-requested review gets resolved.
- Replaying an earlier submission by its idempotency key.
- The required-review guards and the retention protection of review history.

Keep the flag off for real work until the decision routes, the completion guards and the review screen have all shipped. A review that exists without them cannot be resolved from the UI.

## What is stored

| Table | Holds |
|-|-|
| `review_requests` | One row per task and output key: kind (`code` or `document`), required flag, state, version, and a pointer to the current submission. |
| `review_submissions` | One immutable row per revision: summary, requested decision, evidence links, the submitter's validation claims, the artifact, the task's content epoch at capture time, and the idempotency key with the receipt it returned. |
| `review_artifacts` | The manifest of what was captured. A document artifact also stores its exact bytes. |
| `review_actions` | Decisions and their effects. Written by the decision routes. |
| `review_applicability_receipts` | Proof that an accepted submission later landed or was retired with its checkout. |
| `review_cleanup_jobs` | The journal for deleting a task that owns reviews. |
| `review_repositories` | The map from a repository's common Git directory to its review UUID. |

Submissions are never edited. A resubmission adds a revision and moves the request's pointer, so the earlier revision stays in the history. `tasks.review_content_epoch` counts source-changing operations; a submission records the value it saw, and a later change makes the old submission stale even when the bytes match.

Existing tasks, turns, pull requests and documents do not become reviews. A task with no review rows behaves exactly as before.

## What a capture pins

A code submission requires a clean checkout on the task branch with exactly one merge base against the task's base branch. The server creates three refs in the repository, in one create-only transaction:

- `refs/calandria/reviews/<artifactId>/base` points at the merge base.
- `refs/calandria/reviews/<artifactId>/head` points at the submitted head.
- `refs/calandria/reviews/<artifactId>/target` points at the base branch tip.

The review diff reads from these refs. A moved or force-pushed task branch, a deleted worktree and `git gc` do not change what the reviewer sees. Ignored files are outside the submitted artifact.

A document submission accepts `.md` and `.markdown` files inside the task's worktree, up to 1 MiB of valid UTF-8. The server reads the bytes through an open file handle, re-checks the file's identity, and reads again to compare SHA-256. BOM, CRLF and non-ASCII bytes are stored unchanged. A symlink is followed only inside the worktree, and the manifest records both the requested path and the resolved path, so retargeting a link changes applicability. A document review may be captured from a dirty worktree because the stored bytes are the artifact; save the editor first.

## Endpoints

| Route | Returns |
|-|-|
| `GET /api/tasks/{id}/reviews` | Current requests and one page of history. `request_id`, `limit` (1 to 100, default 50) and `cursor` are optional. |
| `GET /api/tasks/{id}/reviews/{requestId}/submissions/{submissionId}/artifact` | The exact manifest, plus a diff preview (code) or the document text. The code preview stops at 2 MiB or 1,000 changed paths and says so in `truncated` and `reason`. |
| `.../artifact/raw` | The stored document bytes as `text/markdown;charset=utf-8` with the SHA-256 as the `ETag`. Code artifacts answer 422. |
| `POST /api/tasks/{id}/reviews/{requestId}/actions` | A person's decision. See [Decisions](#decisions). |

Every path segment is checked against its parent, and an unknown or mismatched id is a 404. Errors have the shape `{error:{code,message,retryable},current?}`. Messages never contain host paths.

The submission service is `submitReview()` in `lib/reviews/submit.ts`. The decision service is `performReviewAction()` in `lib/reviews/actions.ts`.

## Decisions

`POST /api/tasks/{id}/reviews/{requestId}/actions` takes `{submissionId, expectedVersion, action, idempotencyKey, reason?}` and returns `{requestId, submissionId, version, state, action:{id, state, decisionApplied, errorCode, operation}}`. The browser sends an action; no agent tool can. The actor is set by the server: `instance-owner` in local mode and the verified Access subject otherwise. A request that carries a service token or a bearer credential is refused with 403 `human_required`, and a body that names an actor is a 400.

| Action | Effect |
|-|-|
| `accept` | `pending` to `accepted`, when the artifact is still current and its pins resolve. It writes nothing else: no merge, no completion, no reclaim, no dependent launch. |
| `request_changes` | `pending` to `changes_requested` and a feedback delivery to the submitting task. Needs a reason. Returns 202. |
| `withdraw` | `pending` or `changes_requested` to `withdrawn`. Needs a reason. A required review stays unsatisfied. |
| `waive` | A required review to `waived` for this submission only. Needs a reason. A resubmission restores the requirement. |
| `merge` | A separate operation on an accepted, current code review. Local merges use the accepted head and base tip as pins. PR merges pass the accepted head to GitHub with `--match-head-commit`, so a push after the last read fails the merge. Every project landing rule still applies. |
| `retry_feedback` | Resends feedback left `failed` or `indeterminate`. The reason records that the agent may receive it twice. It creates a new action that links the earlier one. |

Competing decisions are resolved by compare-and-swap on the request version. A repeated idempotency key with the same payload returns the stored status and body, even after the version has moved. The same key with a different payload is 409 `idempotency_conflict`. A stale `expectedVersion` is 409 `version_conflict` with the `current` version and state, and a newer revision is 409 `revision_changed`. Accepting from `changes_requested` is refused; the agent resubmits first.

Every action row is stored as `pending` before any external effect, so a crash leaves a row to read instead of a silent success.

### Feedback delivery

A request for changes is delivered to the task and generation that submitted the work. The delivery state lives in the action's `operation` and moves only forward:

| `delivery` | Meaning |
|-|-|
| `queued` | Stored, nothing sent. Parked behind a live turn, or waiting for a free task. Safe to retry. |
| `dispatching` | Intent is recorded and the text went to the task. Never resent automatically. |
| `delivered` | A model output followed the input in the turn that received it. `acceptedAt` and `acceptanceEvidence` are set. |
| `failed` | Nothing reached the agent. `errorCode` is `generation_changed`, `task_deleted`, `launch_blocked` or `launch_failed`. |
| `indeterminate` | The text may have reached the agent without proof, for example after a restart or a turn that ended with no output. Only `retry_feedback` resolves it. |

`recordedAt` is the transcript insertion time and never proves delivery. The delivery turn runs through the normal launcher, so it advances the content epoch and the agent's resubmission captures the new one. A `/clear` between the decision and the delivery fails the delivery with `generation_changed`; feedback is never sent to the newest session.

### Merge outcomes

A failed merge leaves the review `accepted` with a separate `failed` action (`merge_conflict`, `merge_dirty_checkout`, `merge_head_moved`, `merge_base_moved`, `merge_failed`). After a timeout or restart the action is `indeterminate` (`merge_unverified`, `restart_during_merge`). A retry reads the target branch or the PR before it does anything: a landing it finds is recorded and never repeated. An armed auto-merge returns 202 `pending` and the PR poll settles it. Success is reported only with a `landed` receipt for the accepted head.

### Landed receipts

The review merge, `merge`, `merge/prepare`, `merge/complete` and `pr/merge` each mint a `landed` receipt after a verified landing of the accepted head, and the PR poll mints one when a merged PR's head equals it. The evidence is `{repositoryId, submittedHeadSha, targetRef, baseBeforeSha, resultCommitSha, mode, prNumber, observedAt}`. For a PR landing GitHub does not report the base tip before the merge, so `baseBeforeSha` is the base tip the review was captured against. A landing of any other head mints nothing, and the task stays blocked.

## The Review tab

A task with at least one review request shows a REVIEW tab after CONTEXT in the session rail (DIFF, PREVIEW when enabled, CONTEXT, REVIEW). On a phone the Chat and Changes control gains a third Review segment. A task with no review request shows neither. A dot on the tab means a request is waiting for a decision.

The tab shows what the agent explicitly submitted, read from the stored manifest and the review-owned refs. It never reads the task branch or an open editor for the artifact itself.

| Part | Shows |
|-|-|
| Summary | Revision, kind, pinned `base → head` (code) or path and SHA-256 (document), the required tag, whether the task still matches, the agent's summary, evidence links, and the agent's validation claims marked as unverified |
| Artifact | A code diff preview, labelled `PREVIEW TRUNCATED` when it hit the size or path limit, or the document's exact bytes with the digest and a download of the raw bytes |
| Decision | Accept, Request changes and, on a required review, Waive with a reason, plus the state for accepted, accepted then changed, changes requested, unknown or failed delivery, waived, withdrawn and superseded |
| Revisions | Every revision, newest first. Selecting an older one shows it as superseded, with a link back to the current revision |

When a request's checkout no longer matches the captured revision, the links that open the Diff tab or the document editor are disabled and say why, because both show the live branch or file. The captured text on screen stays the submitted version.

A Work Center review chip opens the task on this tab, selects the chip's request and revision, and moves focus to the summary heading. The destination carries `reviewRequestId` and `submissionId` from the attention item.

### Decision controls

Each click mints one idempotency key, and Retry reuses it, so a retry after a lost reply replays the stored receipt and never applies twice. The buttons offered follow the request's `allowedActions`.

| Control | Behavior |
|-|-|
| Accept rev N | Posts `accept` for the current revision and version. It records approval only. The Accepted state links to the landing controls in the DIFF tab, where a merge and its failure are shown. |
| Request changes | Opens a feedback field. Send posts `request_changes`; the strip then follows the delivery state (`queued` or `dispatching`, delivered, failed, indeterminate). |
| Waive… | Opens a reason field. Waive posts `waive` with that reason. |
| Retry delivery | On failed or unknown delivery, enabled once "The agent may receive this twice" is ticked. Posts `retry_feedback` with the fixed reason `Retry acknowledged: the agent may receive this feedback twice.` and the agent receives the original feedback again. |
| Ask agent to resubmit | On an acceptance whose revision changed. Focuses the transcript composer, empty, on the Chat segment on a phone. No review operation. |

A reply that never arrives shows "Unknown result" with Retry held until "May duplicate" is ticked. A refusal with 5xx or 4xx other than a conflict shows the status and keeps Retry. A 404 or 409 that means the review moved (`version_conflict`, `revision_changed`, `source_changed`, `request_expired`, `idempotency_conflict`) shows the server's message with Dismiss only, and Dismiss refetches. Feedback that was not recorded stays in the field. A resubmission replaces the old revision's controls and any open form.

The Work Center row offers Accept rev N and Waive… inline when a pending review is the row's first live item. It reads the request first and offers neither unless the request's current submission and version still match the item. The phone action sheet offers Accept. A task whose required review was withdrawn, sent back, or accepted and then changed carries the waiting reason "Required review unsatisfied".

## Agent tools

An agent submits, reads and withdraws through three tools, mounted in process for Claude and over the stdio bridge for every other agent (`lib/reviews/tool.ts`, `app/api/internal/agent-tools/{submit,get,withdraw}-review/`). The submitter is always the calling task. The tools cannot accept, waive, merge or complete anything.

| Tool | Parameters |
|-|-|
| `submit_review` | `requestId`, `expectedVersion`, `expectedSubmissionId`, `outputKey`, `kind`, `required`, `summary`, `requestedDecision`, `evidence`, `validation`, `idempotencyKey`, `artifact` |
| `get_review` | `requestId?`, `limit?`, `cursor?` |
| `withdraw_review` | `requestId`, `expectedVersion`, `idempotencyKey`, `reason` |

First submission for an output key:

```json
{"requestId":null,"expectedVersion":0,"expectedSubmissionId":null,"outputKey":"implementation","kind":"code","required":true,"summary":"Adds the guard","requestedDecision":"Accept or request changes","evidence":[],"validation":[{"command":"npm test","result":"passed"}],"idempotencyKey":"impl-1","artifact":{"kind":"code"}}
```

To revise, pass the request id, its current `version` and its current submission id. A withdrawal retires the agent's ask and leaves a required condition unsatisfied.

## Completion safeguards

A task that owns a required review is held by one rule, `requiredReviewBlocker()` in `lib/reviews/guard.ts`: every required request must be accepted for an artifact that is still current, landed or retired, or be waived. A task with no required request is unaffected, and an optional review never blocks. A synchronous check inside `updateTask()` and the delete helpers enforces the rule at the point of the write, and an async check against the live checkout runs first on the paths that already await git.

| Path | Behavior while a required review is unsatisfied |
|-|-|
| `updateTask()` to `done` or `cancelled` (task PATCH, `update_task`, agent-edit revert) | Refused with `review_required` (409 from routes) |
| Dependency `blocks()`, auto-start, deferred start, first turn | A terminal blocker keeps blocking; an automatic launch and the first turn of a dependent each revalidate every blocker against its checkout |
| `merge`, `merge/prepare`, `merge/complete`, `pr/merge` | Refused with 409 `review_required` |
| `reclaimTask`, `maybeAutoReclaim`, worktree sweep, retention prune | The task and its checkout are skipped |
| `deleteTask`, `deleteProject` | Refused; `?review_disposition=waive_and_delete` waives each request in place with one `waive` action per request, then deletes. Refused with `operation_pending` while any action on the task's requests is pending or indeterminate |
| `moveTasks` | Refused unless the task is named in the reset set, which waives and advances the epoch. The move preview names the review, and the move routes demand the unsafe-discard acknowledgement for that task before waiving it |

A new turn, a message accepted into a lingering session, reopening a terminal task, retargeting the base branch, catching the checkout up to the base and a worktree repair that re-cuts the checkout each advance the task's content epoch, so an earlier acceptance has to be resubmitted. Review acceptance alone never starts a dependent.

## Integrity checks to know about

- Each repository gets a random marker file, `calandria-review-repository-id`, in its Git common directory. The database must agree with it on every artifact read. A missing or different marker makes the artifacts for that repository unavailable. A clone that carries a marker the database does not know is not adopted automatically.
- Document and code applicability is `current`, `landed`, `retired`, `changed` or `unavailable`. A change of the task's content epoch, branch head, base tip, document digest or resolved path is `changed`. Historical acceptance is never edited.
- A `landed` receipt records that the accepted head reached the base. The landing moves the base, so a landed code artifact is compared on the task branch alone: a commit past the landed head is `changed`, and a checkout that is gone or detached leaves it `landed`. A `retired` receipt passes without a checkout. `landed` receipts are written by the landing paths listed under Decisions. `retired` receipts need a succeeded cleanup journal, and no journal writer exists yet, so none are minted.
- External processes ignore Calandria's locks. Capture detects changes it can observe by reading twice; it cannot rule out a write that lands after the final read.

## Migration

Schema version 10 adds the tables above and `tasks.review_content_epoch` (default 0). Version 11 adds `messages.review_action_id`, `pending_messages.review_action_id` (both unique where set) and `tasks.active_review_action_id`. The migrations are additive and idempotent: running them again changes nothing, and existing rows are untouched. `tests/reviewMigration.test.ts` upgrades a version-9 database twice and compares rows, tables and indexes.

## Retention

- Review history and its pinned refs stay for as long as the owner task exists. No automatic prune ships.
- Review tables use `RESTRICT` foreign keys and copy the owner task and session ids into their own columns, so session and message retention cannot remove them.
- Deleting a task that owns reviews needs an explicit disposition for each review and the cleanup journal in `review_cleanup_jobs`. That deletion path ships with the decision work.

## Backup and rollback

- A database backup alone cannot restore code reviews. The pinned objects live in the Git repositories. Back up each repository that has review refs together with the database, and keep the marker file.
- Once any review exists, do not roll back to a build that predates review guards. That build would complete or delete tasks whose required review is unresolved, and the boot gate refuses a database stamped with a newer schema version.
- Turning the flag off does not authorize a rollback. Keep the current build while the existing requests are resolved or waived, or restore a database and repository backup taken together and accept the loss of later work.
