// Landing receipts (contract work-center/1). After a landing of the exact head
// a person accepted, a `landed` applicability receipt is what lets the task
// keep passing the required-review guard, be reclaimed and be completed: the
// landing moves the base branch by definition, so the acceptance's base pin can
// no longer be compared live. A receipt is minted only from verified evidence:
// a local merge whose result contains the accepted head, or a PR that GitHub
// reports merged with the accepted head as the PR's head.
//
// Imports the database, git helpers and review store only, so the PR poll and
// every landing route can call it without reaching the runner or an agent SDK.

import { isAncestorCommit, resolveCommit } from "../git";
import { createLogger } from "../log.mjs";
import { getProject, getTask } from "../store";
import { bumpWorkCenter } from "../workCenter/execution";
import { getArtifact, getSubmission, insertApplicabilityReceipt, listRequestsForOwner, listUnsettledMerges, updateActionOutcome } from "./store";
import type { ActionOperation, CodeManifest, MergeOperation } from "./types";

const log = createLogger("review-landing");

export interface Landing {
  taskId: string;
  mode: "local" | "pr";
  /** The base branch the work landed on, as a full ref. */
  targetRef: string;
  /** The base tip before the landing; the reviewed base tip when the pre-merge tip was not observable (PR). */
  baseBeforeSha: string | null;
  resultCommitSha: string;
  /** The head that landed: the work branch tip (local) or GitHub's merged PR head (PR). */
  landedHeadSha: string;
  prNumber: number | null;
}

/** Accepted code requests whose current submission is the landed head at the task's current epoch. */
function matchingSubmissions(taskId: string, landedHeadSha: string): Array<{ submissionId: string; manifest: CodeManifest }> {
  const task = getTask(taskId);
  if (!task) return [];
  const out: Array<{ submissionId: string; manifest: CodeManifest }> = [];
  for (const req of listRequestsForOwner(taskId)) {
    if (req.kind !== "code" || req.state !== "accepted" || !req.current_submission_id) continue;
    const sub = getSubmission(req.current_submission_id);
    const art = sub && getArtifact(sub.artifact_id);
    if (!sub || !art || sub.content_epoch !== task.review_content_epoch) continue;
    const manifest = JSON.parse(art.manifest_json) as CodeManifest;
    if (manifest.headCommitSha !== landedHeadSha) continue;
    out.push({ submissionId: sub.id, manifest });
  }
  return out;
}

/**
 * Mint a `landed` receipt for every accepted code request the landing covers.
 * Never throws: a missed mint leaves the task blocked by the guard, which is
 * the safe direction, and is logged for the person to see.
 */
export async function mintLandedReceipts(landing: Landing): Promise<string[]> {
  const minted: string[] = [];
  try {
    const project = getProject(getTask(landing.taskId)?.project_id ?? "");
    for (const m of matchingSubmissions(landing.taskId, landing.landedHeadSha)) {
      if (landing.mode === "local") {
        if (!project?.repo_path) continue;
        if (!(await isAncestorCommit(project.repo_path, m.manifest.headCommitSha, landing.resultCommitSha))) continue;
      }
      try {
        const row = insertApplicabilityReceipt({
          submissionId: m.submissionId,
          kind: "landed",
          evidence: {
            repositoryId: m.manifest.repositoryId,
            submittedHeadSha: m.manifest.headCommitSha,
            targetRef: landing.targetRef,
            baseBeforeSha: landing.baseBeforeSha ?? m.manifest.baseTipSha,
            resultCommitSha: landing.resultCommitSha,
            mode: landing.mode,
            prNumber: landing.prNumber,
            observedAt: Date.now(),
          },
        });
        minted.push(row.id);
      } catch (e) {
        log.warn("could not record a landed receipt", { task: landing.taskId, submission: m.submissionId, err: e });
      }
    }
  } catch (e) {
    log.warn("landing receipt minting failed", { task: landing.taskId, err: e });
  }
  if (minted.length) bumpWorkCenter();
  return minted;
}

