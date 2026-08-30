/**
 * The "Blocked by" picker's candidate list.
 *
 * A blocker gates whether a dependent may START, and `blocks()` in
 * lib/autoStart.ts treats done AND cancelled as terminal. So offering a
 * terminal task as a blocker is offering an edge that is inert the moment it
 * is drawn — the picker leaves them out rather than showing a choice that
 * means nothing.
 *
 * The one exception is an edge that ALREADY exists: a blocker the user picked
 * while it was live and which has since finished must stay on screen, or the
 * only way to remove it would be gone.
 */
import { describe, it, expect } from "vitest";
import { blockerCandidates, alphabetical, isTerminal } from "@/app/shell/format";
import type { TaskRow } from "@/app/shell/types";

const row = (id: string, title: string, status: TaskRow["status"]) =>
  ({ id, title, status }) as TaskRow;

describe("blockerCandidates", () => {
  const all = [
    row("z-running", "Zebra wrangling", "in_progress"),
    row("d-done", "Aardvark audit", "done"),
    row("c-cancelled", "Badger bikeshed", "cancelled"),
    row("n-new", "Marmot migration", "not_started"),
    row("h-hold", "Otter overhaul", "on_hold"),
  ];

  it("drops done and cancelled tasks", () => {
    const ids = blockerCandidates(all, []).map((t) => t.id);
    expect(ids).not.toContain("d-done");
    expect(ids).not.toContain("c-cancelled");
    expect(ids.sort()).toEqual(["h-hold", "n-new", "z-running"]);
  });

  it("keeps a terminal task that is already selected, so the edge stays removable", () => {
    const ids = blockerCandidates(all, ["d-done"]).map((t) => t.id);
    expect(ids).toContain("d-done");
    expect(ids).not.toContain("c-cancelled");
  });

  it("sorts alphabetically by title, not by the caller's order", () => {
    const titles = blockerCandidates(all, ["d-done", "c-cancelled"]).map((t) => t.title);
    expect(titles).toEqual([
      "Aardvark audit",
      "Badger bikeshed",
      "Marmot migration",
      "Otter overhaul",
      "Zebra wrangling",
    ]);
  });

  it("does not mutate the array it was given", () => {
    const input = [row("b", "Beta", "not_started"), row("a", "Alpha", "not_started")];
    blockerCandidates(input, []);
    expect(input.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("has nothing to offer when every other task is terminal", () => {
    expect(blockerCandidates([row("d", "Done thing", "done")], [])).toEqual([]);
  });
});

describe("alphabetical", () => {
  it("ignores case, so a picker list doesn't split on capitalization", () => {
    const names = ["auth migration", "Auth cleanup", "Billing"].sort(alphabetical);
    expect(names).toEqual(["Auth cleanup", "auth migration", "Billing"]);
  });
});

describe("isTerminal", () => {
  it("agrees with blocks() about which statuses are the end of the line", () => {
    expect(isTerminal({ status: "done" })).toBe(true);
    expect(isTerminal({ status: "cancelled" })).toBe(true);
    for (const s of ["not_started", "in_progress", "on_hold"] as const) {
      expect(isTerminal({ status: s })).toBe(false);
    }
  });
});
