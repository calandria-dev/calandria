// Per-project landing policy: work lands by a local merge or by opening a
// pull request. buildProjectContext must describe the correct one, since a
// merge attempt on a repo whose base branch requires a PR is rejected and
// the session has no way to know beforehand. These cases pin the two context
// wordings, the default for existing projects, and the write-time
// normalization that stands in for a CHECK constraint the column doesn't
// have.
import { describe, expect, it } from "vitest";
import { createProject, createTask, getProject, getTask, updateProject, updateTask } from "@/lib/store";
import { buildProjectContext, landingSentence } from "@/lib/agents/shared";
import { detectLandingMode } from "@/lib/github";

describe("projects.landing_mode", () => {
  it("defaults to merge, and the context sentence is the historic one", () => {
    const project = createProject({ name: "Lands by merge", branch: "main" });
    expect(project.landing_mode).toBe("merge");
    const task = createTask({ project_id: project.id, title: "Do a thing" });
    expect(buildProjectContext(project, task)).toContain(
      "Base branch: main — this worktree was cut from it, Sync catches up to it, and Merge lands into it."
    );
  });

  it("under pr, the session is told main is protected, that Merge is rejected, and to open a PR", () => {
    const project = createProject({ name: "Lands by PR", branch: "main" });
    updateProject(project.id, { landing_mode: "pr" });
    const fresh = getProject(project.id)!;
    expect(fresh.landing_mode).toBe("pr");
    const task = createTask({ project_id: fresh.id, title: "Do a thing" });
    const ctx = buildProjectContext(fresh, task);
    // The false sentence is removed entirely.
    expect(ctx).not.toContain("Merge lands into it");
    expect(ctx).toContain("main is protected");
    expect(ctx).toContain("Merge is rejected");
    expect(ctx).toContain("opening a PR against main");
  });

  it("names the task's OWN base branch, not the project default, in either mode", () => {
    const project = createProject({ name: "Feature bases", branch: "main" });
    updateProject(project.id, { landing_mode: "pr" });
    const task = createTask({ project_id: project.id, title: "On a feature branch" });
    updateTask(task.id, { base_branch: "feature/auth" });
    const ctx = buildProjectContext(getProject(project.id)!, getTask(task.id)!);
    expect(ctx).toContain("feature/auth is protected");
    expect(ctx).toContain("opening a PR against feature/auth");
    // The inherited-default parenthetical is still included.
    expect(ctx).toContain("(The project's default is main.)");
  });

  it("can be chosen at creation — detection at project create has nowhere else to land it", () => {
    expect(createProject({ name: "Born protected", landing_mode: "pr" }).landing_mode).toBe("pr");
  });

  it("normalizes anything that isn't merge|pr back to merge on write", () => {
    const project = createProject({ name: "Bad value" });
    // The column has no CHECK behind it and PATCH /api/projects/[id] passes the
    // body straight through, so the writer is the gate.
    updateProject(project.id, { landing_mode: "rebase-and-hope" as never });
    expect(getProject(project.id)!.landing_mode).toBe("merge");
    updateProject(project.id, { landing_mode: "pr" });
    updateProject(project.id, { landing_mode: undefined as never });
    expect(getProject(project.id)!.landing_mode).toBe("merge");
  });

  it("names the tool that actually opens the PR, since the shell cannot", () => {
    // A session's own `git push` is normally refused, so the sentence must
    // name the tool that finishes the job. create_pr is registered whenever
    // this branch of the sentence is (lib/agents/claude/driver.ts,
    // scripts/calandria-mcp.mjs).
    const sentence = landingSentence({ landing_mode: "pr" }, "main");
    expect(sentence).toContain("create_pr");
    // And the half stating that git push is not available for this.
    expect(sentence).toContain("no tool for it");
    expect(landingSentence({ landing_mode: "merge" }, "main")).not.toContain("create_pr");
  });

  it("landingSentence is pure and covers both modes", () => {
    expect(landingSentence({ landing_mode: "merge" }, "main")).toContain("Merge lands into it");
    expect(landingSentence({ landing_mode: "pr" }, "trunk")).toContain("trunk is protected");
  });
});

describe("detectLandingMode", () => {
  // The probe preselects a value for a human to save and never writes one.
  // When it cannot tell, it must report mode: null instead of guessing, so a
  // private repo the login can't read never comes back as "merge".
  it("reports a null mode, with a reason, when there is no repository to check", async () => {
    const probe = await detectLandingMode("", "main");
    expect(probe.mode).toBeNull();
    expect(probe.reason).toMatch(/working directory/i);
  });

  it("reports a null mode when neither a branch nor a checkout can name one", async () => {
    const probe = await detectLandingMode("/nonexistent/definitely-not-a-repo", "");
    expect(probe.mode).toBeNull();
    expect(probe.reason).toMatch(/base branch/i);
  });
});
