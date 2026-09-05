// Pins the withdraw_suggestion lifecycle at the route level. Eligibility,
// the required reason and the bus event are pinned in
// tests/agentTools.test.ts; this file covers reviving a withdrawn
// suggestion and the auto-start sweep on the cancel transition, a path
// shared with the user-facing PATCH.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocked at the same boundary as autoStart.test.ts: asserts a turn was
// launched with the right shape, not that it ran.
vi.mock("@/lib/runner", () => ({ startTurn: vi.fn() }));

import { startTurn } from "@/lib/runner";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import { createProject, createTask, getTask, setTaskDeps, updateTask } from "@/lib/store";
import { createSuggestedTask, withdrawSuggestionForAgent } from "@/lib/agentTools";
import { isWithdrawn, withdrawnLast } from "@/app/shell/format";
import type { TaskRow } from "@/app/shell/types";
import { tmpDir } from "./helpers";

const startTurnMock = vi.mocked(startTurn);
beforeEach(() => startTurnMock.mockClear());

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: Record<string, unknown>) =>
  patchTask(new Request("http://test", { method: "PATCH", body: JSON.stringify(body) }), params(id));

/** A live session and a suggestion it filed, in one project. */
function board(name: string) {
  const project = createProject({ name, repo_path: tmpDir("withdraw-") });
  const caller = createTask({ project_id: project.id, title: "Caller" });
  updateTask(caller.id, { started: 1, running: 1 });
  const inert = createSuggestedTask(project, { title: "Proposed", description: "the brief" }).task!;
  return { project, caller, inert };
}

describe("reviving a withdrawn suggestion", () => {
  // The tray's Add and Start both patch only `suggested: 0`. On a withdrawn
  // suggestion that alone would land a cancelled task in the Cancelled
  // column with the agent's retraction note still attached, so the route
  // clears both fields together instead of leaving each caller to remember.
  it("Add / Start clears the cancel AND the reason in one write", async () => {
    const { caller, inert } = board("Revive-Add");
    withdrawSuggestionForAgent(caller, inert.id, "already covered by the parser rewrite");
    expect(getTask(inert.id)).toMatchObject({ status: "cancelled", suggested: 1 });

    await patch(inert.id, { suggested: 0 });
    expect(getTask(inert.id)).toMatchObject({ status: "not_started", suggested: 0, withdrawn_reason: "" });
  });

  it("an explicit status wins over the default — the board's drag decides where it lands", async () => {
    const { caller, inert } = board("Revive-Drag");
    withdrawSuggestionForAgent(caller, inert.id, "redundant");
    // Dragging a suggested card into "In progress" sends both fields.
    await patch(inert.id, { suggested: 0, status: "in_progress" });
    expect(getTask(inert.id)).toMatchObject({ status: "in_progress", suggested: 0, withdrawn_reason: "" });
  });

  it("re-statusing it in place keeps it in the tray but drops the retraction", async () => {
    const { caller, inert } = board("Revive-Status");
    withdrawSuggestionForAgent(caller, inert.id, "redundant");
    await patch(inert.id, { status: "not_started" });
    // Reverting the retraction alone keeps it in the tray as a live
    // suggestion, without the strikethrough.
    expect(getTask(inert.id)).toMatchObject({ status: "not_started", suggested: 1, withdrawn_reason: "" });
  });

  it("an unrelated edit leaves the withdrawal exactly as it was", async () => {
    const { caller, inert } = board("Revive-Untouched");
    withdrawSuggestionForAgent(caller, inert.id, "redundant");
    await patch(inert.id, { priority: "hi" });
    expect(getTask(inert.id)).toMatchObject({ status: "cancelled", suggested: 1, withdrawn_reason: "redundant" });
  });
});

describe("how the tray tells a withdrawn suggestion from a live one", () => {
  // Both the list tray and the board's Suggested column render off these
  // two helpers to distinguish a withdrawn suggestion from a live one.
  const row = (id: string, over: Partial<TaskRow> = {}) => ({ id, suggested: 1, status: "not_started", withdrawn_reason: "", ...over }) as TaskRow;

  it("is the STATE, not the reason text, that marks a card withdrawn", () => {
    expect(isWithdrawn(row("live"))).toBe(false);
    expect(isWithdrawn(row("gone", { status: "cancelled", withdrawn_reason: "redundant" }))).toBe(true);
    // A suggestion cancelled through the edit dialog reads as withdrawn too;
    // the reason text only affects what is shown, not whether it qualifies.
    expect(isWithdrawn(row("gone-quiet", { status: "cancelled" }))).toBe(true);
    // A cancelled task that isn't in the tray is an ordinary cancelled task.
    expect(isWithdrawn(row("real", { suggested: 0, status: "cancelled" }))).toBe(false);
  });

  it("sinks withdrawn cards below live ones, stably", () => {
    const cards = [
      row("a"),
      row("b", { status: "cancelled" }),
      row("c"),
      row("d", { status: "cancelled" }),
    ];
    // Live cards and withdrawn cards each keep their manual order: the sort
    // partitions the list into two groups instead of reordering it.
    expect([...cards].sort(withdrawnLast).map((t) => t.id)).toEqual(["a", "c", "b", "d"]);
  });
});

describe("PATCH /api/tasks/[id] sweeps auto-start dependents on cancel", () => {
  // blocks() counts cancelled as cleared, so the auto-start sweep must fire
  // on any non-terminal-to-terminal transition, including into cancelled, or
  // an auto_start dependent behind a cancelled blocker never launches. The
  // scheduling decision depends on the resulting state, not on which
  // endpoint produced it.
  it("cancelling the last blocker launches the dependent", async () => {
    const project = createProject({ name: "Cancel-Sweep", repo_path: tmpDir("cancel-sweep-") });
    const a = createTask({ project_id: project.id, title: "A" });
    const b = createTask({ project_id: project.id, title: "B", description: "build on A" });
    setTaskDeps(b.id, [a.id]);
    updateTask(b.id, { auto_start: 1 });

    await patch(a.id, { status: "cancelled" });
    await vi.waitFor(() => expect(startTurnMock).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const [task, , , note] = startTurnMock.mock.calls[0];
    expect(task.id).toBe(b.id);
    expect(note).toContain('"A" was cancelled');
  });

  it("doesn't re-sweep a blocker moving between two terminal statuses", async () => {
    // cancelled → done clears nothing that was not already clear. The launch
    // re-checks under the task lock, so firing again would be harmless, but
    // the guard avoids a claim-and-release churn on every terminal edit by
    // keying on the transition instead of the resulting status.
    const project = createProject({ name: "Cancel-Terminal", repo_path: tmpDir("cancel-terminal-") });
    const a = createTask({ project_id: project.id, title: "A" });
    const b = createTask({ project_id: project.id, title: "B" });
    setTaskDeps(b.id, [a.id]);
    updateTask(b.id, { auto_start: 1 });
    updateTask(a.id, { status: "cancelled" });

    await patch(a.id, { status: "done" });
    expect(startTurnMock).not.toHaveBeenCalled();
  });
});
