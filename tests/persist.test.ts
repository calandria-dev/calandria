import { describe, expect, it } from "vitest";
import { landingSelection, selectionToPersist } from "../app/shell/persist";

const P = (...ids: string[]) => ids.map((id) => ({ id }));

describe("persist — a restart lands on the last project, not the first", () => {
  it("prefers the remembered project over the first in the list", () => {
    const land = landingSelection(P("a", "b", "c"), {}, { selProj: "c" });
    expect(land.proj).toBe("c");
  });

  it("falls back to the first project only when nothing is remembered", () => {
    expect(landingSelection(P("a", "b"), {}, {}).proj).toBe("a");
  });

  it("falls back when the remembered project is gone or deprecated", () => {
    // `active` is already filtered to non-deprecated, so both cases look the same
    // here: the id simply isn't in the list.
    expect(landingSelection(P("a", "b"), {}, { selProj: "gone" }).proj).toBe("a");
  });

  it("lands on nothing when there are no active projects", () => {
    const land = landingSelection([], {}, { selProj: "c", selTask: "t1" });
    expect(land).toEqual({ proj: null, task: null, home: false });
  });

  it("lets the URL override the remembered project", () => {
    const land = landingSelection(P("a", "b"), { project: "b", task: "t9" }, { selProj: "a", selTask: "t1" });
    expect(land).toMatchObject({ proj: "b", task: "t9" });
  });

  it("restores the remembered task alongside its project", () => {
    expect(landingSelection(P("a", "b"), {}, { selProj: "b", selTask: "t1" }).task).toBe("t1");
  });

  it("drops the remembered task when it belongs to a project we did not land on", () => {
    // Remembered project is gone, so we fell back to `a`; `t1` is `gone`'s task.
    expect(landingSelection(P("a"), {}, { selProj: "gone", selTask: "t1" }).task).toBeNull();
  });

  it("restores the project-home pane, but not over a remembered task", () => {
    expect(landingSelection(P("a"), { project: "a", home: true }, {}).home).toBe(true);
    expect(landingSelection(P("a"), { project: "a", home: true }, { selTask: "t1" }).home).toBe(false);
  });

  it("does not open the home pane of a project it fell back to", () => {
    expect(landingSelection(P("a"), { project: "gone", home: true }, {}).home).toBe(false);
  });
});

describe("persist — a pre-boot write must not erase the remembered selection", () => {
  const stored = { selProj: "c", selTask: "t1" };

  it("re-writes what is on disk while boot is still in flight", () => {
    // The live nulls here mean the project fetch has not landed, not that
    // nothing is selected. Persisting them would send the next restart to
    // project one.
    expect(selectionToPersist(false, { selProj: null, selTask: null }, stored)).toEqual(stored);
  });

  it("writes the live selection once boot has applied one", () => {
    expect(selectionToPersist(true, { selProj: "a", selTask: "t7" }, stored)).toEqual({ selProj: "a", selTask: "t7" });
  });

  it("still records a deliberate deselection after boot", () => {
    expect(selectionToPersist(true, { selProj: null, selTask: null }, stored)).toEqual({ selProj: null, selTask: null });
  });

  it("round-trips a pre-boot write back through the landing decision", () => {
    const written = selectionToPersist(false, { selProj: null, selTask: null }, stored);
    expect(landingSelection(P("a", "c"), {}, written)).toMatchObject({ proj: "c", task: "t1" });
  });
});