/**
 * The head a person accepted for this task's code review, when there is one at
 * the current epoch. A PR merge passes it to GitHub as the head to match, so a
 * landing can never carry a commit nobody reviewed.
 */
export function acceptedCodeHead(taskId: string): string | null {
  const task = getTask(taskId);
  if (!task) return null;
  for (const req of listRequestsForOwner(taskId)) {
    if (req.kind !== "code" || req.state !== "accepted" || !req.current_submission_id) continue;
    const sub = getSubmission(req.current_submission_id);
    const art = sub && getArtifact(sub.artifact_id);
    if (!sub || !art || sub.content_epoch !== task.review_content_epoch) continue;
    return (JSON.parse(art.manifest_json) as CodeManifest).headCommitSha;
  }
  return null;
}

/** The base tip a local landing is about to move, read before the merge. "" when it does not resolve. */
export async function baseTipBefore(repoPath: string, baseBranch: string): Promise<string> {
  return resolveCommit(repoPath, `refs/heads/${baseBranch}`);
}

/**
 * Mint receipts after a local merge reported success. `mergedSha` is the work
 * branch tip the merge landed; the receipt is minted only when that is the
 * head a person accepted and the base now contains it.
 */
export async function recordLocalLanding(input: {
  taskId: string;
  repoPath: string;
  baseBranch: string;
  baseBeforeSha: string;
  mergedSha: string | undefined;
}): Promise<string[]> {
  if (!input.mergedSha) return [];
  const resultCommitSha = await resolveCommit(input.repoPath, `refs/heads/${input.baseBranch}`);
  if (!resultCommitSha) return [];
  return mintLandedReceipts({
    taskId: input.taskId,
    mode: "local",
    targetRef: `refs/heads/${input.baseBranch}`,
    baseBeforeSha: input.baseBeforeSha || null,
    resultCommitSha,
    landedHeadSha: input.mergedSha,
    prNumber: null,
  });
}

/** What the PR poll knows about a settled PR. */
export interface PrOutcome {
  state: "merged" | "closed";
  headSha: string;
  mergeCommitSha: string;
  baseRef: string;
}

/**
 * The PR poll's hook. A merged PR whose head is the accepted head mints the
 * receipt and settles any review merge action still waiting on it; a PR that
 * merged a different head, or closed unmerged, fails that action instead.
 */
export async function onPrSettled(taskId: string, outcome: PrOutcome): Promise<void> {
  try {
    const task = getTask(taskId);
    if (!task || !task.pr_number) return;
    const merged = outcome.state === "merged" && !!outcome.headSha;
    if (merged) {
      await mintLandedReceipts({
        taskId,
        mode: "pr",
        targetRef: `refs/heads/${outcome.baseRef || task.base_branch || ""}`,
        baseBeforeSha: null,
        resultCommitSha: outcome.mergeCommitSha || outcome.headSha,
        landedHeadSha: outcome.headSha,
        prNumber: task.pr_number,
      });
    }
    settlePrMergeActions(taskId, outcome, task.pr_url ?? null);
  } catch (e) {
    log.warn("could not settle review state from a PR outcome", { task: taskId, err: e });
  }
}

function settlePrMergeActions(taskId: string, outcome: PrOutcome, prUrl: string | null) {
  for (const row of listUnsettledMerges(taskId)) {
    const op = JSON.parse(row.operation_json ?? "null") as MergeOperation | null;
    if (!op || op.mode !== "pr") continue;
    if (outcome.state === "merged" && outcome.headSha === op.expectedHeadSha) {
      const next: ActionOperation = { ...op, resultCommitSha: outcome.mergeCommitSha || null, resultUrl: prUrl };
      updateActionOutcome(row.id, { state: "succeeded", errorCode: null, operation: next });
    } else if (outcome.state === "merged") {
      updateActionOutcome(row.id, { state: "failed", errorCode: "merge_head_changed", operation: op });
    } else {
      updateActionOutcome(row.id, { state: "failed", errorCode: "pr_closed", operation: op });
    }
  }
  bumpWorkCenter();
}
