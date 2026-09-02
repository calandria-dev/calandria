// projects.branch is the last stop in every task's base-branch fallthrough
// (task -> tag -> project, resolveBaseBranch in lib/baseBranch.ts), and
// branchExists() answers false for a falsy name without ever running git. So a
// blank in this one column doesn't break one task, it flags every task in the
// project at once with a banner naming no branch at all. It happened: a project
// with ~250 tasks was saved with branch = "" from the Context dialog, whose
// Branch field had no required marker and no guard on Save.
//
// The writer is the gate, for landing_mode's reason on the same row: PATCH
// /api/projects/[id] passes its body straight through, and the column has no
// CHECK behind it.
import { describe, expect, it } from "vitest";
import { createProject, getProject, updateProject } from "@/lib/store";

describe("projects.branch is never blanked by an update", () => {
  it("keeps the current branch when the patch carries an empty or whitespace one", () => {
    const project = createProject({ name: "Blankable", branch: "main" });
    expect(updateProject(project.id, { branch: "" })!.branch).toBe("main");
    expect(getProject(project.id)!.branch).toBe("main");
    expect(updateProject(project.id, { branch: "   " })!.branch).toBe("main");
    expect(getProject(project.id)!.branch).toBe("main");
  });

  it("still lets the rest of the same patch land", () => {
    // A refused branch must not be a refused save: the dialog sends every field
    // it owns on every Save, so dropping the whole patch would lose the edit the
    // user actually made.
    const project = createProject({ name: "Renamed", branch: "main" });
    const after = updateProject(project.id, { branch: "", name: "Renamed twice", context: "why" })!;
    expect(after.branch).toBe("main");
    expect(after.name).toBe("Renamed twice");
    expect(after.context).toBe("why");
  });

  it("trims a padded branch rather than storing a name git can't resolve", () => {
    const project = createProject({ name: "Padded", branch: "main" });
    expect(updateProject(project.id, { branch: "  release  " })!.branch).toBe("release");
  });

  it("leaves an ordinary change alone, and an untouched patch alone", () => {
    const project = createProject({ name: "Ordinary", branch: "main" });
    expect(updateProject(project.id, { branch: "develop" })!.branch).toBe("develop");
    expect(updateProject(project.id, { name: "Ordinary still" })!.branch).toBe("develop");
  });

  it("defaults an empty branch at CREATE too, where ?? let one through", () => {
    // `input.branch ?? "main"` defaults null and undefined and nothing else, so
    // a create body that spells the field out as "" wrote the same blank.
    expect(createProject({ name: "Born blank", branch: "" }).branch).toBe("main");
    expect(createProject({ name: "Born padded", branch: " main " }).branch).toBe("main");
    expect(createProject({ name: "Born default" }).branch).toBe("main");
  });
});
