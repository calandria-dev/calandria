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
import { blockerCandidates, alphabetical, isTerminal, isBlocking, blockerTitles } from "@/app/shell/format";
import type { TaskRow } from "@/app/shell/types";

const row = (id: string, title: string, status: TaskRow["status"]) =>
  ({ id, title, status }) as TaskRow;
/** A task still sitting in the Suggested tray — nobody has agreed to do it yet. */
const sugg = (id: string, title: string, status: TaskRow["status"] = "not_started") =>
  ({ id, title, status, suggested: 1 }) as TaskRow;

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

  // Issue #46. A suggestion isn't a choice — waiting on work nobody has agreed
  // to do is not something the picker should invite — but an edge already drawn
  // onto one (an agent's `blocked_by`, which never checks `suggested`) blocks
  // for real, so it has to be listed or it can never be removed.
  it("doesn't offer an unreviewed suggestion as a fresh choice", () => {
    const ids = blockerCandidates([row("n", "Marmot migration", "not_started"), sugg("s", "Proposed step")], []).map((t) => t.id);
    expect(ids).toEqual(["n"]);
  });

  it("lists a suggestion that is already a blocker, so it can be unticked", () => {
    const ids = blockerCandidates([row("n", "Marmot migration", "not_started"), sugg("s", "Proposed step")], ["s"]).map((t) => t.id);
    expect(ids).toContain("s");
  });
});

describe("isBlocking", () => {
  it("agrees with blocks() that a missing row doesn't block", () => {
    expect(isBlocking(undefined)).toBe(false);
  });

  it("agrees with blocks() that terminal doesn't block and everything else does", () => {
    expect(isBlocking(row("d", "Done", "done"))).toBe(false);
    expect(isBlocking(row("c", "Cancelled", "cancelled"))).toBe(false);
    expect(isBlocking(row("n", "New", "not_started"))).toBe(true);
    expect(isBlocking(row("h", "Held", "on_hold"))).toBe(true);
  });

  it("counts an unreviewed suggestion, which is what the server does", () => {
    expect(isBlocking(sugg("s", "Proposed step"))).toBe(true);
    expect(isBlocking(sugg("w", "Withdrawn step", "cancelled"))).toBe(false);
  });
});

describe("blockerTitles", () => {
  const dependent = { id: "dep", title: "Accepted step", depends_on: ["s", "d", "n", "ghost"] } as TaskRow;
  const byId = new Map<string, TaskRow>([
    ["s", sugg("s", "Proposed step")],
    ["d", row("d", "Finished thing", "done")],
    ["n", row("n", "Live thing", "not_started")],
  ]);

  it("names a suggested blocker as suggested, so the chip says what it's waiting on", () => {
    expect(blockerTitles(dependent, byId)).toEqual(["Proposed step (suggested)", "Live thing"]);
  });

  it("drops a blocker whose row is gone, matching blocks()", () => {
    expect(blockerTitles(dependent, byId).join(" ")).not.toContain("ghost");
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
