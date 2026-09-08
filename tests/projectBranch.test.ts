// projects.branch is the project's default base branch (resolveBaseBranch's
// last leg). It has no CHECK constraint, so updateProject normalizes it the
// same way it normalizes landing_mode: a blank or whitespace value keeps the
// current value instead of being saved.
import { describe, expect, it } from "vitest";
import { createProject, getProject, updateProject } from "@/lib/store";
import { PATCH } from "@/app/api/projects/[id]/route";

describe("projects.branch", () => {
  it("keeps the current branch when the patch clears it to empty or whitespace", () => {
    const project = createProject({ name: "Keeps branch", branch: "main" });
    updateProject(project.id, { branch: "" });
    expect(getProject(project.id)!.branch).toBe("main");
    updateProject(project.id, { branch: "   " });
    expect(getProject(project.id)!.branch).toBe("main");
  });

  it("trims and stores an ordinary branch name", () => {
    const project = createProject({ name: "Trims branch", branch: "main" });
    updateProject(project.id, { branch: " dev " });
    expect(getProject(project.id)!.branch).toBe("dev");
  });

  it("defaults a blank branch at CREATE too, where ?? let one through", () => {
    // createProject normalizes a blank branch too, since `??` only catches
    // null and undefined. A repository cloned with no HEAD hits this same
    // path via POST /api/projects.
    expect(createProject({ name: "Born blank", branch: "" }).branch).toBe("main");
    expect(createProject({ name: "Born whitespace", branch: "   " }).branch).toBe("main");
    expect(createProject({ name: "Born padded", branch: " main " }).branch).toBe("main");
    expect(createProject({ name: "Born default" }).branch).toBe("main");
  });
});

describe("PATCH /api/projects/[id]", () => {
  it("refuses a blank branch with a 400 rather than silently keeping the old one", async () => {
    const project = createProject({ name: "Refuses blank branch", branch: "main" });
    const res = await PATCH(
      new Request(`http://test/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ branch: "   " }),
      }),
      { params: Promise.resolve({ id: project.id }) }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/branch is required/);
    expect(getProject(project.id)!.branch).toBe("main");
  });

  it("passes through and trims an ordinary branch", async () => {
    const project = createProject({ name: "Passes through branch", branch: "main" });
    const res = await PATCH(
      new Request(`http://test/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ branch: " dev " }),
      }),
      { params: Promise.resolve({ id: project.id }) }
    );
    expect(res.status).toBe(200);
    expect(getProject(project.id)!.branch).toBe("dev");
  });
});
