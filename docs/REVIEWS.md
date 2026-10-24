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

Every path segment is checked against its parent, and an unknown or mismatched id is a 404. Errors have the shape `{error:{code,message,retryable},current?}`. Messages never contain host paths.

The submission service is `submitReview()` in `lib/reviews/submit.ts`. The decision routes call it and the store; they are a separate task of the Work Center plan.

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
| Dependency `blocks()`, auto-start, deferred start, first turn | A terminal blocker keeps blocking; launch revalidates each blocker against its checkout |
| `merge`, `merge/prepare`, `merge/complete`, `pr/merge` | Refused with 409 `review_required` |
| `reclaimTask`, `maybeAutoReclaim`, worktree sweep, retention prune | The task and its checkout are skipped |
| `deleteTask`, `deleteProject` | Refused; `?review_disposition=waive_and_delete` waives each request in place, then deletes |
| `moveTasks` | Refused unless the task is named in the reset set, which waives and advances the epoch |

A new turn, reopening a terminal task, retargeting the base branch and catching the checkout up to the base each advance the task's content epoch, so an earlier acceptance has to be resubmitted. Review acceptance alone never starts a dependent.

## Integrity checks to know about

- Each repository gets a random marker file, `calandria-review-repository-id`, in its Git common directory. The database must agree with it on every artifact read. A missing or different marker makes the artifacts for that repository unavailable. A clone that carries a marker the database does not know is not adopted automatically.
- Document and code applicability is `current`, `landed`, `retired`, `changed` or `unavailable`. A change of the task's content epoch, branch head, base tip, document digest or resolved path is `changed`. Historical acceptance is never edited.
- External processes ignore Calandria's locks. Capture detects changes it can observe by reading twice; it cannot rule out a write that lands after the final read.

## Migration

Schema version 10 adds the tables above and `tasks.review_content_epoch` (default 0). The migration is additive and idempotent: running it again changes nothing, and existing rows are untouched. `tests/reviewMigration.test.ts` upgrades a version-9 database twice and compares rows, tables and indexes.

## Retention

- Review history and its pinned refs stay for as long as the owner task exists. No automatic prune ships.
- Review tables use `RESTRICT` foreign keys and copy the owner task and session ids into their own columns, so session and message retention cannot remove them.
- Deleting a task that owns reviews needs an explicit disposition for each review and the cleanup journal in `review_cleanup_jobs`. That deletion path ships with the decision work.

## Backup and rollback

- A database backup alone cannot restore code reviews. The pinned objects live in the Git repositories. Back up each repository that has review refs together with the database, and keep the marker file.
- Once any review exists, do not roll back to a build that predates review guards. That build would complete or delete tasks whose required review is unresolved, and the boot gate refuses a database stamped with a newer schema version.
- Turning the flag off does not authorize a rollback. Keep the current build while the existing requests are resolved or waived, or restore a database and repository backup taken together and accept the loss of later work.
