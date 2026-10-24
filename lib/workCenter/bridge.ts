// Connects the process's change signals to the Work Center sequence and the
// global SSE feed (contract work-center/1).
//
// Every source mutation in this app already publishes a coarse event on the
// global bus (task_edited, task_updated, ask/permission and their settlements,
// turn_end, task_deleted, tasks_moved, ...). One internal subscriber turns each
// of those into a sequence bump, and a coalesced `work_center_changed` event
// follows once the bump settles. The sequence moves BEFORE the notification,
// so a snapshot fetched on the notification is never older than the sequence
// it announces. Installed lazily by the first caller that needs it; a snapshot
// assembled before installation could not have missed a mutation, because
// assembly installs it first.

import { publishGlobal, subscribeGlobal } from "@/lib/events";
import { bumpWorkCenter, subscribeWorkCenter, workCenterEpoch, workCenterSequence } from "./execution";
import { workCenterInstanceId } from "@/lib/store";

declare global {
  // eslint-disable-next-line no-var
  var __calandriaWorkCenterBridge: { installed: boolean; timer: ReturnType<typeof setTimeout> | null } | undefined;
}

// Events that carry no source change of their own.
const IGNORED = new Set(["work_center_changed", "notification", "updates_changed", "environment_changed", "agent_auth"]);

export function ensureWorkCenterBridge(): void {
  const st = (global.__calandriaWorkCenterBridge ??= { installed: false, timer: null });
  if (st.installed) return;
  st.installed = true;
  subscribeGlobal((_taskId, ev) => {
    if (IGNORED.has(ev.type)) return;
    bumpWorkCenter();
  }, { internal: true });
  subscribeWorkCenter(() => {
    if (st.timer) return;
    st.timer = setTimeout(() => {
      st.timer = null;
      publishGlobal("", { type: "work_center_changed", ...workCenterTransport() });
    }, 25);
    st.timer.unref?.();
  });
}

/** The transport identity every wire event and snapshot carries. */
export function workCenterTransport(): { version: 1; instanceId: string; instanceEpoch: string; sequence: number } {
  return { version: 1, instanceId: workCenterInstanceId(), instanceEpoch: workCenterEpoch(), sequence: workCenterSequence() };
}
