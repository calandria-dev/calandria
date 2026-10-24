# Review decision safety checklist

For the final policy and concurrency verification of the Work Center review decisions (WC-18). Each row names the property, where it is enforced, and the test that pins it. Run the tests with `npx vitest run tests/reviewActions.test.ts tests/reviewRecovery.test.ts tests/reviewLanding.test.ts tests/reviewActionFixtures.test.ts tests/reviewGateSafety.test.ts`.

## Authority

| Property | Enforced in | Test |
|-|-|-|
| The actor is set by the server and never read from the body | `lib/reviews/actor.ts`, `parseActionBody` (unknown field is a 400) | `reviewActions`: human-only boundary |
| A service-token, bearer or capability request is refused as human authority (403 `human_required`) | `resolveHumanActor` | `reviewActions`: human-only boundary |
| No agent transport can accept, waive, merge or retry | Only `POST .../actions` carries those actions; the three agent tools are submit, get and withdraw | `reviewTools` |
| Accept, merge and waive each re-check applicability under the task lock | `lib/reviews/actions.ts` | `reviewActions`: accept, merge |
| Disposition waivers (delete, move reset) require a server-resolved human actor and refuse a bearer or service-token request | `waiveRequired`, the task and project DELETE routes, `discardCheckout` | `reviewRecovery`: destructive dispositions |

## Atomicity and replay

| Property | Enforced in | Test |
|-|-|-|
| One of two competing decisions wins; the loser gets 409 `version_conflict` with `current` | Task lock plus a compare-and-swap `UPDATE ... WHERE version = ?` in one IMMEDIATE transaction (`commitDecision`) | `reviewActions`: competing keys |
| A known key with the same payload returns the stored status and body at any later version | `getActionByKey` before the version check | `reviewActions`: replay |
| A known key with a different payload is 409 `idempotency_conflict` | Payload hash over the canonical request | `reviewActions`: reused key |
| A newer revision is 409 `revision_changed`; a stale version is 409 `version_conflict` | `run()` | `reviewActions` |
| The action row is stored `pending` before any external effect | `commitDecision` before `landLocal` and `landPr`; `commitFeedback` before `deliverFeedback` | `reviewRecovery` |

## Separation of outcomes

| Property | Enforced in | Test |
|-|-|-|
| Accept writes `accepted` and nothing else: no `done`, no merge, no receipt | `accept()` | `reviewActions`: accept |
| Accept from `changes_requested` is refused | `accept()` state check | `reviewActions`: accept |
| A failed merge leaves the review `accepted` with a separate failed action | `merge()` | `reviewActions`: merge failure |
| Merge never writes task `done`; completion and reclaim stay separate steps | `succeedLocal` writes `merged_at` and `base_sha` only | `reviewActions`: merge |
| `waive_and_delete` and a move reset refuse with `operation_pending` while any action is pending or indeterminate | `waiveRequired`, the task and project DELETE routes, `previewDiscard` teardown | `reviewRecovery`: destructive dispositions |
| Each waived request gets one `waive` action (human actor, reason `waive_and_delete` or `move_reset`) | `waiveRequired` | `reviewRecovery`: destructive dispositions |

## External effects

| Property | Enforced in | Test |
|-|-|-|
| A PR merge passes the accepted head to GitHub (`--match-head-commit`), including on the squash fallback | `mergeTaskPr` | `reviewRecovery`, `reviewLanding` |
| A local merge refuses if the branch or base tip moved since capture, and commits nothing on the way | `mergeTask` `expectedHeadSha` and `expectedBaseSha` | `reviewActions`: branch moved |
| Every local landing route (`/merge`, `/merge/prepare`, `/merge/complete`) passes the accepted head and base pins to `mergeTask`, which merges the pinned commit and commits nothing on the way | `acceptedCodePins`, the three routes, `completeWorktreeMerge` | `reviewLandingPins` |
| After a timeout or restart the PR or target is read before any retry; a landing found is recorded, not repeated | `reconcileMerges`, `observedPrLanding` | `reviewRecovery` |
| A success with no verifiable landing stays indeterminate (`merge_unverified`, `landing_unverified`) | `landPr`, `succeedLocal` | `reviewRecovery` |
| A `landed` receipt is minted only for the accepted head, from the review merge, `merge`, `merge/prepare`, `merge/complete`, `pr/merge` and the PR poll | `lib/reviews/landing.ts` | `reviewLanding` |
| The unsupported boundary: GitHub offers no expected-base compare-and-swap, so a PR receipt records the reviewed base tip as `baseBeforeSha` | `onPrSettled` | `docs/REVIEWS.md` |

## Feedback delivery

| Property | Enforced in | Test |
|-|-|-|
| Feedback goes to the submitting task and generation; a changed generation fails and never reaches the newest session | `deliver()` | `reviewRecovery`: generation |
| Dispatch intent is stored before any send, and a restart turns `dispatching` into `indeterminate` | `markFeedbackDispatching`, `settleReviewEffects` | `reviewRecovery`: restart |
| `delivered` needs a model output after the input; a transcript row (`recordedAt`) never proves it | `settleFeedbackAccepted` in the runner | `reviewActions`, `reviewRecovery` |
| A handoff with no correlated output is `indeterminate` and never resent | `settleFeedbackUnconfirmed` | `reviewRecovery`: no correlated output |
| Only an explicit `retry_feedback` resends, as a new action linked to the old one | `retryFeedback` | `reviewRecovery` |
| Queued feedback whose parked copy was lost is delivered once, never twice | `reconcileFeedback`, the scheduler tick | `reviewRecovery` |
| Feedback parked behind unrelated running work reaches the same task once | The runner queue drain carries `review_action_id` | `reviewRecovery` |

## Known limits

- External processes ignore Calandria's locks. A write after the final read cannot be excluded; it is detected on the next check.
- A feedback handed to a lingering session is proven by the next model output only. If the session produces none before it ends, the delivery is `indeterminate`.
- `retired` receipts need a cleanup journal writer that does not exist yet. No `retired` receipt is minted.
