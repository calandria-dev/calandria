// The withdraw_suggestion lifecycle at the ROUTE level: what happens to a
// retracted suggestion after the agent walks away.
//
// The shared logic (eligibility, the required reason, the bus event) is pinned
// in tests/agentTools.test.ts. What's here is the two halves that live outside
// it and would otherwise be nobody's: the user's way BACK from a withdrawal,
// and the auto-start sweep on the cancel transition — which is a shared path,
// so fixing it for withdrawals changed the user-facing PATCH too.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Same boundary autoStart.test.ts pins at: we care that a turn was launched
// with the right shape, not that it ran.
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
  // The tray's Add and Start both patch `suggested: 0` and nothing else. On a
  // live suggestion that's enough; on a withdrawn one it would accept a
  // CANCELLED task into the list — filed straight into the Cancelled column,
  // still wearing the agent's retraction note. Both halves have to move
  // together, which is why the route owns the transition rather than each
  // caller: there are three ways in and they'd each have to remember.
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
    // Still a suggestion — the user disagreed with the retraction, not with the
    // suggestion — but no longer struck through.
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
  // Both the list tray and the board's Suggested column render off these two
  // helpers, so they're the one place the visual rule lives. Without them a
  // withdrawn suggestion draws identically to a live one — which would make the
  // whole tool pointless: the user would never see the retraction.
  const row = (id: string, over: Partial<TaskRow> = {}) => ({ id, suggested: 1, status: "not_started", withdrawn_reason: "", ...over }) as TaskRow;

  it("is the STATE, not the reason text, that marks a card withdrawn", () => {
    expect(isWithdrawn(row("live"))).toBe(false);
    expect(isWithdrawn(row("gone", { status: "cancelled", withdrawn_reason: "redundant" }))).toBe(true);
    // A suggestion cancelled some other way (the edit dialog) is just as dead
    // and reads the same — the reason is what gets SHOWN, not what qualifies.
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
    // Live cards keep their manual order among themselves, and so do the
    // withdrawn ones — the tray is partitioned, not re-sorted.
    expect([...cards].sort(withdrawnLast).map((t) => t.id)).toEqual(["a", "c", "b", "d"]);
  });
});

describe("PATCH /api/tasks/[id] sweeps auto-start dependents on cancel", () => {
  // The behaviour change this feature forced, and it lands on the UI too: the
  // sweep used to fire only on the transition into done. Since blocks() counts
  // cancelled as cleared, the old code left an auto_start dependent unblocked
  // and unlaunched forever. The scheduling decision follows from the resulting
  // state, not from which endpoint produced it — otherwise the same row means
  // two different things depending on how it got there.
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
    // cancelled → done clears nothing that wasn't already clear. Firing again
    // would be harmless today (the launch re-checks under the task lock) but it
    // is a claim-and-release churn on every terminal edit, and the guard is the
    // thing that says "the TRANSITION is what matters".
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
