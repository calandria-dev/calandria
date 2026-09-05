/**
 * The Start gate the three suggestion Start buttons share.
 *
 * `POST /api/tasks/[id]/messages` answers a blocked first turn with a 409
 * (issue #46). The three suggestion Starts, the tray's (TasksColumn.tsx), the
 * board's (TaskBoard.tsx) and the transcript card's (Transcript.tsx), gate the
 * way the session header's Start already does, on `blockedNote()` over
 * `isBlocking()`: one predicate and one sentence for all four, so the disabled
 * button and the 409 a stale tab gets say the same thing.
 *
 * There is no component-render harness in this suite (vitest runs in `node`,
 * with no jsdom or testing-library), so what is pinned here is the shared
 * decision the buttons take; `e2e/11-suggestions.spec.ts` pins the button.
 */
import { describe, it, expect } from "vitest";
import { blockedNote, blockerTitles, isBlocking } from "@/app/shell/format";
import type { TaskRow } from "@/app/shell/types";
import type { Status } from "@/lib/types";

const row = (id: string, title: string, status: TaskRow["status"], extra: Partial<TaskRow> = {}) =>
  ({ id, title, status, ...extra }) as TaskRow;

/** The shape `GET /api/tasks/[id]/suggestion` hands the transcript card. */
const cardBlocker = (id: string, title: string, status: Status) => ({ id, title, status });

describe("blockedNote", () => {
  it("says nothing when nothing blocks", () => {
    expect(blockedNote([])).toBeUndefined();
    expect(blockedNote(undefined)).toBeUndefined();
  });

  it("names every open blocker, so the tooltip explains the refusal", () => {
    expect(blockedNote(["Ship the migration"])).toBe("Blocked until done: Ship the migration");
    expect(blockedNote(["Ship the migration", "Audit the schema"]))
      .toBe("Blocked until done: Ship the migration, Audit the schema");
  });
});

describe("the tray and board Start gate", () => {
  // Both read the `blockedBy` map useShell builds with blockerTitles(), so a
  // suggestion with a live blocker is exactly the case that must refuse.
  const suggestion = row("s1", "Rename the widget", "not_started", { suggested: 1, depends_on: ["b1"] });

  it("refuses a suggestion whose blocker is still open", () => {
    const byId = new Map([["b1", row("b1", "Land the rename", "in_progress")]]);
    const note = blockedNote(blockerTitles(suggestion, byId));
    expect(note).toBe("Blocked until done: Land the rename");
  });

  it("allows it once the blocker is done — and once it is cancelled", () => {
    for (const status of ["done", "cancelled"] as const) {
      const byId = new Map([["b1", row("b1", "Land the rename", status)]]);
      expect(blockedNote(blockerTitles(suggestion, byId))).toBeUndefined();
    }
  });

  it("allows it when the blocker ref resolves to nothing, agreeing with the server", () => {
    expect(blockedNote(blockerTitles(suggestion, new Map()))).toBeUndefined();
  });

  it("refuses on a SUGGESTED blocker, which blocks server-side too", () => {
    const byId = new Map([["b1", row("b1", "Land the rename", "not_started", { suggested: 1 })]]);
    expect(blockedNote(blockerTitles(suggestion, byId))).toBe("Blocked until done: Land the rename (suggested)");
  });

  it("leaves an unblocked suggestion's Start alone", () => {
    const free = row("s2", "Rename the widget", "not_started", { suggested: 1, depends_on: [] });
    expect(blockedNote(blockerTitles(free, new Map()))).toBeUndefined();
  });
});

describe("the transcript card's Start gate", () => {
  // The card has no TaskRow to look up: its blockers arrive on the payload as
  // { id, title, status }, which is why isBlocking() is generic over the shape.
  it("refuses while a blocker is open, and names it", () => {
    const open = [cardBlocker("b1", "Land the rename", "in_progress")].filter(isBlocking);
    expect(blockedNote(open.map((b) => b.title))).toBe("Blocked until done: Land the rename");
  });

  it("drops terminal blockers from both the notice and the gate", () => {
    const blockers = [
      cardBlocker("b1", "Land the rename", "done"),
      cardBlocker("b2", "Drop the old flag", "cancelled"),
    ];
    const open = blockers.filter(isBlocking);
    expect(open).toEqual([]);
    expect(blockedNote(open.map((b) => b.title))).toBeUndefined();
  });

  it("keeps only the open ones when a suggestion has a mixed set", () => {
    const blockers = [
      cardBlocker("b1", "Land the rename", "done"),
      cardBlocker("b2", "Audit the schema", "not_started"),
    ];
    expect(blockedNote(blockers.filter(isBlocking).map((b) => b.title)))
      .toBe("Blocked until done: Audit the schema");
  });
});
