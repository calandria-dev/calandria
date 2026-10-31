import type { Project } from "@/lib/types";

export interface DivergenceFacts {
  /** The remote-tracking label, e.g. "origin/main". */
  label: string;
  /** Commits on the local base branch that the remote lacks. */
  ahead: number;
  /** Commits on the remote that the local base branch lacks. */
  behind: number;
  localTip: string;
  remoteTip: string;
}

/** Title of the task the base-branch banner's "Fix with AI" button mints. */
export function divergenceTaskTitle(project: Pick<Project, "branch">, facts: DivergenceFacts): string {
  return `Reconcile diverged ${project.branch} with ${facts.label}`;
}

/**
 * The first message of a "Fix with AI" task. The session runs in its own
 * worktree, while the diverged branch lives in the project's main checkout,
 * so the prompt names both and says which one each step happens in.
 *
 * The order of preference is fixed: drop local commits only after proving the
 * remote already has their content, carry anything genuinely unpublished to a
 * pull request (or a push, when the project lands by local merge), and never
 * force-push the remote base branch.
 */
export function buildDivergencePrompt(
  project: Pick<Project, "repo_path" | "branch" | "landing_mode">,
  facts: DivergenceFacts,
): string {
  const base = project.branch;
  const label = facts.label;
  const plural = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
  const publish =
    project.landing_mode === "pr"
      ? `${base} only takes pull requests. Put the unpublished commits on your own task branch (cherry-pick them onto ${label} in your worktree), and open a pull request against ${base} with the create_pr tool.`
      : `Rebase the unpublished commits onto ${label} in your worktree, then show me the result. Push to ${label} only after I approve it; if the push is refused as a protected branch, open a pull request with the create_pr tool instead.`;
  return [
    `The local ${base} branch of this project has diverged from ${label}: it has ${plural(facts.ahead)} that ${label} lacks, and ${label} has ${plural(facts.behind)} that local ${base} lacks.`,
    "",
    `- Main checkout: ${project.repo_path} (local ${base} lives here)`,
    `- Local ${base} tip: ${facts.localTip || "(unknown)"}`,
    `- ${label} tip: ${facts.remoteTip || "(unknown)"}`,
    "",
    `Your session runs in its own worktree on a task branch. Git will not let you check out ${base} there while the main checkout holds it, so run commands that inspect or move local ${base} with \`git -C ${project.repo_path}\`.`,
    "",
    "Reconcile the two so that local and remote agree again, without losing work:",
    "",
    `1. Fetch, then list the local-only commits: \`git -C ${project.repo_path} log --oneline ${label}..${base}\`.`,
    `2. For each one, decide whether ${label} already contains its change. Pull requests that were squash-merged or rebased on the remote are the usual cause, and they leave the original commits behind with new ids. Compare content (\`git cherry\`, \`git range-diff\`, or the diff of each commit against ${label}), not commit ids.`,
    `3. Any commit whose change is NOT on ${label} is unpublished work. ${publish}`,
    `4. Once every local-only commit is either proven present on ${label} or carried to the branch from step 3, move local ${base} to ${label}. Check \`git -C ${project.repo_path} status\` first: if the main checkout has uncommitted changes, stop and tell me instead of touching it. Use \`git -C ${project.repo_path} reset --keep ${label}\` when ${base} is checked out there, or \`git -C ${project.repo_path} branch -f ${base} ${label}\` when it is not.`,
    "",
    `Never force-push ${base} and never discard a commit you have not proven is already on ${label}. If anything is ambiguous, stop and ask me. Finish with a short report: which commits were already upstream, which were carried over and where, and the final state of local ${base}.`,
  ].join("\n");
}
