// projects.branch: the project's DEFAULT base branch (resolveBaseBranch's last
// leg). It has no CHECK constraint, and PATCH /api/projects/[id] used to pass
// the body straight through updateProject, so a Settings edit that cleared the
// field saved branch: "". resolveBaseBranch then resolved to "", branchExists
// returned false before running any git command, and every task in the
// project showed the sync banner's "isn't a branch in this repository" with a
// blank name. updateProject now normalizes branch the same way it already
// normalizes landing_mode: keep the current value rather than saving a blank.
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
    // The update path is guarded twice over now, but the insert defaulted with
    // `??`, which catches null and undefined and nothing else. POST /api/projects
    // passes body.branch straight to createProject, so a caller spelling the
    // field out as "" wrote the same blank the PATCH route refuses. Cloning a
    // repository with no HEAD is the same shape from inside the app.
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
