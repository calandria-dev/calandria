// Pure summary arithmetic for the Work Center (contract work-center/1 with
// amendment 1). One function computes the global summary and every
// per-project summary, so the visible counts cannot drift between scopes.
//
//   known  = how many matching tasks/items are known to exist;
//   value  = known when coverage supports an exact count, otherwise null.
//
// Snoozed needs-you tasks are a subset of needs-you tasks, so the visible
// counts subtract exactly:
//   visibleNeedsYou.known     = needsYou.known     - snoozedNeedsYou.known
//   visibleAttention.known    = attention.known    - (items on snoozed tasks)
// and `value` is that difference only when both inputs have a non-null value.

import type { Attention, Count, Summary } from "./types";

export type TaskTally = {
  taskId: string;
  /** Unresolved attention items on the task. */
  items: number;
  /** `snoozed_until` is still ahead of the assembly's single `now`. */
  snoozed: boolean;
  /** The task might be doing background work nobody can observe. */
  workUnknown: boolean;
  working: boolean;
};

export type SummaryCoverage = {
  /** Every applicable actionable source in this scope was readable. */
  attentionComplete: boolean;
};

export function summarize(tasks: TaskTally[], cov: SummaryCoverage, suggestedTaskCount: number): Summary {
  const working = tasks.filter((t) => t.working).length;
  const workUnknown = tasks.some((t) => !t.working && t.workUnknown);
  const needs = tasks.filter((t) => t.items > 0);
  const snoozed = needs.filter((t) => t.snoozed);
  const itemsAll = needs.reduce((n, t) => n + t.items, 0);
  const itemsSnoozed = snoozed.reduce((n, t) => n + t.items, 0);

  const exact = cov.attentionComplete;
  const needsYou: Count = { value: exact ? needs.length : null, known: needs.length };
  const attention: Count = { value: exact ? itemsAll : null, known: itemsAll };
  // An unobserved item could sit on a snoozed task, so the snoozed count is
  // exact only when the needs-you count is.
  const snoozedCount: Count = { value: needsYou.value === null ? null : snoozed.length, known: snoozed.length };
  const itemsOnSnoozed: Count = { value: attention.value === null ? null : itemsSnoozed, known: itemsSnoozed };

  return {
    workingTaskCount: { value: workUnknown ? null : working, known: working },
    needsYouTaskCount: needsYou,
    attentionItemCount: attention,
    snoozedNeedsYouTaskCount: snoozedCount,
    visibleNeedsYouTaskCount: subtract(needsYou, snoozedCount),
    visibleAttentionItemCount: subtract(attention, itemsOnSnoozed),
    suggestedTaskCount,
  };
}

function subtract(total: Count, part: Count): Count {
  return {
    value: total.value !== null && part.value !== null ? total.value - part.value : null,
    known: total.known - part.known,
  };
}

/**
 * The inline Allow once / Deny offer (amendment 1). Only a live,
 * scope-free, non-settings-drift Claude permission request qualifies; every
 * other item is null. The field never widens what the card itself offers.
 */
export function inlineDecisionOf(i: {
  kind: Attention["kind"];
  live: boolean;
  agent: string;
  requestKind: "settings" | "environment" | undefined;
  offersScope: boolean;
}): Attention["inlineDecision"] {
  return i.kind === "permission" && i.live && i.agent === "claude" && i.requestKind === undefined && !i.offersScope
    ? "allow_once_or_deny"
    : null;
}
